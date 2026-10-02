import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, sep } from 'node:path';
import { backup as backupSqlite, DatabaseSync } from 'node:sqlite';
import type * as lancedb from '@lancedb/lancedb';
import { loadEngine as loadDocumentEngine } from './document-engine.js';
import { loadEngine as loadOcrEngine } from './ocr-engine.js';
import { runOcr, type RecognizeResult } from './ocr-runner.js';
import { loadLanceDB } from './lancedb-engine.js';
import { fallbackTerms, queryTerms } from './snippet.js';

export const ACCEPTED = ['.md', '.markdown', '.txt', '.doc', '.docx', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'];
export const DEFAULT_TAG = 'default';
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff']);
const OFFICE = new Set(['.doc', '.docx', '.pdf']);
const LEGACY_TABLE = 'passages_v1';
const DIMENSIONS = 512;
const MAX_FILE = 64 * 1024 * 1024;
const MAX_TEXT = 6_000_000;

export interface Passage {
  id: string;
  document_id: string;
  path: string;
  name: string;
  hash: string;
  indexed_at: number;
  chunk: number;
  text: string;
  vector: number[];
  _distance?: number;
  [field: string]: unknown;
}
/** A document carries every tag it belongs to; none means it sits in Unclassified. */
export interface DocumentSummary { id: string; path: string; name: string; hash: string; tags: string[]; added_at: number; indexed_at: number; chunks: number; source_path: string | null }
export interface TagSummary { id: string; name: string; count: number }
export type DocumentSort = 'name' | 'added' | 'updated';

/** Character n-gram hashing keeps all data and embedding computation on this machine. */
export function vectorize(text: string): number[] {
  const vector = new Float32Array(DIMENSIONS);
  const normalized = text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  function add(token: string, weight: number): void {
    let hash = 2166136261;
    for (const ch of token) { hash ^= ch.codePointAt(0)!; hash = Math.imul(hash, 16777619); }
    const slot = (hash >>> 0) % DIMENSIONS;
    vector[slot] = (vector[slot] ?? 0) + ((hash & 0x80000000) ? -weight : weight);
  }
  for (const token of tokens) {
    if (token.length < 20) add(`word:${token}`, 2);
    const chars = Array.from(token);
    for (const size of [2, 3]) {
      for (let i = 0; i + size <= chars.length; i++) add(chars.slice(i, i + size).join(''), 1);
    }
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  const scale = Math.sqrt(norm) || 1;
  return Array.from(vector, (value) => value / scale);
}

export function chunkText(text: string, size = 1000, overlap = 160): string[] {
  if (size < 1 || overlap < 0 || overlap >= size) throw new Error('Invalid chunk dimensions.');
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  for (let start = 0; start < normalized.length; start += size - overlap) {
    const piece = normalized.slice(start, start + size).trim();
    if (piece) chunks.push(piece);
    if (start + size >= normalized.length) break;
  }
  return chunks;
}

/**
 * The engine a format cannot be indexed without. Callers check this *before* taking the library
 * lock: a missing engine downloads a hundred megabytes, and holding the lock through that froze
 * every reader in the App View.
 */
export function engineForExtension(extension: string): 'ocr' | 'anydoc' | null {
  if (IMAGE.has(extension)) return 'ocr';
  if (OFFICE.has(extension)) return 'anydoc';
  return null;
}

/** Extracts text for indexing; engine caches live in the local cache path, not with the library data. */
async function readContent(path: string, extension: string, cachePath: string, progress?: (message: string) => void): Promise<string> {
  if (IMAGE.has(extension)) {
    const binary = await loadOcrEngine(join(cachePath, 'ocr'), progress);
    const result = await runOcr(binary, { command: 'recognize', source: path, timeoutMs: 120_000 }) as RecognizeResult;
    return result.text?.trim() || result.lines?.flat().map((box) => box.text ?? '').join('\n').trim() || '';
  }
  if (OFFICE.has(extension)) {
    const engine = await loadDocumentEngine(join(cachePath, 'anydoc'), progress);
    return engine.toMarkdown(path);
  }
  return readFile(path, 'utf8');
}

export interface LibraryOptions {
  /** Local cache for downloadable engines; kept off network volumes. Defaults to the library directory. */
  cachePath?: string;
  progress?: (message: string) => void;
  /** Runs before an import takes the library lock, so a missing engine is reported, not awaited. */
  requireEngine?: (extension: string) => Promise<void>;
}

/** One scalar catalogue for stable document metadata; one LanceDB table per tag. */
export class KnowledgeStore {
  private db?: lancedb.Connection;
  private opening?: Promise<lancedb.Connection>;
  private writes: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly catalog: DatabaseSync;
  private readonly cachePath: string;
  private readonly progress?: (message: string) => void;
  private readonly requireEngine?: (extension: string) => Promise<void>;
  constructor(readonly root: string, options: LibraryOptions = {}) {
    this.cachePath = options.cachePath ?? root;
    this.progress = options.progress;
    this.requireEngine = options.requireEngine;
    mkdirSync(root, { recursive: true });
    this.catalog = new DatabaseSync(join(root, 'catalog.sqlite'));
    this.catalog.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, created_at INTEGER NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, hash TEXT NOT NULL, added_at INTEGER NOT NULL, indexed_at INTEGER NOT NULL, chunks INTEGER NOT NULL, source_path TEXT);
      -- A document can carry several tags, so the pairing lives in its own table. Having no row in
      -- here is what Unclassified means; there is no tag row for it.
      CREATE TABLE IF NOT EXISTS document_tags (document_id TEXT NOT NULL, tag_id TEXT NOT NULL, added_at INTEGER NOT NULL, PRIMARY KEY (document_id, tag_id));
      CREATE INDEX IF NOT EXISTS document_tags_tag ON document_tags(tag_id, document_id);`);
  }

  /** Releases both handles so the same process can reopen the library from a different directory. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writes.catch(() => {});
    await this.opening?.catch(() => {});
    this.db?.close();
    this.db = undefined;
    this.opening = undefined;
    this.catalog.close();
  }

  private tableName(tagId: string): string {
    if (tagId === DEFAULT_TAG) return LEGACY_TABLE;
    if (!/^[a-f\d-]{36}$/i.test(tagId)) throw new Error('Invalid tag ID.');
    return `passages_tag_${tagId.replaceAll('-', '')}`;
  }
  assertTag(tagId: string): void {
    this.tableName(tagId);
    if (tagId !== DEFAULT_TAG && !this.catalog.prepare('SELECT 1 FROM tags WHERE id = ?').get(tagId)) throw new Error('Tag no longer exists.');
  }
  private async connection(): Promise<lancedb.Connection> {
    if (this.db) return this.db;
    if (!this.opening) this.opening = (async () => {
      const sdk = await loadLanceDB(this.cachePath, this.progress);
      await mkdir(this.root, { recursive: true });
      const db = await sdk.connect(join(this.root, 'vectors.lance'));
      await this.migrateCatalog(db);
      this.db = db;
      return db;
    })().catch((error: unknown) => { this.opening = undefined; throw error; });
    return this.opening;
  }
  /**
   * Brings the catalogue up to the current schema. Pass the vector store when it is already
   * open; without it the one migration that reads legacy passages is deferred, so a panel can
   * paint before any engine has been downloaded.
   */
  private async migrateCatalog(db?: lancedb.Connection): Promise<void> {
    const version = (): number => (this.catalog.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    // v1: the original table remains untouched; copy its summaries into the catalogue once.
    if (version() === 0) {
      if (db) {
        if ((await db.tableNames()).includes(LEGACY_TABLE)) {
          const table = await db.openTable(LEGACY_TABLE);
          const rows = await table.query().select(['document_id', 'path', 'name', 'hash', 'indexed_at']).toArray() as Passage[];
          const summaries = new Map<string, DocumentSummary>();
          for (const row of rows) {
            const previous = summaries.get(row.document_id);
            if (previous) previous.chunks++;
            else summaries.set(row.document_id, { id: row.document_id, path: row.path, name: row.name, hash: row.hash, tags: [], added_at: row.indexed_at, indexed_at: row.indexed_at, chunks: 1, source_path: null });
          }
          const insert = this.catalog.prepare('INSERT OR IGNORE INTO documents (id,path,name,hash,added_at,indexed_at,chunks) VALUES (?,?,?,?,?,?,?)');
          this.catalog.exec('BEGIN');
          try {
            for (const doc of summaries.values()) insert.run(doc.id, doc.path, doc.name, doc.hash, doc.added_at, doc.indexed_at, doc.chunks);
            this.catalog.exec('PRAGMA user_version=1; COMMIT');
          } catch (error) { this.catalog.exec('ROLLBACK'); throw error; }
        } else this.catalog.exec('PRAGMA user_version=1');
      } else if (!existsSync(join(this.root, 'vectors.lance'))) {
        // Nothing was ever indexed here, so there is no legacy table to read.
        this.catalog.exec('PRAGMA user_version=1');
      }
    }
    // v2: earlier versions stored managed copies under a content hash. Best effort
    // only — a copy that cannot be renamed simply keeps its hashed name.
    // v3: a first build of that pass skipped every tag that had no import folder
    // yet, so libraries it already stamped are walked once more. The pass is
    // idempotent, so re-running it on a healthy library changes nothing.
    if (version() <= 2) {
      await this.renameManagedCopies();
    }
    // v4: documents imported from a workspace file now remember where that file was, so a
    // later sync can re-index it when it changes. Older rows simply have no source.
    if (version() <= 3) {
      if (!this.hasColumn('documents', 'source_path')) {
        this.catalog.exec('ALTER TABLE documents ADD COLUMN source_path TEXT');
      }
      this.catalog.exec('PRAGMA user_version=4');
    }
    // v5: tags remember the order the user arranged them in. Only an upgrade adds the column, and
    // only then are the existing tags seeded — with the order they already showed, so nothing
    // moves on screen. A catalogue that has the column keeps whatever the user arranged.
    if (version() <= 4) {
      if (this.hasColumn('tags', 'sort_order')) {
        this.catalog.exec('PRAGMA user_version=5');
      } else {
        this.catalog.exec('ALTER TABLE tags ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
        const rows = this.catalog.prepare('SELECT id FROM tags ORDER BY created_at, name').all() as Array<{ id: string }>;
        const update = this.catalog.prepare('UPDATE tags SET sort_order = ? WHERE id = ?');
        this.catalog.exec('BEGIN');
        try {
          rows.forEach((row, index) => update.run(index, row.id));
          this.catalog.exec('PRAGMA user_version=5; COMMIT');
        } catch (error) { this.catalog.exec('ROLLBACK'); throw error; }
      }
    }
    // v6: a document may carry several tags, so the single column becomes a link table. An existing
    // tag becomes one link; Unclassified becomes no link at all, which is what it means now.
    if (version() <= 5) {
      if (this.hasColumn('documents', 'tag_id')) {
        // Insert first, then strip what pointed at the column: SQLite refuses to drop a column an
        // index still references. Both steps are idempotent, so an interrupted run finishes next time.
        this.catalog.exec(`INSERT OR IGNORE INTO document_tags (document_id, tag_id, added_at)
          SELECT id, tag_id, added_at FROM documents WHERE tag_id <> '${DEFAULT_TAG}'`);
        this.catalog.exec('DROP INDEX IF EXISTS documents_tag_updated; DROP INDEX IF EXISTS documents_tag_name;');
        this.catalog.exec('ALTER TABLE documents DROP COLUMN tag_id');
      }
      this.catalog.exec('PRAGMA user_version=6');
    }
  }
  private hasColumn(table: string, column: string): boolean {
    const columns = this.catalog.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return columns.some((entry) => entry.name === column);
  }
  private async table(tagId: string): Promise<lancedb.Table | undefined> {
    const db = await this.connection();
    const name = this.tableName(tagId);
    return (await db.tableNames()).includes(name) ? db.openTable(name) : undefined;
  }
  private locked<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writes.then(operation, operation);
    this.writes = next.catch(() => {});
    return next;
  }

  /**
   * Catalogue counts for the first paint. Deliberately never opens the vector engine: on a
   * fresh machine the engines are still downloading, and the setup screen has to appear first.
   */
  async summary(): Promise<{ documents: number; lastIndexedAt: number | null; tags: TagSummary[] }> {
    await this.writes;
    await this.migrateCatalog();
    const { documents, lastIndexedAt } = this.catalog.prepare('SELECT COUNT(*) AS documents, MAX(indexed_at) AS lastIndexedAt FROM documents').get() as { documents: number; lastIndexedAt: number | null };
    return { documents, lastIndexedAt, tags: [{ id: DEFAULT_TAG, name: '', count: this.uncategorizedCount() }, ...this.tagRows()] };
  }
  async tags(): Promise<TagSummary[]> {
    await this.writes;
    await this.connection();
    return [{ id: DEFAULT_TAG, name: '', count: this.uncategorizedCount() }, ...this.tagRows()];
  }
  /**
   * The user's own tags in the order they arranged them. The two fixed rows — All sources and
   * Unclassified — are not stored here at all; they are pinned by the callers.
   */
  private tagRows(): TagSummary[] {
    return this.catalog.prepare(`SELECT t.id,t.name,COUNT(dt.document_id) AS count FROM tags t LEFT JOIN document_tags dt ON dt.tag_id=t.id GROUP BY t.id ORDER BY t.sort_order,t.created_at,t.name`).all() as unknown as TagSummary[];
  }
  /** Every document's tags in one pass, keyed by document id. */
  private tagsFor(ids: string[]): Map<string, string[]> {
    const map = new Map<string, string[]>();
    if (!ids.length) return map;
    const rows = this.catalog.prepare('SELECT document_id, tag_id FROM document_tags').all() as Array<{ document_id: string; tag_id: string }>;
    const wanted = new Set(ids);
    for (const row of rows) {
      if (!wanted.has(row.document_id)) continue;
      const list = map.get(row.document_id);
      if (list) list.push(row.tag_id);
      else map.set(row.document_id, [row.tag_id]);
    }
    return map;
  }
  /** Rows come out of SQLite without their links, so every read goes through here. */
  private hydrate(rows: DocumentSummary[]): DocumentSummary[] {
    const tags = this.tagsFor(rows.map((row) => row.id));
    return rows.map((row) => ({ ...row, tags: tags.get(row.id) ?? [] }));
  }
  /** Where a document's passages live: one copy per tag, or the default table while it has none. */
  private tablesFor(tags: string[]): string[] {
    return tags.length ? tags : [DEFAULT_TAG];
  }
  /**
   * Copies a document's passages from one tag's table to another. Adding a second tag, or losing the
   * last one, is exactly this: the same passages indexed again under a different name.
   */
  private async copyPassages(id: string, fromTag: string, toTag: string): Promise<void> {
    if (fromTag === toTag) return;
    const source = await this.table(fromTag);
    if (!source) return;
    const raw = await source.query().where(`document_id = '${id}'`).toArray() as Passage[];
    if (!raw.length) return;
    // LanceDB returns an Arrow Vector for each stored embedding; normalize before re-inserting.
    const rows = raw.map((row) => ({ ...row, vector: Array.from((row.vector as unknown as { toArray?: () => ArrayLike<number> }).toArray?.() ?? row.vector) }));
    const db = await this.connection();
    const existing = await this.table(toTag);
    const target = existing ?? await db.createTable(this.tableName(toTag), rows);
    if (existing) await target.add(rows);
  }
  private async dropPassages(id: string, tagId: string): Promise<void> {
    const table = await this.table(tagId);
    if (table) await table.delete(`document_id = '${id}'`);
  }
  private linkTags(id: string, tagIds: string[]): void {
    const insert = this.catalog.prepare('INSERT OR IGNORE INTO document_tags (document_id, tag_id, added_at) VALUES (?,?,?)');
    const now = Date.now();
    for (const tagId of tagIds) insert.run(id, tagId, now);
  }
  private unlinkTags(id: string, tagIds: string[]): void {
    const remove = this.catalog.prepare('DELETE FROM document_tags WHERE document_id = ? AND tag_id = ?');
    for (const tagId of tagIds) remove.run(id, tagId);
  }
  private currentTags(id: string): string[] {
    return (this.catalog.prepare('SELECT tag_id FROM document_tags WHERE document_id = ?').all(id) as Array<{ tag_id: string }>).map((row) => row.tag_id);
  }
  private needDocument(id: string): DocumentSummary {
    const row = this.catalog.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentSummary | undefined;
    if (!row) throw new Error('Document no longer exists.');
    return { ...row, tags: this.currentTags(id) };
  }
  private uncategorizedCount(): number {
    return (this.catalog.prepare('SELECT COUNT(*) AS count FROM documents d WHERE NOT EXISTS (SELECT 1 FROM document_tags dt WHERE dt.document_id = d.id)').get() as { count: number }).count;
  }
  async createTag(name: string): Promise<TagSummary> {
    return this.locked(async () => {
      const clean = name.trim().replace(/\s+/g, ' ');
      if (!clean || clean.length > 60 || /[\x00-\x1f]/.test(clean)) throw new Error('Tag name must be 1–60 characters.');
      const id = randomUUID();
      // Sorting before every existing tag keeps a new one exactly where its input row was, right
      // below Unclassified, instead of dropping it at the bottom of the list.
      const lowest = this.catalog.prepare('SELECT MIN(sort_order) AS value FROM tags').get() as { value: number | null };
      this.catalog.prepare('INSERT INTO tags(id,name,created_at,sort_order) VALUES (?,?,?,?)').run(id, clean, Date.now(), (lowest.value ?? 1) - 1);
      return { id, name: clean, count: 0 };
    });
  }
  /**
   * Stores the order the user dragged the tags into. Only the tags it names are touched, so a
   * stale list from another panel can never drop a tag the caller had not seen.
   */
  async reorderTags(ids: string[]): Promise<void> {
    await this.locked(async () => {
      const update = this.catalog.prepare('UPDATE tags SET sort_order = ? WHERE id = ? AND id <> ?');
      this.catalog.exec('BEGIN');
      try {
        ids.forEach((id, index) => { if (typeof id === 'string' && id) update.run(index, id, DEFAULT_TAG); });
        this.catalog.exec('COMMIT');
      } catch (error) { this.catalog.exec('ROLLBACK'); throw error; }
    });
  }
  /** Adding a tag copies the passages into that tag's table, so a tag-scoped search finds them. */
  async addTag(id: string, tagId: string): Promise<void> {
    if (!/^[a-f\d-]{36}$/i.test(id)) throw new Error('Invalid document ID.');
    await this.locked(async () => {
      this.assertTag(tagId);
      if (tagId === DEFAULT_TAG) return;
      const doc = this.needDocument(id);
      if (doc.tags.includes(tagId)) return;
      // Leaving Unclassified means the passages move out of the untagged table.
      if (!doc.tags.length) await this.copyPassages(id, DEFAULT_TAG, tagId);
      else await this.copyPassages(id, doc.tags[0], tagId);
      if (!doc.tags.length) await this.dropPassages(id, DEFAULT_TAG);
      this.linkTags(id, [tagId]);
    });
  }
  /** Removing the last tag puts the passages back into the untagged table. */
  async removeTag(id: string, tagId: string): Promise<void> {
    if (!/^[a-f\d-]{36}$/i.test(id)) throw new Error('Invalid document ID.');
    await this.locked(async () => {
      const doc = this.needDocument(id);
      if (!doc.tags.includes(tagId)) return;
      const remaining = doc.tags.filter((tag) => tag !== tagId);
      if (!remaining.length) await this.copyPassages(id, tagId, DEFAULT_TAG);
      await this.dropPassages(id, tagId);
      this.unlinkTags(id, [tagId]);
    });
  }
  /** Replaces every tag at once; an empty list means Unclassified. */
  async setTags(id: string, tagIds: string[]): Promise<void> {
    if (!/^[a-f\d-]{36}$/i.test(id)) throw new Error('Invalid document ID.');
    const wanted = [...new Set(tagIds.filter((tagId) => tagId && tagId !== DEFAULT_TAG))];
    for (const tagId of wanted) this.assertTag(tagId);
    await this.locked(async () => {
      const current = this.currentTags(id);
      for (const tagId of wanted) if (!current.includes(tagId)) { this.linkTags(id, [tagId]); await this.copyPassages(id, this.tablesFor(current)[0], tagId); }
      for (const tagId of current) if (!wanted.includes(tagId)) await this.removeTagUnlocked(id, tagId, wanted);
    });
  }
  private async removeTagUnlocked(id: string, tagId: string, staying: string[]): Promise<void> {
    if (!staying.length) await this.copyPassages(id, tagId, DEFAULT_TAG);
    await this.dropPassages(id, tagId);
    this.unlinkTags(id, [tagId]);
  }
  async renameTag(id: string, name: string): Promise<void> {
    await this.locked(async () => {
      this.assertTag(id);
      if (id === DEFAULT_TAG) throw new Error('The default tag cannot be renamed.');
      const clean = name.trim().replace(/\s+/g, ' ');
      if (!clean || clean.length > 60 || /[\x00-\x1f]/.test(clean)) throw new Error('Tag name must be 1–60 characters.');
      this.catalog.prepare('UPDATE tags SET name = ? WHERE id = ?').run(clean, id);
    });
  }

  async list(): Promise<DocumentSummary[]> {
    await this.writes;
    await this.connection();
    return this.hydrate(this.catalog.prepare('SELECT * FROM documents ORDER BY indexed_at DESC').all() as unknown as DocumentSummary[]);
  }
  async page(tagId: string | null, sort: DocumentSort, offset: number, limit = 50): Promise<{ documents: DocumentSummary[]; total: number }> {
    await this.writes;
    await this.connection();
    if (tagId !== null) this.assertTag(tagId);
    const scope = this.scopeFor(tagId);
    const order = sort === 'name' ? 'd.name COLLATE NOCASE ASC, d.id ASC' : sort === 'added' ? 'd.added_at DESC, d.id ASC' : 'd.indexed_at DESC, d.id ASC';
    const total = (this.catalog.prepare(`SELECT COUNT(*) AS count FROM documents d ${scope.from} ${scope.where}`).get(...scope.params) as { count: number }).count;
    const safeOffset = Math.max(0, Math.min(1_000_000, Math.floor(offset) || 0));
    const rows = this.catalog.prepare(`SELECT d.* FROM documents d ${scope.from} ${scope.where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...scope.params, Math.max(1, Math.min(50, limit)), safeOffset) as unknown as DocumentSummary[];
    return { documents: this.hydrate(rows), total };
  }
  async position(id: string, tagId: string | null, sort: DocumentSort): Promise<number | null> {
    await this.writes;
    await this.connection();
    if (tagId !== null) this.assertTag(tagId);
    const scope = this.scopeFor(tagId);
    const order = sort === 'name' ? 'd.name COLLATE NOCASE ASC, d.id ASC' : sort === 'added' ? 'd.added_at DESC, d.id ASC' : 'd.indexed_at DESC, d.id ASC';
    const row = this.catalog.prepare(`SELECT position FROM (SELECT d.id AS id, ROW_NUMBER() OVER (ORDER BY ${order}) - 1 AS position FROM documents d ${scope.from} ${scope.where}) WHERE id = ?`).get(...scope.params, id) as { position: number } | undefined;
    return row?.position ?? null;
  }
  async document(id: string): Promise<DocumentSummary | undefined> {
    await this.writes;
    await this.connection();
    const row = this.catalog.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentSummary | undefined;
    return row ? this.hydrate([row])[0] : undefined;
  }
  /** How one tag narrows a document query: Unclassified is the absence of any link. */
  private scopeFor(tagId: string | null): { from: string; where: string; params: string[] } {
    if (tagId === null) return { from: '', where: '', params: [] };
    if (tagId === DEFAULT_TAG) {
      return { from: '', where: 'WHERE NOT EXISTS (SELECT 1 FROM document_tags dt WHERE dt.document_id = d.id)', params: [] };
    }
    return { from: 'JOIN document_tags dt ON dt.document_id = d.id', where: 'WHERE dt.tag_id = ?', params: [tagId] };
  }
  /**
   * Managed copies keep the user's own file name so the library folder stays
   * browsable. Only characters that are illegal on some platform are replaced,
   * and the catalogue still stores the untouched original name.
   */
  private managedName(name: string): string {
    const safeBase = basename(name);
    const extension = extname(safeBase).toLowerCase();
    const stem = extension ? safeBase.slice(0, -extension.length) : safeBase;
    const safe = stem
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/^\.+/, '')
      .replace(/[. ]+$/, '')
      .trim()
      .slice(0, 120)
      .trim();
    const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safe);
    return `${safe && !reserved ? safe : 'file'}${extension}`;
  }

  /** Appends " (2)", " (3)" … until the path is free both in the catalogue and on disk. */
  private freeManagedPath(tagId: string, name: string, keep?: string): string {
    const directory = join(this.root, 'imports', tagId);
    const extension = extname(name);
    const stem = name.slice(0, name.length - extension.length) || name;
    const taken = new Set(this.copiesIn(directory).map((path) => path).filter((path) => path !== keep));
    for (let attempt = 1; attempt < 1000; attempt++) {
      const candidate = join(directory, attempt === 1 ? name : `${stem} (${attempt})${extension}`);
      if (!taken.has(candidate) && !existsSync(candidate)) return candidate;
    }
    throw new Error('Too many files share this name.');
  }

  /**
   * The copies stored under one folder of `imports/`. The folder is chosen when a file is first
   * imported and never follows a re-tagging, so it names where the copy lives, not what it is.
   */
  private copiesIn(directory: string): string[] {
    const prefix = directory.endsWith(sep) ? directory : directory + sep;
    const rows = this.catalog.prepare('SELECT path FROM documents WHERE path LIKE ?').all(`${prefix}%`) as Array<{ path: string }>;
    return rows.map((row) => row.path);
  }
  async uploadTarget(tagId: string, name: string): Promise<string> {
    await this.writes;
    await this.connection();
    this.assertTag(tagId);
    const directory = join(this.root, 'imports', tagId);
    // A copy of this name already in this folder is replaced in place; that is what makes
    // re-importing an edited file an update rather than a second entry.
    const existing = this.copiesIn(directory).find((path) => basename(path).toLowerCase() === this.managedName(name).toLowerCase());
    if (existing) return existing;
    return this.freeManagedPath(tagId, this.managedName(name));
  }

  /**
   * One-time migration of hash-named managed copies to readable names. Never throws.
   * It only runs on catalogues older than v4, where a document still had a single tag column —
   * which is why the folder it files a copy under is read as `tag_id` rather than as a link.
   */
  private async renameManagedCopies(): Promise<void> {
    const managedRoot = join(this.root, 'imports') + sep;
    interface SingleTagRow { id: string; tag_id: string; path: string; name: string }
    try {
      const rows = this.catalog.prepare('SELECT id, tag_id, path, name FROM documents').all() as unknown as SingleTagRow[];
      for (const row of rows) {
        if (!row.path.startsWith(managedRoot) || !existsSync(row.path)) continue;
        const desired = this.managedName(row.name);
        if (basename(row.path) === desired) continue;
        try {
          const target = this.freeManagedPath(row.tag_id, desired, row.path);
          // A tag that has never had an upload has no directory yet.
          await mkdir(dirname(target), { recursive: true });
          await rename(row.path, target);
          this.catalog.prepare('UPDATE documents SET path = ? WHERE id = ?').run(target, row.id);
        } catch {
          // Leave this one as it is; a hashed name is untidy, not broken.
        }
      }
    } catch {
      // A catalogue without the expected columns is not worth failing the connection over.
    }
    this.catalog.exec('PRAGMA user_version=3');
  }

  /**
   * Reports what has happened to each document's source file since it was indexed.
   * Documents without a known source are not listed: nothing can be followed for them.
   */
  async sourceStates(): Promise<Array<{ document: DocumentSummary; state: 'same' | 'changed' | 'deleted' | 'unreachable' }>> {
    await this.writes;
    await this.connection();
    const rows = this.hydrate(this.catalog.prepare('SELECT * FROM documents WHERE source_path IS NOT NULL').all() as unknown as DocumentSummary[]);
    const states: Array<{ document: DocumentSummary; state: 'same' | 'changed' | 'deleted' | 'unreachable' }> = [];
    for (const doc of rows) {
      const source = doc.source_path!;
      const info = await stat(source).catch(() => null);
      if (!info?.isFile()) {
        // A missing source in a folder that is still there means deleted; a missing folder
        // more likely means the volume is away, which is not the library's business.
        const parent = await stat(dirname(source)).catch(() => null);
        states.push({ document: doc, state: parent?.isDirectory() ? 'deleted' : 'unreachable' });
        continue;
      }
      if (info.size > MAX_FILE) { states.push({ document: doc, state: 'unreachable' }); continue; }
      const hash = createHash('sha256').update(await readFile(source)).digest('hex');
      states.push({ document: doc, state: hash === doc.hash ? 'same' : 'changed' });
    }
    return states;
  }

  /**
   * Drops documents whose source file has disappeared.
   *
   * A missing managed copy means the library lost its own data, so the entry goes.
   * Two cases are deliberately left alone, because "gone" is ambiguous there:
   * a file outside the library may sit on an unmounted volume, and a library whose
   * managed folder is missing entirely is not fully present yet.
   */
  async reconcileMissing(): Promise<DocumentSummary[]> {
    const rows = this.catalog.prepare('SELECT * FROM documents').all() as unknown as DocumentSummary[];
    const managedRoot = join(this.root, 'imports') + sep;
    const managedPresent = (await stat(join(this.root, 'imports')).catch(() => null))?.isDirectory() === true;
    const removed: DocumentSummary[] = [];
    for (const doc of rows) {
      if ((await stat(doc.path).catch(() => null))?.isFile()) continue;
      const insideLibrary = doc.path.startsWith(managedRoot);
      if (insideLibrary && !managedPresent) continue;
      if (!insideLibrary) {
        const parent = await stat(dirname(doc.path)).catch(() => null);
        if (!parent?.isDirectory()) continue;
      }
      if (await this.remove(doc.id)) removed.push(doc);
    }
    return removed;
  }

  /**
   * `sourcePath` is the file the content came from, when the caller knows it (a workspace
   * import does; a sandboxed picker or drop does not). It is what a later sync follows.
   */
  async importFile(path: string, displayName = basename(path), tagId = DEFAULT_TAG, sourcePath: string | null = null): Promise<{ document: DocumentSummary; unchanged: boolean }> {
    const extension = extname(path).toLowerCase();
    if (!ACCEPTED.includes(extension)) throw new Error(`Unsupported file type: ${extension || '(none)'}.`);
    // Deliberately outside `locked()`: an engine that still has to download would otherwise hold the
    // write chain for minutes, and every read in the App View waits on that chain. Formats read
    // straight from disk do not consult it at all.
    if (engineForExtension(extension)) await this.requireEngine?.(extension);
    return this.locked(async () => {
      await this.connection(); // Ensure legacy metadata exists before checking for a previous version.
      if (!isAbsolute(path)) throw new Error('Choose a local file with an absolute path.');
      this.assertTag(tagId);
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_FILE) throw new Error('Choose a regular file smaller than 64 MB.');
      const hash = createHash('sha256').update(await readFile(path)).digest('hex');
      const stored = this.catalog.prepare('SELECT * FROM documents WHERE path = ?').get(path) as DocumentSummary | undefined;
      const prior = stored ? { ...stored, tags: this.currentTags(stored.id) } : undefined;
      if (prior?.hash === hash) {
        // Same bytes: keep the entry, but adopt a newly known source so a sync can follow it, and
        // take the tag it was just imported under — that is how a file joins a second category.
        if (sourcePath && sourcePath !== prior.source_path) {
          this.catalog.prepare('UPDATE documents SET source_path = ? WHERE id = ?').run(sourcePath, prior.id);
          prior.source_path = sourcePath;
        }
        if (tagId !== DEFAULT_TAG && !prior.tags.includes(tagId)) {
          this.linkTags(prior.id, [tagId]);
          await this.copyPassages(prior.id, this.tablesFor(prior.tags)[0], tagId);
          prior.tags.push(tagId);
        }
        return { document: prior, unchanged: true };
      }
      this.progress?.(`Extracting ${displayName}…`);
      const text = (await readContent(path, extension, this.cachePath, this.progress)).slice(0, MAX_TEXT);
      const chunks = chunkText(text);
      if (!chunks.length) throw new Error(`No extractable text in ${displayName}. Scanned PDFs need a text layer; import images separately for OCR.`);
      // A replacement keeps the document's identity: the same file, edited, is still the same
      // entry — only its passages change. That keeps IDs quoted elsewhere valid.
      const id = prior?.id ?? randomUUID();
      const now = Date.now();
      const rows: Passage[] = chunks.map((part, chunk) => ({ id: randomUUID(), document_id: id, path, name: displayName, hash, indexed_at: now, chunk: chunk + 1, text: part, vector: vectorize(part) }));
      const db = await this.connection();
      const table = await this.table(tagId);
      const target = table ?? await db.createTable(this.tableName(tagId), rows);
      // Drop the previous passages before writing the new ones: a replacement reuses the same
      // document id, so deleting afterwards would take the fresh rows with it.
      if (table && prior) await target.delete(`document_id = '${prior.id}'`);
      if (table) await target.add(rows);
      const tags = tagId === DEFAULT_TAG ? [] : [...(prior?.tags ?? []), tagId].filter((tag, at, all) => all.indexOf(tag) === at);
      const document: DocumentSummary = { id, path, name: displayName, hash, tags, added_at: prior?.added_at ?? now, indexed_at: now, chunks: rows.length, source_path: sourcePath ?? prior?.source_path ?? null };
      this.catalog.exec('BEGIN');
      try {
        if (prior) { this.catalog.prepare('DELETE FROM documents WHERE id = ?').run(prior.id); this.unlinkTags(prior.id, prior.tags); }
        this.catalog.prepare('INSERT INTO documents (id,path,name,hash,added_at,indexed_at,chunks,source_path) VALUES (?,?,?,?,?,?,?,?)')
          .run(id, path, displayName, hash, document.added_at, now, rows.length, document.source_path);
        this.linkTags(id, document.tags);
        this.catalog.exec('COMMIT');
      } catch (error) { this.catalog.exec('ROLLBACK'); throw error; }
      return { document, unchanged: false };
    });
  }

  /** Kept for callers that re-file a document outright: one tag, replacing whatever it had. */
  async move(id: string, tagId: string): Promise<void> {
    await this.setTags(id, tagId === DEFAULT_TAG ? [] : [tagId]);
  }
  /**
   * Removes a tag. Every document that carried it keeps its other tags; only one that had none left
   * lands in Unclassified. Reports both numbers, because "moved to Unclassified" is only true of
   * the second.
   */
  async deleteTag(id: string): Promise<{ affected: number; orphaned: number }> {
    return this.locked(async () => {
      this.assertTag(id);
      if (id === DEFAULT_TAG) throw new Error('The default tag cannot be removed.');
      const documents = this.catalog.prepare('SELECT document_id FROM document_tags WHERE tag_id = ?').all(id) as Array<{ document_id: string }>;
      let orphaned = 0;
      for (const row of documents) {
        const remaining = this.currentTags(row.document_id).filter((tag) => tag !== id);
        if (!remaining.length) orphaned++;
        await this.removeTagUnlocked(row.document_id, id, remaining);
      }
      this.catalog.prepare('DELETE FROM tags WHERE id = ?').run(id);
      // The tag's passages left with its documents; the table itself has nothing left to hold.
      const db = await this.connection();
      if ((await db.tableNames()).includes(this.tableName(id))) await db.dropTable(this.tableName(id));
      return { affected: documents.length, orphaned };
    });
  }

  async remove(id: string): Promise<boolean> {
    if (!/^[a-f\d-]{36}$/i.test(id)) throw new Error('Invalid document ID.');
    return this.locked(async () => {
      const row = this.catalog.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentSummary | undefined;
      if (!row) return false;
      const tags = this.currentTags(id);
      for (const tagId of this.tablesFor(tags)) await this.dropPassages(id, tagId);
      this.catalog.prepare('DELETE FROM documents WHERE id = ?').run(id);
      this.unlinkTags(id, tags);
      const source = row.path;
      if (source.startsWith(join(this.root, 'imports') + sep)) {
        await unlink(source).catch(() => {}); // Never delete files outside this mini tool's managed imports.
      }
      return true;
    });
  }

  /** Copies catalogue, vectors and managed copies into a directory, serialized against indexed writes. */
  async copyLibraryTo(directory: string): Promise<{ documents: DocumentSummary[]; tags: TagSummary[] }> {
    return this.locked(async () => {
      // A copy moves catalogue files and managed copies only. It deliberately never opens the
      // vector engine: the setup screen can relocate a library while that engine is still
      // downloading, and a library that was never indexed has no vectors to copy.
      await this.migrateCatalog();
      await backupSqlite(this.catalog, join(directory, 'catalog.sqlite'));
      const vectors = join(this.root, 'vectors.lance');
      if ((await stat(vectors).catch(() => null))?.isDirectory()) {
        await cp(vectors, join(directory, 'vectors.lance'), { recursive: true, errorOnExist: true });
      }
      const imports = join(this.root, 'imports');
      if ((await stat(imports).catch(() => null))?.isDirectory()) {
        await cp(imports, join(directory, 'imports'), {
          recursive: true, errorOnExist: true,
          filter: async (source) => {
            const path = source.slice(imports.length).replace(/^[/\\]/, '');
            if (path === '.staging' || path.startsWith(`.staging${sep}`)) return false;
            if ((await lstat(source)).isSymbolicLink()) throw new Error('Managed imports contain a symbolic link.');
            return true;
          },
        });
      } else await mkdir(join(directory, 'imports'));
      const documents = this.hydrate(this.catalog.prepare('SELECT * FROM documents ORDER BY indexed_at DESC').all() as unknown as DocumentSummary[]);
      const tags = this.catalog.prepare('SELECT id,name,0 AS count FROM tags ORDER BY sort_order,created_at').all() as unknown as TagSummary[];
      return { documents, tags };
    });
  }

  async search(query: string, limit = 5, tagId: string | null = null): Promise<Array<Pick<Passage, 'document_id' | 'path' | 'name' | 'chunk' | 'text'> & { tag_id: string; distance: number; matched: string[] }>> {
    if (!query.trim()) throw new Error('Enter a search query.');
    await this.writes;
    await this.connection();
    if (tagId !== null) this.assertTag(tagId);
    const tagIds = tagId === null ? [DEFAULT_TAG, ...((this.catalog.prepare('SELECT id FROM tags').all() as Array<{ id: string }>).map((row) => row.id))] : [tagId];
    const vector = vectorize(query);
    const count = Math.max(1, Math.min(20, Math.floor(limit) || 5));
    // A nearest-neighbour query always returns its nearest rows, however far away they are: asking
    // for a name that nothing mentions used to hand back ten unrelated passages. The index is
    // lexical, so a candidate has to contain a word of the query — or, failing that, a two-character
    // run of it — to be a result at all.
    const terms = queryTerms(query, 1).map((term) => term.toLowerCase());
    const weak = fallbackTerms(queryTerms(query, 1)).map((term) => term.toLowerCase());
    const batches = await Promise.all(tagIds.map(async (tag) => {
      const table = await this.table(tag);
      if (!table) return [];
      const rows = await table.vectorSearch(vector).limit(count * 4).toArray() as Passage[];
      return rows.map((row) => {
        const text = row.text.toLowerCase();
        const full = terms.filter((term) => text.includes(term));
        // Partial runs only count when the passage holds none of the query as written.
        const partial = full.length ? [] : weak.filter((term) => text.includes(term));
        return { document_id: row.document_id, path: row.path, name: row.name, chunk: row.chunk, text: row.text,
          tag_id: tag, distance: row._distance ?? 0, full: full.length, partial: partial.length,
          // What actually matched, so the App View highlights the words that are really there.
          matched: full.length ? full : partial };
      }).filter((row) => row.full > 0 || row.partial > 0);
    }));
    return batches.flat()
      // Most of the query first, then closest: a passage holding both words beats one holding one.
      .sort((a, b) => b.full - a.full || b.partial - a.partial || a.distance - b.distance)
      .slice(0, count)
      .map(({ full, partial, ...row }) => row);
  }
}

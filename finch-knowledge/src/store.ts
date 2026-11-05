import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, createReadStream } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type * as lancedb from '@lancedb/lancedb';
import { loadEngine as loadDocumentEngine } from './document-engine.js';
import { loadEngine as loadOcrEngine } from './ocr-engine.js';
import { runOcr, type RecognizeResult } from './ocr-runner.js';
import { loadLanceDB } from './lancedb-engine.js';
import { fallbackTerms, queryTerms } from './snippet.js';
import { resolveDocumentStatus, type CoverageState, type SourceState, type DocumentState } from './document-status.js';

import { directoryKey, indexedDirectories, insideDirectory, TAG_COLORS } from './directories.js';
import { IndexSkipError } from './indexing-result.js';
import { interruptible, WorkScope } from './work-scope.js';
import { remoteIndexRoot } from './index-location.js';
import { SourceCatalog, type CatalogRow, type CatalogScope } from './source-catalog.js';

export const ACCEPTED = ['.md', '.markdown', '.txt', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'];
export const DEFAULT_TAG = 'default';
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff']);
const OFFICE = new Set(['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.pdf']);
const PASSAGES_TABLE = 'passages_directory_v1';
const DIMENSIONS = 512;
/**
 * The largest file the library takes. A scanned or exported PDF is usually the biggest thing in a
 * folder and comfortably passes the old 64 MB, so the cap is about patience and disk rather than
 * memory: uploads stream to disk in 192 KB pieces and the hash below is streamed too.
 */
export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_FILE_MB = MAX_FILE_BYTES / (1024 * 1024);
/** One message for every door a file can come in through, so the number cannot drift. */
export const SIZE_LIMIT_MESSAGE = `Choose a nonempty file smaller than ${MAX_FILE_MB} MB.`;
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
export interface DocumentSummary { file_id?: string; source_revision?: number; id: string; path: string; name: string; hash: string; tags: string[]; added_at: number; indexed_at: number; chunks: number; source_path: string | null; size_bytes?: number | null; modified_at?: number | null; file_type?: string }
export interface DocumentStatus extends DocumentSummary { indexState: CoverageState; indexedChunks: number | null; sourceState: SourceState; status: DocumentState; statusReason?: string }
export type SourceIssueKind = 'pending' | 'unsupported' | 'failed' | 'empty_file' | 'no_text' | 'image_no_text' | 'unavailable';
export interface SourceIssue { path: string; kind: SourceIssueKind; reason: string }
export interface SourceIssueDocument extends DocumentSummary { issueKind: SourceIssueKind; statusReason: string }
export interface TagSummary { id: string; name: string; count: number; color?: string }
export type DocumentSort = 'name' | 'added' | 'updated' | 'modified' | 'type' | 'size';
const compareNames = new Intl.Collator('en', { sensitivity: 'base' }).compare;
const metadataSort = (sort: DocumentSort) => sort === 'modified' || sort === 'type' || sort === 'size';
function documentOrder(sort: DocumentSort, descending?: boolean): string {
  const column = sort === 'name' ? 'd.name COLLATE NOCASE' : sort === 'added' ? 'd.added_at' : 'd.indexed_at';
  return `${column} ${(descending ?? sort !== 'name') ? 'DESC' : 'ASC'}, d.id ASC`;
}

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
async function readContent(path: string, extension: string, cachePath: string, progress?: (message: string) => void, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (IMAGE.has(extension)) {
    const binary = await interruptible(loadOcrEngine(join(cachePath, 'ocr'), progress), signal);
    signal?.throwIfAborted();
    const result = await runOcr(binary, { command: 'recognize', source: path, timeoutMs: 120_000, signal }) as RecognizeResult;
    return result.text?.trim() || result.lines?.flat().map((box) => box.text ?? '').join('\n').trim() || '';
  }
  if (OFFICE.has(extension)) {
    const engine = await interruptible(loadDocumentEngine(join(cachePath, 'anydoc'), progress), signal);
    signal?.throwIfAborted();
    return interruptible(engine.toMarkdown(path), signal);
  }
  return interruptible(readText(path), signal);
}
/**
 * Only the first MAX_TEXT characters are ever indexed, so a huge text file is read to that budget
 * rather than pulled into memory whole — the size cap went to 200 MB and a text file of that size
 * would otherwise cost four times its bytes once decoded.
 */
const TEXT_READ_BYTES = MAX_TEXT * 4;
async function readText(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(TEXT_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, TEXT_READ_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}
/**
 * Streams the digest instead of buffering the whole file: a 200 MB PDF has to be hashed on its way
 * past, not held in memory while it is.
 */
async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path, { signal });
    stream.on('data', (piece) => hash.update(piece));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

export interface LibraryOptions {
  /** Source directory; source files are never removed or copied. */
  directoryRoot: string;
  /** Local cache for downloadable engines; kept off network volumes. Defaults to the library directory. */
  cachePath?: string;
  /** Remote sources use one validated, source-specific index below Finch's local storage. */
  remoteIndexKey?: string;
  /** Reject an unmounted or remapped source before indexing or reconciliation. */
  sourceGuard?: () => Promise<void>;
  progress?: (message: string) => void;
  onStatusChange?: (path: string, phase: 'processing' | 'settled') => void;
  /** Runs before an import takes the library lock, so a missing engine is reported, not awaited. */
  requireEngine?: (extension: string) => Promise<void>;
}

/** One catalogue for source metadata and tags; one shared table for indexed passages. */
export class KnowledgeStore {
  private db?: lancedb.Connection;
  private opening?: Promise<lancedb.Connection>;
  private writes: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly catalog: DatabaseSync;
  private readonly sourceCatalog: SourceCatalog;
  get catalogVersion(): number { return this.sourceCatalog.version; }
  private readonly processing = new Map<string, number>();
  private readonly sourceChecks = new Map<string, { stamp: string; hash: string }>();
  private readonly metadataCache = new Map<string, { expires: number; size_bytes: number | null; modified_at: number | null; file_type: string }>();
  private readonly onStatusChange?: LibraryOptions['onStatusChange'];
  readonly directoryRoot: string;
  readonly indexStorage: 'source' | 'local';
  /** Bypass a prior scan cooldown when the catalogue has just been rebuilt. */
  rebuiltIndex = false;
  private readonly cachePath: string;
  private readonly progress?: (message: string) => void;
  private readonly requireEngine?: (extension: string) => Promise<void>;
  private readonly sourceGuard?: () => Promise<void>;
  async assertSourceAvailable(): Promise<void> { this.work.signal.throwIfAborted(); if (this.sourceGuard) await this.work.run(this.sourceGuard()); }
  constructor(readonly root: string, options: LibraryOptions) {
    if (!options?.directoryRoot || (options.remoteIndexKey && !options.cachePath)) throw new Error('Only source-directory indexes are supported.');
    const expected = options.remoteIndexKey && options.cachePath
      ? remoteIndexRoot(resolve(options.cachePath), options.remoteIndexKey)
      : join(resolve(options.directoryRoot), '.knowledge');
    if (resolve(root) !== expected) throw new Error('Only source-directory indexes are supported.');
    this.indexStorage = options.remoteIndexKey ? 'local' : 'source';
    this.directoryRoot = options.directoryRoot;
    this.cachePath = options.cachePath ?? root;
    this.progress = options.progress;
    this.onStatusChange = options.onStatusChange;
    this.requireEngine = options.requireEngine;
    this.sourceGuard = options.sourceGuard;
    mkdirSync(root, { recursive: true });
    const existing = existsSync(join(root, 'catalog.sqlite'));
    this.catalog = new DatabaseSync(join(root, 'catalog.sqlite'));
    let schema: number, compatible: boolean;
    try {
      schema = (this.catalog.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      compatible = schema === 6 && this.hasColumn('documents', 'relative_path');
    } catch (error) { this.catalog.close(); throw error; }
    if (existing && !compatible) {
      this.catalog.close();
      throw Object.assign(new Error('Unsupported knowledge index format. Choose a source directory with a current .knowledge index.'),
        { code: schema <= 6 ? 'KNOWLEDGE_LEGACY_INDEX' : 'KNOWLEDGE_FUTURE_INDEX' });
    }
    this.catalog.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, created_at INTEGER NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, hash TEXT NOT NULL, added_at INTEGER NOT NULL, indexed_at INTEGER NOT NULL, chunks INTEGER NOT NULL, source_path TEXT);
      -- A document can carry several tags, so the pairing lives in its own table. Having no row in
      -- here is what Unclassified means; there is no tag row for it.
      CREATE TABLE IF NOT EXISTS document_tags (document_id TEXT NOT NULL, tag_id TEXT NOT NULL, added_at INTEGER NOT NULL, PRIMARY KEY (document_id, tag_id));
      CREATE INDEX IF NOT EXISTS document_tags_tag ON document_tags(tag_id, document_id);
      CREATE TABLE IF NOT EXISTS index_failures (path TEXT PRIMARY KEY, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_folders (path TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS source_metadata (path TEXT PRIMARY KEY, size_bytes INTEGER, modified_at REAL, file_type TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_issues (path TEXT PRIMARY KEY, kind TEXT NOT NULL, reason TEXT NOT NULL);`);
    if (!this.hasColumn('tags', 'color')) this.catalog.exec("ALTER TABLE tags ADD COLUMN color TEXT NOT NULL DEFAULT 'gray'");
    {
      if (!this.hasColumn('documents', 'relative_path')) this.catalog.exec('ALTER TABLE documents ADD COLUMN relative_path TEXT');
      try{this.sourceCatalog = new SourceCatalog(this.catalog, this.directoryRoot);}catch(error){this.catalog.close();throw error;}
      const rows = this.catalog.prepare('SELECT id,path,source_path,relative_path FROM documents WHERE relative_path IS NOT NULL').all() as Array<{ id: string; path: string; source_path: string | null; relative_path: string }>;
      const update = this.catalog.prepare('UPDATE documents SET path=?,source_path=? WHERE id=?');
      for (const row of rows) {
        const path = resolve(this.directoryRoot, row.relative_path);
        const rel = relative(this.directoryRoot, path);
        if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('Invalid stored source path.');
        if (row.path !== path || row.source_path !== path) update.run(path, path, row.id);
      }
      // Keep the current directory-index schema and committed passages unchanged.
      this.catalog.exec('PRAGMA user_version=6');
    }
  }

  /** Releases both handles so the same process can reopen the library from a different directory. */
  private readonly work = new WorkScope();
  get interrupted(): boolean { return this.work.signal.aborted; }
  interrupt(): void { this.work.cancel(); }
  resume(): void { this.work.resume(); }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.interrupt();
    await this.writes.catch(() => {});
    await this.work.drain();
    await this.opening?.catch(() => {});
    this.db?.close();
    this.db = undefined;
    this.opening = undefined;
    this.catalog.close();
  }

  assertTag(tagId: string): void {
    if (tagId !== DEFAULT_TAG && !/^[a-f\d-]{36}$/i.test(tagId)) throw new Error('Invalid tag ID.');
    if (tagId !== DEFAULT_TAG && !this.catalog.prepare('SELECT 1 FROM tags WHERE id = ?').get(tagId)) throw new Error('Tag no longer exists.');
  }
  private async connection(): Promise<lancedb.Connection> {
    if (this.db) return this.db;
    if (!this.opening) this.opening = (async () => {
      const sdk = await loadLanceDB(this.cachePath, this.progress);
      await mkdir(this.root, { recursive: true });
      const db = await sdk.connect(join(this.root, 'vectors.lance'));
      this.db = db;
      return db;
    })().catch((error: unknown) => { this.opening = undefined; throw error; });
    return this.opening;
  }
  private hasColumn(table: string, column: string): boolean {
    const columns = this.catalog.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return columns.some((entry) => entry.name === column);
  }
  private async table(): Promise<lancedb.Table | undefined> {
    const db = await this.connection();
    const name = PASSAGES_TABLE;
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
  async summary(catalogOnly = false): Promise<{ documents: number; lastIndexedAt: number | null; tags: TagSummary[] }> {
    if (!catalogOnly) await this.writes;
    this.work.signal.throwIfAborted();
    const { documents, lastIndexedAt } = this.catalog.prepare('SELECT COUNT(*) AS documents, MAX(indexed_at) AS lastIndexedAt FROM documents').get() as { documents: number; lastIndexedAt: number | null };
    return { documents, lastIndexedAt, tags: [{ id: DEFAULT_TAG, name: '', count: this.uncategorizedCount() }, ...this.tagRows()] };
  }
  catalogOverview(hideUnsupported=false) {
    this.work.signal.throwIfAborted();this.catalog.exec('SAVEPOINT catalog_overview');
    try{const result={catalogVersion:this.sourceCatalog.version,tags:[{id:DEFAULT_TAG,name:'',count:this.uncategorizedCount()},...this.tagRows()],directories:this.sourceCatalog.directories(hideUnsupported),issuesTotal:this.sourceCatalog.countIssues(hideUnsupported)};
      this.catalog.exec('RELEASE catalog_overview');return result;
    }catch(error){this.catalog.exec('ROLLBACK TO catalog_overview; RELEASE catalog_overview');throw error;}
  }
  async tags(catalogOnly = false): Promise<TagSummary[]> {
    if (!catalogOnly) await this.writes;
    this.work.signal.throwIfAborted();
    return [{ id: DEFAULT_TAG, name: '', count: this.uncategorizedCount() }, ...this.tagRows()];
  }
  /**
   * The user's own tags in the order they arranged them. The two fixed rows — All sources and
   * Unclassified — are not stored here at all; they are pinned by the callers.
   */
  private tagRows(): TagSummary[] {
    return this.sourceCatalog.tagRows() as unknown as TagSummary[];
  }
  /** Every document's tags in one pass, keyed by document id. */
  private tagsFor(ids: string[]): Map<string, string[]> {
    const map = new Map<string, string[]>();
    if (!ids.length) return map;
    const rows: Array<{document_id:string;tag_id:string}> = [];
    for(let offset=0;offset<ids.length;offset+=500){const batch=ids.slice(offset,offset+500);rows.push(...this.catalog.prepare(`SELECT document_id,tag_id FROM document_tags WHERE document_id IN (${batch.map(()=>'?').join(',')})`).all(...batch) as Array<{document_id:string;tag_id:string}>);}
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
    return this.sourceCatalog.uncategorizedCount();
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
  async setTagColor(id: string, color: string): Promise<void> {
    if ((!/^#[0-9a-f]{6}$/i.test(color) && !(TAG_COLORS as readonly string[]).includes(color)) || id === DEFAULT_TAG) throw new Error('Invalid tag color.');
    color = color.toLowerCase();
    await this.locked(async () => {
      this.assertTag(id);
      this.catalog.prepare('UPDATE tags SET color = ? WHERE id = ?').run(color, id);
    });
  }
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
  /** Tags are catalogue metadata; vector passages are never copied or moved. */
  async addTag(id: string, tagId: string): Promise<void> {
    if (!/^[a-f\d-]{36}$/i.test(id)) throw new Error('Invalid document ID.');
    await this.locked(async () => {
      this.assertTag(tagId);
      if (tagId === DEFAULT_TAG) return;
      const doc = this.needDocument(id);
      if (doc.tags.includes(tagId)) return;
      this.linkTags(id, [tagId]);
    });
  }
  /** Removing the last tag leaves the document unclassified. */
  async removeTag(id: string, tagId: string): Promise<void> {
    if (!/^[a-f\d-]{36}$/i.test(id)) throw new Error('Invalid document ID.');
    await this.locked(async () => {
      const doc = this.needDocument(id);
      if (!doc.tags.includes(tagId)) return;
      this.unlinkTags(id, [tagId]);
    });
  }
  /** Replaces every tag at once; an empty list means Unclassified. */
  async setTags(id: string, tagIds: string[]): Promise<void> {
    if (!/^[a-f\d-]{36}$/i.test(id)) throw new Error('Invalid document ID.');
    const wanted = [...new Set(tagIds.filter((tagId) => tagId && tagId !== DEFAULT_TAG))];
    for (const tagId of wanted) this.assertTag(tagId);
    await this.locked(async () => {
      this.needDocument(id);
      this.catalog.exec('BEGIN');
      try {
        this.catalog.prepare('DELETE FROM document_tags WHERE document_id = ?').run(id);
        this.linkTags(id, wanted);
        this.catalog.exec('COMMIT');
      } catch (error) { this.catalog.exec('ROLLBACK'); throw error; }
    });
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

  async list(catalogOnly = false): Promise<DocumentSummary[]> {
    if (!catalogOnly) await this.writes;
    this.work.signal.throwIfAborted();
    return this.hydrate(this.catalog.prepare('SELECT * FROM documents ORDER BY indexed_at DESC').all() as unknown as DocumentSummary[]);
  }
  private fileKey(path: string): string { return process.platform === 'win32' ? path.toLowerCase() : path; }
  private relativeFile(path: string): string { return relative(this.directoryRoot, path).split(sep).join('/'); }
  /** Directory-access notices are not files and must never inflate file totals. */
  private fileIssues(): SourceIssue[] {
    const folders = new Set((this.catalog.prepare('SELECT path FROM source_folders').all() as Array<{ path: string }>).map(row => this.fileKey(row.path)));
    const files = new Map<string, SourceIssue>();
    for (const issue of this.catalog.prepare('SELECT path,kind,reason FROM source_issues').all() as unknown as SourceIssue[]) {
      if (issue.path !== '' && !folders.has(this.fileKey(issue.path))) files.set(this.fileKey(issue.path), issue);
    }
    return [...files.values()];
  }
  private filePaths(includeIssues = false, hideUnsupported = false): string[] {
    const paths = new Map<string, string>();
    for (const row of this.catalog.prepare('SELECT path FROM documents').all() as Array<{ path: string }>) {
      const path = this.relativeFile(row.path); paths.set(this.fileKey(path), path);
    }
    for (const issue of this.fileIssues()) {
      const key = this.fileKey(issue.path);
      if ((!includeIssues && issue.kind !== 'pending') || (hideUnsupported && issue.kind === 'unsupported')) paths.delete(key);
      else if (!paths.has(key)) paths.set(key, issue.path);
    }
    return [...paths.values()];
  }
  async fileCount(hideUnsupported = false, catalogOnly = false): Promise<number> { if (!catalogOnly) await this.writes; this.work.signal.throwIfAborted(); return this.sourceCatalog.countFiles(hideUnsupported); }
  async directories(hideUnsupported = false, catalogOnly = false) {
    if (!catalogOnly) await this.writes;
    this.work.signal.throwIfAborted();
    return this.sourceCatalog.directories(hideUnsupported) as unknown as Array<{path:string;parent:string|null;name:string;count:number}>;
  }
  private async browseOrder(sort: DocumentSort, directory: string | null, descending?: boolean, refresh = false, tagId: string | null = null, hideUnsupported = false, catalogOnly = false): Promise<Array<DocumentSummary | SourceIssueDocument>> {
    if (!catalogOnly) await this.writes;
    this.work.signal.throwIfAborted();
    if (directory !== null) directoryKey(directory);
    const files = new Map<string, DocumentSummary | SourceIssueDocument>();
    const issues = this.fileIssues();
    const allSources = directory === null && tagId === null;
    const excluded = new Set(issues.filter(issue => issue.kind !== 'pending').map(issue => this.fileKey(issue.path)));
    const hidden = new Set(hideUnsupported ? issues.filter(issue => issue.kind === 'unsupported').map(issue => this.fileKey(issue.path)) : []);
    if (tagId !== null) this.assertTag(tagId);
    const scope = this.scopeFor(tagId, directory);
    for (const doc of this.catalog.prepare(`SELECT d.* FROM documents d ${scope.from} ${scope.where}`).all(...scope.params) as unknown as DocumentSummary[]) {
      const key = this.fileKey(this.relativeFile(doc.path));
      if ((allSources && !hidden.has(key)) || !excluded.has(key)) files.set(key, doc);
    }
    if (tagId === null) for (const issue of issues) {
      const key = this.fileKey(issue.path);
      if (allSources && issue.kind !== 'pending' && !(hideUnsupported && issue.kind === 'unsupported')) files.set(key, this.issueDocument(issue));
      else if (issue.kind === 'pending' && !files.has(key)) files.set(key, this.issueDocument(issue));
    }
    const rows = [...files.values()].filter(doc => insideDirectory(this.relativeFile(doc.path), directory));
    if (metadataSort(sort)) {
      if (catalogOnly) { this.applyCachedMetadata(rows); return this.orderKnownMetadata(rows, sort, descending); }
      return this.orderMetadata(rows, sort, descending, refresh) as Promise<Array<DocumentSummary | SourceIssueDocument>>;
    }
    const reverse = descending ?? sort !== 'name';
    return rows.sort((a, b) => {
      const comparison = sort === 'name' ? compareNames(a.name, b.name)
        : (sort === 'added' ? a.added_at - b.added_at : a.indexed_at - b.indexed_at);
      return (reverse ? -comparison : comparison) || a.id.localeCompare(b.id);
    });
  }
  /** All sources includes exceptions once per path; folders and tags show normal sources only. */
  private catalogDocuments(rows: CatalogRow[], indexedOnly = false): Array<DocumentSummary | SourceIssueDocument> {
    return rows.map(row => {
      const path = resolve(this.directoryRoot, row.relative_path);
      const doc: DocumentSummary | SourceIssueDocument = !indexedOnly && (!row.doc_id || (row.issue_kind && row.issue_kind !== 'pending'))
        ? this.issueDocument({path:row.relative_path,kind:row.issue_kind ?? 'pending',reason:row.reason})
        : {id:row.doc_id!,path,name:row.document_name??basename(path),hash:row.hash??'',tags:[],added_at:row.added_at,indexed_at:row.indexed_at,chunks:row.chunks??0,source_path:path};
      return {...doc,file_id:row.file_id,source_revision:row.revision,size_bytes:row.size_bytes,modified_at:row.modified_at,file_type:row.type_key};
    });
  }
  private async catalogPage(scope: CatalogScope, sort: DocumentSort, descending: boolean | undefined,
    options: Parameters<SourceCatalog['page']>[3], catalogOnly: boolean) {
    this.work.signal.throwIfAborted();
    if (scope.tagId != null) this.assertTag(scope.tagId);
    const page = this.sourceCatalog.page(scope,sort,descending,options);
    const documents = this.catalogDocuments(page.rows,scope.indexedOnly);
    void catalogOnly; // Every catalogue page is SQL-only, including legacy callers.
    const {rows,...info}=page;
    return {...info,documents:this.hydrate(documents) as Array<DocumentSummary | SourceIssueDocument>};
  }
  async browsePage(tagId: string | null, sort: DocumentSort, offset: number, limit = 50, directory: string | null = null, descending?: boolean, hideUnsupported = false, catalogOnly = false, cursor?:string, before=false) {
    return this.catalogPage({tagId,directory,hideUnsupported},sort,descending,{offset,limit,cursor,before},catalogOnly);
  }
  async browsePosition(id: string, tagId: string | null, sort: DocumentSort, directory: string | null = null, descending?: boolean, hideUnsupported = false, catalogOnly = false): Promise<number | null> {
    if (!catalogOnly) await this.writes;
    this.work.signal.throwIfAborted();
    if (tagId!==null) this.assertTag(tagId);
    return this.sourceCatalog.position(id,{tagId,directory,hideUnsupported},sort,descending);
  }

  private async scanIdentity(expected: {dev:bigint;ino:bigint}, signal?:AbortSignal): Promise<void> {
    const combined=signal?AbortSignal.any([signal,this.work.signal]):this.work.signal;
    combined.throwIfAborted();
    await interruptible(this.assertSourceAvailable(),combined);
    const current=await this.work.run(stat(this.directoryRoot,{bigint:true}),combined);
    if(!current.isDirectory()||current.dev!==expected.dev||current.ino!==expected.ino)throw new Error('The source directory identity changed during discovery.');
  }
  private readonly scanDirectories=new Map<string,Map<string,{dev:bigint;ino:bigint}>>();
  async beginSourceScan(expected:{dev:bigint;ino:bigint},signal?:AbortSignal):Promise<string>{
    await this.scanIdentity(expected,signal);
    const id=randomUUID();this.scanDirectories.clear();this.scanDirectories.set(id,new Map([['',expected]]));
    this.catalog.exec('BEGIN IMMEDIATE');
    try{
      this.catalog.prepare("UPDATE source_scan_runs SET state='interrupted',finished_at=? WHERE state='running'").run(Date.now());
      this.catalog.prepare('INSERT INTO source_scan_runs(id,root_dev,root_ino,state,started_at) VALUES(?,?,?,?,?)').run(id,String(expected.dev),String(expected.ino),'running',Date.now());
      this.catalog.exec('COMMIT');
    }catch(error){this.catalog.exec('ROLLBACK');throw error;}
    return id;
  }
  assertScan(id:string):void{
    this.work.signal.throwIfAborted();
    if(!(this.catalog.prepare("SELECT 1 FROM source_scan_runs WHERE id=? AND state='running'").get(id)))throw new Error('Source discovery was superseded by another scan.');
  }
  /** Bounded, engine-free short transactions, deliberately independent of content writes. */
  async discoverSourceBatch(id:string,folders:string[],files:Array<{path:string;kind:'pending'|'unsupported'}>,expected:{dev:bigint;ino:bigint},signal?:AbortSignal):Promise<void>{
    await this.scanIdentity(expected,signal);this.assertScan(id);signal?.throwIfAborted();
    this.catalog.exec('BEGIN IMMEDIATE');
    try{
      const folder=this.catalog.prepare('INSERT INTO source_folders(path) VALUES(?) ON CONFLICT(path) DO NOTHING');
      for(const path of folders){const canonical=this.fileKey(directoryKey(path));folder.run(canonical);this.catalog.prepare('UPDATE source_directories SET name=? WHERE path=?').run(path.split('/').at(-1)!,canonical);}
      const issue=this.catalog.prepare(`INSERT INTO source_issues(path,kind,reason) SELECT ?,?,'' WHERE ?='unsupported'
        OR (NOT EXISTS(SELECT 1 FROM documents WHERE source_key=?) AND NOT EXISTS(SELECT 1 FROM source_issues WHERE catalog_key(path)=?))
        ON CONFLICT(path) DO UPDATE SET kind=excluded.kind,reason='' WHERE excluded.kind='unsupported' AND source_issues.kind<>'unsupported'`);
      const seen=this.catalog.prepare('UPDATE source_files SET last_seen=? WHERE path_key=?');
      for(const file of files){const path=directoryKey(file.path),key=this.fileKey(path);issue.run(key,file.kind,file.kind,key,key);seen.run(id,key);this.catalog.prepare('UPDATE source_files SET relative_path=? WHERE path_key=? AND doc_id IS NULL AND relative_path IS NOT ?').run(path,key,path);}
      this.catalog.prepare('UPDATE source_scan_runs SET discovered=discovered+? WHERE id=?').run(files.length,id);
      this.catalog.exec('COMMIT');
    }catch(error){this.catalog.exec('ROLLBACK');throw error;}
  }
  async recordScanMetadata(id:string,entries:Array<{path:string;size:number;mtimeMs:number}>,expected:{dev:bigint;ino:bigint},signal?:AbortSignal):Promise<void>{
    if(!entries.length)return;
    if(entries.length>200)throw new Error('Source metadata batches are limited to 200 files.');
    await this.scanIdentity(expected,signal);this.assertScan(id);signal?.throwIfAborted();
    this.catalog.exec('BEGIN IMMEDIATE');
    try{
      const found=this.catalog.prepare('SELECT 1 FROM source_files WHERE path_key=? AND last_seen=?');
      for(const entry of entries){const path=directoryKey(entry.path);if(found.get(this.fileKey(path),id))this.rememberMetadata({path:resolve(this.directoryRoot,path)} as DocumentSummary,entry);}
      this.catalog.exec('COMMIT');
    }catch(error){this.catalog.exec('ROLLBACK');throw error;}
  }
  recordScanDirectory(id:string,path:string,complete:boolean,identity?:{dev:bigint;ino:bigint}):void{
    this.assertScan(id);if(path)directoryKey(path);
    if(complete&&identity)this.scanDirectories.get(id)?.set(this.fileKey(path),identity);
    else if(!complete)this.scanDirectories.get(id)?.delete(this.fileKey(path));
    this.catalog.prepare('INSERT INTO source_scan_directories(run_id,path,complete) VALUES(?,?,?) ON CONFLICT(run_id,path) DO UPDATE SET complete=excluded.complete').run(id,this.fileKey(path),complete?1:0);
    if(!complete)this.catalog.prepare("INSERT INTO source_issues(path,kind,reason) VALUES(?,'unavailable','') ON CONFLICT(path) DO UPDATE SET kind='unavailable',reason=''").run(this.fileKey(path));
    else this.catalog.prepare("DELETE FROM source_issues WHERE catalog_key(path)=? AND kind='unavailable' AND EXISTS(SELECT 1 FROM source_folders WHERE catalog_key(path)=?)").run(this.fileKey(path),this.fileKey(path));
  }
  async finishSourceScan(id:string,blocked:string[],expected:{dev:bigint;ino:bigint},signal?:AbortSignal):Promise<void>{
    await this.scanIdentity(expected,signal);this.assertScan(id);signal?.throwIfAborted();
    if(!this.catalog.prepare('SELECT 1 FROM source_scan_directories WHERE run_id=? AND path=? AND complete=1').get(id,''))throw new Error('Root discovery did not complete; previous catalogue entries are retained.');
    const paths=JSON.stringify(blocked.map(path=>this.fileKey(path?directoryKey(path):'')));
    const safe=(column:string)=>`NOT EXISTS(SELECT 1 FROM json_each(?) b WHERE b.value='' OR ${column}=b.value OR (${column}>=b.value||'/' AND ${column}<b.value||'0'))`;
    // Recheck unseen candidates outside transactions. A file created again after enumeration
    // must retain its old row; deletion also uses its captured revision as a compare-and-swap.
    let after='';
    while(!signal?.aborted){
      this.assertScan(id);
      const batch=this.catalog.prepare(`SELECT file_id,path_key,relative_path,revision FROM source_files WHERE last_seen IS NOT ? AND path_key>? AND ${safe('path_key')} ORDER BY path_key LIMIT 200`).all(id,after,paths) as Array<{file_id:string;path_key:string;relative_path:string;revision:number}>;
      if(!batch.length)break;
      after=batch.at(-1)!.path_key;
      const absent=[];
      for(const row of batch){
        signal?.throwIfAborted();
        try{await this.work.run(lstat(resolve(this.directoryRoot,row.relative_path)),signal);}catch(error){if(['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??'')){
          let parent=dirname(resolve(this.directoryRoot,row.relative_path));
          while(true){
            const rel=relative(this.directoryRoot,parent);if(rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))break;
            const info=await this.work.run(lstat(parent,{bigint:true}),signal).catch((error:NodeJS.ErrnoException)=>['ENOENT','ENOTDIR'].includes(error.code??'')?null:undefined);
            if(info===undefined)break;
            if(info){const captured=this.scanDirectories.get(id)?.get(this.fileKey(rel.split(sep).join('/')));if(info.isDirectory()&&!info.isSymbolicLink()&&captured&&captured.dev===info.dev&&captured.ino===info.ino)absent.push(row);break;}
            if(parent===this.directoryRoot)break;parent=dirname(parent);
          }
        }else signal?.throwIfAborted();}
      }
      await this.scanIdentity(expected,signal);this.assertScan(id);signal?.throwIfAborted();
      this.catalog.exec('BEGIN IMMEDIATE');
      try{const remove=this.catalog.prepare(`DELETE FROM source_issues WHERE catalog_key(path) IN(SELECT path_key FROM source_files WHERE file_id=? AND revision=? AND last_seen IS NOT ?)`);
        for(const row of absent)remove.run(row.file_id,row.revision,id);
        this.catalog.exec('COMMIT');
      }catch(error){this.catalog.exec('ROLLBACK');throw error;}
      await new Promise<void>(done=>setImmediate(done));
    }
    await this.scanIdentity(expected,signal);this.assertScan(id);signal?.throwIfAborted();
    this.catalog.exec('BEGIN IMMEDIATE');
    try{
      this.catalog.prepare(`DELETE FROM source_folders WHERE NOT EXISTS(SELECT 1 FROM source_scan_directories sd WHERE sd.run_id=? AND sd.path=catalog_key(source_folders.path)) AND ${safe('catalog_key(source_folders.path)')}`).run(id,paths);
      this.catalog.prepare("UPDATE source_scan_runs SET state=?,finished_at=? WHERE id=?").run(blocked.length?'partial':'completed',Date.now(),id);
      this.catalog.exec('COMMIT');
    }catch(error){this.catalog.exec('ROLLBACK');throw error;}
  }
  interruptSourceScan(id:string):void{
    this.scanDirectories.delete(id);
    if(!this.closed)this.catalog.prepare("UPDATE source_scan_runs SET state='interrupted',finished_at=? WHERE id=? AND state='running'").run(Date.now(),id);
  }

  /** Commit a completed scan inventory; unreadable subtrees retain their last known contents. */
  async replaceSourceInventory(folders: string[], issues: SourceIssue[], blocked: string[], expected: { dev: bigint; ino: bigint }, signal?: AbortSignal): Promise<void> {
    await this.locked(async () => {
      await this.assertSourceAvailable();
      const current = await stat(this.directoryRoot, { bigint: true }).catch(() => null);
      if (signal?.aborted || !current?.isDirectory() || current.dev !== expected.dev || current.ino !== expected.ino) return;
      const clean = (path: string) => path === '' ? '' : directoryKey(path);
      const unavailable = blocked.map(clean);
      const retained = (path: string) => unavailable.some(parent => parent === '' || path === parent || path.startsWith(`${parent}/`));
      const previousFolders = this.catalog.prepare('SELECT path FROM source_folders').all() as Array<{ path: string }>;
      const previousIssues = this.catalog.prepare('SELECT path,kind,reason FROM source_issues').all() as unknown as SourceIssue[];
      const nextFolders = new Set(previousFolders.filter(row => retained(row.path)).map(row => row.path));
      for (const folder of folders) if (folder) nextFolders.add(clean(folder));
      const nextIssues = new Map(previousIssues.filter(row => retained(row.path)).map(row => [row.path, row]));
      for (const issue of issues) { const path=this.fileKey(clean(issue.path)); nextIssues.set(path, { ...issue,path,reason:issue.reason.slice(0,1000) }); }
      this.catalog.exec('BEGIN IMMEDIATE');
      try {
        this.catalog.exec('DELETE FROM source_folders; DELETE FROM source_issues;');
        const folderInsert = this.catalog.prepare('INSERT INTO source_folders(path) VALUES(?)');
        const issueInsert = this.catalog.prepare('INSERT INTO source_issues(path,kind,reason) VALUES(?,?,?)');
        for (const path of nextFolders) folderInsert.run(path);
        for (const issue of nextIssues.values()) issueInsert.run(issue.path, issue.kind, issue.reason);
        this.catalog.exec('COMMIT');
      } catch (error) { this.catalog.exec('ROLLBACK'); throw error; }
    });
  }
  /** Checkpoint one completed file without replacing unrelated or still-queued inventory. */
  async settleSourceFile(path: string, issue: SourceIssue | null, expected: { dev: bigint; ino: bigint }): Promise<boolean> {
    return this.locked(async () => {
      await this.assertSourceAvailable();
      const current = await stat(this.directoryRoot, { bigint: true }).catch(() => null);
      if (!current?.isDirectory() || current.dev !== expected.dev || current.ino !== expected.ino) return false;
      path = this.fileKey(directoryKey(path));
      if (issue) this.catalog.prepare('INSERT OR REPLACE INTO source_issues(path,kind,reason) VALUES(?,?,?)').run(path, issue.kind, issue.reason.slice(0, 1000));
      else this.catalog.prepare('DELETE FROM source_issues WHERE path=?').run(path);
      return true;
    });
  }
  async issueCount(hideUnsupported = false, catalogOnly = false): Promise<number> {
    if (!catalogOnly) await this.writes;
    this.work.signal.throwIfAborted();
    return this.sourceCatalog.countIssues(hideUnsupported);
  }
  private issueDocument(issue: SourceIssue): SourceIssueDocument {
    const path = issue.path ? resolve(this.directoryRoot, directoryKey(issue.path)) : this.directoryRoot;
    return { id: `issue:${issue.path}`, path, name: basename(path), hash: '', tags: [], added_at: 0, indexed_at: 0,
      chunks: 0, source_path: path, issueKind: issue.kind, statusReason: issue.reason };
  }
  async sourceIssue(id: string, catalogOnly = false): Promise<SourceIssueDocument | undefined> {
    if (!catalogOnly) await this.writes;
    this.work.signal.throwIfAborted();
    if (!id.startsWith('issue:')) return;
    const path = id.slice(6); if (path) directoryKey(path);
    const issue = this.catalog.prepare('SELECT path,kind,reason FROM source_issues WHERE path=?').get(path) as SourceIssue | undefined;
    return issue ? this.issueDocument(issue) : undefined;
  }
  async issuePage(sort: DocumentSort, offset: number, directory: string | null = null, descending?: boolean, hideUnsupported = false, catalogOnly = false, cursor?:string, before=false) {
    const page=await this.catalogPage({issues:true,directory,hideUnsupported},sort,descending,{offset,cursor,before},catalogOnly);
    return {...page,documents:page.documents as SourceIssueDocument[]};
  }
  /** Refresh a bounded loaded window around a physical path, including pending-to-indexed ID changes. */
  async browseWindow(tagId: string | null, sort: DocumentSort, directory: string | null, descending: boolean | undefined,
    options: { issues?: boolean; hideUnsupported?: boolean; catalogOnly?: boolean; anchorPath?: string; anchorIndex?: number; offset?: number; limit?: number } = {}) {
    return this.catalogPage({tagId:options.issues?null:tagId,directory,issues:options.issues,hideUnsupported:options.hideUnsupported},sort,descending,
      {...options,limit:Math.max(50,Math.min(500,options.limit??50)),window:true},!!options.catalogOnly);
  }
  async page(tagId: string | null, sort: DocumentSort, offset: number, limit = 50, directory: string | null = null, descending?: boolean): Promise<{ documents: DocumentSummary[]; total: number }> {
    return this.catalogPage({tagId,directory,indexedOnly:true},sort,descending,{offset,limit},false);
  }
  /** Additive SQL metadata cache: browsing never needs to reopen a source file. */
  private applyCachedMetadata(rows: DocumentSummary[]): void {
    if (!rows.length) return;
    const keys = [...new Set(rows.map(doc => this.fileKey(this.relativeFile(doc.path))))];
    const cached = (keys.length <= 500
      ? this.catalog.prepare(`SELECT * FROM source_metadata WHERE path IN (${keys.map(() => '?').join(',')})`).all(...keys)
      : this.catalog.prepare('SELECT * FROM source_metadata').all()) as Array<{ path: string; size_bytes: number | null; modified_at: number | null; file_type: string }>;
    const metadata = new Map(cached.map(row => [row.path, row]));
    for (const doc of rows) {
      const row = metadata.get(this.fileKey(this.relativeFile(doc.path)));
      const extension = extname(doc.path).slice(1).toLowerCase();
      Object.assign(doc, { size_bytes: row?.size_bytes ?? null, modified_at: row?.modified_at ?? null,
        file_type: row?.file_type ?? (({ jpg: 'jpeg', tif: 'tiff', markdown: 'md' } as Record<string, string>)[extension] ?? extension) });
    }
  }
  private rememberMetadata(document: DocumentSummary, info: { size: number; mtimeMs: number } | null, confirmedMissing=false) {
    const extension = extname(document.path).slice(1).toLowerCase();
    const metadata = { expires: Date.now() + 30_000, size_bytes: info?.size ?? null, modified_at: info?.mtimeMs ?? null,
      file_type: ({ jpg: 'jpeg', tif: 'tiff', markdown: 'md' } as Record<string, string>)[extension] ?? extension };
    this.metadataCache.set(document.path, metadata);
    if ((info||confirmedMissing) && !this.closed) {
      try { this.catalog.prepare('INSERT OR REPLACE INTO source_metadata(path,size_bytes,modified_at,file_type) VALUES(?,?,?,?)')
        .run(this.fileKey(this.relativeFile(document.path)), metadata.size_bytes, metadata.modified_at, metadata.file_type); }
      catch { /* A best-effort display cache must not alter source validation or content commits. */ }
      const version=this.catalog.prepare('SELECT file_id,revision AS source_revision FROM source_files WHERE path_key=?').get(this.fileKey(this.relativeFile(document.path)));
      if(version)Object.assign(document,version);
    }
    if (this.metadataCache.size > 50_000) this.metadataCache.delete(this.metadataCache.keys().next().value!);
    Object.assign(document, { size_bytes: metadata.size_bytes, modified_at: metadata.modified_at, file_type: metadata.file_type });
    return metadata;
  }
  async refreshMetadata(documents: DocumentSummary[], signal?: AbortSignal): Promise<DocumentSummary[]> {
    const copies = documents.map(doc => ({ ...doc }));
    await Promise.all(copies.map(doc => this.readMetadata(doc, false, signal)));
    return copies;
  }
  private async readMetadata(document: DocumentSummary, refresh: boolean, callerSignal?: AbortSignal): Promise<void> {
    const signal = callerSignal ? AbortSignal.any([this.work.signal, callerSignal]) : this.work.signal;
    signal.throwIfAborted();
    const cached = this.metadataCache.get(document.path);
    if (!refresh && cached && cached.expires > Date.now()) {
      Object.assign(document, { size_bytes: cached.size_bytes, modified_at: cached.modified_at, file_type: cached.file_type }); return;
    }
    try {
      const { assertSourcePath } = await import('./source-directory.js');
      await interruptible(this.assertSourceAvailable(), signal);
      await this.work.run(assertSourcePath(this.directoryRoot, document.path), signal);
      const info = await this.work.run(stat(document.path), signal); this.rememberMetadata(document, info.isFile() ? info : null);
    } catch { signal.throwIfAborted(); this.rememberMetadata(document, null); }
  }
  private async orderMetadata(rows: DocumentSummary[], sort: DocumentSort, descending?: boolean, refresh = false): Promise<DocumentSummary[]> {
    for (let offset = 0; offset < rows.length; offset += 16) await Promise.all(rows.slice(offset, offset + 16).map(document => this.readMetadata(document, refresh)));
    return this.orderKnownMetadata(rows, sort, descending);
  }
  private orderKnownMetadata(rows: DocumentSummary[], sort: DocumentSort, descending?: boolean): DocumentSummary[] {
    const key = sort === 'size' ? 'size_bytes' : sort === 'modified' ? 'modified_at' : 'file_type';
    const reverse = descending ?? sort !== 'type';
    return rows.sort((a, b) => {
      const first = a[key], second = b[key];
      if (first == null || second == null) return first == null && second == null ? a.id.localeCompare(b.id) : first == null ? 1 : -1;
      const comparison = typeof first === 'number' && typeof second === 'number' ? first - second : compareNames(String(first), String(second));
      return (reverse ? -comparison : comparison) || a.id.localeCompare(b.id);
    });
  }
  /** Verify source freshness and committed passage coverage with bounded disk concurrency. */
  async indexStatus(documents: DocumentSummary[], callerSignal?: AbortSignal): Promise<DocumentStatus[]> {
    if (!documents.length) return [];
    const signal = callerSignal ? AbortSignal.any([this.work.signal, callerSignal]) : this.work.signal;
    signal.throwIfAborted();
    await interruptible(this.writes, signal);
    let table: lancedb.Table | undefined;
    let available = true;
    try { table = await this.work.run(this.table(), signal); } catch { signal.throwIfAborted(); available = false; }
    const statuses: DocumentStatus[] = [];
    for (let offset = 0; offset < documents.length; offset += 4) {
      statuses.push(...await Promise.all(documents.slice(offset, offset + 4).map(async document => {
        let indexState: CoverageState = 'unavailable';
        let indexedChunks: number | null = null;
        if (available) {
          try {
            const id = document.id.replaceAll("'", "''"), hash = document.hash.replaceAll("'", "''");
            indexedChunks = table ? await this.work.run(table.countRows(`document_id = '${id}' AND hash = '${hash}'`), signal) : 0;
            indexState = indexedChunks === 0 ? 'missing' : indexedChunks === document.chunks && document.chunks > 0 ? 'indexed' : 'partial';
          } catch { signal.throwIfAborted(); /* Unknown coverage must never be presented as ready. */ }
        }
        const sourceState = await this.checkSource(document, signal);
        signal.throwIfAborted();
        const failure = this.catalog.prepare('SELECT reason FROM index_failures WHERE path=?').get(this.failurePath(document.path)) as { reason: string } | undefined;
        const attempt = this.processing.has(document.path) ? 'processing' : failure ? 'failed' : undefined;
        return { ...document, indexState, indexedChunks, sourceState,
          status: resolveDocumentStatus(indexState, sourceState, attempt), ...(failure ? { statusReason: failure.reason } : {}) };
      })));
    }
    return statuses;
  }

  async statusForPath(path: string): Promise<DocumentStatus | undefined> {
    await this.writes;
    this.work.signal.throwIfAborted();
    const document = this.catalog.prepare('SELECT * FROM documents WHERE path=?').get(path) as DocumentSummary | undefined;
    return document ? (await this.indexStatus(this.hydrate([document])))[0] : undefined;
  }

  private failurePath(path: string): string { return relative(this.directoryRoot, path); }

  private async checkSource(document: DocumentSummary, signal = this.work.signal): Promise<SourceState> {
    signal.throwIfAborted();
    const path = document.source_path ?? document.path;
    try {
      const { assertSourcePath } = await import('./source-directory.js');
      await this.work.run(assertSourcePath(this.directoryRoot, path), signal);
      const before = await this.work.run(stat(path), signal);
      this.rememberMetadata(document, before.isFile() ? before : null);
      if (!before.isFile() || before.size > MAX_FILE_BYTES) return 'unavailable';
      const stamp = `${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
      let cached = this.sourceChecks.get(path);
      if (cached?.stamp !== stamp) {
        const hash = await hashFile(path, signal);
        const after = await this.work.run(stat(path), signal);
        if (`${after.size}:${after.mtimeMs}:${after.ctimeMs}` !== stamp) return 'changed';
        cached = { stamp, hash };
        this.sourceChecks.set(path, cached);
      }
      return cached.hash === document.hash ? 'same' : 'changed';
    } catch (error) {
      signal.throwIfAborted();
      this.rememberMetadata(document, null);
      const code = (error as NodeJS.ErrnoException).code;
      if ((code === 'ENOENT' || code === 'ENOTDIR') && (await stat(dirname(path)).catch(() => null))?.isDirectory()) {
        try{await interruptible(this.assertSourceAvailable(),signal);this.rememberMetadata(document,null,true);}catch{signal.throwIfAborted();return 'unavailable';}
        return 'missing';
      }
      return 'unavailable';
    }
  }
  async position(id: string, tagId: string | null, sort: DocumentSort, directory: string | null = null, descending?: boolean): Promise<number | null> {
    this.work.signal.throwIfAborted();
    if(tagId!==null)this.assertTag(tagId);
    return this.sourceCatalog.position(id,{tagId,directory,indexedOnly:true},sort,descending);
  }
  async document(id: string, catalogOnly = false): Promise<DocumentSummary | undefined> {
    if (!catalogOnly) await this.writes;
    this.work.signal.throwIfAborted();
    const row = this.catalog.prepare('SELECT d.*,f.file_id,f.revision AS source_revision FROM documents d LEFT JOIN source_files f ON f.doc_id=d.id WHERE d.id=?').get(id) as DocumentSummary | undefined;
    return row ? this.hydrate([row])[0] : undefined;
  }
  /** How one tag narrows a document query: Unclassified is the absence of any link. */
  private scopeFor(tagId: string | null, directory: string | null = null): { from: string; where: string; params: Array<string | number> } {
    const clauses: string[] = [], params: Array<string | number> = [];
    if (tagId === DEFAULT_TAG) clauses.push('NOT EXISTS (SELECT 1 FROM document_tags dt WHERE dt.document_id = d.id)');
    else if (tagId !== null) { clauses.push('dt.tag_id = ?'); params.push(tagId); }
    if (directory !== null) {
      const prefix = `${directoryKey(directory)}/`;
      const path = sep === '\\' ? "replace(COALESCE(d.relative_path,d.name), char(92), '/')" : 'COALESCE(d.relative_path,d.name)';
      clauses.push(`substr(${path},1,?) = ?`);
      params.push(Array.from(prefix).length, prefix);
    }
    return { from: tagId !== null && tagId !== DEFAULT_TAG ? 'JOIN document_tags dt ON dt.document_id = d.id' : '', where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }
  /** Index a source in place; no managed copy or alternate storage mode exists. */
  async importFile(path: string, displayName = basename(path), tagId = DEFAULT_TAG, signal?: AbortSignal): Promise<{ document: DocumentSummary; unchanged: boolean }> {
    const combined = signal ? AbortSignal.any([signal, this.work.signal]) : this.work.signal;
    return this.trackedDirectoryFile(path, displayName, tagId, combined);
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
        this.unlinkTags(row.document_id, [id]);
      }
      this.catalog.prepare('DELETE FROM tags WHERE id = ?').run(id);
      return { affected: documents.length, orphaned };
    });
  }

  /** Remove only catalogue/vector entries after a scan confirms the source is missing. */
  async remove(id: string): Promise<boolean> {
    if (!/^[a-f\d-]{36}$/i.test(id)) throw new Error('Invalid document ID.');
    return this.removeDirectoryDocument(id);
  }

  /** Follow a uniquely identifiable move reported by a complete source scan, without copying files. */
  async relocateSource(path: string, missingIds: string[], signal = this.work.signal): Promise<string | null> {
    signal.throwIfAborted();
    if (!missingIds.length) return null;
    const { assertSourcePath } = await import('./source-directory.js');
    path = await assertSourcePath(this.directoryRoot, path);
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    const hash = await hashFile(path, signal), allowed = new Set(missingIds);
    signal.throwIfAborted();
    const candidates = (this.catalog.prepare('SELECT * FROM documents WHERE hash=?').all(hash) as unknown as DocumentSummary[])
      .filter(doc => allowed.has(doc.id) && basename(doc.path) === basename(path));
    // Equal copies are ambiguous: never assign one file another file's identity or tags.
    if (candidates.length !== 1) return null;
    const candidate = candidates[0]!;
    return this.locked(async () => {
      signal.throwIfAborted();
      const current = this.catalog.prepare('SELECT * FROM documents WHERE id=?').get(candidate.id) as DocumentSummary | undefined;
      if (!current || current.path !== candidate.path || current.hash !== hash) return null;
      const duplicate = this.catalog.prepare('SELECT * FROM documents WHERE path=?').get(path) as DocumentSummary | undefined;
      if (duplicate && duplicate.hash !== hash) return null;
      try { await lstat(current.path); return null; }
      catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null; }
      this.catalog.exec('BEGIN');
      try {
        if (duplicate) {
          this.linkTags(current.id, this.currentTags(duplicate.id));
          this.catalog.prepare('DELETE FROM document_tags WHERE document_id=?').run(duplicate.id);
          this.catalog.prepare('DELETE FROM documents WHERE id=?').run(duplicate.id);
        }
        this.catalog.prepare('UPDATE documents SET path=?,source_path=?,relative_path=?,name=?,source_key=? WHERE id=?')
          .run(path, path, relative(this.directoryRoot, path), relative(this.directoryRoot, path), this.fileKey(this.relativeFile(path)), current.id);
        this.catalog.prepare('DELETE FROM index_failures WHERE path=?').run(this.failurePath(current.path));
        this.catalog.exec('COMMIT');
      } catch (error) { this.catalog.exec('ROLLBACK'); throw error; }
      this.sourceChecks.delete(current.path); this.sourceChecks.delete(path);
      if (duplicate) {
        const table = await this.table().catch(() => undefined);
        await table?.delete(`document_id = '${duplicate.id}'`).catch(() => {});
      }
      return current.id;
    });
  }

  private async trackedDirectoryFile(path: string, displayName: string, tagId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    await this.work.run(this.assertSourceAvailable(), signal);
    signal.throwIfAborted();
    const { assertSourcePath } = await import('./source-directory.js');
    path = await this.work.run(assertSourcePath(this.directoryRoot, path), signal);
    signal.throwIfAborted();
    this.processing.set(path, (this.processing.get(path) ?? 0) + 1);
    this.notifyStatus(path, 'processing');
    try {
      const result = await this.indexDirectoryFile(path, displayName, tagId, signal);
      this.catalog.prepare('DELETE FROM index_failures WHERE path=?').run(this.failurePath(path));
      return result;
    } catch (error) {
      if (signal.aborted) throw error;
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      if (error instanceof IndexSkipError) this.catalog.prepare('DELETE FROM index_failures WHERE path=?').run(this.failurePath(path));
      else this.catalog.prepare('INSERT OR REPLACE INTO index_failures(path,reason) VALUES(?,?)').run(this.failurePath(path), reason);
      throw error;
    } finally {
      const remaining = (this.processing.get(path) ?? 1) - 1;
      if (remaining) this.processing.set(path, remaining); else this.processing.delete(path);
      this.sourceChecks.delete(path);
      this.notifyStatus(path, 'settled');
    }
  }

  private notifyStatus(path: string, phase: 'processing' | 'settled'): void {
    try { this.onStatusChange?.(path, phase); } catch { /* Observers must not change indexing results. */ }
  }

  private async indexDirectoryFile(path: string, displayName: string, tagId: string, signal: AbortSignal): Promise<{ document: DocumentSummary; unchanged: boolean }> {
    signal.throwIfAborted();
    const { assertSourcePath } = await import('./source-directory.js');
    path = await this.work.run(assertSourcePath(this.directoryRoot, path), signal);
    signal.throwIfAborted();
    const extension = extname(path).toLowerCase();
    if (!ACCEPTED.includes(extension)) throw new Error(`Unsupported file type: ${extension}.`);
    this.assertTag(tagId);
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error(SIZE_LIMIT_MESSAGE);
    this.rememberMetadata({ path } as DocumentSummary, info);
    if (info.size === 0) throw new IndexSkipError('empty_file');
    const hash = await hashFile(path, signal);
    signal.throwIfAborted();
    const current = this.catalog.prepare('SELECT * FROM documents WHERE path=?').get(path) as DocumentSummary | undefined;
    let reusable = current?.hash === hash;
    if (reusable && current) {
      try {
        const table = await this.table();
        reusable = await table?.countRows(`document_id = '${current.id}' AND hash = '${hash}'`) === current.chunks;
      } catch { reusable = false; }
    }
    if (!reusable && engineForExtension(extension)) await interruptible(Promise.resolve(this.requireEngine?.(extension)), signal);
    signal.throwIfAborted();
    // Extraction is outside the commit queue, so slow OCR cannot freeze catalogue readers.
    const text = reusable ? '' : (await readContent(path, extension, this.cachePath, this.progress, signal)).slice(0, MAX_TEXT);
    const chunks = reusable ? [] : chunkText(text);
    if (!reusable && !chunks.length) throw new IndexSkipError(IMAGE.has(extension) ? 'image_no_text' : 'no_text');
    const vectors: number[][] = [];
    for (const [index, part] of chunks.entries()) {
      if (index % 16 === 0) await new Promise<void>(done => setImmediate(done));
      signal.throwIfAborted();
      vectors.push(vectorize(part));
    }
    if (await hashFile(path, signal) !== hash) throw new Error('Source changed during indexing; scan again.');
    signal.throwIfAborted();
    return this.locked(async () => {
      signal.throwIfAborted();
      this.assertTag(tagId);
      const stored = this.catalog.prepare('SELECT * FROM documents WHERE path=?').get(path) as DocumentSummary | undefined;
      if (stored?.hash === hash && reusable) {
        if (tagId !== DEFAULT_TAG) this.linkTags(stored.id, [tagId]);
        return { document: this.needDocument(stored.id), unchanged: true };
      }
      if (!chunks.length) throw new Error('Source changed during indexing; scan again.');
      const id = stored?.id ?? randomUUID();
      const now = Date.now();
      const rows: Passage[] = chunks.map((part, chunk) => ({ id: randomUUID(), document_id: id, path: '', name: displayName, hash, indexed_at: now, chunk: chunk + 1, text: part, vector: vectors[chunk]! }));
      const db = await this.connection();
      const table = await this.table();
      const target = table ?? await db.createTable(PASSAGES_TABLE, rows);
      if (table) {
        // An interrupted earlier write can have left an uncommitted generation. Remove it first.
        await target.delete(`document_id = '${id}' AND hash = '${hash}'`);
        await target.add(rows);
      }
      this.catalog.exec('BEGIN');
      try {
        this.catalog.prepare(`INSERT INTO documents(id,path,name,hash,added_at,indexed_at,chunks,source_path,relative_path,source_key)
          VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,name=excluded.name,hash=excluded.hash,indexed_at=excluded.indexed_at,chunks=excluded.chunks,source_path=excluded.source_path,relative_path=excluded.relative_path,source_key=excluded.source_key`)
          .run(id, path, displayName, hash, stored?.added_at ?? now, now, rows.length, path, relative(this.directoryRoot, path), this.fileKey(this.relativeFile(path)));
        if (tagId !== DEFAULT_TAG) this.linkTags(id, [tagId]);
        this.catalog.exec('COMMIT');
      } catch (error) { this.catalog.exec('ROLLBACK'); throw error; }
      // Readers accept only the catalogue's committed hash, so stale/uncommitted rows never leak.
      await target.delete(`document_id = '${id}' AND hash != '${hash}'`).catch(() => {});
      return { document: this.needDocument(id), unchanged: false };
    });
  }

  private async removeDirectoryDocument(id: string): Promise<boolean> {
    return this.locked(async () => {
      const doc = this.catalog.prepare('SELECT * FROM documents WHERE id=?').get(id) as DocumentSummary | undefined;
      if (!doc) return false;
      this.catalog.exec('BEGIN');
      try {
        this.catalog.prepare('DELETE FROM document_tags WHERE document_id=?').run(id);
        this.catalog.prepare('DELETE FROM documents WHERE id=?').run(id);
        this.catalog.exec('COMMIT');
      } catch (error) { this.catalog.exec('ROLLBACK'); throw error; }
      // Removal never touches source files; unreferenced vectors are safe until cleanup succeeds.
      const table = await this.table();
      await table?.delete(`document_id = '${id}'`).catch(() => {});
      return true;
    });
  }

  async search(query: string, limit = 5, tagId: string | null = null, directory: string | null = null) {
    if (!query.trim()) throw new Error('Enter a search query.');
    const signal = this.work.signal;
    signal.throwIfAborted();
    await interruptible(this.writes, signal);
    if (tagId !== null) this.assertTag(tagId);
    const docs = await this.work.run(this.list(), signal);
    signal.throwIfAborted();
    const wanted = docs.filter(doc => insideDirectory(relative(this.directoryRoot, doc.path).split(sep).join('/'), directory) && (tagId === null || (tagId === DEFAULT_TAG ? !doc.tags.length : doc.tags.includes(tagId))));
    if (!wanted.length) return [];
    const byId = new Map(wanted.map(doc => [doc.id, doc]));
    const table = await this.work.run(this.table(), signal);
    if (!table) return [];
    const count = Math.max(1, Math.min(20, Math.floor(limit) || 5));
    const terms = queryTerms(query, 1).map(term => term.toLowerCase());
    const weak = fallbackTerms(queryTerms(query, 1)).map(term => term.toLowerCase());
    // Filter before top-k so a small tag cannot be crowded out by unrelated documents.
    const predicates = wanted.map(doc => `(document_id = '${doc.id}' AND hash = '${doc.hash}')`);
    const batches: Passage[][] = [];
    for (let i = 0; i < predicates.length; i += 100) {
      signal.throwIfAborted();
      batches.push(await this.work.run(table.vectorSearch(vectorize(query)).where(predicates.slice(i, i + 100).join(' OR ')).limit(count * 4).toArray(), signal) as Passage[]);
    }
    return batches.flat().map(row => {
      const doc = byId.get(row.document_id)!;
      const text = row.text.toLowerCase();
      const full = terms.filter(term => text.includes(term));
      const partial = full.length ? [] : weak.filter(term => text.includes(term));
      return { document_id: doc.id, path: doc.path, name: doc.name, chunk: row.chunk, text: row.text,
        tag_id: tagId ?? doc.tags[0] ?? DEFAULT_TAG, distance: row._distance ?? 0, matched: full.length ? full : partial, full: full.length, partial: partial.length };
    }).filter(row => row.full || row.partial)
      .sort((a, b) => b.full - a.full || b.partial - a.partial || a.distance - b.distance).slice(0, count)
      .map(({ full, partial, ...row }) => row);
  }

}

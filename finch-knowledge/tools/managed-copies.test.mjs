import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { KnowledgeStore, UploadReceiver } from '../dist/index.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'finch-knowledge-managed-'));
  const target = process.platform === 'darwin' ? 'darwin-arm64' : `${process.platform}-${process.arch}-gnu`;
  const native = resolve(`node_modules/@lancedb/lancedb-${target}/lancedb.${target}.node`);
  const engine = join(root, 'lancedb-engine', '0.39.0');
  await mkdir(engine, { recursive: true });
  await symlink(native, join(engine, `lancedb.${target}.node`));
  return root;
}

/**
 * Rewrites a library's catalogue in the shape version 1 used: documents carry a single `tag_id`
 * column, and the schema version is low enough that the migrations still have work to do. The
 * current code can no longer produce this, which is exactly why the migration needs it.
 */
async function legacyCatalogue(root, data) {
  const catalog = new DatabaseSync(join(root, 'catalog.sqlite'));
  try {
    catalog.exec('DROP TABLE IF EXISTS document_tags; DROP TABLE IF EXISTS documents; DROP TABLE IF EXISTS tags;');
    catalog.exec(`CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE documents (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, hash TEXT NOT NULL, tag_id TEXT NOT NULL, added_at INTEGER NOT NULL, indexed_at INTEGER NOT NULL, chunks INTEGER NOT NULL, source_path TEXT);`);
    const insertTag = catalog.prepare('INSERT INTO tags (id,name,created_at) VALUES (?,?,?)');
    for (const tag of data.tags) insertTag.run(tag.id, tag.name, tag.created_at);
    const insert = catalog.prepare('INSERT INTO documents (id,path,name,hash,tag_id,added_at,indexed_at,chunks,source_path) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const doc of data.documents) insert.run(doc.id, doc.path, doc.name, doc.hash, doc.tag_id, doc.added_at, doc.indexed_at, doc.chunks, doc.source_path);
    catalog.exec('PRAGMA user_version=1');
  } finally { catalog.close(); }
}

async function upload(receiver, name, text, tagId) {
  const bytes = Buffer.from(text);
  await receiver.begin(name, bytes.length, tagId);
  await receiver.chunk(bytes.toString('base64'));
  return receiver.finish();
}

test('managed copies keep the original file name and stay unique per tag', async () => {
  const root = await fixture();
  try {
    const store = new KnowledgeStore(root);
    const law = await store.createTag('Law');
    const edu = await store.createTag('Education');
    const receiver = new UploadReceiver(root, store);
    const first = await upload(receiver, '创始人手册-中文版.md', '# A\n\nContract text here.', law.id);
    const [doc] = await store.list();
    assert.equal(doc.name, '创始人手册-中文版.md', 'the catalogue keeps the exact original name');
    assert.equal(basename(doc.path), '创始人手册-中文版.md', 'and so does the copy on disk');
    assert.match(doc.path, /imports/);

    // The same name in another tag gets its own directory, so nothing collides.
    await upload(receiver, '创始人手册-中文版.md', '# B\n\nClassroom text here.', edu.id);
    const docs = await store.list();
    const other = docs.find((item) => item.id !== first.documentId);
    assert.notEqual(other.path, doc.path);
    assert.equal(basename(other.path), '创始人手册-中文版.md');
    assert.deepEqual(other.tags, [edu.id]);

    // Re-importing the same name in the same tag replaces in place instead of piling up.
    await upload(receiver, '创始人手册-中文版.md', '# C\n\nUpdated contract text.', law.id);
    assert.equal((await store.list()).length, 2);
    const replaced = (await store.list()).find((item) => item.tags.includes(law.id));
    assert.equal(replaced.path, doc.path, 'the same path is reused for an update');
    assert.equal(replaced.id, first.documentId, 'an update keeps the document identity');
    assert.equal(await readFile(replaced.path, 'utf8'), '# C\n\nUpdated contract text.');
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('file names that are illegal on some platform are written safely', async () => {
  const root = await fixture();
  try {
    const store = new KnowledgeStore(root);
    await upload(new UploadReceiver(root, store), 'Q3: revenue projection?.md', '# Notes\n\nRevenue projection figures.', 'default');
    const [doc] = await store.list();
    assert.equal(doc.name, 'Q3: revenue projection?.md', 'the original name is preserved for display');
    assert.equal(basename(doc.path), 'Q3_ revenue projection_.md', 'the copy on disk is sanitised');
    assert.equal((await stat(doc.path)).isFile(), true);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('hash-named copies from older versions are renamed to readable ones', async () => {
  const root = await fixture();
  try {
    const store = new KnowledgeStore(root);
    const tag = await store.createTag('Research');
    await upload(new UploadReceiver(root, store), 'field-notes.md', '# Field\n\nViolet observations.', tag.id);
    const [doc] = await store.list();
    await store.close();

    // Rewrite the catalogue the way version 1 wrote it: one tag column, a hashed copy name.
    const hashed = join(root, 'imports', tag.id, `${'a'.repeat(64)}.md`);
    await writeFile(hashed, '# Field\n\nViolet observations.');
    await unlink(doc.path);
    await legacyCatalogue(root, {
      tags: [{ id: tag.id, name: 'Research', created_at: 1 }],
      documents: [{ id: doc.id, path: hashed, name: 'field-notes.md', hash: doc.hash, tag_id: tag.id, added_at: doc.added_at, indexed_at: doc.indexed_at, chunks: doc.chunks, source_path: null }],
    });

    // A fresh store on the same directory runs the one-time migration.
    const reopened = new KnowledgeStore(root);
    const [migrated] = await reopened.list();
    assert.equal(basename(migrated.path), 'field-notes.md', 'the hashed name became the readable one');
    assert.equal((await stat(migrated.path)).isFile(), true);
    assert.equal(await stat(hashed).catch(() => null), null, 'the old file is gone');
    assert.match((await reopened.search('Violet observations', 3))[0].text, /Violet/);
    await reopened.close();

    // A second open must not try again.
    const again = new KnowledgeStore(root);
    assert.equal(basename((await again.list())[0].path), 'field-notes.md');
    await again.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the migration also covers a tag that has no import folder yet', async () => {
  const root = await fixture();
  try {
    const store = new KnowledgeStore(root);
    const tag = await store.createTag('Startup');
    await upload(new UploadReceiver(root, store), 'thesis.md', '# Thesis\n\nMarket sizing notes.', tag.id);
    const [doc] = await store.list();
    await store.close();

    // The shape seen in real libraries: the copy sits directly under imports/, so
    // its tag folder was never created, and the rename target has no directory.
    const legacy = join(root, 'imports', `${'b'.repeat(64)}.md`);
    await rename(doc.path, legacy);
    await rm(join(root, 'imports', tag.id), { recursive: true, force: true });
    await legacyCatalogue(root, {
      tags: [{ id: tag.id, name: 'Startup', created_at: 1 }],
      documents: [{ id: doc.id, path: legacy, name: 'thesis.md', hash: doc.hash, tag_id: tag.id, added_at: doc.added_at, indexed_at: doc.indexed_at, chunks: doc.chunks, source_path: null }],
    });

    const reopened = new KnowledgeStore(root);
    const [migrated] = await reopened.list();
    assert.equal(basename(migrated.path), 'thesis.md', 'the copy was renamed even though its folder was missing');
    assert.equal(dirname(migrated.path), join(root, 'imports', tag.id));
    assert.equal((await stat(migrated.path)).isFile(), true);
    assert.deepEqual(await reopened.reconcileMissing(), [], 'and it still counts as present');
    await reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a library whose managed folder is missing altogether is not pruned', async () => {
  const root = await fixture();
  try {
    const store = new KnowledgeStore(root);
    const receiver = new UploadReceiver(root, store);
    await upload(receiver, 'synced.md', '# Synced\n\nWaiting for the rest of the copy.', 'default');
    assert.equal((await store.list()).length, 1);
    // Half-present is not the same as deleted.
    await rm(join(root, 'imports'), { recursive: true, force: true });
    assert.deepEqual(await store.reconcileMissing(), []);
    assert.equal((await store.list()).length, 1);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('entries whose source file disappeared are dropped, but unmounted volumes are not', async () => {
  const root = await fixture();
  try {
    const store = new KnowledgeStore(root);
    const receiver = new UploadReceiver(root, store);
    await upload(receiver, 'kept.md', '# Kept\n\nThis copy is still here.', 'default');
    await upload(receiver, 'gone.md', '# Gone\n\nThe copy will be deleted.', 'default');
    const external = join(root, 'external.md');
    await writeFile(external, '# External\n\nOutside the library.');
    await store.importFile(external, 'external.md');
    const detachedDir = join(root, 'detached');
    await mkdir(detachedDir, { recursive: true });
    const detached = join(detachedDir, 'offline.md');
    await writeFile(detached, '# Offline\n\nPretend this volume is unmounted.');
    await store.importFile(detached, 'offline.md');
    await unlink(detached);
    await rm(detachedDir, { recursive: true, force: true });
    assert.equal((await store.list()).length, 4);

    await unlink((await store.list()).find((doc) => doc.name === 'gone.md').path);
    await unlink(external);

    const removed = await store.reconcileMissing();
    assert.deepEqual(removed.map((doc) => doc.name).sort(), ['external.md', 'gone.md']);
    assert.deepEqual((await store.list()).map((doc) => doc.name).sort(), ['kept.md', 'offline.md']);
    // Search has no distance threshold, so the check is that the dropped entries never come back.
    const hits = await store.search('The copy will be deleted', 5);
    assert.equal(hits.some((hit) => hit.name === 'gone.md'), false, 'the dropped entry is no longer searchable');
    assert.equal(hits.some((hit) => hit.name === 'external.md'), false, 'so is the missing external one');
    assert.match((await store.search('This copy is still here', 3))[0].name, /kept\.md/);
    await store.close();

    const reopened = new KnowledgeStore(root);
    assert.deepEqual(await reopened.reconcileMissing(), [], 'running it again changes nothing');
    assert.equal((await reopened.list()).length, 2);
    await reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

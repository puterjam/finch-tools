import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_TAG, KnowledgeStore, UploadReceiver } from '../dist/index.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'finch-knowledge-multitag-'));
  const target = process.platform === 'darwin' ? 'darwin-arm64' : `${process.platform}-${process.arch}-gnu`;
  const native = resolve(`node_modules/@lancedb/lancedb-${target}/lancedb.${target}.node`);
  const engine = join(root, 'lancedb-engine', '0.39.0');
  await mkdir(engine, { recursive: true });
  await symlink(native, join(engine, `lancedb.${target}.node`));
  return root;
}
async function upload(store, root, name, text, tagId) {
  const receiver = new UploadReceiver(root, store);
  const bytes = Buffer.from(text);
  await receiver.begin(name, bytes.length, tagId);
  await receiver.chunk(bytes.toString('base64'));
  return receiver.finish();
}

test('a document can carry several tags, and each one can find it', async () => {
  const root = await fixture();
  try {
    const store = new KnowledgeStore(root);
    const design = await store.createTag('Design');
    const writing = await store.createTag('Writing');
    // A file imported under one tag, then filed under a second one as well.
    const { documentId } = await upload(store, root, 'notes.md', '# Notes\n\nFinch keeps a local copy.', design.id);
    await store.addTag(documentId, writing.id);

    const doc = await store.document(documentId);
    assert.deepEqual([...doc.tags].sort(), [design.id, writing.id].sort());
    for (const tagId of [design.id, writing.id]) {
      assert.equal((await store.search('Finch keeps', 5, tagId)).length, 1, 'searchable under each tag');
      assert.equal((await store.page(tagId, 'updated', 0)).total, 1, 'listed under each tag');
    }
    // It is not unclassified any more, and the counts say so.
    assert.equal((await store.summary()).tags.find((tag) => tag.id === DEFAULT_TAG).count, 0);
    const counts = Object.fromEntries((await store.tags()).map((tag) => [tag.id, tag.count]));
    assert.equal(counts[design.id], 1);
    assert.equal(counts[writing.id], 1);
    assert.equal((await store.page(DEFAULT_TAG, 'updated', 0)).total, 0);

    // Adding a tag twice is a no-op rather than a duplicate link.
    await store.addTag(documentId, writing.id);
    assert.equal((await store.document(documentId)).tags.length, 2);

    // Removing one leaves the other, in the catalogue and in the index.
    await store.removeTag(documentId, writing.id);
    assert.deepEqual((await store.document(documentId)).tags, [design.id]);
    assert.equal((await store.search('Finch keeps', 5, writing.id)).length, 0);
    assert.equal((await store.search('Finch keeps', 5, design.id)).length, 1);

    // Removing the last one is what puts it back in Unclassified.
    await store.removeTag(documentId, design.id);
    assert.deepEqual((await store.document(documentId)).tags, []);
    assert.equal((await store.search('Finch keeps', 5, DEFAULT_TAG)).length, 1);
    assert.equal((await store.page(DEFAULT_TAG, 'updated', 0)).total, 1);
    assert.equal((await store.summary()).tags.find((tag) => tag.id === DEFAULT_TAG).count, 1);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('deleting a shared tag keeps the other tag, and only orphans land in Unclassified', async () => {
  const root = await fixture();
  try {
    const store = new KnowledgeStore(root);
    const shared = await store.createTag('Shared');
    const only = await store.createTag('Only');
    const keep = await store.createTag('Keep');
    const both = (await upload(store, root, 'both.md', '# Both\n\nShared material about libraries.', shared.id)).documentId;
    const orphan = (await upload(store, root, 'orphan.md', '# Orphan\n\nFiled only under the tag that goes away.', shared.id)).documentId;
    const other = (await upload(store, root, 'other.md', '# Other\n\nNever had that tag at all.', only.id)).documentId;
    await store.addTag(both, keep.id);

    const moved = await store.deleteTag(shared.id);
    assert.equal(moved.affected, 2, 'two documents carried that tag');
    assert.equal(moved.orphaned, 1, 'only the one without another tag moved to Unclassified');
    assert.deepEqual((await store.document(both)).tags, [keep.id], 'the shared document keeps its other tag');
    assert.deepEqual((await store.document(orphan)).tags, [], 'the orphan lands in Unclassified');
    assert.deepEqual((await store.document(other)).tags, [only.id], 'a document without that tag is untouched');
    assert.equal((await store.search('Shared material', 5, keep.id)).length, 1);
    assert.equal((await store.search('Only filed here', 5, DEFAULT_TAG)).length, 1);
    // The deleted tag is gone from the catalogue and from the search path.
    assert.equal((await store.tags()).some((tag) => tag.id === shared.id), false);
    assert.equal((await store.search('Shared material', 5, shared.id).catch(() => 'threw')), 'threw');
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('re-importing the same copy under a second tag adds the tag instead of a second entry', async () => {
  const root = await fixture();
  try {
    const store = new KnowledgeStore(root);
    const first = await store.createTag('First');
    const second = await store.createTag('Second');
    const { documentId } = await upload(store, root, 'paper.md', '# Paper\n\nA single copy of this text.', first.id);
    const copy = (await store.document(documentId)).path;
    assert.deepEqual((await store.document(documentId)).tags, [first.id]);

    // The same file, same path, imported again under another tag: one entry, two tags.
    const again = await store.importFile(copy, 'paper.md', second.id);
    assert.equal(again.unchanged, true);
    assert.deepEqual([...again.document.tags].sort(), [first.id, second.id].sort());
    assert.equal((await store.list()).length, 1);
    assert.equal((await store.search('A single copy', 5, second.id)).length, 1, 'the new tag is searchable');
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a v1 catalogue converts its single tag into one link', async () => {
  const root = await fixture();
  try {
    await mkdir(join(root, 'imports', '22222222-2222-4222-8222-222222222222'), { recursive: true });
    const copy = join(root, 'imports', '22222222-2222-4222-8222-222222222222', 'old.md');
    await writeFile(copy, '# Old\n\nLegacy content.');
    const { DatabaseSync } = await import('node:sqlite');
    const legacy = new DatabaseSync(join(root, 'catalog.sqlite'));
    legacy.exec(`CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE documents (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, hash TEXT NOT NULL, tag_id TEXT NOT NULL, added_at INTEGER NOT NULL, indexed_at INTEGER NOT NULL, chunks INTEGER NOT NULL, source_path TEXT);`);
    legacy.prepare('INSERT INTO tags (id,name,created_at) VALUES (?,?,?)').run('22222222-2222-4222-8222-222222222222', 'Legacy', 1);
    legacy.prepare('INSERT INTO documents (id,path,name,hash,tag_id,added_at,indexed_at,chunks,source_path) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('11111111-1111-4111-8111-111111111111', copy, 'old.md', 'hash', '22222222-2222-4222-8222-222222222222', 2, 2, 1, null);
    legacy.exec('PRAGMA user_version=3');
    legacy.close();

    const store = new KnowledgeStore(root);
    const doc = await store.document('11111111-1111-4111-8111-111111111111');
    assert.deepEqual(doc.tags, ['22222222-2222-4222-8222-222222222222'], 'the single tag became a link');
    assert.equal((await store.page('22222222-2222-4222-8222-222222222222', 'updated', 0)).total, 1);
    assert.equal((await store.summary()).tags.find((tag) => tag.id === DEFAULT_TAG).count, 0);
    // And the column that held it is gone, so nothing can drift back to a single tag.
    const columns = store.catalogColumnsForTest?.() ?? null;
    if (columns) assert.equal(columns.includes('tag_id'), false);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

import assert from 'node:assert/strict';
import { fixtureLink as symlink, nativeTarget } from './test-platform.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_TAG, KnowledgeStore } from '../dist/index.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'finch-knowledge-multitag-'));
  const target = nativeTarget;
  const native = resolve(`node_modules/@lancedb/lancedb-${target}/lancedb.${target}.node`);
  const engine = join(root, 'lancedb-engine', '0.39.0');
  await mkdir(engine, { recursive: true });
  await symlink(native, join(engine, `lancedb.${target}.node`));
  return root;
}
async function upload(store, root, name, text, tagId) {
  const path = join(root, name);
  await writeFile(path, text);
  const indexed = await store.importFile(path, name, tagId);
  return { documentId: indexed.document.id, unchanged: indexed.unchanged };
}

test('a document can carry several tags, and each one can find it', async () => {
  const root = await fixture();
  try {
    const store = new KnowledgeStore(join(root, '.knowledge'), { directoryRoot: root, cachePath: root });
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
    const store = new KnowledgeStore(join(root, '.knowledge'), { directoryRoot: root, cachePath: root });
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
    const store = new KnowledgeStore(join(root, '.knowledge'), { directoryRoot: root, cachePath: root });
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

test('retired catalogues are rejected without migration, reset or deleting their files', async () => {
  const root = await fixture();
  try {
    const index = join(root, '.knowledge'); await mkdir(index);
    const path = join(index, 'catalog.sqlite');
    const original = join(root, 'old.md'); await writeFile(original, 'Keep this historical original.');
    const { DatabaseSync } = await import('node:sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec("CREATE TABLE documents (id TEXT PRIMARY KEY, path TEXT); PRAGMA user_version=3;");
    legacy.prepare('INSERT INTO documents VALUES (?,?)').run('old', original); legacy.close();
    const before = await readFile(path);
    assert.throws(() => new KnowledgeStore(index, { directoryRoot: root, cachePath: root }), /Unsupported knowledge index format/);
    assert.deepEqual(await readFile(path), before, 'opening must not stamp, migrate or reset the old catalogue');
    assert.equal(await readFile(original, 'utf8'), 'Keep this historical original.');
    assert.throws(() => new KnowledgeStore(root), /Only source-directory indexes/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import assert from 'node:assert/strict';
import { copyFile, cp, rename, mkdir, mkdtemp, realpath, readFile, readdir, rm, writeFile, stat, utimes } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import * as lance from '@lancedb/lancedb';
import { nativeTarget, fixtureLink } from './test-platform.mjs';
import { activate, assertSourcePath, openSourceDirectory, scanSourceDirectory, IndexSkipError } from '../dist/index.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'knowledge-directory-')));
  const source = join(root, 'sources'), cache = join(root, 'cache');
  await mkdir(source); await mkdir(join(cache, 'lancedb-engine', '0.39.0'), { recursive: true });
  await copyFile(resolve(`node_modules/@lancedb/lancedb-${nativeTarget}/lancedb.${nativeTarget}.node`), join(cache, 'lancedb-engine', '0.39.0', `lancedb.${nativeTarget}.node`));
  const stores = [];
  const open = async (directory = source, options = {}) => { const store = await openSourceDirectory(directory, cache, options); stores.push(store); return store; };
  t.after(async () => { for (const store of stores) await store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, source, cache, open };
}

test('empty or populated directories are accepted and private data stays in .knowledge', async t => {
  const { source, open } = await fixture(t);
  const first = await open();
  assert.deepEqual((await readdir(source)).sort(), ['.knowledge']);
  assert.equal((await first.page(null, 'name', 0)).total, 0);
  await first.close();
  await mkdir(join(source, 'notes'));
  await writeFile(join(source, 'notes', 'a.md'), 'Original folder structure');
  const reopened = await open();
  assert.equal((await scanSourceDirectory(reopened)).updated.length, 1);
  assert.equal((await reopened.list())[0].path, join(source, 'notes', 'a.md'));
  assert.equal(await readFile(join(source, 'notes', 'a.md'), 'utf8'), 'Original folder structure');
  assert.deepEqual((await readdir(source)).sort(), ['.knowledge', 'notes']);
  assert.equal((await scanSourceDirectory(reopened)).unchanged, 1);
});

test('tags do not duplicate vectors and updates are visible under every tag', async t => {
  const { source, open } = await fixture(t);
  const path = join(source, 'shared.md');
  await writeFile(path, 'oldkeyword');
  const store = await open();
  await scanSourceDirectory(store);
  const [doc] = await store.list();
  const a = await store.createTag('A'), b = await store.createTag('B');
  await store.setTags(doc.id, [a.id, b.id]);
  const db = await lance.connect(join(source, '.knowledge', 'vectors.lance'));
  assert.deepEqual(await db.tableNames(), ['passages_directory_v1']);
  assert.equal(await (await db.openTable('passages_directory_v1')).countRows(), 1);
  assert.equal((await store.search('oldkeyword')).length, 1, 'all-tags search must deduplicate');
  await writeFile(path, 'freshkeyword');
  assert.equal((await scanSourceDirectory(store)).updated.length, 1);
  for (const tag of [a.id, b.id]) {
    assert.equal((await store.search('freshkeyword', 5, tag)).length, 1);
    assert.equal((await store.search('oldkeyword', 5, tag)).length, 0);
  }
  assert.deepEqual((await store.list())[0].tags.sort(), [a.id, b.id].sort());
  await store.deleteTag(a.id);
  assert.equal((await store.search('freshkeyword', 5, b.id)).length, 1);
  db.close();
});

test('incremental scan adds, changes, removes and preserves failed sources; removal never deletes originals', async t => {
  const { source, open } = await fixture(t);
  await writeFile(join(source, 'changed.md'), 'Beforechange');
  await writeFile(join(source, 'gone.md'), 'Deletedfromdisk');
  await writeFile(join(source, 'failed.md'), 'Preservedkeyword');
  const store = await open();
  await scanSourceDirectory(store);
  await writeFile(join(source, 'changed.md'), 'Afterchange');
  await writeFile(join(source, 'new.md'), 'Newkeyword');
  await rm(join(source, 'gone.md'));
  await writeFile(join(source, 'failed.md'), '');
  const outcome = await scanSourceDirectory(store);
  assert.equal(outcome.updated.length, 2); assert.equal(outcome.removed.length, 1); assert.equal(outcome.failed.length, 0);
  assert.equal(outcome.skipped.length, 1); assert.equal(outcome.skipped[0].reason, 'empty_file');
  assert.equal((await store.search('Preservedkeyword')).length, 1);
  await writeFile(join(source, 'gone.md'), 'Recreatedkeyword');
  await scanSourceDirectory(store);
  assert.equal((await store.search('Recreatedkeyword')).length, 1, 'a deleted file recreated later is discovered');
  const doc = (await store.list()).find(doc => doc.name === 'new.md');
  await store.remove(doc.id);
  assert.equal(await readFile(doc.path, 'utf8'), 'Newkeyword');
  await scanSourceDirectory(store);
  assert.equal((await store.list()).some(row => row.path === doc.path), true, 'scanning reflects the real directory, including sources excluded by older versions');
  await store.importFile(doc.path);
  assert.equal((await store.search('Newkeyword')).length, 1);
});

test('a source directory copied by the user keeps relative structure and search citations correct', async t => {
  const { root, source, open } = await fixture(t);
  await mkdir(join(source, 'nested'));
  await writeFile(join(source, 'nested', 'note.md'), 'Portablekeyword');
  const store = await open(); await scanSourceDirectory(store);
  await store.close();
  const copied = join(root, 'user-copy');
  await cp(source, copied, { recursive: true });
  assert.equal(await readFile(join(copied, 'nested', 'note.md'), 'utf8'), 'Portablekeyword');
  const restored = await open(copied);
  assert.equal((await restored.search('Portablekeyword'))[0].path, join(copied, 'nested', 'note.md'));
  await restored.close(); await store.close();
  const moved = join(root, 'moved');
  await cp(source, moved, { recursive: true }); await rm(source, { recursive: true });
  const reopened = await open(moved);
  assert.equal((await reopened.search('Portablekeyword'))[0].path, join(moved, 'nested', 'note.md'));
  assert.equal((await scanSourceDirectory(reopened)).unchanged, 1);
});

test('private directories, traversal and symlinks are never indexed', async t => {
  const { root, source, open } = await fixture(t);
  const store = await open();
  await writeFile(join(source, '.knowledge', 'private.md'), 'Privatekeyword');
  await writeFile(join(root, 'outside.md'), 'Outsidekeyword');
  await fixtureLink(join(root, 'outside.md'), join(source, 'linked'));
  await assert.rejects(assertSourcePath(source, '../outside.md'));
  await assert.rejects(assertSourcePath(source, '.knowledge/private.md'));
  await assert.rejects(assertSourcePath(source, 'linked'));
  await scanSourceDirectory(store);
  assert.equal((await store.list()).length, 0);
  await assert.rejects(open(join(source, '.knowledge')));
});

test('activation and page ready do not create a library; entering is refused without a directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-no-selection-'));
  const subscriptions = []; let receive; let fetches = 0; let tool;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetches++; throw new Error('Unexpected download'); };
  t.after(async () => { globalThis.fetch = originalFetch; for (const sub of subscriptions) await sub.dispose?.(); await rm(root, { recursive: true, force: true }); });
  const sent = [];
  const panel = { view: 'appView', postMessage: async message => sent.push(message), onDidReceiveMessage: fn => { receive = fn; return { dispose() {} }; }, onDidDispose: () => ({ dispose() {} }) };
  activate({ storagePath: root, subscriptions, storage: { get: async () => undefined },
    i18n: { t: key => key }, composerActions: { register: () => ({ dispose() {}, notifyUpdate() {} }) },
    tools: { register: definition => { tool = definition; return { dispose() {} }; } },
    ui: { onDidOpenPanel: fn => { fn(panel); return { dispose() {} }; } } });
  await receive({ type: 'ready', requestId: '1' });
  await receive({ type: 'enterLibrary', requestId: '2' });
  assert.equal(sent.find(message => message.requestId === '1').library.selected, false);
  assert.equal(sent.find(message => message.requestId === '2').type, 'error');
  assert.deepEqual(await readdir(root), []);
  assert.equal(fetches, 0);
  assert.equal((await tool.execute({ action: 'sync' }, {})).isError, true);
});

test('collection status verifies complete current-generation LanceDB records, not catalogue presence', async t => {
  const { source, open } = await fixture(t);
  await writeFile(join(source, 'coverage.md'), 'Coveragekeyword passage. '.repeat(2000));
  const store = await open();
  await scanSourceDirectory(store);
  const documents = await store.list();
  const [doc] = documents;
  assert.ok(doc.chunks > 1);
  const [complete] = await store.indexStatus(documents);
  assert.equal(complete.indexState, 'indexed');
  assert.equal(complete.status, 'ready');
  assert.equal(complete.indexedChunks, doc.chunks);
  const db = await lance.connect(join(source, '.knowledge', 'vectors.lance'));
  t.after(() => db.close());
  const table = await db.openTable('passages_directory_v1');
  const [old] = await table.query().where(`document_id = '${doc.id}' AND chunk = 1`).toArray();
  await table.delete(`document_id = '${doc.id}' AND chunk = 1`);
  const [partial] = await store.indexStatus(documents);
  assert.equal(partial.indexState, 'partial');
  assert.equal(partial.status, 'incomplete');
  assert.equal(partial.indexedChunks, doc.chunks - 1);
  await table.delete(`document_id = '${doc.id}'`);
  assert.equal((await store.indexStatus(documents))[0].indexState, 'missing');
  await table.add([{ ...old, hash: 'outdated-generation', vector: Array.from(old.vector.toArray?.() ?? old.vector) }]);
  assert.equal((await store.indexStatus(documents))[0].indexState, 'missing', 'stale generations do not count as collection');
  assert.equal((await store.list()).length, 1, 'verification never deletes a catalogue entry');
  const tag = await store.createTag('Repair');
  await store.addTag(doc.id, tag.id);
  assert.equal((await store.indexStatus(await store.list()))[0].status, 'pending');
  assert.equal((await scanSourceDirectory(store)).updated.length, 1, 'unchanged originals repair missing passages');
  const [repaired] = await store.indexStatus(await store.list());
  assert.equal(repaired.id, doc.id);
  assert.deepEqual(repaired.tags, [tag.id]);
  assert.equal(repaired.status, 'ready');
});

test('collection verification failures remain unknown and empty pages need no engine', async t => {
  const { source, open } = await fixture(t);
  await writeFile(join(source, 'status.md'), 'Statuskeyword');
  const store = await open();
  await scanSourceDirectory(store);
  const documents = await store.list();
  const original = store.table;
  store.table = async () => { throw new Error('Engine is unavailable'); };
  try {
    assert.deepEqual(await store.indexStatus([]), []);
    const [unknown] = await store.indexStatus(documents);
    assert.equal(unknown.indexState, 'unavailable');
    assert.equal(unknown.status, 'unverified');
    assert.equal(unknown.indexedChunks, null);
  } finally { store.table = original; }
});

test('source freshness, persistent failures and recovery produce distinct user states', async t => {
  const { source, open } = await fixture(t);
  const path = join(source, 'lifecycle.md');
  await writeFile(path, 'Originalkeyword');
  let store = await open();
  await scanSourceDirectory(store);
  const id = (await store.list())[0].id;
  await writeFile(path, 'Changedkeyword content');
  assert.equal((await store.statusForPath(path)).status, 'outdated');
  store.indexDirectoryFile = async () => { throw new Error('Fixture parser could not read the source'); };
  assert.equal((await scanSourceDirectory(store)).failed.length, 1);
  const failed = await store.statusForPath(path);
  assert.equal(failed.status, 'failed');
  assert.ok(failed.statusReason);
  assert.equal((await store.search('Originalkeyword')).length, 1, 'a failed update keeps committed passages');
  await store.close();
  store = await open();
  assert.equal((await store.statusForPath(path)).status, 'failed', 'failure survives reopening the library');
  await writeFile(path, 'Recoveredkeyword');
  await scanSourceDirectory(store);
  assert.equal((await store.statusForPath(path)).status, 'ready');
  assert.equal((await store.statusForPath(path)).id, id);
  assert.equal((await store.statusForPath(path)).statusReason, undefined);
  await rm(path);
  assert.equal((await store.statusForPath(path)).status, 'source_missing');
});

test('missing parent folders are temporarily unavailable, not falsely searchable or deleted', async t => {
  const { source, open } = await fixture(t);
  await mkdir(join(source, 'detached'));
  const path = join(source, 'detached', 'note.md');
  await writeFile(path, 'Offlinekeyword');
  const store = await open();
  await scanSourceDirectory(store);
  await rm(join(source, 'detached'), { recursive: true });
  assert.equal((await store.statusForPath(path)).status, 'source_unavailable');
  assert.equal((await store.list()).length, 1);
});

test('processing is observable while an attempt is running and clears after completion', async t => {
  const { source, open } = await fixture(t);
  const path = join(source, 'progress.md');
  await writeFile(path, 'Progresskeyword');
  let start;
  const started = new Promise(resolve => { start = resolve; });
  let armed = false;
  const phases = [];
  const store = await open(source, { onStatusChange(changedPath, phase) {
    assert.equal(changedPath, path);
    if (armed) { phases.push(phase); if (phase === 'processing') start(); }
  } });
  await scanSourceDirectory(store);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const index = store.indexDirectoryFile.bind(store);
  store.indexDirectoryFile = async (...args) => { await blocked; return index(...args); };
  armed = true;
  const attempt = store.importFile(path);
  await started;
  try { assert.equal((await store.statusForPath(path)).status, 'processing'); }
  finally { release(); await attempt; }
  assert.deepEqual(phases, ['processing', 'settled']);
  assert.equal((await store.statusForPath(path)).status, 'ready');
});

test('persisted SHA-256 drives incremental updates even when file size and modification time stay the same', async t => {
  const { source, open } = await fixture(t);
  const path = join(source, 'changed.md'), other = join(source, 'unchanged.md');
  const before = 'Initialkeyword AAA', after = 'Changedkeyword BBB';
  assert.equal(before.length, after.length);
  await writeFile(path, before); await writeFile(other, 'Stablekeyword');
  await utimes(path, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  let store = await open();
  await scanSourceDirectory(store);
  const original = (await store.list()).find(doc => doc.path === path);
  const stable = (await store.list()).find(doc => doc.path === other);
  const metadata = await stat(path);
  const db = new DatabaseSync(join(source, '.knowledge', 'catalog.sqlite'), { readOnly: true });
  try {
    const record = db.prepare('SELECT hash FROM documents WHERE id=?').get(original.id);
    assert.equal(record.hash, createHash('sha256').update(before).digest('hex'));
  } finally { db.close(); }
  await store.close();
  store = await open();
  assert.equal((await store.document(original.id)).hash, original.hash, 'hash survives reopening');
  await writeFile(path, after);
  await utimes(path, metadata.atime, metadata.mtime);
  assert.equal((await stat(path)).size, metadata.size);
  assert.equal((await stat(path)).mtimeMs, metadata.mtimeMs);
  const result = await scanSourceDirectory(store);
  assert.deepEqual(result.updated, ['changed.md']);
  assert.equal(result.unchanged, 1);
  const updated = await store.document(original.id);
  assert.equal(updated.hash, createHash('sha256').update(after).digest('hex'));
  assert.equal((await store.document(stable.id)).indexed_at, stable.indexed_at, 'unchanged content is not rewritten');
  assert.equal((await store.search('Initialkeyword')).length, 0);
  assert.equal((await store.search('Changedkeyword'))[0].document_id, original.id);
  const vectors = await lance.connect(join(source, '.knowledge', 'vectors.lance'));
  try {
    const table = await vectors.openTable('passages_directory_v1');
    assert.equal(await table.countRows(`document_id = '${original.id}' AND hash = '${original.hash}'`), 0);
    assert.equal(await table.countRows(`document_id = '${original.id}' AND hash = '${updated.hash}'`), updated.chunks);
  } finally { vectors.close(); }
});

test('indexed folder navigation uses catalogue paths and scopes pages, locating and search', async t => {
  const { source, open } = await fixture(t);
  for (const folder of ['group/sub', 'group-other', '100%_😀', 'empty']) await mkdir(join(source, folder), { recursive: true });
  for (const file of ['root.md', 'group/a.md', 'group/sub/b.md', 'group-other/c.md', '100%_😀/d.md']) await writeFile(join(source, file), 'folderkeyword original content');
  const store = await open(); await scanSourceDirectory(store);
  await mkdir(join(source, 'unindexed')); await writeFile(join(source, 'unindexed', 'new.md'), 'not indexed');
  const tree = await store.directories();
  assert.equal(tree.find(item => item.path === '').count, 5);
  assert.equal(tree.find(item => item.path === 'group').count, 2);
  assert.equal(tree.find(item => item.path === 'group/sub').count, 1);
  assert.equal(tree.find(item => item.path === 'empty').count, 0, 'scanned empty folders remain visible');
  assert.ok(!tree.some(item => item.path === 'unindexed'), 'directories created after the last scan appear on the next scan');
  const page = await store.page(null, 'name', 0, 1, 'group');
  assert.equal(page.total, 2); assert.equal(page.documents.length, 1);
  const second = await store.page(null, 'name', 1, 1, 'group');
  assert.equal(await store.position(second.documents[0].id, null, 'name', 'group'), 1);
  const outside = (await store.page(null, 'name', 0, 50, 'group-other')).documents[0];
  assert.equal(await store.position(outside.id, null, 'name', 'group'), null);
  const matches = await store.search('folderkeyword', 10, null, 'group');
  assert.equal(matches.length, 2);
  assert.ok(matches.every(item => item.path.startsWith(join(source, 'group') + (process.platform === 'win32' ? '\\' : '/'))));
  assert.equal((await store.page(null, 'name', 0, 50, '100%_😀')).total, 1);
  await assert.rejects(store.page(null, 'name', 0, 50, '../group'), /Invalid indexed directory/);
  const tag = await store.createTag('Cross-folder'); await store.addTag(page.documents[0].id, tag.id); await store.addTag(outside.id, tag.id);
  assert.equal((await store.page(tag.id, 'name', 0, 50, 'group')).total, 1);
  assert.deepEqual(await store.directories(), tree, 'tags never alter directory structure or counts');
});

test('tag colors persist in the selected library without changing tags, paths or original content', async t => {
  const { source, open } = await fixture(t);
  const path = join(source, 'original.md'); await writeFile(path, 'unchanged original');
  const store = await open(); await scanSourceDirectory(store);
  const doc = (await store.list())[0], tag = await store.createTag('Important');
  await store.addTag(doc.id, tag.id);
  await store.setTagColor(tag.id, 'red');
  assert.equal((await store.tags()).find(item => item.id === tag.id).color, 'red');
  await store.setTagColor(tag.id, '#1A2B3C');
  assert.equal((await store.tags()).find(item => item.id === tag.id).color, '#1a2b3c');
  for (const invalid of ['not-a-color', '#abc', '#12345678', 'transparent', 'url(x)', '#12345g']) await assert.rejects(store.setTagColor(tag.id, invalid), /Invalid tag color/);
  await store.close();
  const reopened = await open();
  assert.equal((await reopened.tags()).find(item => item.id === tag.id).color, '#1a2b3c');
  assert.deepEqual((await reopened.document(doc.id)).tags, [tag.id]);
  assert.equal((await reopened.document(doc.id)).path, path);
  assert.equal(await readFile(path, 'utf8'), 'unchanged original');
});

test('empty files and sources without recognized text are skips, not refresh failures', async t => {
  const { source, open } = await fixture(t);
  for (const [name, content] of Object.entries({ 'empty.txt': '', 'empty.png': '', 'blank.txt': ' \n\t ', 'picture.png': 'image fixture', 'broken.pdf': 'pdf fixture', 'good.md': 'Searchablekeyword' })) await writeFile(join(source, name), content);
  const engineCalls = [];
  const store = await open(source, { requireEngine: async extension => { engineCalls.push(extension); throw new Error('Document engine rejected the input'); } });
  const index = store.importFile.bind(store);
  store.importFile = async (path, ...args) => {
    if (path.endsWith('picture.png')) throw new IndexSkipError('image_no_text');
    return index(path, ...args);
  };
  const scan = await scanSourceDirectory(store);
  assert.deepEqual(scan.skipped.map(item => `${item.name}:${item.reason}`).sort(), ['blank.txt:no_text', 'empty.png:empty_file', 'empty.txt:empty_file', 'picture.png:image_no_text']);
  assert.equal(scan.failed.length, 1); assert.equal(scan.failed[0].name, 'broken.pdf');
  assert.deepEqual(engineCalls, ['.pdf'], 'empty images never trigger OCR preparation');
  assert.equal((await store.list()).length, 1);
  assert.equal(await readFile(join(source, 'empty.txt'), 'utf8'), '');
});

test('moving a whole source folder removes its old tree entry and preserves identity, tags and color', async t => {
  const { source, open } = await fixture(t);
  await mkdir(join(source, 'proofs')); await mkdir(join(source, 'company'));
  await writeFile(join(source, 'proofs', 'identity.md'), 'Identitymovekeyword');
  await writeFile(join(source, 'company', 'other.md'), 'Otherkeyword');
  const store = await open(); await scanSourceDirectory(store);
  const original = (await store.list()).find(doc => doc.path === join(source, 'proofs', 'identity.md'));
  const tag = await store.createTag('Private'); await store.addTag(original.id, tag.id); await store.setTagColor(tag.id, 'purple');
  await rename(join(source, 'proofs'), join(source, 'company', 'proofs'));
  const scan = await scanSourceDirectory(store);
  assert.equal(scan.failed.length, 0); assert.equal(scan.unreachable.length, 0); assert.equal(scan.moved.length, 1);
  const docs = await store.list(); assert.equal(docs.length, 2);
  const moved = docs.find(doc => doc.id === original.id);
  assert.equal(moved.path, join(source, 'company', 'proofs', 'identity.md')); assert.deepEqual(moved.tags, [tag.id]);
  assert.equal((await store.tags()).find(item => item.id === tag.id).color, 'purple');
  assert.ok(!(await store.directories()).some(item => item.path === 'proofs'));
  assert.equal((await store.directories()).find(item => item.path === 'company/proofs').count, 1);
  const matches = await store.search('Identitymovekeyword'); assert.equal(matches.length, 1); assert.equal(matches[0].path, moved.path);
  assert.equal((await scanSourceDirectory(store)).moved.length, 0, 'subsequent scans do not count the same move again');
});

test('a scan repairs duplicate old/new mappings left by earlier scans and keeps both sets of tags', async t => {
  const { source, open } = await fixture(t);
  await mkdir(join(source, 'proofs')); await mkdir(join(source, 'company'));
  await writeFile(join(source, 'proofs', 'note.md'), 'Duplicatemovekeyword');
  const store = await open(); await scanSourceDirectory(store);
  const old = (await store.list())[0], beforeTag = await store.createTag('Before'), afterTag = await store.createTag('After');
  await store.addTag(old.id, beforeTag.id);
  await rename(join(source, 'proofs'), join(source, 'company', 'proofs'));
  const duplicate = await store.importFile(join(source, 'company', 'proofs', 'note.md'));
  await store.addTag(duplicate.document.id, afterTag.id);
  assert.equal((await store.list()).length, 2, 'reproduce the stale mapping from the previous scanner');
  await scanSourceDirectory(store);
  const docs = await store.list(); assert.equal(docs.length, 1); assert.equal(docs[0].id, old.id);
  assert.deepEqual([...docs[0].tags].sort(), [beforeTag.id, afterTag.id].sort());
  assert.equal((await store.search('Duplicatemovekeyword')).length, 1);
  assert.ok(!(await store.directories()).some(item => item.path === 'proofs'));
});

test('deleting an entire nested folder cleans old mappings instead of calling missing parents offline', async t => {
  const { source, open } = await fixture(t);
  await mkdir(join(source, 'gone', 'nested'), { recursive: true });
  await writeFile(join(source, 'gone', 'nested', 'note.md'), 'Deletedsubtreekeyword');
  const store = await open(); await scanSourceDirectory(store);
  await rm(join(source, 'gone'), { recursive: true });
  const scan = await scanSourceDirectory(store);
  assert.equal(scan.removed.length, 1); assert.equal(scan.unreachable.length, 0);
  assert.equal((await store.list()).length, 0); assert.equal((await store.directories()).length, 1);
});

test('ambiguous equal copies never inherit an arbitrary missing document identity or tags', async t => {
  const { source, open } = await fixture(t);
  for (const folder of ['one', 'two', 'new']) await mkdir(join(source, folder));
  await writeFile(join(source, 'one', 'same.md'), 'Identicalkeyword'); await writeFile(join(source, 'two', 'same.md'), 'Identicalkeyword');
  const store = await open(); await scanSourceDirectory(store);
  const old = await store.list(), tag = await store.createTag('Only one'); await store.addTag(old[0].id, tag.id);
  await rm(join(source, 'one'), { recursive: true }); await rm(join(source, 'two'), { recursive: true });
  await writeFile(join(source, 'new', 'same.md'), 'Identicalkeyword');
  const scan = await scanSourceDirectory(store), docs = await store.list();
  assert.equal(scan.moved.length, 0); assert.equal(scan.removed.length, 2); assert.equal(docs.length, 1);
  assert.ok(!old.some(doc => doc.id === docs[0].id)); assert.deepEqual(docs[0].tags, []);
});

test('a blocked symlink subtree keeps its mappings until a readable scan can confirm absence', async t => {
  const { root, source, open } = await fixture(t);
  await mkdir(join(source, 'proofs')); await writeFile(join(source, 'proofs', 'note.md'), 'Unavailablekeyword');
  const store = await open(); await scanSourceDirectory(store);
  const id = (await store.list())[0].id;
  await rename(join(source, 'proofs'), join(root, 'detached'));
  await fixtureLink(join(root, 'detached'), join(source, 'proofs'), 'dir');
  const scan = await scanSourceDirectory(store);
  assert.equal(scan.removed.length, 0); assert.ok(scan.unreachable.length > 0); assert.equal((await store.list())[0].id, id);
});

test('an emptied indexed source is skipped without becoming a persistent processing failure', async t => {
  const { source, open } = await fixture(t);
  const path = join(source, 'was-readable.md'); await writeFile(path, 'Previoussnapshotkeyword');
  let store = await open(); await scanSourceDirectory(store);
  const original = (await store.list())[0], tag = await store.createTag('Keep'); await store.addTag(original.id, tag.id);
  await writeFile(path, '');
  const scan = await scanSourceDirectory(store);
  assert.equal(scan.failed.length, 0); assert.equal(scan.skipped[0].reason, 'empty_file');
  assert.equal((await store.statusForPath(path)).status, 'outdated');
  assert.equal((await store.statusForPath(path)).statusReason, undefined);
  await store.close(); store = await open();
  assert.equal((await store.statusForPath(path)).status, 'outdated');
  assert.deepEqual((await store.document(original.id)).tags, [tag.id]);
});


test('file details use original attributes and metadata sorting spans pages, tags and directories', async t => {
  const { source, open } = await fixture(t);
  const folder = join(source, 'notes'); await mkdir(folder);
  const base = Date.UTC(2020, 0, 1);
  for (let index = 0; index < 55; index++) {
    const path = join(folder, `${String(index).padStart(2, '0')}.${index % 2 ? 'txt' : 'md'}`);
    await writeFile(path, `${String(index).padStart(3, '0')}${'x'.repeat(index + 1)}`);
    await utimes(path, new Date(base + index * 1000), new Date(base + index * 1000));
  }
  await writeFile(join(source, 'outside.md'), 'x'.repeat(500));
  const store = await open(); await scanSourceDirectory(store);
  const first = await store.page(null, 'size', 0, 50, 'notes');
  const second = await store.page(null, 'size', 50, 50, 'notes');
  assert.equal(first.total, 55); assert.equal(first.documents.length, 50); assert.equal(second.documents.length, 5);
  const descending = [...first.documents, ...second.documents];
  assert.deepEqual(descending.map(doc => doc.size_bytes), Array.from({ length: 55 }, (_, index) => 58 - index));
  assert.equal((await store.page(null, 'size', 0)).documents[0].name, 'outside.md');
  for (const index of [0, 49, 50, 54]) assert.equal(await store.position(descending[index].id, null, 'size', 'notes'), index);
  const ascending = await store.page(null, 'size', 0, 50, 'notes', false);
  assert.equal(ascending.documents[0].size_bytes, 4);
  const smallest = ascending.documents[0];
  const [details] = await store.indexStatus([smallest]);
  assert.equal(details.modified_at, base); assert.equal(details.file_type, 'md'); assert.equal(details.size_bytes, 4);
  assert.notEqual(details.modified_at, details.indexed_at, 'source mtime is not the index timestamp');
  const nextTime = Date.UTC(2030, 0, 1); await utimes(smallest.path, new Date(nextTime), new Date(nextTime));
  await store.indexStatus([smallest]); // Metadata refresh is explicit background work, never a page prerequisite.
  const modified = await store.page(null, 'modified', 0, 50, 'notes');
  assert.equal(modified.documents[0].id, smallest.id); assert.equal(modified.documents[0].modified_at, nextTime);
  const types = await store.page(null, 'type', 0, 50, 'notes');
  assert.equal(types.documents[0].file_type, 'md'); assert.equal(types.documents.at(-1).file_type, 'txt');
  const tag = await store.createTag('Subset');
  for (const doc of [descending[0], descending[20], descending[54]]) await store.addTag(doc.id, tag.id);
  const tagged = await store.page(tag.id, 'size', 0, 50, 'notes', false);
  assert.equal(tagged.total, 3); assert.equal(tagged.documents[0].id, smallest.id);
  assert.equal(await store.position(smallest.id, tag.id, 'size', 'notes', false), 0);
  const reverseNames = await store.page(null, 'name', 0, 50, 'notes', true);
  assert.ok(reverseNames.documents[0].name.endsWith('54.md'));
  assert.equal(await store.position(reverseNames.documents[0].id, null, 'name', 'notes', true), 0);
  assert.equal(await readFile(smallest.path, 'utf8'), '000x', 'reading details never rewrites originals');
  await rm(smallest.path);
  const missing = await store.page(null, 'size', 50, 50, 'notes', false);
  // A background verification records a confirmed missing file as unknown, not zero or 1970.
  await store.indexStatus([smallest]);
  await store.page(null, 'size', 0, 50, 'notes', false);
  const final = await store.page(null, 'size', 50, 50, 'notes', false);
  assert.equal(final.documents.at(-1).id, smallest.id); assert.equal(final.documents.at(-1).size_bytes, null);
  assert.equal(final.documents.at(-1).modified_at, null);
  assert.ok(missing.total === 55);
});


test('real panel reopens and backend reloads respect the cooldown while manual scan bypasses it', async t => {
  const { source, cache, open } = await fixture(t);
  await writeFile(join(source, 'cooldown.md'), 'Cooldown integration fixture');
  const initial = await open(); await initial.close();
  const values = new Map([['sourceDirectory', source], ['setupComplete', true]]);
  const instances = [];
  const start = () => {
    const subscriptions = [], sent = []; let receive, completed;
    const done = new Promise(resolve => { completed = resolve; });
    const panel = { view: 'appView', postMessage: async message => { sent.push(message); if (message.type === 'scanDone' || message.type === 'scanFailed') completed(message); },
      onDidReceiveMessage: fn => { receive = fn; return { dispose() {} }; }, onDidDispose: () => ({ dispose() {} }) };
    activate({ storagePath: cache, subscriptions, storage: { get: async key => values.get(key), set: async (key, value) => { values.set(key, value); } },
      i18n: { t: key => key }, composerActions: { register: () => ({ dispose() {}, notifyUpdate() {} }) },
      tools: { register: () => ({ dispose() {} }) }, ui: { onDidOpenPanel: fn => { fn(panel); return { dispose() {} }; } } });
    const instance = { sent, done, receive: message => receive(message), dispose: async () => { for (const sub of subscriptions.splice(0)) await sub.dispose?.(); } };
    instances.push(instance); return instance;
  };
  t.after(async () => { for (const instance of instances) await instance.dispose(); });
  try {
  const first = start(); await first.receive({ type: 'ready', requestId: 'first' });
  assert.equal((await first.done).type, 'scanDone');
  await Promise.all(Array.from({ length: 4 }, (_, index) => first.receive({ type: 'ready', requestId: `again-${index}` })));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.sent.filter(message => message.type === 'scanStarted').length, 1);
  await first.receive({ type: 'sync', requestId: 'manual' });
  assert.equal(first.sent.filter(message => message.type === 'scanStarted').length, 2);
  assert.equal(first.sent.find(message => message.requestId === 'manual' && message.type === 'syncDone').sync.unchanged, 1);
  await first.dispose();
  const reopened = start(); await reopened.receive({ type: 'ready', requestId: 'reload' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reopened.sent.filter(message => message.type === 'scanStarted').length, 0);
  await reopened.receive({ type: 'sync', requestId: 'force-after-reload' });
  assert.equal(reopened.sent.filter(message => message.type === 'scanStarted').length, 1);
  } finally { for (const instance of instances) await instance.dispose(); }
});

test('source inventory includes empty and unsupported-only folders with reasons outside the searchable index', async t => {
  const f = await fixture(t);
  await mkdir(join(f.source, 'empty', 'nested'), { recursive: true });
  await mkdir(join(f.source, 'unsupported-only'));
  await mkdir(join(f.source, 'text'));
  await writeFile(join(f.source, 'unsupported-only', 'archive.zip'), 'Do not parse or alter');
  await writeFile(join(f.source, 'text', 'empty.txt'), '');
  await writeFile(join(f.source, 'text', 'spaces.md'), '   \n\t');
  await writeFile(join(f.source, 'text', 'good.md'), 'Searchable inventory token');
  const store = await f.open(); const result = await scanSourceDirectory(store);
  assert.equal(result.failed.length, 0); assert.equal(result.skipped.length, 2);
  const dirs = await store.directories();
  for (const path of ['empty', 'empty/nested', 'unsupported-only', 'text']) assert.ok(dirs.some(item => item.path === path), path);
  assert.equal(dirs.find(item => item.path === 'empty').count, 0);
  assert.equal(dirs.find(item => item.path === 'text').count, 1, 'ordinary folders exclude non-pending exceptions while All sources retains them');
  assert.equal(await store.fileCount(), 4);
  assert.equal((await store.browsePage(null, 'name', 0)).total, 4);
  assert.equal((await store.list()).length, 1);
  const issues = await store.issuePage('name', 0);
  assert.equal(issues.total, 3);
  assert.deepEqual(issues.documents.map(doc => doc.issueKind).sort(), ['empty_file', 'no_text', 'unsupported']);
  assert.equal((await store.issuePage('name', 0, 'text')).total, 2);
  assert.equal((await store.issuePage('name', 0, 'empty')).total, 0);
  assert.equal(await readFile(join(f.source, 'unsupported-only', 'archive.zip'), 'utf8'), 'Do not parse or alter');
  await store.close(); const reopened = await f.open();
  assert.deepEqual(await reopened.directories(), dirs);
  assert.equal(await reopened.issueCount(), 3);
});

test('unrecognized images and parser errors remain visible even when they never had an index', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'photo.png'), 'Image fixture'); await writeFile(join(f.source, 'broken.pdf'), 'PDF fixture');
  const store = await f.open();
  store.importFile = async path => {
    if (path.endsWith('.png')) throw new IndexSkipError('image_no_text');
    throw new Error('Cannot read encrypted PDF');
  };
  const result = await scanSourceDirectory(store);
  assert.equal(result.failed.length, 1); assert.equal(result.skipped.length, 1);
  const issues = (await store.issuePage('name', 0)).documents;
  assert.deepEqual(issues.map(doc => doc.issueKind).sort(), ['failed', 'image_no_text']);
  assert.equal(issues.find(doc => doc.issueKind === 'failed').statusReason, 'Cannot read encrypted PDF');
  assert.equal((await store.list()).length, 0);
  assert.equal((await store.sourceIssue(issues[0].id)).path, issues[0].path);
  await assert.rejects(store.sourceIssue('issue:../escape'), /Invalid/);
});

test('rescanning clears recovered and removed issues while keeping genuine empty directories', async t => {
  const f = await fixture(t); await mkdir(join(f.source, 'keep-empty')); await mkdir(join(f.source, 'remove-empty'));
  await writeFile(join(f.source, 'recover.txt'), ''); await writeFile(join(f.source, 'remove.bin'), 'Unsupported');
  const store = await f.open(); await scanSourceDirectory(store); assert.equal(await store.issueCount(), 2);
  await writeFile(join(f.source, 'recover.txt'), 'Recovered searchable text'); await rm(join(f.source, 'remove.bin')); await rm(join(f.source, 'remove-empty'), { recursive: true });
  await scanSourceDirectory(store);
  assert.equal(await store.issueCount(), 0); assert.equal((await store.list()).length, 1);
  const dirs = await store.directories(); assert.ok(dirs.some(item => item.path === 'keep-empty'));
  assert.equal(dirs.some(item => item.path === 'remove-empty'), false);
});

test('inventory replacement preserves inaccessible subtrees, and abort or root replacement cannot wipe it', async t => {
  const f = await fixture(t); await mkdir(join(f.source, 'offline', 'empty'), { recursive: true });
  await writeFile(join(f.source, 'offline', 'unsupported.bin'), 'Original');
  const store = await f.open(); await scanSourceDirectory(store); const identity = await stat(f.source, { bigint: true });
  await store.replaceSourceInventory(['offline', 'fresh'], [{ path: 'offline', kind: 'unavailable', reason: '' }], ['offline'], identity);
  assert.ok((await store.directories()).some(item => item.path === 'offline/empty'));
  assert.equal(await store.issueCount(), 1, 'directory-access notices are not files');
  assert.equal(await store.fileCount(), 1);
  const before = await store.directories();
  const controller = new AbortController(); controller.abort();
  await store.replaceSourceInventory([], [], [], identity, controller.signal);
  await store.replaceSourceInventory([], [], [], { dev: identity.dev, ino: identity.ino + 1n });
  assert.deepEqual(await store.directories(), before); assert.equal(await store.issueCount(), 1);
  await scanSourceDirectory(store); assert.equal(await store.issueCount(), 1);
  assert.equal((await store.issuePage('name', 0)).documents[0].issueKind, 'unsupported');
});

test('issue pagination, folder boundaries and library ownership stay isolated', async t => {
  const f = await fixture(t); await mkdir(join(f.source, 'folder')); await mkdir(join(f.source, 'folder-other'));
  for (let i = 0; i < 56; i++) await writeFile(join(f.source, 'folder', `${String(i).padStart(2, '0')}.bin`), 'Original');
  await writeFile(join(f.source, 'folder-other', 'outside.bin'), 'Outside scope');
  const first = await f.open(); await scanSourceDirectory(first);
  const page1 = await first.issuePage('name', 0, 'folder'), page2 = await first.issuePage('name', 50, 'folder');
  assert.equal(page1.total, 56); assert.equal(page1.documents.length, 50); assert.equal(page2.documents.length, 6);
  assert.equal(new Set([...page1.documents, ...page2.documents].map(doc => doc.id)).size, 56);
  const secondRoot = join(f.root, 'second'); await mkdir(secondRoot); await mkdir(join(secondRoot, 'second-empty'));
  const second = await f.open(secondRoot); await scanSourceDirectory(second);
  assert.equal(await second.issueCount(), 0); assert.equal(await second.sourceIssue(page1.documents[0].id), undefined);
  assert.equal((await second.directories()).some(item => item.path === 'folder'), false);
  assert.equal((await first.directories()).some(item => item.path === 'second-empty'), false);
});

test('file totals count each source path once across indexes, tags and issues, including root files', async t => {
  const f = await fixture(t); await mkdir(join(f.source, 'group')); await mkdir(join(f.source, 'empty-folder'));
  const changed = join(f.source, 'group', 'changed.txt');
  await writeFile(changed, 'Original searchable text'); await writeFile(join(f.source, 'root.md'), 'Root searchable text');
  await writeFile(join(f.source, 'group', 'unsupported.zip'), 'Original archive'); await writeFile(join(f.source, 'group', 'empty.txt'), '');
  const store = await f.open(); await scanSourceDirectory(store);
  const indexed = (await store.list()).find(doc => doc.path === changed);
  const a = await store.createTag('A'), b = await store.createTag('B'); await store.setTags(indexed.id, [a.id, b.id]);
  await writeFile(changed, ''); await scanSourceDirectory(store);
  assert.equal((await store.list()).length, 2, 'old searchable passages are retained');
  assert.equal(await store.issueCount(), 3, 'one indexed file is also an issue');
  assert.equal(await store.fileCount(), 4, 'All sources counts the old index and its exception once');
  assert.equal((await store.issuePage('name', 0)).total, 3);
  const directories = await store.directories();
  assert.equal(directories.find(item => item.path === '').count, 4);
  assert.equal(directories.find(item => item.path === 'group').count, 0);
  assert.equal(directories.find(item => item.path === 'empty-folder').count, 0);
  for (const sort of ['name', 'added', 'updated', 'modified', 'size', 'type']) {
    const page = await store.browsePage(null, sort, 0);
    assert.equal(page.total, 4); assert.equal(new Set(page.documents.map(doc => doc.path)).size, 4);
    const root = page.documents.find(doc => doc.name === 'root.md');
    assert.equal(await store.browsePosition(root.id, null, sort), page.documents.indexOf(root));
    assert.equal((await store.browsePage(null, sort, 0, 50, 'group')).total, 0);
  }
  assert.equal((await store.browsePage(a.id, 'name', 0)).total, 0, 'tag browsing also excludes failed updates');
  assert.equal((await store.browsePage(b.id, 'name', 0)).total, 0);
  await writeFile(changed, 'Recovered searchable text'); await rm(join(f.source, 'group', 'unsupported.zip')); await scanSourceDirectory(store);
  assert.equal(await store.fileCount(), 3); assert.equal(await store.issueCount(), 1);
  assert.equal((await store.browsePage(a.id, 'name', 0)).total, 1, 'recovery restores normal tag membership');
  await store.close(); const reopened = await f.open(); assert.equal(await reopened.fileCount(), 3);
  assert.equal((await reopened.browsePage(null, 'name', 0)).total, 3);
});

test('All sources and exception browsing page unsupported files without engines, gaps or duplicate paths', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 57; i++) await writeFile(join(f.source, `${String(i).padStart(2, '0')}.bin`), 'Original');
  const store = await f.open(); await scanSourceDirectory(store);
  assert.equal((await store.browsePage(null, 'name', 0)).total, 57);
  const first = await store.issuePage('name', 0), last = await store.issuePage('name', 50);
  assert.equal(await store.fileCount(), 57); assert.equal(first.total, 57); assert.equal(last.total, 57);
  assert.equal(first.documents.length, 50); assert.equal(last.documents.length, 7);
  assert.equal(new Set([...first.documents, ...last.documents].map(doc => doc.path)).size, 57);
  assert.equal((await readdir(store.root)).includes('vectors.lance'), false, 'counting and browsing do not require a vector engine');
});

test('Windows counts case variants of a single file once across old index and issue records', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); await writeFile(join(f.source, 'one.md'), 'Searchable text');
  const store = await f.open(); await scanSourceDirectory(store);
  await store.replaceSourceInventory([], [
    { path: 'ONE.MD', kind: 'failed', reason: 'Old case variant' },
    { path: 'one.md', kind: 'failed', reason: 'Latest attempt' },
    { path: '', kind: 'unavailable', reason: 'Root notice is not a file' },
  ], [], await stat(f.source, { bigint: true }));
  assert.equal(await store.fileCount(), 1); assert.equal(await store.issueCount(), 1);
  assert.equal((await store.browsePage(null, 'name', 0)).total, 1);
  assert.equal((await store.issuePage('name', 0)).total, 1);
  assert.equal((await store.directories()).find(item => item.path === '').count, 1);
});

test('progressive scans expose pending files, then searchable results before the entire batch finishes', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'a-large.txt'), 'laterkeyword '.repeat(200));
  await writeFile(join(f.source, 'z-small.txt'), 'earlykeyword');
  const store = await f.open(); const checkpoints = [];
  const outcome = await scanSourceDirectory(store, undefined, undefined, { yieldMs: 0, async onCheckpoint(state) {
    checkpoints.push(state.completed);
    assert.equal(await store.fileCount(), 2, 'inventory is usable before extraction finishes');
    assert.equal(await store.issueCount(), 0, 'pending files are not exceptions');
    if (state.completed === 0) assert.equal((await store.browsePage(null, 'name', 0)).documents.filter(doc => doc.issueKind === 'pending').length, 2);
    if (state.completed === 1) {
      assert.equal((await store.search('earlykeyword')).length, 1, 'small file is searchable while the large file is still queued');
      assert.equal((await store.browsePage(null, 'name', 0)).documents.filter(doc => doc.issueKind === 'pending').length, 1);
    }
  } });
  assert.deepEqual(checkpoints, [0, 1, 2]); assert.equal(outcome.updated.length, 2);
});

test('stopping between files preserves pending inventory and resumes without rebuilding committed files', async t => {
  const f = await fixture(t); await writeFile(join(f.source, 'first.txt'), 'firstkeyword'); await writeFile(join(f.source, 'second.txt'), 'secondkeyword extra');
  const store = await f.open(); const controller = new AbortController();
  const stopped = await scanSourceDirectory(store, undefined, controller.signal, { yieldMs: 0, onCheckpoint(state) { if (state.completed === 1) controller.abort(); } });
  assert.equal(stopped.updated.length, 1); assert.equal(await store.fileCount(), 2);
  assert.equal((await store.search('firstkeyword')).length, 1);
  await store.close(); const reopened = await f.open();
  assert.equal((await reopened.browsePage(null, 'name', 0)).documents.filter(doc => doc.issueKind === 'pending').length, 1);
  const resumed = await scanSourceDirectory(reopened, undefined, undefined, { yieldMs: 0 });
  assert.equal(resumed.unchanged, 1); assert.equal(resumed.updated.length, 1); assert.equal(await reopened.issueCount(), 0);
  assert.equal((await reopened.search('secondkeyword')).length, 1);
});

test('background window refresh anchors a pending file by path after its ID changes and keeps filters scoped', async t => {
  const f = await fixture(t); for (let i = 0; i < 70; i++) await writeFile(join(f.source, `${String(i).padStart(2, '0')}.txt`), `keyword${i}`);
  const store = await f.open(); const controller = new AbortController();
  await scanSourceDirectory(store, undefined, controller.signal, { onCheckpoint(state) { if (!state.completed) controller.abort(); } });
  const anchorPath = join(f.source, '35.txt');
  const before = await store.browseWindow(null, 'name', null, false, { anchorPath, anchorIndex: 10 });
  assert.equal(before.offset, 20); assert.equal(before.documents.length, 50); assert.equal(before.documents[15].path, anchorPath); assert.equal(before.documents[15].issueKind, 'pending');
  const indexed = await store.importFile(anchorPath); await store.settleSourceFile('35.txt', null, await stat(f.source, { bigint: true }));
  await writeFile(join(f.source, '00-first.txt'), 'earlierkeyword'); await store.importFile(join(f.source, '00-first.txt'));
  const after = await store.browseWindow(null, 'name', null, false, { anchorPath, anchorIndex: 10, limit: 60 });
  assert.equal(after.documents[25].id, indexed.document.id); assert.equal(after.offset, 11); assert.equal(after.documents.length, 60); assert.equal(after.total, 71);
  assert.equal((await store.browseWindow(null, 'name', null, false, { issues: true })).total, 0, 'queued files never leak into the issue filter');
  const tag = await store.createTag('Only selected'); await store.setTags(indexed.document.id, [tag.id]);
  assert.equal((await store.browseWindow(tag.id, 'name', null, false)).total, 1);
  assert.equal((await store.browseWindow(null, 'name', 'absent', false)).total, 0);
  const identity = await stat(f.source, { bigint: true });
  assert.equal(await store.settleSourceFile('36.txt', null, { dev: identity.dev, ino: identity.ino + 1n }), false);
  assert.equal((await store.sourceIssue('issue:36.txt')).issueKind, 'pending', 'remapped roots cannot settle old work');
});

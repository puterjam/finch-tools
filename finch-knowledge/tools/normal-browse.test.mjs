import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, realpath, readdir, copyFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nativeTarget } from './test-platform.mjs';
import { openSourceDirectory, scanSourceDirectory } from '../dist/index.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'knowledge-normal-browse-')));
  const source = join(root, 'sources'), cache = join(root, 'cache');
  await mkdir(source); const engine = join(cache, 'lancedb-engine', '0.39.0'); await mkdir(engine, { recursive: true });
  await copyFile(resolve(`node_modules/@lancedb/lancedb-${nativeTarget}/lancedb.${nativeTarget}.node`), join(engine, `lancedb.${nativeTarget}.node`));
  const store = await openSourceDirectory(source, cache);
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  const scan = () => scanSourceDirectory(store, undefined, undefined, { yieldMs: 0 });
  return { source, store, scan };
}

test('All sources includes exceptions while ordinary folders exclude them', async t => {
  const { source, store, scan } = await fixture(t); await mkdir(join(source, 'downloads'));
  await writeFile(join(source, 'good.md'), 'Normalkeyword');
  for (const name of ['setup.exe', 'tool.fapp', 'archive.zip']) await writeFile(join(source, 'downloads', name), 'Original binary fixture');
  await writeFile(join(source, 'downloads', 'empty.txt'), ''); await scan();
  assert.equal(await store.fileCount(), 5); assert.equal(await store.issueCount(), 4);
  assert.equal((await store.issuePage('name', 0)).total, 4);
  const dirs = await store.directories();
  assert.equal(dirs.find(dir => dir.path === '').count, 5); assert.equal(dirs.find(dir => dir.path === 'downloads').count, 0);
  for (const sort of ['name', 'added', 'updated', 'modified', 'size', 'type']) {
    const page = await store.browsePage(null, sort, 0);
    assert.equal(page.total, 5); assert.equal(page.documents.filter(doc => doc.issueKind && doc.issueKind !== 'pending').length, 4);
    assert.equal(new Set(page.documents.map(doc => doc.path)).size, 5);
    assert.equal((await store.browsePage(null, sort, 0, 50, 'downloads')).total, 0);
    assert.equal(await store.browsePosition(page.documents[0].id, null, sort), 0);
    const window = await store.browseWindow(null, sort, null, undefined);
    assert.equal(window.total, 5); assert.deepEqual(window.documents.map(doc => doc.path), page.documents.map(doc => doc.path));
  }
  assert.equal(await readFile(join(source, 'downloads', 'setup.exe'), 'utf8'), 'Original binary fixture');
});

test('failed updates retain their old index but disappear from normal tag pages and return after recovery', async t => {
  const { source, store, scan } = await fixture(t); await mkdir(join(source, 'notes'));
  const path = join(source, 'notes', 'note.txt');
  await writeFile(path, 'Beforekeyword'); await scan();
  const [original] = await store.list(), tag = await store.createTag('Work'); await store.setTags(original.id, [tag.id]);
  await writeFile(path, ''); await scan();
  assert.equal((await store.list()).length, 1, 'failure does not destroy committed passages');
  const all = await store.browsePage(null, 'name', 0);
  assert.equal(all.total, 1); assert.equal(all.documents[0].issueKind, 'empty_file');
  assert.equal(await store.fileCount(), 1, 'the old index and its exception count once');
  assert.equal((await store.browsePage(null, 'name', 0, 50, 'notes')).total, 0);
  assert.equal((await store.browsePage(tag.id, 'name', 0)).total, 0);
  assert.equal(await store.browsePosition(original.id, tag.id, 'name'), null);
  assert.equal((await store.tags()).find(item => item.id === tag.id).count, 0);
  assert.equal((await store.issuePage('name', 0)).total, 1);
  await writeFile(path, 'Recoveredkeyword'); await scan();
  const normal = await store.browsePage(tag.id, 'name', 0);
  assert.equal(normal.total, 1); assert.equal(normal.documents[0].id, original.id);
  assert.equal((await store.tags()).find(item => item.id === tag.id).count, 1); assert.equal(await store.issueCount(), 0);
});

test('pending supported files remain in normal browsing while actual exceptions stay separate', async t => {
  const { source, store } = await fixture(t); await mkdir(join(source, 'notes'));
  await writeFile(join(source, 'notes', 'queued.md'), 'Queuedkeyword');
  await store.replaceSourceInventory(['notes'], [{ path: 'notes/queued.md', kind: 'pending', reason: '' }, { path: 'notes/bad.exe', kind: 'unsupported', reason: '' }], [], await stat(source, { bigint: true }));
  assert.equal(await store.fileCount(), 2); assert.equal(await store.issueCount(), 1);
  const normal = await store.browsePage(null, 'name', 0, 50, 'notes');
  assert.equal(normal.total, 1); assert.equal(normal.documents[0].issueKind, 'pending');
  assert.equal((await store.browsePage(null, 'name', 0)).total, 2);
  const issues = await store.issuePage('name', 0);
  assert.equal(issues.total, 1); assert.equal(issues.documents[0].name, 'bad.exe');
  const window = await store.browseWindow(null, 'name', null, false);
  assert.equal(window.total, 2); assert.ok(window.documents.some(doc => doc.name === 'queued.md'));
});

test('an exception-only directory stays empty normally while its exception list paginates without gaps', async t => {
  const { source, store, scan } = await fixture(t); await mkdir(join(source, 'notes'));
  for (let i = 0; i < 57; i++) await writeFile(join(source, 'notes', `${String(i).padStart(2, '0')}.bin`), 'Original');
  await scan(); assert.equal(await store.fileCount(), 57); assert.equal((await store.browsePage(null, 'name', 0)).total, 57);
  assert.equal((await store.browsePage(null, 'name', 0, 50, 'notes')).total, 0);
  const allFirst = await store.browsePage(null, 'name', 0), allLast = await store.browsePage(null, 'name', 50);
  assert.equal(allFirst.documents.length, 50); assert.equal(allLast.documents.length, 7);
  assert.equal(new Set([...allFirst.documents, ...allLast.documents].map(doc => doc.path)).size, 57);
  const first = await store.issuePage('name', 0), last = await store.issuePage('name', 50);
  assert.equal(first.total, 57); assert.equal(first.documents.length, 50); assert.equal(last.documents.length, 7);
  assert.equal(new Set([...first.documents, ...last.documents].map(doc => doc.path)).size, 57);
  assert.equal((await readdir(store.root)).includes('vectors.lance'), false, 'exception browsing remains engine-free');
});

test('case-normalized exception paths cannot leak a previously indexed duplicate into normal browsing', async t => {
  const { source, store, scan } = await fixture(t); await mkdir(join(source, 'notes'));
  await writeFile(join(source, 'notes', 'note.md'), 'Casekeyword'); await scan();
  store.fileKey = path => path.toLowerCase();
  await store.replaceSourceInventory(['notes'], [{ path: 'notes/NOTE.MD', kind: 'failed', reason: 'Failed update' }], [], await stat(source, { bigint: true }));
  assert.equal(await store.fileCount(), 1); const all = await store.browsePage(null, 'name', 0);
  assert.equal(all.total, 1); assert.equal(all.documents[0].issueKind, 'failed');
  assert.equal((await store.browsePage(null, 'name', 0, 50, 'notes')).total, 0);
  assert.equal((await store.issuePage('name', 0)).total, 1); assert.equal((await store.list()).length, 1);
});

// Regression for a 16-file library shrinking to the last 11 rows after an anchored refresh.
test('a complete small library stays complete when the old reading anchor moves down', async t => {
  const { source, store, scan } = await fixture(t); await mkdir(join(source, 'notes'));
  for (let i = 0; i < 16; i++) await writeFile(join(source, 'notes', `${String(i).padStart(2, '0')}.${i < 12 ? 'txt' : 'exe'}`), `Windowkeyword${i}`);
  await scan();
  for (const sort of ['name', 'added', 'updated', 'modified', 'size', 'type']) {
    const full = await store.browsePage(null, sort, 0);
    assert.equal(full.total, 16);
    const refreshed = await store.browseWindow(null, sort, null, undefined, { anchorPath: full.documents[5].path, anchorIndex: 0, offset: 0, limit: 50 });
    assert.equal(refreshed.offset, 0, sort);
    assert.equal(refreshed.total, 16); assert.equal(refreshed.documents.length, 16, sort);
    assert.deepEqual(refreshed.documents.map(doc => doc.path), full.documents.map(doc => doc.path));
  }
});

test('a refresh near the end backfills a full window instead of returning an unreachable short tail', async t => {
  const { source, store, scan } = await fixture(t);
  for (let i = 0; i < 57; i++) await writeFile(join(source, `${String(i).padStart(2, '0')}.bin`), 'Original');
  await scan(); const first = await store.browsePage(null, 'name', 0), tail = await store.browsePage(null, 'name', 50);
  for (const issues of [false, true]) {
    const refreshed = await store.browseWindow(null, 'name', null, false, { issues, anchorPath: tail.documents[0].path, anchorIndex: 0, limit: 50 });
    assert.equal(refreshed.offset, 7); assert.equal(refreshed.total, 57); assert.equal(refreshed.documents.length, 50);
    assert.equal(refreshed.documents.at(-1).path, tail.documents.at(-1).path);
    assert.ok(refreshed.documents.some(doc => doc.path === first.documents[7].path));
  }
});

test('hide-unsupported filters before pagination and keeps empty/failed sources and original records', async t => {
  const { source, store, scan } = await fixture(t);
  for (let i = 0; i < 57; i++) await writeFile(join(source, `${String(i).padStart(2, '0')}.bin`), 'Original');
  await writeFile(join(source, 'good.txt'), 'Filterkeyword'); await writeFile(join(source, 'other.md'), 'Otherkeyword'); await writeFile(join(source, 'empty.txt'), '');
  await scan();
  assert.equal(await store.fileCount(), 60); assert.equal(await store.fileCount(true), 3);
  assert.equal(await store.issueCount(), 58); assert.equal(await store.issueCount(true), 1);
  assert.equal((await store.directories(true)).find(dir => dir.path === '').count, 3);
  for (const sort of ['name', 'added', 'updated', 'modified', 'size', 'type']) {
    const page = await store.browsePage(null, sort, 0, 50, null, undefined, true);
    assert.equal(page.total, 3); assert.equal(page.documents.length, 3);
    assert.equal(page.documents.some(doc => doc.issueKind === 'unsupported'), false);
    assert.ok(page.documents.some(doc => doc.issueKind === 'empty_file'));
    const window = await store.browseWindow(null, sort, null, undefined, { hideUnsupported: true, offset: 55 });
    assert.equal(window.offset, 0); assert.equal(window.documents.length, 3);
  }
  const errors = await store.issuePage('name', 0, null, false, true);
  assert.equal(errors.total, 1); assert.equal(errors.documents[0].issueKind, 'empty_file');
  assert.equal((await store.issuePage('name', 0)).total, 58, 'filtering never deletes original exception records');
  assert.equal(await readFile(join(source, '00.bin'), 'utf8'), 'Original');
});

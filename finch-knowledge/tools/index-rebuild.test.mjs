import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, realpath, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nativeTarget } from './test-platform.mjs';
import { openSourceDirectory, scanSourceDirectory } from '../dist/index.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'knowledge-rebuild-')));
  const source = join(root, 'sources'), cache = join(root, 'cache');
  await mkdir(source);
  const engine = join(cache, 'lancedb-engine', '0.39.0'); await mkdir(engine, { recursive: true });
  await copyFile(resolve(`node_modules/@lancedb/lancedb-${nativeTarget}/lancedb.${nativeTarget}.node`), join(engine, `lancedb.${nativeTarget}.node`));
  const stores = [];
  const open = async () => { const store = await openSourceDirectory(source, cache); stores.push(store); return store; };
  const legacy = async version => {
    const index = join(source, '.knowledge'); await mkdir(index);
    const db = new DatabaseSync(join(index, 'catalog.sqlite'));
    try { db.exec(`CREATE TABLE tags(id TEXT, name TEXT); INSERT INTO tags VALUES('old', 'Old tag'); PRAGMA user_version=${version};`); } finally { db.close(); }
    await mkdir(join(index, 'originals')); await writeFile(join(index, 'originals', 'old.md'), 'Historical managed copy');
  };
  t.after(async () => { for (const store of stores) await store.close(); await rm(root, { recursive: true, force: true }); });
  return { source, cache, open, legacy, backups: async () => (await readdir(source)).filter(name => name.startsWith('.knowledge-backup-')) };
}

for (const version of [0, 3, 5, 6]) {
  test(`old schema ${version} is backed up and rebuilt without changing source documents`, async t => {
    const f = await fixture(t); await f.legacy(version); await writeFile(join(f.source, 'note.md'), 'Rebuiltkeyword');
    const oldBytes = await readFile(join(f.source, '.knowledge', 'catalog.sqlite'));
    const store = await f.open();
    assert.equal(store.rebuiltIndex, true); assert.equal((await store.list()).length, 0);
    assert.equal((await store.tags()).some(tag => tag.name === 'Old tag'), false, 'old tags are not silently migrated');
    const backups = await f.backups(); assert.equal(backups.length, 1);
    const backup = join(f.source, backups[0]);
    assert.deepEqual(await readFile(join(backup, 'catalog.sqlite')), oldBytes);
    assert.equal(await readFile(join(backup, 'originals', 'old.md'), 'utf8'), 'Historical managed copy');
    const result = await scanSourceDirectory(store, undefined, undefined, { yieldMs: 0 });
    assert.equal(result.updated.length, 1, 'hidden backup data is never indexed as source documents');
    assert.equal((await store.search('Rebuiltkeyword')).length, 1);
    assert.equal(await readFile(join(f.source, 'note.md'), 'utf8'), 'Rebuiltkeyword');
    await store.close(); const reopened = await f.open();
    assert.equal(reopened.rebuiltIndex, false); assert.equal((await reopened.list()).length, 1);
    assert.equal((await f.backups()).length, 1, 'reopening must not repeatedly rebuild the same index');
  });
}

test('a populated ordinary folder with no previous index opens normally', async t => {
  const f = await fixture(t); await writeFile(join(f.source, 'note.md'), 'Normalkeyword');
  const store = await f.open(); assert.equal(store.rebuiltIndex, false); assert.equal((await f.backups()).length, 0);
  await scanSourceDirectory(store, undefined, undefined, { yieldMs: 0 }); assert.equal((await store.list()).length, 1);
});
test('current indexes preserve their tags and document identity', async t => {
  const f = await fixture(t); await writeFile(join(f.source, 'note.md'), 'Currentkeyword');
  const first = await f.open(); await scanSourceDirectory(first, undefined, undefined, { yieldMs: 0 });
  const [doc] = await first.list(), tag = await first.createTag('Current tag'); await first.setTags(doc.id, [tag.id]); await first.close();
  const next = await f.open(); assert.equal(next.rebuiltIndex, false);
  assert.equal((await next.list())[0].id, doc.id); assert.deepEqual((await next.list())[0].tags, [tag.id]);
  assert.equal((await f.backups()).length, 0);
});
test('a future index format is rejected rather than replaced by an older application', async t => {
  const f = await fixture(t); await f.legacy(7);
  const path = join(f.source, '.knowledge', 'catalog.sqlite'), before = await readFile(path);
  await assert.rejects(f.open(), error => error.code === 'KNOWLEDGE_FUTURE_INDEX');
  assert.deepEqual(await readFile(path), before); assert.equal((await f.backups()).length, 0);
});
test('corrupt databases do not trigger automatic destructive recovery', async t => {
  const f = await fixture(t); await mkdir(join(f.source, '.knowledge'));
  const path = join(f.source, '.knowledge', 'catalog.sqlite'); await writeFile(path, 'Not a SQLite database');
  await assert.rejects(f.open()); assert.equal(await readFile(path, 'utf8'), 'Not a SQLite database');
  assert.equal((await f.backups()).length, 0);
});
test('concurrent opens produce only one legacy backup', async t => {
  const f = await fixture(t); await f.legacy(5);
  const stores = await Promise.all([f.open(), f.open()]);
  assert.equal((await f.backups()).length, 1); assert.equal(stores.filter(store => store.rebuiltIndex).length, 1);
});

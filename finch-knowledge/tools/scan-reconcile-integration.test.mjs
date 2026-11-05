import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, realpath, rm, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import * as lance from '@lancedb/lancedb';
import { nativeTarget } from './test-platform.mjs';
import { openSourceDirectory, scanSourceDirectory } from '../dist/index.js';

async function fixture(t) {
  // Canonical paths avoid macOS /var -> /private/var aliases in source-boundary checks.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'knowledge-reconcile-')));
  const source = join(root, 'sources'), cache = join(root, 'cache');
  await mkdir(source); await mkdir(join(cache, 'lancedb-engine', '0.39.0'), { recursive: true });
  await copyFile(resolve(`node_modules/@lancedb/lancedb-${nativeTarget}/lancedb.${nativeTarget}.node`), join(cache, 'lancedb-engine', '0.39.0', `lancedb.${nativeTarget}.node`));
  const store = await openSourceDirectory(source, cache);
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  return { source, store };
}

test('a successful scan removes deleted files, folders, tags and passages from the real indexes', async t => {
  const { source, store } = await fixture(t);
  await mkdir(join(source, 'folder'));
  await writeFile(join(source, 'keep.md'), 'Keptuniquekeyword');
  await writeFile(join(source, 'gone.md'), 'Deleteduniquekeyword');
  await writeFile(join(source, 'folder', 'note.md'), 'Folderuniquekeyword');
  assert.equal((await scanSourceDirectory(store)).updated.length, 3);
  const tag = await store.createTag('Important');
  const deleted = (await store.list()).filter(doc => doc.name !== 'keep.md');
  for (const doc of deleted) await store.setTags(doc.id, [tag.id]);
  await rm(join(source, 'gone.md')); await rm(join(source, 'folder'), { recursive: true });
  const outcome = await scanSourceDirectory(store);
  assert.equal(outcome.removed.length, 2); assert.equal(outcome.unreachable.length, 0);
  assert.deepEqual((await store.list()).map(doc => doc.name), ['keep.md']);
  assert.equal((await store.page(null, 'name', 0)).total, 1);
  assert.equal((await store.search('Deleteduniquekeyword')).length, 0);
  assert.equal((await store.search('Folderuniquekeyword')).length, 0);
  assert.equal((await store.search('Keptuniquekeyword')).length, 1);
  const database = await lance.connect(join(source, '.knowledge', 'vectors.lance'));
  try { assert.equal(await (await database.openTable('passages_directory_v1')).countRows(), 1); } finally { database.close(); }
  assert.equal(await readFile(join(source, 'keep.md'), 'utf8'), 'Keptuniquekeyword');
});

test('unsupported historical catalogue entries are cleared without deleting their originals', async t => {
  const { source, store } = await fixture(t);
  const old = join(source, 'old.md'), unsupported = join(source, 'old.zip');
  await writeFile(old, 'Historicaluniquekeyword'); await scanSourceDirectory(store);
  const [doc] = await store.list();
  await rename(old, unsupported);
  const catalog = new DatabaseSync(join(source, '.knowledge', 'catalog.sqlite'));
  try { catalog.prepare('UPDATE documents SET path=?,source_path=?,relative_path=?,name=? WHERE id=?').run(unsupported, unsupported, 'old.zip', 'old.zip', doc.id); } finally { catalog.close(); }
  const result = await scanSourceDirectory(store);
  assert.equal(result.removed.length, 1); assert.equal((await store.list()).length, 0);
  assert.equal((await store.search('Historicaluniquekeyword')).length, 0);
  assert.equal(await readFile(unsupported, 'utf8'), 'Historicaluniquekeyword');
});

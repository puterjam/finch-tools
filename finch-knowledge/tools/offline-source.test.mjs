import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, realpath, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSourceDirectory, scanSourceDirectory } from '../dist/index.js';

async function fixture(t, sourceFilesystem) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'knowledge-offline-'))), source = join(root, 'source');
  await mkdir(source); await mkdir(join(root, 'cache'));
  const store = await openSourceDirectory(source, join(root, 'cache'), {sourceFilesystem});
  t.after(async () => { await store.close(); await rm(root, {recursive:true,force:true}); });
  return {root,source,store};
}
const identity = {network:true,identity:'smb://fixture/share'};

test('missing remote roots are rejected before network probing and retain cached inventory', async t => {
  let probes = 0;
  const {root,source,store} = await fixture(t, async () => { probes++; return identity; });
  await writeFile(join(source, 'original.bin'), 'Original'); await scanSourceDirectory(store);
  assert.equal(await store.fileCount(), 1); probes = 0;
  const offline = join(root, 'disconnected'); await rename(source, offline);
  await assert.rejects(store.assertSourceAvailable(), /no longer on disk/);
  await assert.rejects(scanSourceDirectory(store), /no longer on disk/);
  assert.equal(probes, 0, 'do not query a disconnected drive mapping after the root is missing');
  assert.equal(await store.fileCount(), 1); assert.equal(await store.issueCount(), 1);
  await rename(offline, source); await store.assertSourceAvailable(); assert.equal(probes, 1);
});

test('concurrent network probes coalesce and switching can interrupt their callers', async t => {
  let block = false, probes = 0, release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const {store} = await fixture(t, async () => { probes++; if (block) { entered(); await held; } return identity; });
  block = true; probes = 0;
  const one = store.assertSourceAvailable(), two = store.assertSourceAvailable();
  const rejected = Promise.all([assert.rejects(one, /cancel|abort/i), assert.rejects(two, /cancel|abort/i)]);
  await started; assert.equal(probes, 1); store.interrupt();
  await rejected; release(); store.resume(); await store.assertSourceAvailable();
});

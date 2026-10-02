import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { KnowledgeStore, UploadReceiver } from '../dist/index.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'finch-knowledge-upload-'));
  const target = process.platform === 'darwin' ? 'darwin-arm64' : `${process.platform}-${process.arch}-gnu`;
  const native = resolve(`node_modules/@lancedb/lancedb-${target}/lancedb.${target}.node`);
  const engine = join(root, 'lancedb-engine', '0.39.0');
  await mkdir(engine, { recursive: true });
  await symlink(native, join(engine, `lancedb.${target}.node`));
  const store = new KnowledgeStore(root);
  return { root, store, receiver: new UploadReceiver(root, store) };
}

async function send(receiver, name, content) {
  const data = Buffer.from(content);
  await receiver.begin(name, data.length);
  for (let offset = 0; offset < data.length; offset += 12) {
    await receiver.chunk(data.subarray(offset, offset + 12).toString('base64'));
  }
  return receiver.finish();
}

test('system-picker/drop bytes share chunked indexing, dedupe, replacement and managed-copy cleanup', async () => {
  const { root, store, receiver } = await fixture();
  try {
    const name = 'Field Notes.md';
    const first = await send(receiver, name, '# First\n\nA violet Finch records notes.');
    assert.equal(first.unchanged, false);
    const [doc] = await store.list();
    assert.equal(doc.name, name);
    assert.match(doc.path, /imports/);
    assert.equal((await store.search('violet Finch'))[0].name, name);
    const repeat = await send(receiver, name, '# First\n\nA violet Finch records notes.');
    assert.equal(repeat.unchanged, true);
    assert.equal((await store.list()).length, 1);
    const updated = await send(receiver, name, '# Second\n\nMint colored paper.');
    assert.equal(updated.unchanged, false);
    assert.equal((await store.list()).length, 1);
    assert.match((await readFile(doc.path, 'utf8')), /Mint colored/);
    const beforeFailure = await store.list();
    await receiver.begin(name, 3);
    await receiver.chunk(Buffer.from('   ').toString('base64'));
    await assert.rejects(receiver.finish(), /No extractable text/);
    assert.equal((await store.list())[0].id, beforeFailure[0].id);
    assert.match((await readFile(doc.path, 'utf8')), /Mint colored/);
    assert.equal(await store.remove(beforeFailure[0].id), true);
    await assert.rejects(stat(doc.path), { code: 'ENOENT' });
  } finally {
    await receiver.abort();
    await rm(root, { recursive: true, force: true });
  }
});

test('reject unsafe names, oversized declarations, incomplete and oversized chunks', async () => {
  const { root, receiver } = await fixture();
  try {
    await assert.rejects(receiver.begin('../secret.md', 3), /Invalid file name/);
    await assert.rejects(receiver.begin('secret.exe', 3), /Unsupported file type/);
    await assert.rejects(receiver.begin('guide.md', 64 * 1024 * 1024 + 1), /64 MB/);
    await receiver.begin('guide.md', 4);
    await receiver.chunk(Buffer.from('abc').toString('base64'));
    await assert.rejects(receiver.finish(), /incomplete/);
    await assert.rejects(receiver.chunk(Buffer.from('de').toString('base64')), /declared size/);
    await receiver.abort();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

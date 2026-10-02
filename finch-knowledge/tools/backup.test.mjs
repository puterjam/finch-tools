import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import * as lancedb from '@lancedb/lancedb';
import { BackupGate, createLibraryBackup, KnowledgeStore, UploadReceiver } from '../dist/index.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'finch-knowledge-backup-'));
  const library = join(root, 'live');
  const destination = join(root, 'nas');
  await mkdir(library); await mkdir(destination);
  const target = process.platform === 'darwin' ? 'darwin-arm64' : `${process.platform}-${process.arch}-gnu`;
  const native = resolve(`node_modules/@lancedb/lancedb-${target}/lancedb.${target}.node`);
  const engine = join(library, 'lancedb-engine', '0.39.0');
  await mkdir(engine, { recursive: true });
  await symlink(native, join(engine, `lancedb.${target}.node`));
  return { root, library, destination, store: new KnowledgeStore(library) };
}

async function upload(receiver, name, text, tagId) {
  const bytes = Buffer.from(text);
  await receiver.begin(name, bytes.length, tagId);
  await receiver.chunk(bytes.toString('base64'));
  return receiver.finish();
}

test('snapshot includes catalogue, vectors, copies, legacy originals and a checksum manifest', async () => {
  const { root, library, destination, store } = await fixture();
  try {
    const tag = await store.createTag('Research');
    const receiver = new UploadReceiver(library, store);
    await upload(receiver, 'managed.md', '# Backup\n\nManaged violet notes.', tag.id);
    const legacy = join(root, 'legacy.md');
    await writeFile(legacy, '# Archive\n\nOld notes copied from outside.');
    const present = await store.importFile(legacy, 'legacy.md');
    const removed = join(root, 'removed.md');
    await writeFile(removed, '# Gone\n\nThe original disappeared.');
    const absent = await store.importFile(removed, 'removed.md');
    await unlink(removed);
    const snapshot = await createLibraryBackup(store, library, destination);
    assert.equal(snapshot.documentCount, 3);
    assert.deepEqual(snapshot.missingSources.map((source) => source.id), [absent.document.id]);
    const manifest = JSON.parse(await readFile(join(snapshot.path, 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, 1);
    assert.equal(manifest.format, 'finch-knowledge-snapshot');
    assert.equal(manifest.documents, 3);
    assert.equal(manifest.tags[0].name, 'Research');
    assert.equal(manifest.sources.find((source) => source.id === present.document.id).archivePath, `external/${present.document.id}.md`);
    assert.match(await readFile(join(snapshot.path, 'external', `${present.document.id}.md`), 'utf8'), /Old notes/);
    assert.equal(manifest.sources.filter((source) => source.archivePath).length, 2);
    assert.equal(manifest.files.some((file) => file.path === 'catalog.sqlite'), true);
    assert.equal(manifest.files.some((file) => file.path.startsWith('vectors.lance/')), true);
    assert.equal(manifest.files.some((file) => file.path.startsWith('imports/')), true);
    assert.equal(manifest.files.some((file) => file.path.includes('lancedb-engine')), false);
    for (const file of manifest.files) {
      const checksum = createHash('sha256').update(await readFile(join(snapshot.path, file.path))).digest('hex');
      assert.equal(checksum, file.sha256, file.path);
    }
    const catalog = new DatabaseSync(join(snapshot.path, 'catalog.sqlite'));
    assert.equal(catalog.prepare('SELECT COUNT(*) AS n FROM documents').get().n, 3);
    catalog.close();
    const db = await lancedb.connect(join(snapshot.path, 'vectors.lance'));
    assert.equal((await db.tableNames()).length, 2);
    assert.equal((await store.list()).length, 3);
    assert.equal((await readdir(destination)).length, 1);
    await assert.rejects(createLibraryBackup(store, library, join(library, 'imports')), /inside the live library/);
    assert.equal((await readdir(destination)).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('backup gate excludes imports and edits until the snapshot ends', async () => {
  const gate = new BackupGate();
  const release = gate.reserveWrite();
  await assert.rejects(gate.snapshot(async () => 1), /Finish current imports/);
  release(); release();
  let finish;
  const waiting = gate.snapshot(() => new Promise((resolve) => { finish = resolve; }));
  assert.throws(() => gate.reserveWrite(), /backup is in progress/);
  await assert.rejects(gate.snapshot(async () => 1), /Finish current imports/);
  finish(7);
  assert.equal(await waiting, 7);
  assert.equal(await gate.write(async () => 8), 8);
});

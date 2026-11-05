import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, realpath, writeFile, readFile, readdir, rename, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureLink, fixtureRm, nativeTarget } from './test-platform.mjs';
import { inspectSourceFilesystem, remoteIndexKey, remoteIndexRoot, openSourceDirectory, scanSourceDirectory, KnowledgeStore, pickDirectory } from '../dist/index.js';

const windows = provider => ({ run: async () => JSON.stringify({ type: 4, root: provider }) });
test('Windows UNC, extended UNC and mapped paths identify the same share subdirectory', async () => {
  const unc = await inspectSourceFilesystem('\\\\NAS\\资料\\工作', 'win32');
  const extended = await inspectSourceFilesystem('\\\\?\\UNC\\nas\\资料\\工作', 'win32');
  const mapped = await inspectSourceFilesystem('Z:\\工作', 'win32', windows('\\\\nas\\资料'));
  assert.equal(unc.network, true); assert.deepEqual(extended, unc); assert.deepEqual(mapped, unc);
  const child = await inspectSourceFilesystem('Z:\\其他', 'win32', windows('\\\\nas\\资料'));
  assert.notEqual(remoteIndexKey(child.identity), remoteIndexKey(mapped.identity));
  const replaced = await inspectSourceFilesystem('Z:\\工作', 'win32', windows('\\\\other-nas\\资料'));
  assert.notEqual(remoteIndexKey(replaced.identity), remoteIndexKey(mapped.identity), 'reusing a drive letter must not reuse another share index');
});

test('fixed and removable Windows disks retain source-local index placement', async () => {
  for (const type of [2, 3]) assert.equal((await inspectSourceFilesystem('E:\\Local folder', 'win32', { run: async () => JSON.stringify({ type }) })).network, false);
  await assert.rejects(inspectSourceFilesystem('Z:\\Share', 'win32', { run: async () => JSON.stringify({ type: 4 }) }), /identity/);
  await assert.rejects(inspectSourceFilesystem('Z:\\Share', 'win32', { run: async () => { throw new Error('probe unavailable'); } }), /probe unavailable/);
});

test('macOS mount detection handles spaces, longest mounts, aliases and remounted shares', async () => {
  const table = '/dev/disk1s1 on / (apfs, local)\n//user@nas/share on /Volumes/My Share (smbfs, nodev)\n/dev/disk2s1 on /Volumes/USB (exfat, local)\n';
  const probe = { run: async () => table };
  const remote = await inspectSourceFilesystem('/Volumes/My Share/notes', 'darwin', probe);
  assert.equal(remote.network, true);
  assert.equal((await inspectSourceFilesystem('/Volumes/My Share2/notes', 'darwin', probe)).network, false);
  assert.equal((await inspectSourceFilesystem('/Volumes/USB/notes', 'darwin', probe)).network, false);
  const alias = await inspectSourceFilesystem('/Volumes/Other/notes', 'darwin', { run: async () => table.replace('/Volumes/My Share', '/Volumes/Other') });
  assert.equal(alias.identity, remote.identity);
  const replaced = await inspectSourceFilesystem('/Volumes/My Share/notes', 'darwin', { run: async () => table.replace('user@nas/share', 'user@different/share') });
  assert.notEqual(replaced.identity, remote.identity);
});

test('Linux CIFS and NFS mountinfo selects the longest matching decoded mountpoint', async () => {
  const table = '1 0 0:1 / / rw - ext4 /dev/root rw\n2 1 0:2 / /mnt/My\\040Share rw - cifs //nas/share rw\n3 1 0:3 / /mnt/nfs rw - nfs4 nas:/export rw\n4 2 0:4 / /mnt/My\\040Share/local rw - ext4 /dev/local rw\n';
  const probe = { read: async () => table };
  assert.equal((await inspectSourceFilesystem('/mnt/My Share/docs', 'linux', probe)).network, true);
  assert.equal((await inspectSourceFilesystem('/mnt/nfs/docs', 'linux', probe)).network, true);
  assert.equal((await inspectSourceFilesystem('/mnt/My Share/local/docs', 'linux', probe)).network, false);
  assert.equal((await inspectSourceFilesystem('/mnt/nfs2/docs', 'linux', probe)).network, false);
  await assert.rejects(inspectSourceFilesystem('/mnt/share', 'linux', { read: async () => '' }), /determine/);
});

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'knowledge-network-')));
  const source = join(root, 'remote'), second = join(root, 'other-remote'), cache = join(root, 'local-cache');
  await mkdir(source); await mkdir(second);
  const engine = join(cache, 'lancedb-engine', '0.39.0'); await mkdir(engine, { recursive: true });
  await fixtureLink(resolve(`node_modules/@lancedb/lancedb-${nativeTarget}/lancedb.${nativeTarget}.node`), join(engine, `lancedb.${nativeTarget}.node`));
  const stores = [];
  const open = async (directory = source, identity = `smb://nas/share/${directory === source ? 'first' : 'second'}`) => {
    const store = await openSourceDirectory(directory, cache, { sourceFilesystem: async () => ({ network: true, identity }) });
    stores.push(store); return store;
  };
  t.after(async () => { for (const store of stores) await store.close(); await fixtureRm(root, { recursive: true, force: true }); });
  return { root, source, second, cache, open };
}

test('remote scanning writes neither SQLite nor vectors nor tags into the source directory', async t => {
  const f = await fixture(t); const path = join(f.source, 'notes.md');
  await writeFile(path, 'remoteword'); const before = await stat(path);
  const store = await f.open(); const scan = await scanSourceDirectory(store); assert.deepEqual(scan.failed, []);
  const tag = await store.createTag('Only on this computer'); await store.addTag((await store.list())[0].id, tag.id);
  assert.equal(store.indexStorage, 'local'); assert.ok(store.root.startsWith(f.cache));
  assert.equal((await stat(join(store.root, 'catalog.sqlite'))).isFile(), true);
  assert.equal((await stat(join(store.root, 'vectors.lance'))).isDirectory(), true);
  assert.deepEqual(await readdir(f.source), ['notes.md']);
  assert.equal(await readFile(path, 'utf8'), 'remoteword'); assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
  assert.ok((await store.search('remoteword')).length > 0);
});

test('each remote directory gets independent local documents, search and tags; reopening reuses them', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'same.md'), 'firstonlyword'); await writeFile(join(f.second, 'same.md'), 'secondonlyword');
  const a = await f.open(), b = await f.open(f.second);
  assert.notEqual(a.root, b.root); await scanSourceDirectory(a); await scanSourceDirectory(b);
  const tag = await a.createTag('First only'); const id = (await a.list())[0].id; await a.addTag(id, tag.id);
  assert.equal((await b.tags()).some(tag => tag.name === 'First only'), false);
  assert.equal((await b.search('firstonlyword')).length, 0);
  const index = a.root; await a.close();
  const reopened = await f.open(); assert.equal(reopened.root, index);
  assert.equal((await reopened.list())[0].id, id); assert.ok((await reopened.tags()).some(item => item.id === tag.id));
  assert.equal((await scanSourceDirectory(reopened)).unchanged, 1);
});

test('a disconnected source cannot clear the local catalogue, and reconnecting resumes it', async t => {
  const f = await fixture(t); await writeFile(join(f.source, 'notes.md'), 'keepthisindex');
  const store = await f.open(); await scanSourceDirectory(store);
  const id = (await store.list())[0].id; const index = store.root;
  await rename(f.source, `${f.source}-offline`);
  await assert.rejects(scanSourceDirectory(store), {message:'The library folder is no longer on disk.'}); assert.equal((await store.list())[0].id, id);
  await assert.rejects(f.open(), /ENOENT/); assert.equal((await stat(join(index, 'catalog.sqlite'))).isFile(), true);
  await rename(`${f.source}-offline`, f.source); await store.close();
  assert.equal((await (await f.open()).list())[0].id, id);
});

test('old network-side .knowledge data is left untouched instead of opened or migrated', async t => {
  const f = await fixture(t); await mkdir(join(f.source, '.knowledge'));
  const old = join(f.source, '.knowledge', 'catalog.sqlite'); await writeFile(old, 'Leave the remote database untouched');
  const store = await f.open(); assert.equal((await store.list()).length, 0);
  assert.equal(await readFile(old, 'utf8'), 'Leave the remote database untouched');
});

test('local folders still use their existing .knowledge indexes', async t => {
  const f = await fixture(t); const store = await openSourceDirectory(f.source, f.cache);
  try { assert.equal(store.root, join(f.source, '.knowledge')); assert.equal(store.indexStorage, 'source'); }
  finally { await store.close(); }
});

test('unknown mounts fail before writing, and remote indexes cannot escape local storage', async t => {
  const f = await fixture(t);
  await assert.rejects(openSourceDirectory(f.source, f.cache, { sourceFilesystem: async () => { throw new Error('Cannot identify mount'); } }), /identify/);
  assert.deepEqual(await readdir(f.source), []);
  assert.throws(() => remoteIndexRoot(f.cache, '../escape'), /identity/);
  assert.throws(() => new KnowledgeStore(join(f.root, 'arbitrary'), { directoryRoot: f.source, cachePath: f.cache, remoteIndexKey: remoteIndexKey('smb://nas/share') }), /Only source-directory/);
  await assert.rejects(openSourceDirectory(f.source, f.source, { sourceFilesystem: async () => ({ network: true, identity: 'remote' }) }), /local Finch cache/);
  assert.deepEqual(await readdir(f.source), []);
});

test('Linux bind mounts of different share subdirectories never share an index identity', async () => {
  const table = '1 0 0:1 / / rw - ext4 /dev/root rw\n2 1 0:2 /a /mnt/a rw - cifs //nas/share rw\n3 1 0:2 /b /mnt/b rw - cifs //nas/share rw\n4 1 0:2 /a /mnt/alias rw - cifs //nas/share rw\n';
  const probe = { read: async () => table };
  const a = await inspectSourceFilesystem('/mnt/a/notes', 'linux', probe);
  const b = await inspectSourceFilesystem('/mnt/b/notes', 'linux', probe);
  const alias = await inspectSourceFilesystem('/mnt/alias/notes', 'linux', probe);
  assert.notEqual(a.identity, b.identity); assert.equal(a.identity, alias.identity);
});

test('an empty leftover mountpoint or a remapped share cannot erase the old remote catalogue', async t => {
  const f = await fixture(t); await writeFile(join(f.source, 'notes.md'), 'preserveacrossdisconnect');
  const original = { network: true, identity: 'smb://nas/share/first' };
  let mounted = original;
  const store = await openSourceDirectory(f.source, f.cache, { sourceFilesystem: async () => mounted });
  try {
    await scanSourceDirectory(store); const id = (await store.list())[0].id;
    await rename(f.source, `${f.source}-mounted`); await mkdir(f.source);
    mounted = { network: false, identity: 'local-empty-mountpoint' };
    await assert.rejects(scanSourceDirectory(store), /disconnected or mapped/);
    assert.equal((await store.list())[0].id, id);
    mounted = { network: true, identity: 'smb://other-nas/share/first' };
    await assert.rejects(scanSourceDirectory(store), /disconnected or mapped/);
    await writeFile(join(f.source, 'wrong.md'), 'wrongshare');
    await assert.rejects(store.importFile(join(f.source, 'wrong.md'), 'wrong.md', 'default'), /disconnected or mapped/);
    assert.equal((await store.list()).length, 1);
  } finally { await store.close(); }
});

test('Windows initialization accepts selected SMB locations before any library exists', async () => {
  const expected = await inspectSourceFilesystem('\\\\nas\\资料\\工作', 'win32');
  for (const path of ['\\\\nas\\资料\\工作', '\\\\?\\UNC\\nas\\资料\\工作', 'Z:\\工作', '\\\\?\\Z:\\工作']) {
    const selected = await pickDirectory('Choose first library', '', async () => ({ stdout: 'True\r\nFINCH_DIRECTORY:' + Buffer.from(path, 'utf8').toString('base64') }), 'win32');
    const filesystem = await inspectSourceFilesystem(selected, 'win32', windows('\\\\nas\\资料'));
    assert.deepEqual(filesystem, expected);
    assert.equal(remoteIndexKey(filesystem.identity), remoteIndexKey(expected.identity));
  }
});
test('Windows extended local filesystem paths keep local index placement', async () => {
  assert.equal((await inspectSourceFilesystem('\\\\?\\C:\\资料', 'win32', { run: async () => JSON.stringify({ type: 3 }) })).network, false);
});

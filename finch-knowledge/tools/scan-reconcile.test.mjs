import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { posix, win32 } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { test } from 'node:test';
import { transform } from 'esbuild';

// Exercise the actual scanner with deterministic filesystem responses, including Windows paths.
const source = process.env.KNOWLEDGE_SCAN_BASELINE
  ? execFileSync('git', ['show', 'HEAD:finch-knowledge/src/source-directory.ts'], { encoding: 'utf8' })
  : await readFile(new URL('../src/source-directory.ts', import.meta.url), 'utf8');
const start = source.includes('const pathKey =') ? source.indexOf('const pathKey =') : source.indexOf('const inside =');
const helpers = source.slice(start, source.indexOf('/** Sources must stay'));
const scanner = source.slice(source.indexOf('export async function scanSourceDirectory')).replace('export async', 'async');
const { code } = await transform(`${helpers}\n${scanner}`, { loader: 'ts' });
const info = (kind = 'file', ino = 1) => ({ dev: 1, ino, isFile: () => kind === 'file', isDirectory: () => kind === 'directory', isSymbolicLink: () => kind === 'link' });
const entry = (name, kind = 'file') => ({ name, ...info(kind) });
const failure = code => Object.assign(new Error(code), { code });

function fixture(platform = 'win32') {
  const paths = platform === 'win32' ? win32 : posix;
  const root = platform === 'win32' ? 'C:\\Library' : '/library';
  const key = value => platform === 'win32' ? paths.resolve(value).toLowerCase() : paths.resolve(value);
  const nodes = new Map([[key(root), info('directory')]]);
  const listings = new Map([[key(root), []]]);
  const blocked = new Set(), docs = new Map(), vectors = new Set(), removed = [], imported = [], readDirectories = [];
  let rootInode = 1, checks = 0;
  const probed=new Set();
  const lookup = async path => {
    probed.add(key(path));
    if (blocked.has(key(path))) throw failure('EACCES');
    const found = nodes.get(key(path));
    if (!found) throw failure('ENOENT');
    return key(path) === key(root) ? info('directory', rootInode) : found;
  };
  const store = {
    directoryRoot: root,
    assertScan:()=>{},beginSourceScan: async()=> 'scan', discoverSourceBatch:async()=>{}, recordScanMetadata:async()=>{},recordScanDirectory:()=>{},finishSourceScan:async()=>{},interruptSourceScan:()=>{},
    assertSourceAvailable: async () => { checks++; },
    list: async () => [...docs.values()],
    document: async id => docs.get(id),
    relocateSource: async () => undefined,
    replaceSourceInventory: async (folders, issues, blocked) => { store.inventory = { folders, issues, blocked }; },
    importFile: async path => { imported.push(path); return { unchanged: true }; },
    settleSourceFile: async () => true,
    remove: async id => { docs.delete(id); vectors.delete(id); removed.push(id); return true; },
  };
  const context = createContext({ ...paths, setTimeout, clearTimeout, setImmediate, process: { platform }, ACCEPTED: ['.md', '.txt', '.pdf'], DEFAULT_TAG: 'default', INDEX_DIRECTORY: '.knowledge', IndexSkipError: class extends Error {},
    stat: lookup, lstat: lookup,
    opendir: async path => {
      readDirectories.push(path);
      if(blocked.has(key(path)))throw failure('EACCES');
      if(!listings.has(key(path)))throw failure('ENOENT');
      return {async *[Symbol.asyncIterator](){yield* listings.get(key(path));}};
    },
    readdir: async path => {
      readDirectories.push(path);
      if (blocked.has(key(path))) throw failure('EACCES');
      if (!listings.has(key(path))) throw failure('ENOENT');
      return listings.get(key(path));
    },
  });
  runInContext(code, context);
  function tracked(path, id = 'doc') { docs.set(id, { id, path, tags: ['important'] }); vectors.add(id); return path; }
  function file(name) { const path = paths.join(root, name); nodes.set(key(path), info()); listings.get(key(root)).push(entry(name)); return path; }
  return { root, paths, key, nodes, listings, blocked, docs, vectors, removed, imported, readDirectories, probed, store, tracked, file,
    scan: signal => context.scanSourceDirectory(store, undefined, signal),
    setRootInode: value => { rootInode = value; }, get checks() { return checks; },
  };
}

for (const platform of ['win32', 'linux']) {
  test(`${platform}: deleted files and whole subtrees disappear after a scan`, async () => {
    const f = fixture(platform);
    f.tracked(f.paths.join(f.root, 'gone.md'), 'file');
    f.tracked(f.paths.join(f.root, 'deleted', 'nested', 'note.md'), 'tree');
    const result = await f.scan();
    assert.equal(result.removed.length, 2); assert.equal(result.unreachable.length, 0);
    assert.equal(f.docs.size, 0); assert.equal(f.vectors.size, 0);
  });
  test(`${platform}: unsupported historical entries are removed from indexes, not source files`, async () => {
    const f = fixture(platform), path = f.file('old.zip'); f.tracked(path);
    const result = await f.scan();
    assert.equal(result.removed.length, 1); assert.equal(f.docs.size, 0); assert.equal(f.vectors.size, 0);
    assert.equal(f.nodes.has(f.key(path)), true, 'original is untouched');
    assert.equal(f.imported.length, 0, 'unsupported sources never reach the indexer');
  });
  test(`${platform}: inaccessible directories keep their indexes instead of becoming deletions`, async () => {
    const f = fixture(platform), sub = f.paths.join(f.root, 'offline');
    f.listings.get(f.key(f.root)).push(entry('offline', 'directory'));
    f.nodes.set(f.key(sub), info('directory')); f.blocked.add(f.key(sub));
    f.tracked(f.paths.join(sub, 'note.md'));
    const result = await f.scan();
    assert.equal(result.removed.length, 0); assert.ok(result.unreachable.length);
    assert.equal(f.docs.size, 1); assert.equal(f.vectors.size, 1);
  });
}

test('Windows: drive and ancestor casing do not turn confirmed deletions into unavailable sources', async () => {
  const f = fixture();
  f.tracked('c:\\library\\Deleted\\meeting.md');
  const result = await f.scan();
  assert.equal(result.removed.length, 1); assert.equal(result.unreachable.length, 0);
  assert.equal(f.docs.size, 0);
});
test('Windows: a supported source with different catalogue casing stays indexed', async () => {
  const f = fixture(); f.file('Meeting.MD'); f.tracked('c:\\library\\meeting.md');
  const result = await f.scan();
  assert.equal(result.removed.length, 0); assert.equal(f.docs.size, 1); assert.equal(f.imported.length, 1);
});
test('a disconnected network share never prunes its catalogue', async () => {
  const f = fixture(); f.tracked(f.paths.join(f.root, 'note.md'));
  f.store.assertSourceAvailable = async () => { throw new Error('share offline'); };
  await assert.rejects(f.scan(), /share offline/); assert.equal(f.docs.size, 1);
});
test('an unavailable root never prunes the catalogue', async () => {
  const f = fixture(); f.tracked(f.paths.join(f.root, 'note.md')); f.blocked.add(f.key(f.root));
  await assert.rejects(f.scan(), /EACCES/); assert.equal(f.docs.size, 1);
});
test('root replacement before cleanup preserves missing and unsupported entries', async () => {
  const f = fixture(); f.tracked(f.file('old.zip'), 'unsupported'); f.tracked(f.paths.join(f.root, 'gone.md'), 'missing');
  let checks = 0;
  f.store.assertSourceAvailable = async () => { if (++checks === 2) f.setRootInode(2); };
  const result = await f.scan();
  assert.equal(result.removed.length, 0); assert.equal(f.docs.size, 2);
});
test('a file recreated before cleanup is retained', async () => {
  const f = fixture(), path = f.tracked(f.paths.join(f.root, 'gone.md'));
  let checks = 0;
  f.store.assertSourceAvailable = async () => { if (++checks === 2) f.nodes.set(f.key(path), info()); };
  const result = await f.scan(); assert.equal(result.removed.length, 0); assert.equal(f.docs.size, 1);
});
test('cancelling a scan cannot prune unseen documents', async () => {
  const f = fixture(); f.tracked(f.paths.join(f.root, 'gone.md'));
  const result = await f.scan({ aborted: true }); assert.equal(result.removed.length, 0); assert.equal(f.docs.size, 1);
});

test('Windows system directories are skipped case-insensitively without attempting access or reporting warnings', async () => {
  const f = fixture();
  for (const name of ['$RECYCLE.BIN', 'system volume information']) {
    const directory = f.paths.join(f.root, name);
    f.listings.get(f.key(f.root)).push(entry(name, 'directory'));
    f.nodes.set(f.key(directory), info('directory')); f.blocked.add(f.key(directory));
  }
  f.tracked(f.file('keep.md'));
  const result = await f.scan();
  assert.equal(f.readDirectories.length, 1, 'only the source root is read');
  assert.equal(result.unreachable.length, 0); assert.equal(result.failed.length, 0);
  assert.equal(f.docs.size, 1); assert.equal(f.imported.length, 1);
});
test('historical entries under excluded Windows system directories leave the catalogue without touching originals', async () => {
  const f = fixture(), directory = f.paths.join(f.root, '$Recycle.Bin');
  const path = f.paths.join(directory, 'SID', 'note.md');
  f.listings.get(f.key(f.root)).push(entry('$Recycle.Bin', 'directory'));
  f.blocked.add(f.key(directory)); f.nodes.set(f.key(path), info()); f.tracked(path);
  const result = await f.scan();
  assert.equal(result.removed.length, 1); assert.equal(result.unreachable.length, 0);
  assert.equal(f.docs.size, 0); assert.equal(f.nodes.has(f.key(path)), true);
  assert.equal(f.readDirectories.length, 1);
});
test('ordinary folders with similar names are not silently excluded', async () => {
  const f = fixture(), name = 'System Volume Information notes', directory = f.paths.join(f.root, name);
  f.listings.get(f.key(f.root)).push(entry(name, 'directory'));
  f.nodes.set(f.key(directory),info('directory')); f.blocked.add(f.key(directory)); f.tracked(f.paths.join(directory, 'note.md'));
  const result = await f.scan();
  assert.ok(result.unreachable.length); assert.equal(f.docs.size, 1);
  assert.ok(f.probed.has(f.key(directory)),'ordinary similar names must reach the metadata safety probe');
  assert.equal(f.readDirectories.length, 1,'a failed metadata guard must prevent directory enumeration');
});

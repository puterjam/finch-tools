import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { hideKnowledgeDirectory, openSourceDirectory } from '../dist/index.js';

const execute = promisify(execFile);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-hidden-'));
  const source = join(root, "source folder's notes"), directory = join(source, '.knowledge');
  await mkdir(directory, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, source, directory };
}

test('Windows hides only the index directory with a literal non-recursive attrib call', async t => {
  const f = await fixture(t); const calls = [];
  assert.equal(await hideKnowledgeDirectory(f.directory, { platform: 'win32', run: async (...args) => { calls.push(args); } }), true);
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /[\\/]System32[\\/]attrib\.exe$/i);
  assert.deepEqual(calls[0][1], ['+H', f.directory]);
});

test('reopening an existing index safely reapplies only its Hidden attribute', async t => {
  const f = await fixture(t); const calls = [];
  const options = { platform: 'win32', run: async (...args) => { calls.push(args); } };
  await hideKnowledgeDirectory(f.directory, options); await hideKnowledgeDirectory(f.directory, options);
  assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
});

test('macOS and Linux dot directories do not invoke attribute commands', async t => {
  const f = await fixture(t);
  for (const platform of ['darwin', 'linux']) assert.equal(await hideKnowledgeDirectory(f.directory, { platform, run: async () => assert.fail('No native command needed') }), true);
});

test('source folders, files and index links cannot become attribute targets', async t => {
  const f = await fixture(t); const options = { platform: 'win32', run: async () => assert.fail('Unsafe target') };
  assert.equal(await hideKnowledgeDirectory(f.source, options), false);
  const file = join(f.root, '.knowledge'); await writeFile(file, 'Not a directory');
  assert.equal(await hideKnowledgeDirectory(file, options), false);
  const parent = join(f.root, 'linked'); await mkdir(parent);
  const link = join(parent, '.knowledge');
  await symlink(f.directory, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await hideKnowledgeDirectory(link, options), false);
});

test('unsupported attributes or denied access are nonfatal and leave contents intact', async t => {
  const f = await fixture(t); const path = join(f.directory, 'sentinel'); await writeFile(path, 'Keep this data');
  assert.equal(await hideKnowledgeDirectory(f.directory, { platform: 'win32', run: async () => { throw new Error('Access denied'); } }), false);
  assert.equal(await readFile(path, 'utf8'), 'Keep this data');
});

test('real Windows opens hide both new and existing indexes without hiding originals', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); const original = join(f.source, 'source.txt'); await writeFile(original, 'Original source');
  const command = join(process.env.SystemRoot, 'System32', 'attrib.exe');
  const attributes = async path => {
    const { stdout } = await execute(command, [path], { windowsHide: true });
    const position = stdout.toLowerCase().indexOf(path.toLowerCase());
    assert.ok(position >= 0, `Expected exact target in attrib output: ${stdout}`);
    return stdout.slice(0, position).replace(/\s/g, '');
  };
  const sourceBefore = await attributes(f.source), fileBefore = await attributes(original);
  // Open a fresh directory, then deliberately unhide it and verify re-opening repairs it.
  await rm(f.directory, { recursive: true });
  const store = await openSourceDirectory(f.source, join(f.root, 'cache'), { sourceFilesystem: async () => ({ network: false, identity: f.source }) });
  try { assert.ok((await attributes(f.directory)).includes('H')); assert.equal((await store.list()).length, 0); }
  finally { await store.close(); }
  await execute(command, ['-H', f.directory], { windowsHide: true }); assert.equal((await attributes(f.directory)).includes('H'), false);
  const reopened = await openSourceDirectory(f.source, join(f.root, 'cache'), { sourceFilesystem: async () => ({ network: false, identity: f.source }) });
  try { assert.ok((await attributes(f.directory)).includes('H')); assert.equal((await reopened.list()).length, 0); }
  finally { await reopened.close(); }
  assert.equal(await attributes(f.source), sourceBefore); assert.equal(await attributes(original), fileBefore);
  assert.equal(await readFile(original, 'utf8'), 'Original source');
});

test('opening a network library never changes attributes on its old remote .knowledge', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); const cache = join(f.root, 'cache'); await mkdir(cache);
  const sentinel = join(f.directory, 'sentinel'); await writeFile(sentinel, 'Remote index must stay untouched');
  const command = join(process.env.SystemRoot, 'System32', 'attrib.exe');
  const before = (await execute(command, [f.directory], { windowsHide: true })).stdout;
  const store = await openSourceDirectory(f.source, cache, { sourceFilesystem: async () => ({ network: true, identity: 'smb://nas/hidden-test' }) });
  try {
    assert.equal(store.indexStorage, 'local');
    assert.equal((await execute(command, [f.directory], { windowsHide: true })).stdout, before);
    assert.equal(await readFile(sentinel, 'utf8'), 'Remote index must stay untouched');
  } finally { await store.close(); }
});

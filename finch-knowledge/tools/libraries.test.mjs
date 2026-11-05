import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LibraryRegistry, isLibraryScoped } from '../dist/index.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-registry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let data;
  let fail = false;
  const writes = [];
  const registry = new LibraryRegistry(async () => structuredClone(data), async next => {
    if (fail) throw new Error('storage failure');
    data = structuredClone(next); writes.push(data);
  });
  return { root, registry, writes, get data() { return data; }, set data(value) { data = value; }, fail(value) { fail = value; },
    reload: async current => { const next = new LibraryRegistry(async () => structuredClone(data), async value => { data = structuredClone(value); }); await next.load(current); return next; } };
}

test('the previous selected directory becomes the first registered library without filesystem writes', async t => {
  const { root, registry } = await fixture(t);
  const source = join(root, 'offline-sources');
  await registry.load(source);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.list()[0].root, source);
  assert.equal(registry.list()[0].name, 'offline-sources');
  assert.deepEqual(await readdir(root), [], 'registering never creates or copies directories or indexes');
});

test('registering an existing directory deduplicates it and preserves its friendly name', async t => {
  const { root, registry } = await fixture(t);
  await registry.load(root);
  const first = registry.list()[0];

  const repeated = await registry.add(resolve(root, '.'));
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.name, first.name);
  assert.equal(registry.list().length, 1);
});

test('all library names and roots survive reload, including unavailable directories', async t => {
  const f = await fixture(t);
  await f.registry.load(join(f.root, 'a'));
  await f.registry.add(join(f.root, 'disconnected-drive'));
  const reloaded = await f.reload(join(f.root, 'a'));
  assert.deepEqual(reloaded.list(), f.registry.list());
  assert.deepEqual(await readdir(f.root), []);
});

test('parallel registrations and edits are serialized without lost updates', async t => {
  const { root, registry, writes } = await fixture(t);
  await registry.load();
  await Promise.all([registry.add(join(root, 'a')), registry.add(join(root, 'b'))]);
  assert.deepEqual(registry.list().map(item => item.name), ['a', 'b']);
  assert.deepEqual(writes.map(value => value.libraries.length), [1, 2]);
});

test('failed persistence rolls back memory and does not poison later operations', async t => {
  const f = await fixture(t);
  await f.registry.load(f.root);
  const before = f.registry.list();
  f.fail(true);
  await assert.rejects(f.registry.add(join(f.root, 'b')), /storage failure/);
  assert.deepEqual(f.registry.list(), before);
  f.fail(false);
  await f.registry.add(join(f.root, 'c'));
  assert.deepEqual(f.registry.list().map(item => item.name), [before[0].name, 'c']);
});

test('malformed stored records are skipped, deduplicated and given computed identities', async t => {
  const f = await fixture(t);
  f.data = { version: 1, libraries: [null, { root: 'relative', name: 'Bad' }, { id: 'untrusted', root: f.root, name: 'Valid' }, { root: f.root, name: 'Duplicate' }] };
  await f.registry.load();
  assert.equal(f.registry.list().length, 1);
  assert.equal(f.registry.list()[0].name, 'Valid');
  assert.notEqual(f.registry.list()[0].id, 'untrusted');
});

test('callers cannot mutate registered records through returned snapshots', async t => {
  const { root, registry } = await fixture(t);
  await registry.load(root);
  const entry = registry.list()[0];
  registry.list()[0].name = 'Changed'; registry.find(entry.id).name = 'Changed'; registry.forRoot(root).name = 'Changed';
  assert.equal(registry.list()[0].name, entry.name);
});

test('Windows case-only directory differences share one registration', { skip: process.platform !== 'win32' }, async t => {
  const { root, registry } = await fixture(t);
  await registry.load(root);
  await registry.add(root.toUpperCase());
  assert.equal(registry.list().length, 1);
});

test('source operations are scoped while library management and environment actions are global', () => {
  for (const action of ['page', 'locate', 'tags', 'tagCreate', 'tagRename', 'tagDelete', 'tagToggle', 'tagColor', 'tagReorder', 'search', 'reveal', 'sync', 'enterLibrary', 'libraryReveal']) assert.equal(isLibraryScoped(action), true, action);
  for (const action of ['ready', 'library', 'librarySwitch', 'libraryAction', 'libraryRename', 'libraryRemove', 'environment', 'environmentInstall']) assert.equal(isLibraryScoped(action), false, action);
});


test('rename and remove persist independently of source availability and removed selections never resurrect',async t=>{
  const f=await fixture(t);await f.registry.load(join(f.root,'offline'));const entry=f.registry.list()[0];
  await f.registry.rename(entry.id,'  Reading room  ');assert.equal(f.registry.find(entry.id).name,'Reading room');
  await assert.rejects(f.registry.rename(entry.id,'   '),/1–60/);
  assert.equal((await f.reload(entry.root)).find(entry.id).name,'Reading room');
  await f.registry.remove(entry.id);assert.deepEqual((await f.reload(entry.root)).list(),[],'legacy selection must not re-add an explicitly removed library');
  assert.deepEqual(await readdir(f.root),[],'metadata operations never create, rename or delete source directories');
});

test('rename/remove failures are atomic and concurrent changes keep their ownership',async t=>{
  const f=await fixture(t);await f.registry.load(f.root);const a=f.registry.list()[0];const b=await f.registry.add(join(f.root,'b'));
  f.fail(true);await assert.rejects(f.registry.remove(a.id),/storage failure/);assert.equal(f.registry.find(a.id).name,a.name);
  await assert.rejects(f.registry.rename(a.id,'Changed'),/storage failure/);assert.equal(f.registry.find(a.id).name,a.name);
  f.fail(false);await Promise.all([f.registry.rename(a.id,'A'),f.registry.remove(b.id)]);assert.deepEqual(f.registry.list().map(v=>v.name),['A']);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, realpath, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { transform } from 'esbuild';
import { nativeTarget } from './test-platform.mjs';
import { activate, KnowledgeStore, LibraryRegistry, LIBRARIES_STORAGE_KEY, openSourceDirectory } from '../dist/index.js';

const scopeSource = await readFile(new URL('../src/work-scope.ts', import.meta.url), 'utf8');
const { code } = await transform(scopeSource, { loader: 'ts', format: 'esm' });
const { interruptible, WorkScope } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = () => new Promise(done => setImmediate(done));

test('cancelling a scope releases callers before an uncancellable native read finishes', async () => {
  const scope = new WorkScope(), native = deferred();
  const running = scope.run(native.promise);
  const rejected = assert.rejects(running, { name: 'AbortError' });
  scope.cancel(); await rejected;
  let drained = false;
  const cleanup = scope.drain().then(() => { drained = true; });
  await turn(); assert.equal(drained, false, 'the native handle stays alive until the actual operation ends');
  native.resolve('late result'); await cleanup; assert.equal(drained, true);
  scope.resume(); assert.equal(await scope.run(Promise.resolve('B')), 'B');
});
test('late native rejection after cancellation is observed and never becomes an unhandled rejection', async () => {
  const native = deferred(), controller = new AbortController();
  const waiting = interruptible(native.promise, controller.signal);
  const rejected = assert.rejects(waiting, { name: 'AbortError' });
  controller.abort(); await rejected; native.reject(new Error('late native failure')); await turn();
});

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'knowledge-interruption-')));
  const cache = join(root, 'cache'), a = join(root, 'A'), b = join(root, 'B');
  await mkdir(a); await mkdir(b);
  const engine = join(cache, 'lancedb-engine', '0.39.0'); await mkdir(engine, { recursive: true });
  await copyFile(resolve(`node_modules/@lancedb/lancedb-${nativeTarget}/lancedb.${nativeTarget}.node`), join(engine, `lancedb.${nativeTarget}.node`));
  const stores = [], cleanup = [];
  const open = async (directory = a, options = {}) => { const store = await openSourceDirectory(directory, cache, options); stores.push(store); return store; };
  t.after(async () => { for (const dispose of cleanup) await dispose(); for (const store of stores) await store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, cache, a, b, open, cleanup };
}

test('an index job waiting for an engine is interrupted without a failure record or late commit', { timeout: 10000 }, async t => {
  const f = await fixture(t), entered = deferred(), engine = deferred();
  f.cleanup.unshift(() => engine.resolve());
  const store = await f.open(f.a, { requireEngine: async () => { entered.resolve(); await engine.promise; } });
  const path = join(f.a, 'slow.pdf'); await writeFile(path, 'fixture PDF');
  const job = store.importFile(path);
  const rejected = assert.rejects(job, { name: 'AbortError' });
  await entered.promise; store.interrupt(); await rejected;
  engine.resolve(); await turn(); store.resume();
  assert.equal((await store.list()).length, 0, 'late extraction cannot create a catalogue row');
  const db = new DatabaseSync(join(f.a, '.knowledge', 'catalog.sqlite'));
  try { assert.equal(db.prepare('SELECT COUNT(*) AS count FROM index_failures').get().count, 0); } finally { db.close(); }
  const next = join(f.a, 'resumed.md'); await writeFile(next, 'Resumedkeyword');
  await store.importFile(next); assert.equal((await store.list()).length, 1, 'failed switching can resume A');
});

test('an in-flight native search is cancelled promptly, but close defers handle release until it settles', { timeout: 10000 }, async t => {
  const f = await fixture(t), store = await f.open();
  const path = join(f.a, 'note.md'); await writeFile(path, 'Searchkeyword'); await store.importFile(path);
  const entered = deferred(), native = deferred(); f.cleanup.unshift(() => native.resolve([]));
  const original = store.table.bind(store);
  store.table = async () => ({ vectorSearch() { return { where() { return this; }, limit() { return this; }, toArray() { entered.resolve(); return native.promise; } }; } });
  const query = store.search('Searchkeyword'); const rejected = assert.rejects(query, { name: 'AbortError' });
  await entered.promise; store.interrupt(); await rejected;
  let closed = false; const cleanup = store.close().then(() => { closed = true; });
  await turn(); assert.equal(closed, false, 'never close a native table under its active query');
  native.resolve([]); await cleanup; store.table = original;
});

async function appHarness(t, f, savedValues) {
  const values = savedValues ?? new Map([['sourceDirectory', f.a]]), subscriptions = [], sent = [];
  const registry = new LibraryRegistry(async () => values.get(LIBRARIES_STORAGE_KEY), async data => values.set(LIBRARIES_STORAGE_KEY, data));
  await registry.load(f.a); await registry.add(f.b);
  let openPanel, receive, serial = 0, failSelection = false;
  activate({ storagePath: f.cache, subscriptions,
    storage: { get: async key => values.get(key), set: async (key, value) => {
      if (failSelection && key === 'sourceDirectory') throw new Error('selection failed'); values.set(key, value);
    } }, i18n: { t: key => key }, logger: { warn() {} },
    composerActions: { register: () => ({ dispose() {}, notifyUpdate() {} }) },
    tools: { register: () => ({ dispose() {} }) },
    ui: { onDidOpenPanel(fn) { openPanel = fn; return { dispose() {} }; } },
  });
  openPanel({ view: 'appView', postMessage: async message => { sent.push(message); }, onDidReceiveMessage(fn) { receive = fn; return { dispose() {} }; }, onDidDispose: () => ({ dispose() {} }) });
  const call = async (type, payload = {}) => {
    const requestId = String(++serial); await receive({ type, requestId, ...payload });
    return sent.filter(message => message.requestId === requestId).at(-1);
  };
  await call('ready');
  f.cleanup.push(async () => { for (const item of subscriptions) await item.dispose?.(); });
  return { call, sent, registry, values, failSelection: () => { failSelection = true; } };
}

test('switching to B does not wait for A and a late A scan cannot clear or cancel B', { timeout: 10000 }, async t => {
  const f = await fixture(t); await writeFile(join(f.a, 'a.md'), 'A'); await writeFile(join(f.b, 'b.md'), 'B');
  const aEntered = deferred(), bEntered = deferred(), aBlock = deferred(), bBlock = deferred();
  let bSignal;
  const original = KnowledgeStore.prototype.importFile;
  KnowledgeStore.prototype.importFile = async function(path, name, tag, signal) {
    if (path === join(f.a, 'a.md')) { aEntered.resolve(); await aBlock.promise; }
    if (path === join(f.b, 'b.md')) { bSignal = signal; bEntered.resolve(); await bBlock.promise; }
    signal?.throwIfAborted(); return original.call(this, path, name, tag, signal);
  };
  // Release barriers before app disposal even on assertion failure.
  f.cleanup.unshift(() => { aBlock.resolve(); bBlock.resolve(); KnowledgeStore.prototype.importFile = original; });
  const app = await appHarness(t, f);
  const scanningA = app.call('sync'); await aEntered.promise;
  const switched = await app.call('librarySwitch', { id: app.registry.forRoot(f.b).id });
  assert.equal(switched.type, 'libraryDone'); assert.equal(switched.library.root, f.b);
  const scanningB = app.call('sync'); await bEntered.promise;
  aBlock.resolve(); await scanningA;
  await app.call('scanPause');
  assert.equal(bSignal.aborted, true, 'A finally must not erase B scan/controller ownership');
  bBlock.resolve(); const paused = await scanningB;
  assert.equal(paused.root, f.b); assert.equal(paused.sync.paused, true);
  assert.equal(app.values.get('sourceDirectory'), f.b);
});

test('a failed library switch resumes the old store instead of leaving it permanently cancelled', { timeout: 10000 }, async t => {
  const f = await fixture(t), app = await appHarness(t, f); app.failSelection();
  const failed = await app.call('librarySwitch', { id: app.registry.forRoot(f.b).id });
  assert.equal(failed.type, 'error');
  const page = await app.call('page'); assert.equal(page.type, 'page'); assert.equal(page.root, f.a);
  const search = await app.call('search', { query: 'anything' }); assert.equal(search.type, 'matches');
});

test('display preference persists across activation and is applied before page counts', async t => {
  const f = await fixture(t); await writeFile(join(f.a, 'note.txt'), 'Preferencekeyword'); await writeFile(join(f.a, 'setup.exe'), 'Original');
  const app = await appHarness(t, f); await app.call('sync');
  assert.equal((await app.call('page')).total, 2);
  assert.equal((await app.call('preferences', {hideUnsupported:true})).type, 'preferences');
  assert.equal(app.values.get('hideUnsupported'), true);
  assert.equal((await app.call('page')).total, 1);
  const rebooted = await appHarness(t, f, app.values);
  const ready = await rebooted.call('ready'); assert.equal(ready.preferences.hideUnsupported, true);
  assert.equal((await rebooted.call('page')).total, 1);
  await rebooted.call('preferences', {hideUnsupported:false});
  assert.equal((await rebooted.call('page')).total, 2);
});

test('an unavailable source keeps cached pages readable but blocks scans and never blocks switching', async t => {
  const f = await fixture(t); await writeFile(join(f.a, 'cached.md'), 'Offlinekeyword');
  const prepared = await f.open(); await prepared.importFile(join(f.a, 'cached.md'));
  const app = await appHarness(t, f);
  const original = KnowledgeStore.prototype.assertSourceAvailable;
  f.cleanup.unshift(() => { KnowledgeStore.prototype.assertSourceAvailable = original; });
  KnowledgeStore.prototype.assertSourceAvailable = async function() {
    if (this.directoryRoot === f.a) throw new Error('The library folder is no longer on disk.');
    return original.call(this);
  };
  const cached = await app.call('page'); assert.equal(cached.type, 'page'); assert.equal(cached.total, 1);
  assert.equal((await app.call('sync')).type, 'error', 'source writes and scanning retain the offline guard');
  const switched = await app.call('librarySwitch', {id:app.registry.forRoot(f.b).id});
  assert.equal(switched.type, 'libraryDone'); assert.equal(switched.library.root, f.b);
  assert.equal((await app.call('page')).type, 'page');
});

test('catalogue page returns before a blocked vector and content status check', async t => {
  const f = await fixture(t); await writeFile(join(f.a, 'cached.md'), 'Cachedkeyword');
  const prepared = await f.open(); await prepared.importFile(join(f.a, 'cached.md'));
  const app = await appHarness(t, f), entered = deferred(), held = deferred();
  const original = KnowledgeStore.prototype.indexStatus;
  f.cleanup.unshift(() => { held.resolve(); KnowledgeStore.prototype.indexStatus = original; });
  KnowledgeStore.prototype.indexStatus = async function(documents, signal) {
    entered.resolve(); await interruptible(held.promise, signal);
    return original.call(this, documents, signal);
  };
  let reply;
  const request = app.call('page').then(value => { reply = value; });
  await entered.promise; await turn();
  assert.equal(reply?.type, 'page', 'the first page must be delivered while status verification is still blocked');
  assert.equal(reply.total, 1); assert.equal(reply.documents[0].name, 'cached.md');
  assert.notEqual(reply.documents[0].status, 'ready', 'unverified coverage is not invented');
  held.resolve(); await request;
});

test('a blocked root probe cannot hold the cached page response', async t => {
  const f = await fixture(t); await writeFile(join(f.a,'cached.md'),'Cachedkeyword');
  const prepared = await f.open(); await prepared.importFile(join(f.a,'cached.md'));
  const app = await appHarness(t,f), entered = deferred(), held = deferred();
  const original = KnowledgeStore.prototype.assertSourceAvailable;
  f.cleanup.unshift(() => {held.resolve();KnowledgeStore.prototype.assertSourceAvailable=original;});
  KnowledgeStore.prototype.assertSourceAvailable = async function() {entered.resolve();await held.promise;return original.call(this);};
  let reply; const request = app.call('page').then(value => {reply=value;});
  await entered.promise; await turn(); assert.equal(reply?.type,'page');assert.equal(reply.total,1);
  held.resolve();await request;
});

test('a newer page cancels old verification and suppresses its late result', async t => {
  const f = await fixture(t); await writeFile(join(f.a,'cached.md'),'Cachedkeyword');
  const prepared = await f.open(); await prepared.importFile(join(f.a,'cached.md'));
  const app = await appHarness(t,f), firstEntered=deferred(), secondEntered=deferred(), first=deferred(), second=deferred();
  const original = KnowledgeStore.prototype.indexStatus; const signals=[];
  f.cleanup.unshift(() => {first.resolve();second.resolve();KnowledgeStore.prototype.indexStatus=original;});
  KnowledgeStore.prototype.indexStatus = async function(documents,signal) {
    const attempt=signals.length;signals.push(signal);(attempt===0?firstEntered:secondEntered).resolve();
    // Deliberately ignores abort to model an uncancellable, late native return.
    await (attempt===0?first:second).promise;
    return documents.map(doc=>({...doc,indexState:'indexed',indexedChunks:doc.chunks,sourceState:'same',status:'ready',statusReason:attempt===0?'obsolete':'current'}));
  };
  await app.call('page');await firstEntered.promise;
  await app.call('page');await secondEntered.promise;
  assert.equal(signals[0].aborted,true);
  first.resolve();second.resolve();await turn();
  const updates=app.sent.filter(message=>message.type==='documentStatus');
  assert.equal(updates.length,1);assert.equal(updates[0].document.statusReason,'current');
});

test('unsupported files receive background metadata without any vector verification', async t => {
  const f=await fixture(t);await writeFile(join(f.a,'setup.exe'),'Original');
  const app=await appHarness(t,f);await app.call('sync');
  const metadataDone=deferred(), original=KnowledgeStore.prototype.refreshMetadata, originalStatus=KnowledgeStore.prototype.indexStatus;
  let vectorChecks=0;
  f.cleanup.unshift(()=>{KnowledgeStore.prototype.refreshMetadata=original;KnowledgeStore.prototype.indexStatus=originalStatus;});
  KnowledgeStore.prototype.indexStatus=async()=>{vectorChecks++;throw new Error('No vector check for an unsupported file');};
  KnowledgeStore.prototype.refreshMetadata=async function(documents,signal){const result=await original.call(this,documents,signal);metadataDone.resolve();return result;};
  const page=await app.call('page');assert.equal(page.documents[0].issueKind,'unsupported');
  await metadataDone.promise;await turn();
  const update=app.sent.find(message=>message.type==='documentStatus'&&message.path===join(f.a,'setup.exe'));
  assert.equal(update.document.size_bytes,8);assert.equal(update.document.issueKind,'unsupported');assert.equal(vectorChecks,0);
  const cached=await app.call('page');assert.equal(cached.documents[0].size_bytes,8);
});

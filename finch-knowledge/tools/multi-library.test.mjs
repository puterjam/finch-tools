import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, realpath, readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureLink, fixtureRm, nativeTarget } from './test-platform.mjs';
import { activate, KnowledgeStore, LibraryRegistry, LIBRARIES_STORAGE_KEY, openSourceDirectory, scanSourceDirectory } from '../dist/index.js';

async function harness(t, { offline = false, sharedIndex } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'knowledge-multi-library-')));
  const cache = join(root, 'cache'), a = join(root, 'work'), b = join(root, 'personal');
  await mkdir(a); if (!offline) await mkdir(b);
  const engine = join(cache, 'lancedb-engine', '0.39.0');
  await mkdir(engine, { recursive: true });
  await fixtureLink(resolve(`node_modules/@lancedb/lancedb-${nativeTarget}/lancedb.${nativeTarget}.node`), join(engine, `lancedb.${nativeTarget}.node`));
  for (const [directory, word] of [[a, 'workonlyword'], ...(!offline ? [[b, 'personalonlyword']] : [])]) {
    await writeFile(join(directory, 'same.md'), word);
    const store = await openSourceDirectory(directory, cache);
    try {
      await scanSourceDirectory(store);
      const tag = await store.createTag(directory === a ? 'Work tag' : 'Personal tag');
      await store.setTags((await store.list())[0].id, [tag.id]);
    } finally { await store.close(); }
  }
  const values = new Map([['sourceDirectory', a]]);
  const registry = new LibraryRegistry(async () => values.get(LIBRARIES_STORAGE_KEY), async data => { values.set(LIBRARIES_STORAGE_KEY, structuredClone(data)); });
  await registry.load(a); await registry.add(b,sharedIndex?{kind:'local',key:sharedIndex}:undefined);
  if(sharedIndex)await registry.add(join(root,'shared-alias'),{kind:'local',key:sharedIndex});
  const records = registry.list();
  const subscriptions = [], panels = [];
  let open, tool, failSelection = false,failRegistry=false;
  let answer={action:'save',values:{name:'Renamed library'}};
  const dialogs = [];
  const copy = JSON.parse(await readFile(new URL('../i18n/en-US.json', import.meta.url), 'utf8'));
  activate({ storagePath: cache, subscriptions,
    storage: { get: async key => values.get(key), set: async (key, value) => {
      if (failSelection && key === 'sourceDirectory') throw new Error('selection storage failure');
      if(failRegistry&&key===LIBRARIES_STORAGE_KEY)throw new Error('registry storage failure');
      values.set(key, structuredClone(value));
    }, delete: async key => { values.delete(key); } },
    i18n: { t: (key, replacements = {}) => {
      let text = key.startsWith('ui.') ? copy.ui[key.slice(3)] : copy[key];
      for (const [name, value] of Object.entries(replacements)) text = (text ?? key).replaceAll(`{${name}}`, String(value));
      return text ?? key;
    } },
    composerActions: { register: () => ({ dispose() {}, notifyUpdate() {} }) },
    tools: { register(definition) { tool = definition; return { dispose() {} }; } },
    ui: { onDidOpenPanel(fn) { open = fn; return { dispose() {} }; }, showModalDialog: async options => { dialogs.push(options); return structuredClone(answer); } },
  });
  for (let index = 0; index < 2; index++) {
    const sent = []; let receive;
    open({ view: 'appView', postMessage: async message => { sent.push(message); }, onDidReceiveMessage: fn => { receive = fn; return { dispose() {} }; }, onDidDispose: () => ({ dispose() {} }) });
    let serial = 0;
    const call = async (type, payload = {}) => {
      const requestId = `${index}-${++serial}`;
      await receive({ type, requestId, ...payload });
      return sent.filter(message => message.requestId === requestId).at(-1);
    };
    panels.push({ sent, call });
    await call('ready');
  }
  t.after(async () => { for (const item of subscriptions) await item.dispose?.(); await fixtureRm(root, { recursive: true, force: true }); });
  return { root, a, b, records, values, dialogs, panels, tool,
    failSelection() { failSelection = true; },
    respond(value){answer=value;},failRegistry(value){failRegistry=value;},
    exec: { cwd: root, signal: new AbortController().signal, progress: { report() {} } } };
}

test('switching libraries isolates documents, tags and search and updates every open panel', async t => {
  const h = await harness(t);
  const [first, second] = h.panels;
  const beforeA = await stat(join(h.a, 'same.md')), beforeB = await stat(join(h.b, 'same.md'));
  let page = await first.call('page', { libraryRoot: h.a });
  assert.equal(page.documents.length, 1); assert.equal(page.documents[0].path, join(h.a, 'same.md'));
  const selected = await first.call('librarySwitch', { id: h.records[1].id });
  assert.equal(selected.type, 'libraryDone'); assert.equal(selected.library.root, h.b);
  assert.equal(selected.library.libraries.length, 2); assert.equal(h.values.get('sourceDirectory'), h.b);
  assert.ok(second.sent.some(message => message.type === 'libraries' && message.library.root === h.b));
  page = await first.call('page', { libraryRoot: h.b });
  assert.equal(page.documents.length, 1); assert.equal(page.documents[0].path, join(h.b, 'same.md'));
  const tags = await first.call('tags', { libraryRoot: h.b });
  assert.ok(tags.tags.some(tag => tag.name === 'Personal tag'));
  assert.equal(tags.tags.some(tag => tag.name === 'Work tag'), false);
  const own = await h.tool.execute({ action: 'search', query: 'personalonlyword' }, h.exec);
  const other = await h.tool.execute({ action: 'search', query: 'workonlyword' }, h.exec);
  assert.match(own.content[0].text, /personalonlyword/); assert.doesNotMatch(other.content[0].text, /workonlyword/);
  await first.call('librarySwitch', { id: h.records[0].id });
  const restored = await first.call('tags', { libraryRoot: h.a });
  assert.ok(restored.tags.some(tag => tag.name === 'Work tag'));
  assert.equal((await stat(join(h.a, 'same.md'))).mtimeMs, beforeA.mtimeMs);
  assert.equal((await stat(join(h.b, 'same.md'))).mtimeMs, beforeB.mtimeMs);
  assert.equal(await readFile(join(h.a, 'same.md'), 'utf8'), 'workonlyword');
  assert.equal(await readFile(join(h.b, 'same.md'), 'utf8'), 'personalonlyword');
});

test('stale source requests cannot mutate, search or scan the newly selected library', async t => {
  const h = await harness(t); const panel = h.panels[0];
  await panel.call('librarySwitch', { id: h.records[1].id });
  const before = await panel.call('tags', { libraryRoot: h.b });
  for (const type of ['tagCreate', 'tagRename', 'tagDelete', 'tagColor', 'tagToggle', 'tagReorder', 'page', 'search', 'sync']) {
    const reply = await panel.call(type, { libraryRoot: h.a, name: 'Wrong library', query: 'workonlyword' });
    assert.equal(reply.type, 'error', type); assert.match(reply.error, /knowledge base changed/, type);
  }
  assert.deepEqual((await panel.call('tags', { libraryRoot: h.b })).tags, before.tags);
  assert.equal(panel.sent.some(message => message.type === 'scanStarted'), false);
});

test('library rename is metadata-only and reaches every panel; removal requires its own confirmation', async t => {
  const h=await harness(t),panel=h.panels[0],id=h.records[1].id;
  const renamed=await panel.call('libraryRename',{id,name:'Renamed library'});assert.equal(renamed.type,'libraryRenamed');assert.equal(h.dialogs.length,0,'inline rename never opens a host modal');assert.equal(renamed.library.libraries.find(v=>v.id===id).name,'Renamed library');
  assert.ok(h.panels[1].sent.some(v=>v.type==='libraries'&&v.library.libraries.some(r=>r.name==='Renamed library')));
  h.respond({action:'cancel',values:{deleteIndex:true}});assert.equal((await panel.call('libraryRemove',{id,deleteIndex:true,confirmed:true})).type,'libraryCanceled');
  assert.equal((await panel.call('library')).library.libraries.length,2);assert.equal(h.values.get('sourceDirectory'),h.a);
  assert.equal((await stat(join(h.b,'.knowledge'))).isDirectory(),true);assert.equal(await readFile(join(h.b,'same.md'),'utf8'),'personalonlyword');
  const dialog=h.dialogs.at(-1);assert.equal(dialog.fields[0].key,'deleteIndex');assert.equal(dialog.fields[0].default,false);
});

test('an unavailable library remains registered and failed switching keeps the previous library usable', async t => {
  const h = await harness(t, { offline: true }); const panel = h.panels[0];
  assert.equal((await panel.call('librarySwitch', { id: h.records[1].id })).type, 'error');
  const library = (await panel.call('library')).library;
  assert.equal(library.root, h.a); assert.equal(library.libraries.length, 2);
  assert.equal(h.values.get('sourceDirectory'), h.a);
  assert.equal((await panel.call('page', { libraryRoot: h.a })).documents.length, 1);
});

test('selection persistence failure closes the candidate store without abandoning the old library', async t => {
  const h = await harness(t); const panel = h.panels[0]; h.failSelection();
  const failed = await panel.call('librarySwitch', { id: h.records[1].id });
  assert.equal(failed.type, 'error'); assert.match(failed.error, /selection storage failure/);
  assert.equal((await panel.call('library')).library.root, h.a);
  assert.equal(h.values.get('sourceDirectory'), h.a);
  assert.equal((await panel.call('page', { libraryRoot: h.a })).documents[0].path, join(h.a, 'same.md'));
});

test('returning to the same root rejects mutations queued during its previous selection', async t => {
  const h = await harness(t); const panel = h.panels[0];
  const version = (await panel.call('library')).library.version;
  await panel.call('librarySwitch', { id: h.records[1].id });
  await panel.call('librarySwitch', { id: h.records[0].id });
  const stale = await panel.call('tagCreate', { libraryRoot: h.a, libraryVersion: version, name: 'Stale mutation' });
  assert.equal(stale.type, 'error'); assert.match(stale.error, /knowledge base changed/);
  assert.equal((await panel.call('tags', { libraryRoot: h.a })).tags.some(tag => tag.name === 'Stale mutation'), false);
});

test('an assistant mutation paused during tag lookup cannot edit the next library', async t => {
  const h = await harness(t); const panel = h.panels[0];
  const original = KnowledgeStore.prototype.tags;
  let entered, release, paused = false;
  const began = new Promise(resolve => { entered = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  KnowledgeStore.prototype.tags = async function (...args) {
    const result = await original.apply(this, args);
    if (!paused && this.directoryRoot === h.a) { paused = true; entered(); await resume; }
    return result;
  };
  try {
    const work = h.tool.execute({ action: 'rename_tag', tag: 'Work tag', name: 'Must not leak' }, h.exec);
    await began;
    await panel.call('librarySwitch', { id: h.records[1].id });
    release();
    const result = await work;
    assert.equal(result.isError, true); assert.match(result.content[0].text, /knowledge base changed/);
    const personal = await panel.call('tags', { libraryRoot: h.b });
    assert.ok(personal.tags.some(tag => tag.name === 'Personal tag'));
    assert.equal(personal.tags.some(tag => tag.name === 'Must not leak'), false);
    await panel.call('librarySwitch', { id: h.records[0].id });
    assert.ok((await panel.call('tags', { libraryRoot: h.a })).tags.some(tag => tag.name === 'Work tag'));
  } finally { release(); KnowledgeStore.prototype.tags = original; }
});


test('remove-only works for an offline unselected library and keeps its selection and all originals',async t=>{
  const h=await harness(t,{offline:true}),panel=h.panels[0];h.respond({action:'remove',values:{deleteIndex:false}});
  const removed=await panel.call('libraryRemove',{id:h.records[1].id,deleteIndex:true});assert.equal(removed.type,'libraryRemoved');
  assert.equal(removed.library.libraries.length,1);assert.equal(removed.library.root,h.a);assert.equal(h.values.get('sourceDirectory'),h.a);
  assert.equal(await stat(h.b).catch(()=>null),null,'removing an offline registration never creates its source directory');
  assert.equal(await readFile(join(h.a,'same.md'),'utf8'),'workonlyword');
});
test('removing the selected and final libraries clears selection but retains indexes for re-adding',async t=>{
  const h=await harness(t),panel=h.panels[0];h.respond({action:'remove',values:{deleteIndex:false}});
  const result=await panel.call('libraryRemove',{id:h.records[0].id});assert.equal(result.type,'libraryRemoved');assert.equal(result.library.selected,false);assert.equal(result.library.root,'');assert.equal(h.values.get('sourceDirectory'),'');
  assert.equal((await stat(join(h.a,'.knowledge','catalog.sqlite'))).isFile(),true);assert.equal((await panel.call('page')).total,0);
  assert.equal((await panel.call('librarySwitch',{id:h.records[1].id})).library.root,h.b);
  await panel.call('libraryRemove',{id:h.records[1].id});assert.equal((await panel.call('library')).library.libraries.length,0);
  const loaded=new LibraryRegistry(async()=>h.values.get(LIBRARIES_STORAGE_KEY),async()=>{});await loaded.load(h.a);assert.equal(loaded.list().length,0);
  assert.equal(await readFile(join(h.a,'same.md'),'utf8'),'workonlyword');assert.equal(await readFile(join(h.b,'same.md'),'utf8'),'personalonlyword');
});
test('failed registry persistence restores a staged index and preserves the registered owner',async t=>{
  const h=await harness(t),panel=h.panels[0];h.respond({action:'remove',values:{deleteIndex:true}});h.failRegistry(true);
  const result=await panel.call('libraryRemove',{id:h.records[0].id});assert.equal(result.type,'error');assert.match(result.error,/registry storage failure/);
  assert.equal((await stat(join(h.a,'.knowledge','catalog.sqlite'))).isFile(),true);assert.equal(await readFile(join(h.a,'same.md'),'utf8'),'workonlyword');
  assert.equal(h.values.get(LIBRARIES_STORAGE_KEY).libraries.some(v=>v.id===h.records[0].id),true);
  h.failRegistry(false);assert.equal((await panel.call('librarySwitch',{id:h.records[0].id})).type,'libraryDone');
});
test('missing-file and unavailable-library errors are distinct and do not delete cached rows',async t=>{
  const h=await harness(t),panel=h.panels[0],doc=(await panel.call('page',{libraryRoot:h.a})).documents[0];
  await fixtureRm(join(h.a,'same.md'));const missing=await panel.call('reveal',{id:doc.id});assert.match(missing.error,/Source file not found.*scan and update/);
  assert.equal((await panel.call('page')).documents.length,1);
  const {rename}=await import('node:fs/promises');await rename(h.a,join(h.root,'detached'));
  const unavailable=await panel.call('reveal',{id:doc.id});assert.match(unavailable.error,/Cannot access.*drive.*network/);assert.doesNotMatch(unavailable.error,/Source file not found/);
});


test('checked removal waits for native handle retirement before sending its index to trash',{skip:process.platform!=='darwin',timeout:10000},async t=>{
  const h=await harness(t),panel=h.panels[0];h.respond({action:'remove',values:{deleteIndex:true}});
  const close=KnowledgeStore.prototype.close;let release,entered;let block=true;
  const barrier=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  t.mock.method(KnowledgeStore.prototype,'close',async function(){if(this.directoryRoot===h.a&&block){block=false;entered();await barrier;}return close.call(this);});
  let complete=false;const pending=panel.call('libraryRemove',{id:h.records[0].id}).then(v=>{complete=true;return v;});
  try{await started;assert.equal(complete,false);assert.equal((await stat(join(h.a,'.knowledge','catalog.sqlite'))).isFile(),true,'index must not move while a writer/handle remains');}
  finally{release();}
  const result=await pending;assert.equal(result.type,'libraryRemoved');assert.equal(result.warning,undefined);assert.equal(await stat(join(h.a,'.knowledge')).catch(()=>null),null);
  assert.equal(await readFile(join(h.a,'same.md'),'utf8'),'workonlyword');assert.equal((await stat(join(h.b,'.knowledge'))).isDirectory(),true);
});


test('shared cached indexes cannot be deleted through another registered library',async t=>{
  const key='c'.repeat(32),h=await harness(t,{offline:true,sharedIndex:key}),panel=h.panels[0],index=join(h.root,'cache','remote',key);
  await mkdir(index,{recursive:true});await writeFile(join(index,'catalog.sqlite'),'Shared index');h.respond({action:'remove',values:{deleteIndex:true}});
  const result=await panel.call('libraryRemove',{id:h.records[1].id});assert.equal(result.type,'error');assert.match(result.error,/Another knowledge base still uses this index/);
  assert.equal(await readFile(join(index,'catalog.sqlite'),'utf8'),'Shared index');assert.equal((await panel.call('library')).library.libraries.length,3);assert.equal(h.values.get('sourceDirectory'),h.a);
});

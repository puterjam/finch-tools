import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { openSourceDirectory } from '../dist/index.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
const FILE_COUNT = process.env.FINCH_BENCH_FILES === '100000' ? 100_000 : 10_000;
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'knowledge-catalog-first-'))), source = join(root, 'source');
  await mkdir(source); const stores = [];
  const open = async () => { const store = await openSourceDirectory(source, join(root, 'cache')); stores.push(store); return store; };
  t.after(async () => { for (const store of stores) await store.close(); await rm(root, {recursive:true,force:true}); });
  return {root,source,open};
}

test(`${FILE_COUNT} cached files remain pageable while the content write queue is held, with zero source/vector calls`, async t => {
  const f = await fixture(t), store = await f.open(), catalog = store.catalog;
  const insert = catalog.prepare('INSERT INTO documents(id,path,name,hash,added_at,indexed_at,chunks,source_path,relative_path) VALUES(?,?,?,?,?,?,?,?,?)');
  const metadata = catalog.prepare('INSERT INTO source_metadata(path,size_bytes,modified_at,file_type) VALUES(?,?,?,?)');
  catalog.exec('BEGIN');
  for (let i = 0; i < FILE_COUNT; i++) {
    const name = `${String(i).padStart(5,'0')}.txt`, relative = `notes/${name}`, path = join(f.source, 'notes', name);
    insert.run(randomUUID(), path, name, '0'.repeat(64), i, i, 1, path, relative); metadata.run(relative, i, i, 'txt');
  }
  catalog.prepare('INSERT INTO source_folders(path) VALUES(?)').run('notes'); catalog.exec('COMMIT');
  let release; const held = new Promise(resolve => { release = resolve; }); store.writes = held;
  let forbidden = 0;
  for (const method of ['table','checkSource','readMetadata','assertSourceAvailable']) store[method] = () => { forbidden++; throw new Error(`Forbidden catalogue call: ${method}`); };
  try {
    const started = performance.now(), timings = [];
    for (const sort of ['name','added','updated','modified','size','type']) {
      let result; const pageStarted = performance.now();
      const read = store.browsePage(null, sort, 0, 50, null, undefined, false, true).then(value => {result=value;});
      await turn(); assert.equal(result?.total, FILE_COUNT, sort); assert.equal(result.documents.length, 50); await read;
      timings.push({sort,pageMs:Math.round(performance.now()-pageStarted)});
      const window = await store.browseWindow(null, sort, null, undefined, {catalogOnly:true,offset:FILE_COUNT-50});
      assert.equal(window.documents.length, 50); assert.equal(window.total, FILE_COUNT);
      assert.equal(await store.fileCount(false,true), FILE_COUNT);
      assert.equal((await store.directories(false,true)).find(dir => dir.path === '').count, FILE_COUNT);
      assert.equal((await store.summary(true)).documents, FILE_COUNT);
      assert.equal((await store.tags(true))[0].count, FILE_COUNT);
    }
    assert.equal(forbidden, 0);
    console.log(JSON.stringify({files:FILE_COUNT,timings,sixScenariosMs:Math.round(performance.now()-started),sourceVectorCalls:forbidden}));
  } finally { release(); }
});

test('cached metadata survives reopening and does not fabricate coverage or reread the source', async t => {
  const f = await fixture(t), first = await f.open(); await writeFile(join(f.source,'note.txt'),'Metadata');
  await first.replaceSourceInventory([], [{path:'note.txt',kind:'pending',reason:''}], [], await (await import('node:fs/promises')).stat(f.source,{bigint:true}));
  const initial=await first.browsePage(null,'name',0);
  await first.refreshMetadata(initial.documents);
  assert.equal((await first.browsePage(null,'name',0)).documents[0].size_bytes, 8);
  await first.close(); const second = await f.open();
  second.readMetadata = () => { throw new Error('Do not read a source during catalogue pagination'); };
  const cached = await second.browsePage(null,'size',0,50,null,false,false,true);
  assert.equal(cached.documents[0].size_bytes,8); assert.equal(cached.documents[0].file_type,'txt');
  assert.equal(cached.documents[0].issueKind,'pending'); assert.notEqual(cached.documents[0].status,'ready');
  assert.equal(second.catalog.prepare('PRAGMA user_version').get().user_version,6,'the additive cache does not force a content-index rebuild');
});

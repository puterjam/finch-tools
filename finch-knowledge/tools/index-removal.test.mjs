import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,realpath,mkdir,writeFile,readFile,readdir,stat,lstat,rename} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fixtureRm,fixtureLink} from './test-platform.mjs';
import {stageIndexRemoval,libraryIndexPath,trashIndex} from '../dist/index.js';
async function fixture(t){
  const root=await realpath(await mkdtemp(join(tmpdir(),'knowledge-remove-'))),source=join(root,'source'),cache=join(root,'cache');
  await mkdir(source);await mkdir(cache);const index=join(source,'.knowledge');await mkdir(index);await writeFile(join(index,'catalog.sqlite'),'SQLite format 3\0fixture');await writeFile(join(source,'original.txt'),'Keep original');
  t.after(()=>fixtureRm(root,{recursive:true,force:true}));const info=await stat(source,{bigint:true});
  return {root,source,cache,index,record:{id:'fixture',root:source,name:'Fixture',index:{kind:'source',dev:String(info.dev),ino:String(info.ino)}}};
}
test('index staging is reversible before persistence and commits only the owned index',async t=>{
  const f=await fixture(t);let trashed;
  const staged=await stageIndexRemoval(f.record,f.cache,async path=>{trashed=path;await fixtureRm(path,{recursive:true,force:true});});
  assert.equal(await lstat(f.index).catch(()=>null),null);assert.equal(await readFile(join(f.source,'original.txt'),'utf8'),'Keep original');
  await staged.rollback();assert.equal((await stat(f.index)).isDirectory(),true);assert.equal(trashed,undefined);
  const final=await stageIndexRemoval(f.record,f.cache,async path=>{trashed=path;await fixtureRm(path,{recursive:true,force:true});});await final.commit();
  assert.equal(dirname(trashed),f.source);assert.match(trashed,/\.knowledge-removed-/);assert.deepEqual(await readdir(f.source),['original.txt']);
});
test('a trash failure restores the original index instead of claiming deletion',async t=>{
  const f=await fixture(t),staged=await stageIndexRemoval(f.record,f.cache,async()=>{throw new Error('Trash unavailable');});
  await assert.rejects(staged.commit(),/Trash unavailable/);assert.equal(await readFile(join(f.index,'catalog.sqlite'),'utf8'),'SQLite format 3\0fixture');assert.equal(await readFile(join(f.source,'original.txt'),'utf8'),'Keep original');
});
test('index symlinks, unknown contents and changed source identities fail closed',async t=>{
  const f=await fixture(t);let calls=0;const trash=async()=>{calls++;};
  await writeFile(join(f.index,'important-user-file.txt'),'Do not delete');await assert.rejects(stageIndexRemoval(f.record,f.cache,trash),/INDEX_REMOVAL_UNSAFE/);assert.equal(await readFile(join(f.index,'important-user-file.txt'),'utf8'),'Do not delete');
  await fixtureRm(join(f.index,'important-user-file.txt'));
  await assert.rejects(stageIndexRemoval({...f.record,index:{kind:'source',dev:'999999',ino:'999999'}},f.cache,trash),/INDEX_REMOVAL_UNSAFE/);
  const saved=join(f.root,'saved');await rename(f.index,saved);await fixtureLink(saved,f.index);
  await assert.rejects(stageIndexRemoval(f.record,f.cache,trash),/INDEX_REMOVAL_UNSAFE/);assert.equal(calls,0);assert.equal(await readFile(join(saved,'catalog.sqlite'),'utf8'),'SQLite format 3\0fixture');
});
test('a known remote index can be removed while offline without touching its share or other caches',async t=>{
  const f=await fixture(t),key='a'.repeat(32),index=join(f.cache,'remote',key),other=join(f.cache,'remote','b'.repeat(32));
  await mkdir(index,{recursive:true});await mkdir(other);await writeFile(join(index,'catalog.sqlite'),'SQLite format 3\0fixture');await writeFile(join(other,'catalog.sqlite'),'Other');
  const record={id:'remote',root:join(f.root,'offline-share'),name:'Offline',index:{kind:'local',key}};
  assert.equal(await libraryIndexPath(record,f.cache),index);
  const staged=await stageIndexRemoval(record,f.cache,async path=>fixtureRm(path,{recursive:true,force:true}));await staged.commit();
  assert.equal(await lstat(index).catch(()=>null),null);assert.equal(await readFile(join(other,'catalog.sqlite'),'utf8'),'Other');
});
test('macOS system trash accepts a newly-created private test index', {skip:process.platform!=='darwin'},async t=>{
  const f=await fixture(t),staged=await stageIndexRemoval(f.record,f.cache,trashIndex);await staged.commit();
  assert.equal(await lstat(f.index).catch(()=>null),null);assert.equal(await readFile(join(f.source,'original.txt'),'utf8'),'Keep original');
});

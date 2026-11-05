import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,realpath,mkdir,writeFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {openSourceDirectory,scanSourceDirectory} from '../dist/index.js';

async function fixture(t){
  const root=await realpath(await mkdtemp(join(tmpdir(),'knowledge-incremental-'))), source=join(root,'source');await mkdir(source);
  const stores=[];t.after(async()=>{for(const s of stores)await s.close();await rm(root,{recursive:true,force:true});});
  const open=async()=>{const s=await openSourceDirectory(source,join(root,'cache'));stores.push(s);return s;};
  return {root,source,open};
}

test('discovery commits a bounded first batch before content work and cancellation retains unseen cached files',async t=>{
  const f=await fixture(t),s=await f.open(),identity=await stat(f.source,{bigint:true});
  await s.replaceSourceInventory([], [{path:'old-unseen.txt',kind:'pending',reason:''}],[],identity);
  for(let i=0;i<620;i++)await writeFile(join(f.source,`${String(i).padStart(4,'0')}.txt`),'Contentkeyword');
  let batches=0,content=0;const controller=new AbortController();
  s.importFile=async()=>{content++;throw new Error('Content must not start during discovery');};
  await scanSourceDirectory(s,undefined,controller.signal,{
    async onCatalogBatch(state){
      batches++;assert.equal(content,0);assert.ok(state.discovered>0&&state.discovered<=200);
      const page=await s.browsePage(null,'name',0,50,null,false,false,true);
      assert.ok(page.total>1&&page.total<621,'new files are visible before the tree is complete');
      assert.ok(page.documents.every(doc=>typeof doc.file_id==='string'),'catalogue identity exists before indexing');
      controller.abort();
    },
    onCheckpoint(){if(!batches)controller.abort();},
  });
  assert.ok(batches>0,'discovery must publish committed batches, not wait for the complete tree');
  assert.equal(content,0);
  const old=await s.sourceIssue('issue:old-unseen.txt',true);assert.ok(old,'an interrupted generation cannot erase unseen cached records');
});

test('catalogue pagination and counts never construct or sort the full library in JavaScript',async t=>{
  const f=await fixture(t),s=await f.open(),db=s.catalog;
  const insert=db.prepare('INSERT INTO documents(id,path,name,hash,added_at,indexed_at,chunks,source_path,relative_path) VALUES(?,?,?,?,?,?,?,?,?)');
  db.exec('BEGIN');for(let i=0;i<1200;i++){const name=`file-${String(i).padStart(4,'0')}.txt`,path=join(f.source,name);insert.run(randomUUID(),path,name,'0'.repeat(64),i,i,1,path,name);}db.exec('COMMIT');
  for(const method of ['browseOrder','filePaths','fileIssues','orderMetadata','orderKnownMetadata'])s[method]=()=>{throw new Error(`Unbounded legacy path: ${method}`);};
  for(const sort of ['name','added','updated','modified','size','type']){
    const page=await s.browsePage(null,sort,0,50,null,false,false,true);assert.equal(page.total,1200);assert.equal(page.documents.length,50);
    const next=await s.browseWindow(null,sort,null,false,{catalogOnly:true,offset:1150});assert.equal(next.documents.length,50);
  }
  assert.equal(await s.fileCount(false,true),1200);assert.equal((await s.directories(false,true))[0].count,1200);
  assert.equal((await s.tags(true))[0].count,1200);
});


test('all SQL sort orders support reversible cursors, stable identity, prefix isolation and tail refill',async t=>{
  const f=await fixture(t),s=await f.open(),identity=await stat(f.source,{bigint:true}),db=s.catalog;
  const run=await s.beginSourceScan(identity);
  await s.discoverSourceBatch(run,['notes','notes2'],Array.from({length:135},(_,i)=>({path:`${i<130?'notes':'notes2'}/f-${String(i).padStart(3,'0')}.txt`,kind:'pending'})),identity);
  const firstId=(await s.browsePage(null,'name',0,50,'notes',false,false,true)).documents[0].file_id;
  const insert=db.prepare('INSERT INTO documents(id,path,name,hash,added_at,indexed_at,chunks,source_path,relative_path) VALUES(?,?,?,?,?,?,?,?,?)');
  for(let i=0;i<130;i++){const path=`notes/f-${String(i).padStart(3,'0')}.txt`;insert.run(`d${i}`,join(f.source,path),path.split('/').at(-1),'a'.repeat(64),i%7,i%11,1,join(f.source,path),path);if(i%3)db.prepare('INSERT INTO source_metadata VALUES(?,?,?,?)').run(path,i%9,i%13,'txt');}
  assert.equal((await s.browsePage(null,'name',0,50,'notes',false,false,true)).documents[0].file_id,firstId);
  for(const sort of ['name','added','updated','type','size','modified'])for(const descending of [false,true]){
    const a=await s.browsePage(null,sort,0,50,'notes',descending,false,true),b=await s.browsePage(null,sort,50,50,'notes',descending,false,true,a.nextCursor);
    const back=await s.browsePage(null,sort,0,50,'notes',descending,false,true,b.previousCursor,true);
    assert.equal(a.total,130);assert.equal(b.offset,50);assert.deepEqual(back.documents.map(d=>d.file_id),a.documents.map(d=>d.file_id));
    assert.equal(new Set([...a.documents,...b.documents].map(d=>d.file_id)).size,100);
    const window=await s.browseWindow(null,sort,'notes',descending,{catalogOnly:true,offset:129,limit:50});assert.equal(window.offset,80);assert.equal(window.documents.length,50);
    await assert.rejects(s.browsePage(null,sort,0,50,'notes2',descending,false,true,a.nextCursor),/does not belong/);
  }
  s.interruptSourceScan(run);
});

test('superseded scans, recreated pending files and blocked subtrees cannot lose their cached records',async t=>{
  const f=await fixture(t),s=await f.open(),identity=await stat(f.source,{bigint:true});
  await s.replaceSourceInventory(['blocked'],[{path:'recreated.txt',kind:'pending',reason:''},{path:'gone.txt',kind:'pending',reason:''},{path:'blocked/old.txt',kind:'pending',reason:''}],[],identity);
  const old=await s.beginSourceScan(identity),run=await s.beginSourceScan(identity);
  await assert.rejects(s.discoverSourceBatch(old,[],[{path:'late.txt',kind:'pending'}],identity),/superseded/);
  s.recordScanDirectory(run,'',true);s.recordScanDirectory(run,'blocked',false);
  await writeFile(join(f.source,'recreated.txt'),'Created after enumeration');
  await s.finishSourceScan(run,['blocked'],identity);
  assert.ok(await s.sourceIssue('issue:recreated.txt',true));assert.ok(await s.sourceIssue('issue:blocked/old.txt',true));assert.equal(await s.sourceIssue('issue:gone.txt',true),undefined);
});

test('a failed batch consumer propagates instead of masquerading as an unreadable directory',async t=>{
  const f=await fixture(t),s=await f.open();await writeFile(join(f.source,'note.txt'),'Hello');
  await assert.rejects(scanSourceDirectory(s,undefined,undefined,{onCatalogBatch(){throw new Error('Consumer failed');}}),/Consumer failed/);
  assert.equal(s.catalog.prepare("SELECT state FROM source_scan_runs ORDER BY started_at DESC LIMIT 1").get().state,'interrupted');
  assert.equal(await s.fileCount(false,true),1);
});


test('a version-6 content catalogue upgrades additively without replacing tags or native vector files',async t=>{
  const f=await fixture(t),first=await f.open(),{DatabaseSync}=await import('node:sqlite');
  const index=join(f.source,'.knowledge');await first.close();
  const db=new DatabaseSync(join(index,'catalog.sqlite'));
  for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'catalog_%'").all())db.exec(`DROP TRIGGER ${name}`);
  db.exec('DROP INDEX documents_source_key; DROP INDEX source_issues_key; DROP INDEX source_folders_key; ALTER TABLE documents DROP COLUMN source_key; DROP TABLE source_files; DROP TABLE source_directories; DROP TABLE source_scan_directories; DROP TABLE source_scan_runs; DROP TABLE source_catalog_meta;');
  const path=join(f.source,'legacy.txt');
  db.prepare('INSERT INTO documents(id,path,name,hash,added_at,indexed_at,chunks,source_path,relative_path) VALUES(?,?,?,?,?,?,?,?,?)').run('legacy',path,'legacy.txt','b'.repeat(64),1,2,3,path,'legacy.txt');
  db.exec("INSERT INTO tags(id,name,created_at) VALUES('kept','Kept',1); INSERT INTO document_tags VALUES('legacy','kept',1)");
  const folder=db.prepare('INSERT INTO source_folders VALUES(?)');db.exec('BEGIN');for(let i=0;i<2500;i++)folder.run(`empty/${i}`);db.exec('COMMIT');db.close();
  const vectors=join(index,'vectors.lance');await mkdir(vectors);await writeFile(join(vectors,'marker'),'Untouched committed vector data');
  const migrationStarted=performance.now();const second=await f.open(),page=await second.browsePage(null,'name',0,50,null,undefined,false,true);
  t.diagnostic(`v6 migration with 2500 empty folders: ${(performance.now()-migrationStarted).toFixed(2)}ms`);
  assert.equal(second.catalog.prepare("SELECT explicit_count FROM source_directories WHERE path=''").get().explicit_count,2500);
  assert.equal(second.catalog.prepare("SELECT count(*) AS n FROM source_directories WHERE explicit_count=1 AND path GLOB 'empty/*'").get().n,2500);
  assert.equal(page.documents[0].id,'legacy');assert.equal(page.documents[0].file_id,'legacy');assert.deepEqual(page.documents[0].tags,['kept']);
  assert.equal(second.catalog.prepare('PRAGMA user_version').get().user_version,6);assert.equal(second.rebuiltIndex,false);
  assert.equal(await (await import('node:fs/promises')).readFile(join(vectors,'marker'),'utf8'),'Untouched committed vector data');
  await second.close();const future=new DatabaseSync(join(index,'catalog.sqlite'));future.exec('UPDATE source_catalog_meta SET schema_version=99');future.close();
  await assert.rejects(f.open(),/Unsupported source catalogue schema/);
  assert.equal(await (await import('node:fs/promises')).readFile(join(vectors,'marker'),'utf8'),'Untouched committed vector data');
});

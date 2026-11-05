import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {openSourceDirectory,scanSourceDirectory} from '../dist/index.js';

const root=await realpath(await mkdtemp(join(tmpdir(),'knowledge-sql-benchmark-')));
const source=join(root,'source');await mkdir(source);
const store=await openSourceDirectory(source,join(root,'cache'));
try{
  const db=store.catalog,n=Number(process.env.KNOWLEDGE_BENCH_ROWS??100000);
  const put=db.prepare('INSERT INTO documents(id,path,name,hash,added_at,indexed_at,chunks,source_path,relative_path) VALUES(?,?,?,?,?,?,?,?,?)');
  const meta=db.prepare('INSERT INTO source_metadata VALUES(?,?,?,?)');
  const seed=performance.now();db.exec('BEGIN');
  for(let i=0;i<n;i++){const name=`file-${String(i).padStart(6,'0')}.txt`,relative=`notes/${name}`,path=join(source,relative);put.run(String(i).padStart(10,'0'),path,name,'0'.repeat(64),i,i,1,path,relative);meta.run(relative,(i*37)%10000,i*1000,'txt');}
  db.exec('COMMIT');console.log(JSON.stringify({rows:n,seedMs:Math.round(performance.now()-seed),database:'synthetic committed catalogue, no real content/vector coverage'}));
  for(const sort of ['name','added','updated','type','size','modified']){
    const start=performance.now(),page=await store.browsePage(null,sort,0,50,null,undefined,false,true),firstMs=performance.now()-start;
    const cursorStart=performance.now();const next=await store.browsePage(null,sort,50,50,null,undefined,false,true,page.nextCursor);const cursorMs=performance.now()-cursorStart;
    const tailStart=performance.now();await store.browseWindow(null,sort,null,undefined,{catalogOnly:true,offset:n-50});const tailMs=performance.now()-tailStart;
    const legacyStart=performance.now();await store.browseOrder(sort,null,undefined,false,null,false,true);const legacyMs=performance.now()-legacyStart;
    console.log(JSON.stringify({sort,firstMs:+firstMs.toFixed(2),cursorMs:+cursorMs.toFixed(2),tailMs:+tailMs.toFixed(2),legacyWholeListMs:+legacyMs.toFixed(2),total:page.total,nextOffset:next.offset}));
  }
  console.log(JSON.stringify({queryPlan:db.prepare('EXPLAIN QUERY PLAN SELECT * FROM source_files ORDER BY size_known DESC,size_key DESC,file_id ASC LIMIT 50').all()}));
}finally{await store.close();await rm(root,{recursive:true,force:true});}

const actual=await realpath(await mkdtemp(join(tmpdir(),'knowledge-discovery-benchmark-')));
const actualSource=join(actual,'source');await mkdir(actualSource);
for(let start=0;start<2000;start+=50)await Promise.all(Array.from({length:50},(_,j)=>writeFile(join(actualSource,`real-${start+j}.txt`),'Benchmark')));
const live=await openSourceDirectory(actualSource,join(actual,'cache')),controller=new AbortController();
let firstBatchMs,firstTotal,batches=0;const start=performance.now();
live.importFile=async()=>{controller.abort();return {unchanged:true};};
try{
  await scanSourceDirectory(live,undefined,controller.signal,{async onCatalogBatch(){batches++;if(firstBatchMs===undefined){firstBatchMs=performance.now()-start;firstTotal=(await live.browsePage(null,'name',0,50,null,undefined,false,true)).total;}}});
  console.log(JSON.stringify({realFiles:2000,firstBatchMs:+firstBatchMs.toFixed(2),firstTotal,discoveryAndMetadataMs:+(performance.now()-start).toFixed(2),batches,finalTotal:await live.fileCount(false,true),content:'cancelled at first import; no content/index latency claimed'}));
}finally{await live.close();await rm(actual,{recursive:true,force:true});}

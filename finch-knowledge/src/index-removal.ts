import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {lstat,readdir,realpath,rename,stat} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {promisify} from 'node:util';
import type {LibraryRecord} from './libraries.js';
import {inspectSourceFilesystem,remoteIndexRoot} from './index-location.js';

const execute=promisify(execFile);
const same=(a:string,b:string)=>process.platform==='win32'?resolve(a).toLowerCase()===resolve(b).toLowerCase():resolve(a)===resolve(b);
const absent=(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT';

/** Never accept an arbitrary index path from a webview or storage. Only derive an owned location. */
export async function libraryIndexPath(record:LibraryRecord,cachePath:string):Promise<string>{
  if(record.index?.kind==='local')return remoteIndexRoot(cachePath,record.index.key);
  const root=await realpath(record.root);
  if(!same(root,record.root))throw new Error('INDEX_REMOVAL_UNSAFE');
  const filesystem=await inspectSourceFilesystem(root);
  if(filesystem.network)throw new Error('INDEX_REMOVAL_UNSAFE');
  const current=await stat(root,{bigint:true});
  if(record.index?.kind==='source'&&record.index.dev!==undefined&&(String(current.dev)!==record.index.dev||String(current.ino)!==record.index.ino))throw new Error('INDEX_REMOVAL_UNSAFE');
  return join(root,'.knowledge');
}

/** Use the operating system's recoverable trash, never recursively delete a source tree. */
export async function trashIndex(path:string):Promise<void>{
  if(process.platform==='darwin'){
    const script="function run(argv) { ObjC.import('Foundation'); var error=Ref(); var result=Ref(); if (!$.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(argv[0]),result,error)) { throw new Error(error[0] ? ObjC.unwrap(error[0].localizedDescription) : 'Trash failed'); } }";
    await execute('/usr/bin/osascript',['-l','JavaScript','-e',script,path],{timeout:30000,maxBuffer:65536});
  }else if(process.platform==='win32'){
    const literal=path.replaceAll("'","''");
    const script=`Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${literal}',[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)`;
    await execute('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:30000,maxBuffer:65536});
  }else await execute('gio',['trash','--',path],{timeout:30000,maxBuffer:65536});
}

export interface StagedIndexRemoval {path:string;rollback():Promise<void>;commit():Promise<void>}
/** Call only after all handles/writers for this exact index have drained. Staging is reversible
 * until the registry commit succeeds; source documents and shared engine caches are never moved. */
export async function stageIndexRemoval(record:LibraryRecord,cachePath:string,trash:(path:string)=>Promise<void>=trashIndex):Promise<StagedIndexRemoval>{
  const path=await libraryIndexPath(record,cachePath);
  const cacheIndex=same(dirname(path),join(cachePath,'remote'))&&/^[a-f0-9]{32}$/.test(basename(path));
  if(!cacheIndex&&!same(path,join(record.root,'.knowledge')))throw new Error('INDEX_REMOVAL_UNSAFE');
  const base=cacheIndex?cachePath:record.root;
  const rootInfo=await stat(base,{bigint:true});
  const original=await lstat(path,{bigint:true}).catch(error=>{if(absent(error))return null;throw error;});
  if(!original)return {path,rollback:async()=>{},commit:async()=>{}};
  if(!original.isDirectory()||original.isSymbolicLink())throw new Error('INDEX_REMOVAL_UNSAFE');
  // A symlink at cache/remote must not redirect removal outside Finch's private cache.
  if(cacheIndex){const remote=await lstat(join(cachePath,'remote'));if(!remote.isDirectory()||remote.isSymbolicLink())throw new Error('INDEX_REMOVAL_UNSAFE');}
  if(!same(await realpath(dirname(path)),dirname(path)))throw new Error('INDEX_REMOVAL_UNSAFE');
  const allowed=new Set(['catalog.sqlite','catalog.sqlite-wal','catalog.sqlite-shm','vectors.lance','.DS_Store','desktop.ini']);
  if((await readdir(path)).some(name=>!allowed.has(name)))throw new Error('INDEX_REMOVAL_UNSAFE');
  const catalogue=await lstat(join(path,'catalog.sqlite'));
  if(!catalogue.isFile()||catalogue.isSymbolicLink())throw new Error('INDEX_REMOVAL_UNSAFE');
  const now=await lstat(path,{bigint:true}),rootNow=await stat(base,{bigint:true});
  if(now.dev!==original.dev||now.ino!==original.ino||rootNow.dev!==rootInfo.dev||rootNow.ino!==rootInfo.ino)throw new Error('INDEX_REMOVAL_UNSAFE');
  const quarantine=join(dirname(path),`${basename(path)}-removed-${randomUUID()}`);
  await rename(path,quarantine);
  async function rollback():Promise<void>{
    const exists=await lstat(quarantine).catch(error=>{if(absent(error))return null;throw error;});
    if(!exists)return;
    const replacement=await lstat(path).catch(error=>{if(absent(error))return null;throw error;});
    if(replacement)throw new Error(`INDEX_REMOVAL_RECOVERY: ${quarantine}`);
    await rename(quarantine,path);
  }
  const moved=await lstat(quarantine,{bigint:true});
  if(moved.dev!==original.dev||moved.ino!==original.ino){await rollback();throw new Error('INDEX_REMOVAL_UNSAFE');}
  return {path,rollback,async commit(){try{await trash(quarantine);}catch(error){await rollback();throw error;}}};
}

import {lstat,opendir} from 'node:fs/promises';
import type {LibraryRecord} from './libraries.js';
import {inspectSourceFilesystem,remoteIndexKey} from './index-location.js';

export type LibraryState='unknown'|'checking'|'available'|'offline'|'unavailable';
export interface LibraryStateRow {id:string;fingerprint:string;state:LibraryState}
export const libraryFingerprint=(record:LibraryRecord)=>JSON.stringify([record.root,record.index??null]);

/** Availability means that the original directory can be opened, not that content is indexed. */
export async function probeLibrary(record:LibraryRecord):Promise<LibraryState>{
  try{
    const root=await lstat(record.root,{bigint:true});
    if(!root.isDirectory()||root.isSymbolicLink())return 'unavailable';
    if(record.index?.kind==='source'&&record.index.dev!==undefined&&(String(root.dev)!==record.index.dev||String(root.ino)!==record.index.ino))return 'unavailable';
    const directory=await opendir(record.root);await directory.close();
    if(record.index?.kind==='local'){
      const filesystem=await inspectSourceFilesystem(record.root);
      if(!filesystem.network)return 'offline';
      if(remoteIndexKey(filesystem.identity)!==record.index.key)return 'unavailable';
    }
    return 'available';
  }catch(error){return ['ENOENT','ENOTDIR','ENOTCONN'].includes((error as NodeJS.ErrnoException).code??'')?'offline':'unavailable';}
}
interface Entry {record:LibraryRecord;fingerprint:string;state:LibraryState;queued:boolean;checkedAt:number;attemptedAt:number}
interface Options {probe?:(record:LibraryRecord)=>Promise<LibraryState>;timeoutMs?:number;ttlMs?:number;concurrency?:number;now?:()=>number}

/** Small read-only observer, separate from content/index locks. Timed-out physical I/O still
 * occupies its slot until it settles: repeated menu opens cannot leak unbounded SMB probes. */
export class LibraryAvailability {
  private readonly entries=new Map<string,Entry>();
  private readonly running=new Set<Entry>();
  private queue:Entry[]=[];
  private disposed=false;
  private readonly timers=new Set<ReturnType<typeof setTimeout>>();
  private readonly probe:(record:LibraryRecord)=>Promise<LibraryState>;
  private readonly now:()=>number;
  constructor(private readonly changed:(rows:LibraryStateRow[])=>void,private readonly options:Options={}){this.probe=options.probe??probeLibrary;this.now=options.now??Date.now;}
  private publish():void{if(this.disposed)return;try{this.changed([...this.entries].map(([id,e])=>({id,fingerprint:e.fingerprint,state:e.state})));}catch{/* A detached page must not break probe retirement. */}}
  state(record:LibraryRecord):LibraryState{const e=this.entries.get(record.id);return e?.fingerprint===libraryFingerprint(record)?e.state:'unknown';}
  refresh(records:LibraryRecord[],force=false):void{
    if(this.disposed)return;
    const ids=new Set(records.map(r=>r.id));for(const id of this.entries.keys())if(!ids.has(id))this.entries.delete(id);
    for(const record of records){
      const fingerprint=libraryFingerprint(record);let e=this.entries.get(record.id);
      if(!e||e.fingerprint!==fingerprint){e={record:{...record},fingerprint,state:'unknown',queued:false,checkedAt:-Infinity,attemptedAt:-Infinity};this.entries.set(record.id,e);}
      if(e.queued||this.running.has(e))continue;
      const age=this.now()-e.checkedAt;
      if(age<(this.options.ttlMs??15000)&&(!force||this.now()-e.attemptedAt<1000))continue;
      e.queued=true;this.queue.push(e);
    }
    this.pump();
  }
  private current(entry:Entry):boolean{return !this.disposed&&this.entries.get(entry.record.id)===entry;}
  private pump():void{
    while(!this.disposed&&this.running.size<(this.options.concurrency??2)&&this.queue.length){
      const e=this.queue.shift()!;e.queued=false;if(!this.current(e))continue;
      this.running.add(e);e.attemptedAt=this.now();e.state='checking';this.publish();
      const timer=setTimeout(()=>{this.timers.delete(timer);if(this.current(e)){e.state='unavailable';e.checkedAt=this.now();this.publish();}},this.options.timeoutMs??2000);
      timer.unref?.();this.timers.add(timer);
      void Promise.resolve().then(()=>this.probe(e.record)).then(state=>{if(this.current(e)){e.state=state;e.checkedAt=this.now();this.publish();}},()=>{if(this.current(e)){e.state='unavailable';e.checkedAt=this.now();this.publish();}}).finally(()=>{
        clearTimeout(timer);this.timers.delete(timer);this.running.delete(e);this.pump();
      });
    }
  }
  dispose():void{this.disposed=true;this.queue=[];this.entries.clear();for(const timer of this.timers)clearTimeout(timer);this.timers.clear();}
}

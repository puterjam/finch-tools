import { createHash } from 'node:crypto';
import { basename, isAbsolute, resolve } from 'node:path';

export type LibraryIndex = {kind:'source';dev?:string;ino?:string} | {kind:'local';key:string};
export interface LibraryRecord { id: string; root: string; name: string; index?:LibraryIndex }
interface LibraryRegistryData { version: 1; libraries: LibraryRecord[] }
export const LIBRARIES_STORAGE_KEY = 'sourceLibraries';

/** Registry metadata only. No filesystem access or changes to source directories. */
export class LibraryRegistry {
  private records: LibraryRecord[] = [];
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly read: () => Promise<unknown>, private readonly save: (data: LibraryRegistryData) => Promise<void>) {}

  private record(root: string, name?: string): LibraryRecord {
    if (!root || !isAbsolute(root)) throw new Error('Choose an absolute library directory.');
    root = resolve(root);
    const key = process.platform === 'win32' ? root.toLowerCase() : root;
    const id = createHash('sha256').update(key).digest('hex').slice(0, 24);
    return { id, root, name: name ?? (basename(root) || root) };
  }

  private copy(record:LibraryRecord):LibraryRecord {return {...record,...(record.index?{index:{...record.index}}:{})};}
  list(): LibraryRecord[] { return this.records.map(record => this.copy(record)); }
  forRoot(root: string): LibraryRecord | undefined {
    const id = root ? this.record(root).id : undefined;
    const record = this.records.find(item => item.id === id);
    return record ? this.copy(record) : undefined;
  }
  find(id: string): LibraryRecord {
    const record = this.records.find(record => record.id === id);
    if (!record) throw new Error('Library is no longer registered.');
    return this.copy(record);
  }

  async load(currentRoot?: string): Promise<void> {
    const stored = await this.read();
    const data = stored as Partial<LibraryRegistryData> | null;
    const records: LibraryRecord[] = [];
    if (data?.version === 1 && Array.isArray(data.libraries)) {
      for (const value of data.libraries) {
        if (!value || typeof value.root !== 'string' || !isAbsolute(value.root)) continue;
        const name = typeof value.name === 'string' ? value.name.trim() : '';
        const record = this.record(value.root, name && name.length <= 60 ? name : undefined);
        if(value.index?.kind==='source')record.index={kind:'source',...(/^\d{1,40}$/.test(value.index.dev??'')&&/^\d{1,40}$/.test(value.index.ino??'')?{dev:value.index.dev,ino:value.index.ino}:{})};
        else if(value.index?.kind==='local'&&/^[a-f0-9]{32}$/.test(value.index.key))record.index={kind:'local',key:value.index.key};
        if (!records.some(item => item.id === record.id)) records.push(record);
      }
    }
    this.records = records;
    // Migrate the legacy pointer only once. An authoritative registry (even empty) must
    // never resurrect a removed library from a stale selection left by a failed save.
    if (!(data?.version===1&&Array.isArray(data.libraries)) && currentRoot && isAbsolute(currentRoot)) await this.add(currentRoot);
  }

  private update<T>(change: (records: LibraryRecord[]) => T): Promise<T> {
    const next = this.tail.then(async () => {
      const records = this.list();
      const result = change(records);
      await this.save({ version: 1, libraries: records });
      this.records = records;
      return result;
    });
    this.tail = next.catch(() => {});
    return next;
  }

  rename(id:string,name:string):Promise<LibraryRecord>{
    name=name.trim();if(!name||name.length>60)return Promise.reject(new Error('Library name must be 1–60 characters.'));
    return this.update(records=>{const record=records.find(v=>v.id===id);if(!record)throw new Error('Library is no longer registered.');record.name=name;return this.copy(record);});
  }
  remove(id:string):Promise<LibraryRecord>{
    return this.update(records=>{const index=records.findIndex(v=>v.id===id);if(index<0)throw new Error('Library is no longer registered.');return this.copy(records.splice(index,1)[0]!);});
  }
  add(root: string,index?:LibraryIndex): Promise<LibraryRecord> {
    const record = this.record(root);
    return this.update(records => {
      const existing = records.find(item => item.id === record.id);
      if (existing) {if(index)existing.index={...index};return this.copy(existing);}
      if(index)record.index={...index};records.push(record);
      return this.copy(record);
    });
  }

}

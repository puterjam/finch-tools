import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ACCEPTED, DEFAULT_TAG, KnowledgeStore, MAX_FILE_BYTES, type SourceIssue } from './store.js';
import { IndexSkipError, type IndexSkipReason } from './indexing-result.js';
import { inspectSourceFilesystem, remoteIndexKey, remoteIndexRoot, type SourceFilesystem } from './index-location.js';
import { hideKnowledgeDirectory } from './index-visibility.js';
import { openIndexWithRebuild } from './index-rebuild.js';

export const INDEX_DIRECTORY = '.knowledge';
export interface ScanOutcome {
  paused?: boolean;
  updated: string[]; removed: string[]; unchanged: number; unreachable: string[];
  failed: Array<{ name: string; reason: string }>;
  skipped: Array<{ name: string; reason: IndexSkipReason }>;
  moved: string[];
}
// Windows paths are case-insensitive even when catalogue and enumeration spellings differ.
const pathKey = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const ignoredSourceDirectory = (name: string) => ['$recycle.bin', 'system volume information'].includes(name.toLowerCase());
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** Sources must stay below the selected directory and outside private/nested index folders. */
export async function assertSourcePath(root: string, input: string): Promise<string> {
  const path = resolve(root, input);
  if (!inside(root, path) || relative(root, path).split(sep).some(part => part.toLowerCase() === INDEX_DIRECTORY)) throw new Error('Source must be inside the selected knowledge directory, outside .knowledge.');
  let cursor = root;
  for (const part of relative(root, path).split(sep)) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Choose a regular file, not a symbolic link.');
  }
  if (!inside(await realpath(root), await realpath(path))) throw new Error('Source is outside the selected knowledge directory.');
  return path;
}

/** Existing content and empty directories are both valid; no source file is copied or moved. */
export async function openSourceDirectory(input: string, cachePath: string, options: { requireEngine?: (extension: string) => Promise<void>; progress?: (message: string) => void; onStatusChange?: (path: string, phase: 'processing' | 'settled') => void; sourceFilesystem?: (root: string) => Promise<SourceFilesystem>; onVisibilityWarning?: () => void } = {}): Promise<KnowledgeStore> {
  if (!isAbsolute(input)) throw new Error('Choose an absolute library directory.');
  const root = await realpath(input);
  if (!(await stat(root, { bigint: true })).isDirectory()) throw new Error('Choose a directory, not a file.');
  if (basename(root) === INDEX_DIRECTORY) throw new Error('Select the source directory, not .knowledge itself.');
  const filesystem = await (options.sourceFilesystem ?? inspectSourceFilesystem)(root);
  let index = join(root, INDEX_DIRECTORY);
  let indexKey: string | undefined;
  let engineCache = cachePath;
  if (filesystem.network) {
    const cache = await realpath(cachePath);
    engineCache = cache;
    if (inside(root, cache) || (await inspectSourceFilesystem(cache)).network) throw new Error('Network libraries require a local Finch cache directory.');
    indexKey = remoteIndexKey(filesystem.identity);
    index = remoteIndexRoot(cache, indexKey);
    for (const parent of [join(cache, 'remote')]) {
      const info = await lstat(parent).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Knowledge index data must not be a symbolic link.');
    }
  }
  let sourceProbe: Promise<void> | undefined;
  const sourceGuard = (): Promise<void> => {
    if (!sourceProbe) sourceProbe = (async () => {
      // Missing roots must fail before querying network mappings or touching cached indexes.
      const info = await stat(root).catch(() => null);
      if (!info?.isDirectory()) throw new Error('The library folder is no longer on disk.');
      if (filesystem.network) {
        const current = await (options.sourceFilesystem ?? inspectSourceFilesystem)(root);
        if (!current.network || current.identity !== filesystem.identity) throw new Error('The network source is disconnected or mapped to a different share. Reconnect the original share and retry.');
      }
    })().finally(() => { sourceProbe = undefined; });
    return sourceProbe;
  };
  const store = await openIndexWithRebuild(index, { ...options, cachePath: engineCache, directoryRoot: root, remoteIndexKey: indexKey, sourceGuard });
  if (!indexKey && !(await hideKnowledgeDirectory(index))) {
    try { options.onVisibilityWarning?.(); } catch { /* Visibility warnings must not close a usable index. */ }
  }
  return store;
}

/** Incremental recursive reconciliation. Failed reads never become deletions. */
export interface ScanCheckpoint { completed: number; total: number; changed?: boolean }
export interface ScanOptions {
  onCheckpoint?: (state: ScanCheckpoint) => void | Promise<void>;
  onDiscover?: (count: number) => void;
  onCatalogBatch?: (state: {discovered:number;catalogVersion:number}) => void | Promise<void>;
  yieldMs?: number;
}
export async function scanSourceDirectory(store: KnowledgeStore, report?: (message: string, percent: number) => void, signal?: AbortSignal, options: ScanOptions = {}): Promise<ScanOutcome> {
  const root = store.directoryRoot;
  if (!root) throw new Error('No source directory selected.');
  const outcome: ScanOutcome = { updated: [], removed: [], unchanged: 0, unreachable: [], failed: [], skipped: [], moved: [] };
  // A still-existing local mountpoint is not evidence that its network share is connected.
  await store.assertSourceAvailable();
  // A root that went offline or changed mounts must not wipe the catalogue.
  const rootInfo = await stat(root, { bigint: true });
  const run=await store.beginSourceScan(rootInfo,signal);
  try {
  const files: Array<{ path: string; size: number }> = [];
  let discovered = 0;
  options.onDiscover?.(0);
  let pendingFolders: string[] = [];
  let pendingFiles: Array<{path:string;kind:'pending'|'unsupported'}> = [];
  let lastFlush=Date.now();
  async function flush():Promise<void>{
    if(signal?.aborted||(!pendingFolders.length&&!pendingFiles.length))return;
    await store.discoverSourceBatch(run,pendingFolders,pendingFiles,rootInfo,signal);
    pendingFolders=[];pendingFiles=[];lastFlush=Date.now();
    await options.onCatalogBatch?.({discovered,catalogVersion:store.catalogVersion});
    options.onDiscover?.(discovered);
    await new Promise<void>(done=>setImmediate(done));
  }
  const sourceKey = (path: string) => relative(root, path).split(sep).join('/');
  const seen = new Set<string>();
  const unsupported = new Set<string>();
  const blocked: string[] = [];
  const inventoried = new Map<string,{dev:bigint;ino:bigint}>();
  async function walk(directory: string): Promise<void> {
    if (signal?.aborted) return;
    await flush();if(signal?.aborted)return;
    let entries,directoryInfo;
    try { directoryInfo=await lstat(directory,{bigint:true});if(directoryInfo.isSymbolicLink()||!directoryInfo.isDirectory())throw new Error('Source directory changed.');entries=await opendir(directory); }
    catch { blocked.push(directory);outcome.unreachable.push(relative(root!,directory)||root!);store.recordScanDirectory(run,sourceKey(directory),false);return; }
    const iterator=entries[Symbol.asyncIterator]();
    let complete=true;
    try { while(!signal?.aborted) {
      let next:Awaited<ReturnType<typeof iterator.next>>;
      try{next=await iterator.next();}
      catch{complete=false;blocked.push(directory);outcome.unreachable.push(relative(root!,directory)||root!);break;}
      if(next.done)break;
      const entry=next.value!;
      if (signal?.aborted) return;
      const path = join(directory, entry.name);
      if (entry.name === INDEX_DIRECTORY || entry.name.startsWith('.')) continue;
      if (entry.isDirectory() && ignoredSourceDirectory(entry.name)) continue;
      if (entry.isSymbolicLink()) { blocked.push(path); continue; }
      if (entry.isDirectory()) { pendingFolders.push(sourceKey(path)); await flush(); await walk(path); }
      else if (entry.isFile()) {
        if (ACCEPTED.includes(extname(path).toLowerCase())) {
          seen.add(pathKey(path));
          files.push({ path, size: Number.MAX_SAFE_INTEGER });
          pendingFiles.push({path:sourceKey(path),kind:'pending'});
        } else { unsupported.add(pathKey(path)); pendingFiles.push({path:sourceKey(path),kind:'unsupported'}); }
        discovered++;
        if(pendingFiles.length+pendingFolders.length>=200||Date.now()-lastFlush>=150)await flush();
      }
    }}finally{await iterator.return?.();}
    if(!signal?.aborted){
      const current=await lstat(directory,{bigint:true}).catch(()=>null);
      if(!current?.isDirectory()||current.isSymbolicLink()||current.dev!==directoryInfo.dev||current.ino!==directoryInfo.ino){complete=false;blocked.push(directory);outcome.unreachable.push(sourceKey(directory)||root);}
      await flush();if(!signal?.aborted){if(complete)inventoried.set(pathKey(directory),directoryInfo);store.recordScanDirectory(run,sourceKey(directory),complete,directoryInfo);}
    }
  }
  await walk(root);
  if (signal?.aborted) return outcome;
  options.onDiscover?.(discovered);
  await options.onCheckpoint?.({ completed: 0, total: files.length });
  if(signal?.aborted)return outcome;
  // Metadata is bounded and happens after discovery is already visible, never before a batch.
  let metadataIndex=0;
  const metadata:Array<{path:string;size:number;mtimeMs:number}>=[];
  async function flushMetadata():Promise<void>{if(signal?.aborted||!metadata.length)return;await store.recordScanMetadata(run,metadata.splice(0,200),rootInfo,signal);await options.onCatalogBatch?.({discovered,catalogVersion:store.catalogVersion});}
  await Promise.all(Array.from({length:Math.min(store.indexStorage==='local'?2:4,files.length)},async()=>{
    while(metadataIndex<files.length&&!signal?.aborted){const file=files[metadataIndex++]!;const info=await lstat(file.path).catch(()=>null);file.size=info?.size??Number.MAX_SAFE_INTEGER;
      if(info?.isFile())metadata.push({path:sourceKey(file.path),size:info.size,mtimeMs:info.mtimeMs});
      if(metadata.length>=32)await flushMetadata();}
  }));
  await flushMetadata();if(signal?.aborted)return outcome;
  const documents = await store.list(true);
  files.sort((a, b) => a.size - b.size || a.path.localeCompare(b.path));
  async function sourcePresence(path: string): Promise<'present' | 'missing' | 'unsupported' | 'unavailable'> {
    if (!inside(root, path)) return 'unavailable';
    if (relative(root, path).split(sep).slice(0, -1).some(ignoredSourceDirectory)) return 'unsupported';
    if (blocked.some(directory => inside(directory, path))) return 'unavailable';
    try {
      const info = await lstat(path);
      if (info.isFile() && unsupported.has(pathKey(path))) return 'unsupported';
      return 'present';
    }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return 'unavailable'; }
    const currentRoot = await stat(root, { bigint: true }).catch(() => null);
    if (!currentRoot?.isDirectory() || currentRoot.dev !== rootInfo.dev || currentRoot.ino !== rootInfo.ino) return 'unavailable';
    // A whole removed/moved subtree has missing parents too. Climb to an ancestor that this
    // scan actually listed, rather than treating every absent parent as an offline volume.
    let parent = dirname(path);
    while (inside(root, parent)) {
      if (blocked.some(directory => inside(directory, parent))) return 'unavailable';
      const info = await lstat(parent,{bigint:true}).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
        throw error;
      }).catch(() => undefined);
      if (info === undefined || info?.isSymbolicLink()) return 'unavailable';
      if (info?.isDirectory()) {const captured=inventoried.get(pathKey(parent));return captured&&String(captured.dev)===String(info.dev)&&String(captured.ino)===String(info.ino)?'missing':'unavailable';}
      if (parent === root) break;
      parent = dirname(parent);
    }
    return 'unavailable';
  }
  const missing = new Map<string, (typeof documents)[number]>();
  for (const doc of documents) {
    if (signal?.aborted) return outcome;
    if (seen.has(pathKey(doc.path))) continue;
    const presence = await sourcePresence(doc.path);
    if (presence === 'missing' || presence === 'unsupported') missing.set(doc.id, doc);
    else if (presence === 'unavailable') outcome.unreachable.push(relative(root, doc.path));
  }
  for (const [index, file] of files.entries()) {
    const { path } = file;
    if (signal?.aborted) return outcome;
    store.assertScan(run);
    const name = relative(root, path);
    report?.(name, Math.floor(index / Math.max(files.length, 1) * 100));
    let issue: SourceIssue | null = null;
    let changed = false;
    try {
      const candidates = [...missing.values()].filter(doc => basename(doc.path) === basename(path)).map(doc => doc.id);
      const moved = await store.relocateSource(path, candidates, signal);
      if (signal?.aborted) return outcome;
      if (moved) { changed = true; missing.delete(moved); outcome.moved.push(name); }
      const indexed = await store.importFile(path, basename(path), DEFAULT_TAG, signal);
      if (indexed.unchanged) outcome.unchanged++; else { changed = true; outcome.updated.push(name); }
    } catch (error) {
      if (signal?.aborted) return outcome;
      if (error instanceof IndexSkipError) {
        outcome.skipped.push({ name, reason: error.reason });
        issue = { path: sourceKey(path), kind: error.reason, reason: '' };
      } else {
        const reason = error instanceof Error ? error.message : String(error);
        outcome.failed.push({ name, reason });
        issue = { path: sourceKey(path), kind: 'failed', reason };
      }
    }
    if (signal?.aborted) return outcome;
    store.assertScan(run);
    if (!await store.settleSourceFile(sourceKey(path), issue, rootInfo)) { outcome.unreachable.push(root); return outcome; }
    await options.onCheckpoint?.({ completed: index + 1, total: files.length, changed: changed || issue !== null });
    // Yield without adding a fixed delay to every unchanged file in a large directory.
    const delay = Math.max(0, Math.min(1000, options.yieldMs ?? 0));
    if (delay && !signal?.aborted) await new Promise<void>(done => {
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); done(); };
      const timer = setTimeout(finish, delay); signal?.addEventListener('abort', finish, { once: true });
    });
    else await new Promise<void>(done => setImmediate(done));
  }
  if (signal?.aborted) return outcome;
  await store.assertSourceAvailable();
  const finalRoot = await stat(root, { bigint: true }).catch(() => null);
  if (!finalRoot?.isDirectory() || finalRoot.dev !== rootInfo.dev || finalRoot.ino !== rootInfo.ino) {
    outcome.unreachable.push(root);
    return outcome;
  }
  for (const doc of missing.values()) {
    if (signal?.aborted) return outcome;
    const presence = await sourcePresence(doc.path);
    const current = await store.document(doc.id);
    store.assertScan(run);
    if ((presence === 'missing' || presence === 'unsupported') && current?.path === doc.path) {
      await store.remove(doc.id);
      outcome.removed.push(relative(root, doc.path));
    } else if (presence === 'unavailable') outcome.unreachable.push(relative(root, doc.path));
  }
  if (!signal?.aborted) await store.finishSourceScan(run,blocked.map(sourceKey),rootInfo,signal);
  report?.('', 100);
  return outcome;
  } finally { store.interruptSourceScan(run); }
}

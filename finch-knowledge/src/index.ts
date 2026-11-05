import type * as finch from 'finch';
import { execFile } from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {LibraryAvailability} from './library-availability.js';
export {LibraryAvailability,probeLibrary,libraryFingerprint} from './library-availability.js';
import { stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_TAG, KnowledgeStore, MAX_FILE_MB, SIZE_LIMIT_MESSAGE, engineForExtension, type DocumentSummary, type DocumentStatus, type DocumentSort } from './store.js';
import { expandImportTargets, MAX_BATCH_FILES, type ImportedFile, type ImportFailure, type ImportRequest, type SkipReason } from './tool-import.js';
import { loadEngine as loadDocumentEngine, ENGINE_VERSION as DOCUMENT_ENGINE_VERSION, isEngineInstalled as isDocumentEngineInstalled } from './document-engine.js';
import { loadEngine as loadOcrEngine, ENGINE_VERSION as OCR_ENGINE_VERSION, isEngineInstalled as isOcrEngineInstalled, engineBinaryPath } from './ocr-engine.js';
import { listModels as listOcrModels } from './ocr-runner.js';
import { loadLanceDB, isEngineInstalled as isLanceEngineInstalled, engineVersion as lanceEngineVersion } from './lancedb-engine.js';
import { LibraryGate } from './library-gate.js';
import { interruptible } from './work-scope.js';
import { directoryKey } from './directories.js';
import { ScanUpdates } from './scan-updates.js';
export { ScanUpdates } from './scan-updates.js';
import { LibraryRegistry, LIBRARIES_STORAGE_KEY, type LibraryIndex } from './libraries.js';
import {libraryIndexPath,stageIndexRemoval,type StagedIndexRemoval} from './index-removal.js';
export {libraryIndexPath,stageIndexRemoval,trashIndex} from './index-removal.js';
import { isLibraryScoped } from './library-scope.js';
import { AutoScanCooldown } from './scan-cooldown.js';
import { EnvironmentManager, type EnvironmentSnapshot } from './environment.js';
import { createKnowledgeComposer } from './composer.js';
import { assertSourcePath, openSourceDirectory, scanSourceDirectory, type ScanOutcome } from './source-directory.js';
import { pickDirectory } from './directory-picker.js';
export { pickDirectory, directoryPickerCommand } from './directory-picker.js';
export { assertSourcePath, openSourceDirectory, scanSourceDirectory } from './source-directory.js';
export { createKnowledgeComposer } from './composer.js';
export { resolveDocumentStatus } from './document-status.js';
export { IndexSkipError } from './indexing-result.js';
export { KnowledgeStore, vectorize, chunkText, DEFAULT_TAG, engineForExtension, ACCEPTED, MAX_FILE_BYTES, MAX_FILE_MB } from './store.js';
export { highlightTerms, snippetParts, snippetText } from './snippet.js';
export { openInPreview, openListedDocument, previewRoute } from './preview.js';
export { inScope, UNCLASSIFIED } from './scope.js';
export { expandImportTargets, MAX_BATCH_FILES } from './tool-import.js';
export { LibraryGate } from './library-gate.js';
export { LibraryRegistry, LIBRARIES_STORAGE_KEY } from './libraries.js';
export { isLibraryScoped } from './library-scope.js';
export { inspectSourceFilesystem, remoteIndexKey, remoteIndexRoot } from './index-location.js';
export { hideKnowledgeDirectory } from './index-visibility.js';
export { EnvironmentManager } from './environment.js';
export { downloadWithProgress, formatBytes, oncePerPercent } from './download.js';

const execFileAsync = promisify(execFile);
export const KNOWLEDGE_ACTIONS = ['search', 'tags', 'documents', 'library', 'environment', 'index', 'sync', 'create_tag', 'rename_tag', 'delete_tag', 'tag_document', 'untag_document'] as const;
interface ViewRequest { cursor?:string; before?:boolean; hideUnsupported?: boolean; refresh?: boolean; anchorPath?: string; anchorIndex?: number; limit?: number; issues?: boolean; type?: string; libraryRoot?: string; libraryVersion?: number; directory?: string; color?: string; requestId?: string; id?: string; ids?: string[]; key?: string; tagId?: string | null; name?: string; size?: number; data?: string; query?: string; offset?: number; sort?: string; descending?: boolean; mode?: string }
function result(text: string, isError = false): finch.ToolResult {
  return { content: [{ type: 'text', text }], isError };
}

/**
 * Reads what the caller wants imported. Three shapes are accepted so that a single
 * file, a folder, several paths, or a hand-made classification can all arrive the
 * same way: `path`, `paths`, and `items` (each with its own destination tag).
 */
function readImportRequests(input: Record<string, unknown>): ImportRequest[] {
  const requests: ImportRequest[] = [];
  const push = (value: unknown, tag?: unknown): void => {
    if (typeof value !== 'string' || !value.trim()) return;
    requests.push({ path: value.trim(), tag: typeof tag === 'string' && tag.trim() ? tag.trim() : undefined });
  };
  push(input.path);
  if (Array.isArray(input.paths)) for (const entry of input.paths) push(entry);
  if (Array.isArray(input.items)) {
    for (const entry of input.items) {
      if (!entry || typeof entry !== 'object') continue;
      const item = entry as { path?: unknown; tag?: unknown };
      push(item.path, item.tag);
    }
  }
  return requests;
}

/** Reveal the indexed original in the system file manager. */
async function revealFile(path: string): Promise<void> {
  if (!(await stat(path)).isFile()) throw new Error('Indexed file is no longer on disk.');
  if (process.platform === 'darwin') await execFileAsync('open', ['-R', path]);
  else if (process.platform === 'win32') await execFileAsync('explorer.exe', [`/select,${path}`]);
  else await execFileAsync('xdg-open', [dirname(path)]);
}

/** Opens the library directory itself rather than selecting a file inside it. */
async function revealDirectory(path: string): Promise<void> {
  if (!(await stat(path)).isDirectory()) throw new Error('The library folder is no longer on disk.');
  if (process.platform === 'win32') await execFileAsync('explorer.exe', [path]);
  else await execFileAsync(process.platform === 'darwin' ? 'open' : 'xdg-open', [path]);
}

export function activate(ctx: finch.MiniToolContext): void {
  const panels = new Set<finch.AppPanel>();
  const gate = new LibraryGate();
  const libraries = new LibraryRegistry(() => ctx.storage.get(LIBRARIES_STORAGE_KEY), data => ctx.storage.set(LIBRARIES_STORAGE_KEY, data));
  let libraryVersion = 0;
  const bound = new WeakSet<finch.AppPanel>();
  const t = (key: string, values?: Record<string, string | number>) => ctx.i18n.t(key, values);
  const forwardProgress = (message: string): void => {
    for (const panel of panels) void panel.postMessage({ type: 'progress', message }).catch(() => {});
  };

  /** The library directory is chosen at runtime, so the store is swapped in place instead of rebuilt. */
  let activeStore: KnowledgeStore | undefined;
  const state = {
    root: '',
    get store(): KnowledgeStore { if (!activeStore) throw new Error(t('library.chooseFirst')); return activeStore; },
    set store(store: KnowledgeStore) { activeStore = store; },
  };
  let disposed = false;
  const availabilityEpoch=randomUUID();let availabilityVersion=0;
  const availability=new LibraryAvailability(states=>{
    if(disposed)return;availabilityVersion++;
    for(const panel of panels)void panel.postMessage({type:'libraryAvailability',availabilityEpoch,availabilityVersion,states}).catch(()=>{});
  });
  let scanController: AbortController | undefined;
  let scanning: Promise<SyncOutcome> | undefined;
  let statusSequence = 0;
  const statusTasks = new Set<Promise<void>>();
  const pageChecks = new Map<finch.AppPanel, AbortController>();
  const statusVersions = new WeakMap<KnowledgeStore, Map<string, number>>();
  const retiringStores = new Set<Promise<void>>();
  const retiringIndexes=new Map<string,Set<Promise<void>>>();
  const retirementFailures=new Set<string>();
  const indexKey=(path:string)=>process.platform==='win32'?path.toLowerCase():path;
  function retire(store:KnowledgeStore|undefined,scan:Promise<SyncOutcome>|undefined,statuses:Promise<void>[]):Promise<void>{
    if(!store)return Promise.resolve();
    const key=indexKey(store.root);
    const raw=(async()=>{await scan?.catch(()=>{});await Promise.allSettled(statuses);await store.close();})();
    let tasks=retiringIndexes.get(key);if(!tasks){tasks=new Set();retiringIndexes.set(key,tasks);}tasks.add(raw);
    const settled=raw.catch(error=>{retirementFailures.add(key);ctx.logger?.warn?.(`Library cleanup failed: ${errorText(error)}`);}).finally(()=>{retiringStores.delete(settled);tasks!.delete(raw);if(!tasks!.size)retiringIndexes.delete(key);});
    retiringStores.add(settled);return raw;
  }
  ctx.subscriptions.push({ async dispose() { disposed = true; availability.dispose();scanController?.abort(); for (const controller of pageChecks.values()) controller.abort(); activeStore?.interrupt(); await ready; await scanning?.catch(() => {}); await Promise.allSettled([...statusTasks, ...retiringStores]); await activeStore?.close(); } });
  let unavailable: string | null = null;
  let setupComplete = false;
  let hideUnsupported = false;
  const pausedLibraries = new Set<string>();

  async function swapTo(root: string, commit?: (root: string) => Promise<void>): Promise<void> {
    for (const controller of pageChecks.values()) controller.abort();
    pageChecks.clear();
    const previous = activeStore;
    const previousScan = scanning;
    const previousStatuses = [...statusTasks];
    scanController?.abort(); previous?.interrupt();
    scanController = undefined; scanning = undefined;
    const versions = new Map<string, number>();
    const selectionVersion = libraryVersion + 1;
    let next: KnowledgeStore;
    try {
    next = await openSourceDirectory(root, ctx.storagePath, { progress: forwardProgress, requireEngine,
      onVisibilityWarning: () => forwardProgress(t('library.hideFailed')),
      onStatusChange(path, phase) {
        if (disposed || activeStore !== next || next.interrupted) return;
        const version = ++statusSequence;
        versions.set(path, version);
        const publish = (document?: unknown) => {
          if (disposed || activeStore !== next || versions.get(path) !== version) return;
          for (const panel of panels) void panel.postMessage({ type: 'documentStatus', root: next.directoryRoot, libraryVersion: selectionVersion, path, phase, version, document }).catch(() => {});
        };
        if (phase === 'processing') publish();
        else {
          const task = next.statusForPath(path).then(publish).catch(() => {});
          statusTasks.add(task);
          void task.finally(() => statusTasks.delete(task));
        }
      },
    });
    statusVersions.set(next, versions);
    // Persist the selection before exposing a new store. A failed save keeps the old library usable.
    try {
      const info=await stat(next.directoryRoot,{bigint:true});
      const index:LibraryIndex=next.indexStorage==='local'?{kind:'local',key:basename(next.root)}:{kind:'source',dev:String(info.dev),ino:String(info.ino)};
      await libraries.add(next.directoryRoot,index);
      await commit?.(next.directoryRoot!);
    }
    catch (error) { await next.close(); throw error; }
    } catch (error) { previous?.resume(); throw error; }
    libraryVersion++;
    state.root = next.directoryRoot!;
    state.store = next;
    // Retire A behind B's acknowledgement. Native read calls may not support hard cancellation.
    void retire(previous,previousScan,previousStatuses).catch(()=>{});
  }

  const ready = (async () => {
    setupComplete = await ctx.storage.get<boolean>('setupComplete') === true;
    hideUnsupported = await ctx.storage.get<boolean>('hideUnsupported') === true;
    const paused = await ctx.storage.get<unknown>('pausedLibraries');
    if (Array.isArray(paused)) for (const root of paused) if (typeof root === 'string') pausedLibraries.add(root);
    const saved = await ctx.storage.get<string>('sourceDirectory');
    await libraries.load(saved);
    // An authoritative registry prevents a removed selection from opening/recreating an index.
    if (saved && libraries.forRoot(saved) && saved !== state.root) {
      try { await swapTo(saved); } catch { unavailable = saved; }
    }
  })();

  /**
   * Follows every recorded source file: re-indexes the ones whose content changed and drops
   * the ones that are gone. This is the "keep up with edits made outside the app" path, and
   * automatic triggers are rate-limited per directory while manual scans always remain available.
   */
  type SyncOutcome = ScanOutcome;
  const scanCooldown = new AutoScanCooldown(key => ctx.storage.get<number>(key), (key, value) => ctx.storage.set(key, value));
  async function autoScan(): Promise<SyncOutcome | undefined> {
    const store = activeStore;
    if (!store || !setupComplete || disposed || pausedLibraries.has(store.directoryRoot)) return;
    try { await store.assertSourceAvailable(); }
    catch { if (activeStore === store) { unavailable = store.directoryRoot; await broadcastLibraries(); } return; }
    if (activeStore !== store) return;
    unavailable = null;
    if (store.rebuiltIndex) return syncSources();
    return scanCooldown.run(store.directoryRoot, async () => {
      if (disposed || activeStore !== store) return undefined;
      return syncSources();
    });
  }

  async function syncSources(report?: (message: string, percent: number) => void, signal?: AbortSignal): Promise<SyncOutcome> {
    if (scanning) return scanning;
    const store = state.store, scopeVersion = libraryVersion;
    scanController = new AbortController();
    const controller = scanController;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    for (const panel of panels) void panel.postMessage({ type: 'scanStarted', root: store.directoryRoot, libraryVersion: scopeVersion }).catch(() => {});
    const updates = new ScanUpdates(async () => {
      if (!disposed && !controller.signal.aborted && activeStore === store && libraryVersion === scopeVersion) await broadcast({ kind: 'scanBatch' });
    },200);
    // The scan owns this captured store; it must not hold the global switching gate.
    const task: Promise<SyncOutcome> = (async () => {
      if (pausedLibraries.delete(store.directoryRoot)) await ctx.storage.set('pausedLibraries', [...pausedLibraries]);
      await scanCooldown.record(store.directoryRoot);
      return scanSourceDirectory(store, (name, percent) => {
        if (controller.signal.aborted || activeStore !== store || libraryVersion !== scopeVersion) return;
        const message = t('progress.sync', { name });
        report?.(message, percent);
        for (const panel of panels) void panel.postMessage({ type: 'scanProgress', root: store.directoryRoot, libraryVersion: scopeVersion, message, percent }).catch(() => {});
      }, controller.signal, {
        onCheckpoint: state => { if (!state.completed || state.changed) updates.mark(); },
        onCatalogBatch: () => { if(!controller.signal.aborted&&activeStore===store&&libraryVersion===scopeVersion)updates.mark(); },
        onDiscover(count) {
          if (controller.signal.aborted || activeStore !== store || libraryVersion !== scopeVersion) return;
          const message = t('progress.discover', { count });
          for (const panel of panels) void panel.postMessage({ type: 'scanProgress', root: store.directoryRoot, libraryVersion: scopeVersion, message }).catch(() => {});
        },
      });
    })().then(async outcome => {
      outcome.paused = controller.signal.aborted;
      if (!controller.signal.aborted) { store.rebuiltIndex = false; await scanCooldown.record(store.directoryRoot); }
      updates.mark();
      await updates.flush();
      for (const panel of panels) void panel.postMessage({ type: 'scanDone', root: store.directoryRoot, libraryVersion: scopeVersion, sync: outcome, paused: outcome.paused }).catch(() => {});
      return outcome;
    }).catch(async error => {
      updates.mark(); await updates.flush();
      for (const panel of panels) void panel.postMessage({ type: 'scanFailed', root: store.directoryRoot, libraryVersion: scopeVersion, error: errorText(error) }).catch(() => {});
      throw error;
    }).finally(() => { if (scanning === task) scanning = undefined; signal?.removeEventListener('abort', abort); });
    scanning = task;
    return task;
  }

  /**
   * The three engines download lazily on first use; the onboard page simply does
   * that up front so the wait is visible. State lives here rather than in a panel,
   * so closing the App View does not cancel a run.
   */
  const environment = new EnvironmentManager([
    {
      id: 'lancedb',
      version: lanceEngineVersion(),
      probe: () => isLanceEngineInstalled(ctx.storagePath),
      install: async (report) => {
        await loadLanceDB(ctx.storagePath, report);
        // Loading verifies the native binding without creating a library before directory selection.
        if (activeStore) await state.store.tags();
      },
    },
    {
      id: 'anydoc',
      version: DOCUMENT_ENGINE_VERSION,
      probe: () => isDocumentEngineInstalled(join(ctx.storagePath, 'anydoc')),
      install: async (report) => { await loadDocumentEngine(join(ctx.storagePath, 'anydoc'), report); },
    },
    {
      id: 'ocr',
      version: OCR_ENGINE_VERSION,
      // Only image imports need this, so setup must not hold the library hostage to a ~70 MB download.
      optional: true,
      lazy: true,
      probe: () => isOcrEngineInstalled(join(ctx.storagePath, 'ocr')),
      install: async (report) => {
        const binary = await loadOcrEngine(join(ctx.storagePath, 'ocr'), report);
        // Running the binary once proves it is executable on this machine, not just present.
        await listOcrModels(binary);
      },
    },
  ], (snapshot) => {
    for (const panel of panels) void panel.postMessage({ type: 'environment', environment: snapshot }).catch(() => {});
  });

  function environmentStatus(): Record<string, unknown> {
    const snapshot = environment.snapshot();
    return {
      ...snapshot,
      cachePath: ctx.storagePath,
      platform: `${process.platform}/${process.arch}`,
      ocrBinary: engineBinaryPath(join(ctx.storagePath, 'ocr')) ?? null,
    };
  }

  const composerAction = ctx.composerActions.register('knowledge', createKnowledgeComposer({
    snapshot: async () => { await ready; return unavailable || !activeStore ? null : state.store.summary(true); },
    locale: async () => (await ctx.app?.getInfo())?.locale,
    t,
    showGuide: async () => {
      await ctx.ui.showModalDialog({ title: t('composer.guide'), message: t('composer.guideText'),
        actions: [{ id: 'close', label: t('composer.close') }] });
    },
  }));
  ctx.subscriptions.push(composerAction);

  async function openRepairSession(): Promise<string> {
    const snapshot = environment.snapshot();
    const failures = snapshot.steps.filter((step) => step.status === 'failed');
    type SessionCreate = (options: finch.SessionCreateOptions) => Promise<{ id: string }>;
    const sessions = ctx.sessions as unknown as {
      create?: SessionCreate;
      send?: (sessionId: string, message: { text: string; idempotencyKey: string }) => Promise<unknown>;
    } | undefined;
    if (!sessions?.create || !sessions.send) throw new Error('Environment help needs the sessions permission.');
    const lines = [
      t('environment.helpIntro'),
      '',
      `- platform: ${process.platform}/${process.arch}`,
      `- cache: ${ctx.storagePath}`,
      `- lancedb: ${statusOf(snapshot, 'lancedb')}`,
      `- anydoc: ${statusOf(snapshot, 'anydoc')}`,
      `- ocr: ${statusOf(snapshot, 'ocr')}`,
      '',
      t('environment.helpAsk'),
    ];
    for (const step of failures) lines.push('', `${step.id}: ${step.error ?? t('environment.unknownFailure')}`);
    const message = lines.join('\n');
    const created = await sessions.create({});
    await sessions.send(created.id, {
      text: message,
      idempotencyKey: `knowledge-env-${Date.now()}-${created.id}`,
    });
    await ctx.navigation.openSession(created.id);
    return created.id;
  }

  function statusOf(snapshot: EnvironmentSnapshot, id: string): string {
    const step = snapshot.steps.find((item) => item.id === id);
    if (!step) return 'unknown';
    return `${step.status}${step.detail ? ` (${step.detail})` : ''}${step.error ? ` — ${step.error}` : ''}`;
  }

  async function libraryInfo(): Promise<Record<string, unknown>> {
    // summary() reads the catalogue only, so the first paint never waits on an engine download.
    const store = activeStore, root = state.root, version = libraryVersion;
    const { tags } = store ? await store.summary(true) : { tags: [] };
    const documents = store ? await store.fileCount(hideUnsupported, true) : 0;
    const current = libraries.forRoot(root);
    const records=libraries.list();availability.refresh(records);
    const choices=records.map(record=>({...record,availability:availability.state(record)}));
    return { availabilityEpoch,availabilityVersion, root, version, indexStorage: store?.indexStorage, indexRoot: store?.root, name: current?.name, activeId: current?.id, libraries: choices, selected: Boolean(store), entered: setupComplete, isDefault: false, documents, tags: tags.length, unavailable };
  }

  const errorText = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('UNIQUE constraint failed: tags.name')) return t('error.duplicateTag');
    if (message === 'Tag no longer exists.') return t('error.missingTag');
    if (message === 'Tag name must be 1–60 characters.') return t('error.tagName');
    if (message === 'Document no longer exists.') return t('error.missingDocument');
    if (message === 'SOURCE_MISSING' || message === 'Indexed file is no longer on disk.') return t('error.missingFile');
    if (message === 'SOURCE_UNAVAILABLE') return t('error.sourceUnavailable');
    if (message === 'Library name must be 1–60 characters.') return t('library.nameInvalid');
    if (message === 'INDEX_REMOVAL_UNSAFE') return t('library.indexRemovalUnsafe');
    if (message === 'INDEX_REMOVAL_SHARED') return t('library.indexRemovalShared');
    if (message === 'INDEX_RETIREMENT_FAILED') return t('library.indexRetirementFailed');
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return t('error.pathUnavailable');
    if (message === 'Specify a local file path.') return t('tool.fileRequired');
    if (message === 'The file must be inside the current workspace.') return t('tool.fileOutside');
    if (message === 'Choose a regular file, not a symbolic link.') return t('tool.fileSymlink');
    if (message === SIZE_LIMIT_MESSAGE) return t('tool.fileSize', { max: MAX_FILE_MB });
    if (message === 'File import cancelled.') return t('tool.fileCancelled');
    if (message === 'The library directory is switching. Try again when it finishes.') return t('library.switching');
    if (message === 'Finish current indexing or edits before switching directories.') return t('library.busy');
    if (message.startsWith('Unsupported knowledge index format.')) return t('library.unsupportedIndex');
    if (message === 'Choose a library directory.' || message === 'Choose an absolute library directory.' || message === 'Choose a directory, not a file.') return t('library.invalidDirectory');
    if (message === 'INVALID_DIRECTORY_PICKER_RESPONSE') return t('library.pickerInvalid');
    if (message === 'This is already the working library directory.') return t('library.same');
    if (message === 'Library is no longer registered.') return t('library.missing');
    if (message.startsWith('Unable to determine the source filesystem') || message === 'Drive type is unavailable.' || message === 'Network share identity is unavailable.') return t('library.filesystemUnavailable');
    if (message.startsWith('The network source is disconnected or mapped')) return t('library.networkUnavailable');
    if (message === 'Network libraries require a local Finch cache directory.') return t('library.localCacheRequired');
    if (message === 'The library folder is no longer on disk.') return t('library.unavailable');
    return message;
  };
  const supported = new Set(['enterLibrary', 'ready', 'page', 'locate', 'tags', 'tagCreate', 'tagRename', 'tagColor', 'tagDelete', 'tagToggle', 'tagReorder', 'search', 'reveal', 'sync', 'scanPause', 'library', 'libraryAction', 'librarySwitch', 'libraryRename', 'libraryRemove', 'libraryAvailability', 'libraryReveal', 'preferences', 'environment', 'environmentInstall', 'environmentHelp']);
  const retired = new Set(['addFiles', 'uploadStart', 'uploadChunk', 'uploadFinish', 'uploadAbort', 'uploadCancel', 'delete', 'backup']);

  /**
   * Tells every open page what changed. `change` describes a change that concerns a single row, so
   * a page can patch that row instead of reloading the list under the user.
   */
  async function broadcast(change?: { kind: 'tagToggle' | 'tagColor' | 'scanBatch'; documentId?: string; tags?: string[] }): Promise<void> {
    composerAction.notifyUpdate();
    const store = state.store, root = state.root, version = libraryVersion;
    const {tags,directories,issuesTotal,catalogVersion}=store.catalogOverview(hideUnsupported);
    if (store !== activeStore) return;
    for (const panel of panels) void panel.postMessage({ type: 'changed', root, libraryVersion: version, catalogVersion, tags, directories, issuesTotal, preferences: { hideUnsupported }, ...(change ? { change } : {}) }).catch(() => {});
  }
  async function broadcastLibraries(except?: finch.AppPanel): Promise<void> {
    composerAction.notifyUpdate();
    const library = await libraryInfo();
    await Promise.allSettled([...panels].filter(panel => panel !== except).map(panel => panel.postMessage({ type: 'libraries', library })));
  }
  async function indexedPage(tagId: string | null, sort: DocumentSort, offset: number, directory: string | null = null, descending?: boolean, cursor?:string, before=false) {
    return state.store.browsePage(tagId, sort, offset, 50, directory, descending, hideUnsupported, true,cursor,before);
  }
  /** The reply owns only SQL data; expensive verification is cancellable, page-scoped work. */
  function verifyPage(panel: finch.AppPanel, store: KnowledgeStore, documents: DocumentSummary[], scopeVersion: number): void {
    pageChecks.get(panel)?.abort();
    const controller = new AbortController(); pageChecks.set(panel, controller);
    const versions = statusVersions.get(store)!;
    const candidates = documents.filter(doc => !('issueKind' in doc));
    if (!documents.length) { pageChecks.delete(panel); return; }
    const task = Promise.resolve().then(async () => {
      const available = await interruptible(store.assertSourceAvailable(), controller.signal).then(() => true, () => false);
      if (controller.signal.aborted || disposed || activeStore !== store || libraryVersion !== scopeVersion) return;
      if (!available && unavailable !== store.directoryRoot) { unavailable = store.directoryRoot; await broadcastLibraries(); }
      const issues = documents.filter(doc => 'issueKind' in doc);
      if (available) for (let offset = 0; offset < issues.length; offset += 4) {
        if (controller.signal.aborted || disposed || activeStore !== store || libraryVersion !== scopeVersion) return;
        const batch = issues.slice(offset, offset + 4);
        const requested = new Map(batch.map(doc => { const version = ++statusSequence; versions.set(doc.path, version); return [doc.path, version] as const; }));
        const metadata = await store.refreshMetadata(batch, controller.signal);
        if (controller.signal.aborted || disposed || activeStore !== store || libraryVersion !== scopeVersion) return;
        for (const document of metadata) {
          const current = await store.sourceIssue(document.id, true), original = batch.find(doc => doc.id === document.id)!;
          const version = requested.get(document.path)!;
          if (!current || current.issueKind !== (original as {issueKind: string}).issueKind || versions.get(document.path) !== version) continue;
          const update = { ...current, size_bytes: document.size_bytes, modified_at: document.modified_at, file_type: document.file_type };
          await Promise.allSettled([...panels].map(target => target.postMessage({ type: 'documentStatus', root: store.directoryRoot,
            libraryVersion: scopeVersion, path: document.path, phase: 'settled', version, document: update })));
        }
      }
      for (let offset = 0; offset < candidates.length; offset += 4) {
        if (controller.signal.aborted || disposed || activeStore !== store || libraryVersion !== scopeVersion) return;
        const batch: DocumentSummary[] = [];
        for (const doc of candidates.slice(offset, offset + 4)) {
          const current = await store.document(doc.id, true);
          if (current?.hash === doc.hash && current.path === doc.path) batch.push(doc);
        }
        const requested = new Map(batch.map(doc => { const version = ++statusSequence; versions.set(doc.path, version); return [doc.path, version] as const; }));
        const statuses: DocumentStatus[] = available ? await store.indexStatus(batch, controller.signal)
          : batch.map(doc => ({ ...doc, indexState: 'unavailable', indexedChunks: null, sourceState: 'unavailable', status: 'source_unavailable' }));
        if (controller.signal.aborted || disposed || activeStore !== store || libraryVersion !== scopeVersion) return;
        for (const document of statuses) {
          const version = requested.get(document.path)!;
          const current=await store.document(document.id,true);
          if (versions.get(document.path) !== version || current?.hash !== document.hash || (document.source_revision!==undefined&&current.source_revision!==document.source_revision)) continue;
          await Promise.allSettled([...panels].map(target => target.postMessage({ type: 'documentStatus', root: store.directoryRoot, libraryVersion: scopeVersion,
            path: document.path, phase: 'settled', version, document })));
        }
      }
    }).catch(() => {}).finally(() => { if (pageChecks.get(panel) === controller) pageChecks.delete(panel); });
    statusTasks.add(task); void task.finally(() => statusTasks.delete(task));
  }
  async function handle(panel: finch.AppPanel, raw: unknown): Promise<void> {
    const message = raw as ViewRequest;
    if (!message || typeof message !== 'object') return;
    if (retired.has(message.type ?? '')) {
      await panel.postMessage({ requestId: message.requestId, type: 'error', error: t('library.readOnlySources') });
      return;
    }
    if (!supported.has(message.type ?? '')) return;
    const requestId = typeof message.requestId === 'string' ? message.requestId.slice(0, 80) : '';
    let requestRoot = state.root, requestVersion = libraryVersion;
    const reply = (payload: Record<string, unknown>) => panel.postMessage({ requestId, root: requestRoot, libraryVersion: requestVersion, ...payload });
    try {
      await ready;
      requestRoot = state.root; requestVersion = libraryVersion;
      if (isLibraryScoped(message.type!) && ((message.libraryRoot !== undefined && message.libraryRoot !== state.root) || (message.libraryVersion !== undefined && message.libraryVersion !== libraryVersion))) throw new Error(t('library.changed'));
      if (!activeStore && !['ready', 'library', 'libraryAction', 'librarySwitch', 'libraryRename', 'libraryRemove', 'libraryAvailability', 'preferences', 'environment', 'environmentInstall', 'environmentHelp'].includes(message.type!)) {
        if (message.type === 'page') { await reply({ type: 'page', documents: [], total: 0, offset: 0 }); return; }
        throw new Error(t('library.chooseFirst'));
      }
      if (activeStore && ['search', 'sync'].includes(message.type!)) {
        const store = activeStore;
        try { await store.assertSourceAvailable(); }
        catch (error) {
          if (activeStore === store) { unavailable = store.directoryRoot; await broadcastLibraries(); }
          throw error;
        }
        if (activeStore !== store || libraryVersion !== requestVersion) throw new Error(t('library.changed'));
        unavailable = null;
      }
      switch (message.type) {
        case 'preferences': {
          if (typeof message.hideUnsupported !== 'boolean') throw new Error('Invalid display preference.');
          await ctx.storage.set('hideUnsupported', message.hideUnsupported);
          hideUnsupported = message.hideUnsupported;
          await reply({ type: 'preferences', preferences: { hideUnsupported } });
          if (activeStore) await broadcast();
          break;
        }
        case 'ready': {
          // Everything here must be engine-free: on a fresh machine the vector engine is still
          // downloading, and the setup screen cannot wait for it.
          const { tags } = activeStore ? await state.store.summary(true) : { tags: [] };
          await reply({ type: 'tags', tags, library: await libraryInfo(),
            scanning: Boolean(scanning), preferences: { hideUnsupported }, environment: await environment.probe(), directories: activeStore ? await state.store.directories(hideUnsupported, true) : [], issuesTotal: activeStore ? await state.store.issueCount(hideUnsupported, true) : 0 });
          if (activeStore && setupComplete && !scanning) void autoScan().catch(error => forwardProgress(errorText(error)));
          break;
        }
        case 'environment':
          await reply({ type: 'environment', environment: environment.snapshot() });
          break;
        case 'environmentInstall': {
          // Reply immediately so the page can render, then stream updates as steps run.
          const snapshot = environment.snapshot();
          await reply({ type: 'environment', environment: snapshot });
          void environment.install().then(() => activeStore && setupComplete ? autoScan() : undefined).catch(error => forwardProgress(errorText(error)));
          break;
        }
        case 'enterLibrary': {
          if (!activeStore || unavailable || !environment.snapshot().usable) throw new Error(t('library.setupIncomplete'));
          setupComplete = true;
          await ctx.storage.set('setupComplete', true);
          await reply({ type: 'libraryEntered', library: await libraryInfo(), environment: environment.snapshot() });
          void autoScan().catch(error => forwardProgress(errorText(error)));
          break;
        }
        case 'environmentHelp': {
          const sessionId = await openRepairSession();
          await reply({ type: 'environmentHelpOpened', sessionId });
          break;
        }
        case 'library':
          await reply({ type: 'library', library: await libraryInfo() });
          break;
        case 'libraryAvailability':
          availability.refresh(libraries.list(),true);
          await reply({type:'libraryAvailability',availabilityEpoch,availabilityVersion,states:libraries.list().map(record=>({id:record.id,fingerprint:JSON.stringify([record.root,record.index??null]),state:availability.state(record)}))});break;
        case 'libraryRename': {
          const record=libraries.find(String(message.id??''));
          await gate.exclusive(()=>libraries.rename(record.id,typeof message.name==='string'?message.name:''));
          await reply({type:'libraryRenamed',id:record.id,library:await libraryInfo()});await broadcastLibraries(panel);break;
        }
        case 'libraryRemove': {
          const record=libraries.find(String(message.id??''));
          const answer=await ctx.ui.showModalDialog({title:t('library.removeTitle',{name:record.name}),message:t('library.removeMessage'),fields:[{key:'deleteIndex',type:'boolean',label:t('library.deleteIndex'),default:false}],actions:[{id:'cancel',label:t('library.cancel')},{id:'remove',label:t('library.removeConfirm'),variant:'danger'}]});
          if(answer.action!=='remove'){await reply({type:'libraryCanceled'});break;}
          let warning:string|undefined;
          await gate.exclusive(async()=>{
            const latest=libraries.find(record.id);
            if(latest.root!==record.root||latest.name!==record.name||JSON.stringify(latest.index)!==JSON.stringify(record.index))throw new Error(t('library.changed'));
            const deleting=answer.values?.deleteIndex===true;
            let target:string|undefined;
            if(deleting){
              target=await libraryIndexPath(latest,ctx.storagePath).catch(()=>{throw new Error('INDEX_REMOVAL_UNSAFE');});
              for(const other of libraries.list().filter(v=>v.id!==latest.id)){
                if(latest.index?.kind==='local'){
                  if(!other.index)throw new Error('INDEX_REMOVAL_UNSAFE');
                  if(other.index.kind==='local'&&other.index.key===latest.index.key)throw new Error('INDEX_REMOVAL_SHARED');
                }else if(other.root===latest.root)throw new Error('INDEX_REMOVAL_SHARED');
              }
            }
            const selected=latest.id===libraries.forRoot(state.root||unavailable||'')?.id;
            const previousRoot=state.root||unavailable||'';
            let detached=false,staged:StagedIndexRemoval|undefined;
            const detach=()=>{
              for(const check of pageChecks.values())check.abort();pageChecks.clear();
              const previous=activeStore,scan=scanning,statuses=[...statusTasks];scanController?.abort();previous?.interrupt();
              scanController=undefined;scanning=undefined;activeStore=undefined;state.root='';unavailable=null;libraryVersion++;detached=true;
              void retire(previous,scan,statuses).catch(()=>{});
            };
            try{
              if(selected)await ctx.storage.set('sourceDirectory','');
              if(deleting){
                if(selected)detach();
                await Promise.all([...retiringIndexes.get(indexKey(target!))??[]]);
                if(retirementFailures.has(indexKey(target!)))throw new Error('INDEX_RETIREMENT_FAILED');
                staged=await stageIndexRemoval(latest,ctx.storagePath).catch(()=>{throw new Error('INDEX_REMOVAL_UNSAFE');});
              }
              await libraries.remove(latest.id);
            }catch(error){
              await staged?.rollback();
              if(selected){await ctx.storage.set('sourceDirectory',previousRoot);if(detached&&!retirementFailures.has(indexKey(target??''))){try{await swapTo(previousRoot);}catch{unavailable=previousRoot;}}}
              throw error;
            }
            if(selected&&!detached)detach();
            if(pausedLibraries.delete(latest.root))await ctx.storage.set('pausedLibraries',[...pausedLibraries]).catch(()=>{warning=t('library.cleanupWarning');});
            try{await staged?.commit();}catch{warning=t('library.cleanupWarning');}
          });
          await reply({type:'libraryRemoved',warning,library:await libraryInfo()});await broadcastLibraries(panel);break;
        }
        case 'libraryReveal': {
          await state.store.assertSourceAvailable();
          const directory = typeof message.directory === 'string' && message.directory !== ''
            ? await assertSourcePath(state.root, directoryKey(message.directory)) : state.root;
          await revealDirectory(directory);
          await reply({ type: 'libraryRevealed' });
          break;
        }
        case 'libraryAction':
        case 'librarySwitch': {
          if (message.type === 'libraryAction' && message.mode !== 'choose') throw new Error(t('library.invalidDirectory'));
          const chosen = message.type === 'librarySwitch' ? libraries.find(message.id ?? '').root
            : await pickDirectory(t('library.title.choose', { root: state.root }), state.root);
          if (!chosen) { await reply({ type: 'libraryCanceled' }); break; }
          // Open in place; registering and switching never copy or rename source files.
          const previousRoot = state.root;
          const existing = (await stat(join(chosen, '.knowledge')).catch(() => null))?.isDirectory();
          await gate.exclusive(() => swapTo(chosen, async root => {
            await libraries.add(root);
            await ctx.storage.set('sourceDirectory', root);
          }));
          unavailable = null;
          await reply({ type: 'libraryDone', mode: message.type === 'librarySwitch' ? 'switch' : existing ? 'open' : 'create', previousRoot, library: await libraryInfo(), environment: await environment.probe() });
          await broadcastLibraries(panel);
          await broadcast();
          if (setupComplete) void autoScan().catch(error => forwardProgress(errorText(error)));
          break;
        }
        case 'tags':
          await reply({ type: 'tags', tags: await state.store.tags(true), directories: await state.store.directories(hideUnsupported, true), issuesTotal: await state.store.issueCount(hideUnsupported, true) });
          break;
        case 'page': {
          const store = state.store;
          const tagId = typeof message.tagId === 'string' ? message.tagId : null;
          const sort = (['name', 'added', 'updated', 'modified', 'type', 'size'].includes(message.sort ?? '') ? message.sort : 'updated') as DocumentSort;
          const directory = typeof message.directory === 'string' ? message.directory : null;
          const descending = typeof message.descending === 'boolean' ? message.descending : undefined;
          if (message.refresh === true) {
            const page = await state.store.browseWindow(tagId, sort, directory, descending, {
              issues: message.issues === true, hideUnsupported, catalogOnly: true, anchorPath: typeof message.anchorPath === 'string' ? message.anchorPath : undefined,
              anchorIndex: Number(message.anchorIndex ?? 0), offset: Number(message.offset ?? 0), limit: Number(message.limit ?? 50),
            });
            await reply({ type: 'page', ...page });
            verifyPage(panel, store, page.documents, requestVersion);
          } else {
            const page = message.issues === true ? await state.store.issuePage(sort, Number(message.offset ?? 0), directory, descending, hideUnsupported, true,typeof message.cursor==='string'?message.cursor:undefined,message.before===true)
              : await indexedPage(tagId, sort, Number(message.offset ?? 0), directory, descending,typeof message.cursor==='string'?message.cursor:undefined,message.before===true);
            await reply({ type: 'page', ...page });
            verifyPage(panel, store, page.documents, requestVersion);
          }
          break;
        }
        case 'locate': {
          const store = state.store;
          const tagId = typeof message.tagId === 'string' ? message.tagId : null;
          const sort = (['name', 'added', 'updated', 'modified', 'type', 'size'].includes(message.sort ?? '') ? message.sort : 'updated') as DocumentSort;
          const id = String(message.id ?? '');
          const directory = typeof message.directory === 'string' ? message.directory : null;
          const position = await state.store.browsePosition(id, tagId, sort, directory, typeof message.descending === 'boolean' ? message.descending : undefined, hideUnsupported, true);
          if (position === null) throw new Error('Document is not in the selected tag.');
          const offset = Math.floor(position / 50) * 50;
          const page = await indexedPage(tagId, sort, offset, directory, typeof message.descending === 'boolean' ? message.descending : undefined);
          await reply({ type: 'page', ...page, offset, focusId: id });
          verifyPage(panel, store, page.documents, requestVersion);
          break;
        }
        case 'tagCreate': {
          const tag = await gate.write(() => state.store.createTag(String(message.name ?? '')));
          await reply({ type: 'tagCreated', tag });
          await broadcast();
          break;
        }
        case 'tagColor':
          await gate.write(() => state.store.setTagColor(String(message.id ?? ''), String(message.color ?? '')));
          await reply({ type: 'changedTag' });
          await broadcast({ kind: 'tagColor' });
          break;
        case 'tagRename':
          await gate.write(() => state.store.renameTag(String(message.id ?? ''), String(message.name ?? '')));
          await reply({ type: 'changedTag' });
          await broadcast();
          break;
        case 'tagDelete': {
          const outcome = await gate.write(() => state.store.deleteTag(String(message.id ?? '')));
          await reply({ type: 'changedTag', removed: outcome.affected, orphaned: outcome.orphaned });
          await broadcast();
          break;
        }
        case 'tagToggle': {
          // Clicking a tag in the row menu adds or removes it; clicking Unclassified clears them all,
          // because that row is what "no category" means.
          const id = String(message.id ?? '');
          const tagId = String(message.tagId ?? DEFAULT_TAG);
          const updated = await gate.write(async () => {
            if (tagId === DEFAULT_TAG) await state.store.setTags(id, []);
            else {
              const doc = await state.store.document(id);
              if (!doc) throw new Error('Document no longer exists.');
              await (doc.tags.includes(tagId) ? state.store.removeTag(id, tagId) : state.store.addTag(id, tagId));
            }
            // The page patches this one row from the reply, so it has to carry the outcome.
            return (await state.store.document(id))?.tags ?? [];
          });
          await reply({ type: 'changedTag', id, tags: updated });
          await broadcast({ kind: 'tagToggle', documentId: id, tags: updated });
          break;
        }
        case 'tagReorder': {
          // The panel answers a drag with the whole order it just showed, so the catalogue simply
          // adopts it. The two pinned rows never appear in that list.
          const ids = Array.isArray(message.ids) ? (message.ids as unknown[]).filter((id): id is string => typeof id === 'string') : [];
          if (!ids.length) throw new Error('A tag order must name at least one tag.');
          await gate.write(() => state.store.reorderTags(ids));
          await reply({ type: 'changedTag' });
          await broadcast();
          break;
        }
        case 'search': {
          const query = String(message.query ?? '').trim().slice(0, 500);
          const tagId = typeof message.tagId === 'string' ? message.tagId : null;
          await reply({ type: 'matches', matches: await state.store.search(query, 10, tagId, typeof message.directory === 'string' ? message.directory : null) });
          break;
        }
        case 'scanPause': {
          if (scanning) {
            pausedLibraries.add(state.root);
            scanController?.abort();
            await ctx.storage.set('pausedLibraries', [...pausedLibraries]);
          }
          await reply({ type: 'scanPauseRequested' });
          break;
        }
        case 'sync': {
          const root = state.root;
          // Answer first so the page can show the hairline, then stream progress into it.
          await reply({ type: 'syncStarted' });
          if (root !== state.root) throw new Error(t('library.changed'));
          const outcome = await syncSources(
            (message, percent) => { void panel.postMessage({ type: 'progress', message, percent }).catch(() => {}); },
            undefined,
          );
          await reply({ type: 'syncDone', root, sync: outcome });
          break;
        }
        case 'reveal': {
          const store = state.store;
          const doc = message.issues === true ? await store.sourceIssue(String(message.id ?? ''), true) : await store.document(String(message.id ?? ''), true);
          if (!doc) throw new Error('Document no longer exists.');
          try{
            await store.assertSourceAvailable();
            const binding=libraries.forRoot(store.directoryRoot)?.index;
            if(binding?.kind==='source'&&binding.dev!==undefined){const root=await stat(store.directoryRoot,{bigint:true});if(String(root.dev)!==binding.dev||String(root.ino)!==binding.ino)throw new Error('Source identity changed.');}
          }catch{throw new Error('SOURCE_UNAVAILABLE');}
          let info;
          try{await assertSourcePath(store.directoryRoot,doc.path);info=await stat(doc.path);}
          catch(error){
            const code=(error as NodeJS.ErrnoException).code;
            if(['ENOENT','ENOTDIR'].includes(code??'')){try{await store.assertSourceAvailable();}catch{throw new Error('SOURCE_UNAVAILABLE');}throw new Error('SOURCE_MISSING');}
            if(['EACCES','EPERM','EIO','ENOTCONN','ESTALE','ETIMEDOUT'].includes(code??''))throw new Error('SOURCE_UNAVAILABLE');
            throw error;
          }
          if (store !== activeStore || requestVersion !== libraryVersion) throw new Error(t('library.changed'));
          if (info.isDirectory()) await revealDirectory(doc.path); else await revealFile(doc.path);
          await reply({ type: 'revealed' });
          break;
        }
      }
    } catch (error) {
      await reply({ type: 'error', id:message.id,error: errorText(error),...(message.type?.startsWith('library')?{library:await libraryInfo()}:{}) });
    }
  }

  ctx.subscriptions.push(ctx.ui.onDidOpenPanel((panel) => {
    if (panel.view !== 'appView') return;
    panels.add(panel);
    if (bound.has(panel)) return;
    bound.add(panel);
    ctx.subscriptions.push(
      panel.onDidReceiveMessage((message) => handle(panel, message)),
      panel.onDidDispose(() => { panels.delete(panel); pageChecks.get(panel)?.abort(); pageChecks.delete(panel); }),
    );
  }));

  async function findTag(value: string, store = state.store): Promise<{ id: string; name: string; count: number }> {
    const requested = value.trim();
    if (!requested) throw new Error(t('tool.tagRequired'));
    const tags = await store.tags();
    const tag = tags.find((item) => item.id === requested ||
      (item.id === DEFAULT_TAG ? t('tool.uncategorized') : item.name).toLowerCase() === requested.toLowerCase());
    if (!tag) throw new Error(t('tool.tagMissing', { name: requested }));
    return { id: tag.id, name: tag.id === DEFAULT_TAG ? t('tool.uncategorized') : tag.name, count: tag.count };
  }

  /**
   * A format's engine has to be installed before the bytes are read, because the download must not
   * happen under the library lock. The install starts here instead — in the background, where the
   * footer hairline already reports it — and the caller is told to import again once it lands.
   */
  async function requireEngine(extension: string): Promise<void> {
    const step = engineForExtension(extension);
    if (!step) return;
    let state = environment.snapshot();
    if (!state.steps.some((item) => item.id === step)) state = await environment.probe();
    const entry = state.steps.find((item) => item.id === step);
    if (!entry || entry.status === 'ready') return;
    if (step === 'ocr') {
      const snapshot = await environment.ensure('ocr');
      const ocr = snapshot.steps.find(item => item.id === 'ocr');
      if (ocr?.status !== 'ready') throw new Error(ocr?.error ?? t('environment.unknownFailure'));
      return;
    }
    if (entry.status !== 'running' && !state.running) void environment.install().catch(() => {});
    const installing = entry.status === 'running' || state.running;
    throw new Error(t(installing ? 'import.engineInstalling' : 'import.engineMissing', {
      name: t('engine.anydoc'),
    }));
  }

  ctx.subscriptions.push(ctx.tools.register({
    name: 'local_knowledge_search',
    title: t('tool.title'),
    description: t('tool.description'),
    defaultEnabled: true,
    risk: 'medium',
    timeoutMs: 600_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...KNOWLEDGE_ACTIONS], description: 'Operation. Defaults to search for backwards compatibility.' },
        query: { type: 'string', description: 'Search question or keywords (search only).' },
        tag: { type: 'string', description: 'Tag name or id: search/documents filter; rename_tag/delete_tag target; index tag assignment. A missing tag is created for index. Omit for all tags in search/documents, or leave a new document untagged when indexing.' },
        name: { type: 'string', description: 'New tag name (create_tag or rename_tag). Renaming changes only the tag name; it does not change its color or document assignments.' },
        force: { type: 'boolean', description: 'delete_tag: required to remove a tag that still holds documents. The documents are never deleted and keep their other tags; a document that had only this tag becomes untagged. Confirmation prevents accidental removal of a tag from a batch.' },
        documentId: { type: 'string', description: 'Document ID from documents/search (tag_document, untag_document).' },
        path: { type: 'string', description: 'index: existing file or folder inside the selected knowledge directory, absolute or relative to that root. Indexes in place without copying files. A folder is read recursively.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'index: several files and/or folders in one call. Every entry lands in the tag given by `tag`.' },
        items: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, tag: { type: 'string' } }, required: ['path'] }, description: 'index: per-file tag assignments, for tagging a batch yourself — read the files, then send each one with the tag it belongs to. Overrides `tag`. Example: [{"path":"a/合同.pdf","tag":"合同"},{"path":"b/发票.pdf","tag":"发票"}].' },
        recursive: { type: 'boolean', description: 'index: read subfolders too (default true). Set false to read only the folder itself.' },
        offset: { type: 'number', description: 'Document list offset (documents; default 0).' },
        limit: { type: 'number', description: 'Maximum passages (1–20) or documents (1–50).' },
      },
    },
    async execute(input, exec) {
      try {
        await ready;
        const action = input.action ?? 'search';
        if (!KNOWLEDGE_ACTIONS.some(allowed => allowed === action)) {
          return result(t(['import', 'import_url', 'save_document', 'delete', 'remove', 'backup'].includes(String(action)) ? 'library.readOnlySources' : 'tool.actionUnknown'), true);
        }
        if (action === 'library') {
          const info = await libraryInfo();
          return result(t('tool.libraryEntry', { root: String(info.root), documents: Number(info.documents), tags: Number(info.tags) }) +
            (info.indexRoot ? `\n${t('tool.indexLocation', { path: String(info.indexRoot) })}` : '') +
            (info.isDefault ? `\n${t('tool.libraryDefault')}` : '') +
            (info.unavailable ? `\n${t('tool.libraryUnavailable', { path: String(info.unavailable) })}` : ''));
        }
        if (action === 'environment') {
          const status = environmentStatus();
          const steps = status.steps as Array<{ id: string; status: string; detail?: string; error?: string; message?: string }>;
          return result([
            t('tool.environmentEntry', { platform: String(status.platform), root: String(status.cachePath) }),
            ...steps.map((step) => `- ${step.id}: ${step.status}${step.detail ? ` (${step.detail})` : ''}${step.message ? ` — ${step.message}` : ''}${step.error ? `\n  ${step.error}` : ''}`),
          ].join('\n'));
        }
        // Bind every subsequent store access to the library selected at call start.
        // If the user switches during an await, fail safely instead of reading or editing the next library.
        return await inSelectedLibrary(activeStore);
        async function inSelectedLibrary(selected: KnowledgeStore | undefined): Promise<finch.ToolResult> {
        const state = { get store(): KnowledgeStore {
          if (!selected) throw new Error(t('library.chooseFirst'));
          if (selected !== activeStore) throw new Error(t('library.changed'));
          return selected;
        } };
        if (action === 'tags') {
          const tags = await state.store.tags();
          return result(tags.map((tag) => t('tool.tagEntry', {
            name: tag.id === DEFAULT_TAG ? t('tool.uncategorized') : tag.name,
            count: tag.count, id: tag.id,
          })).join('\n'));
        }
        if (action === 'create_tag') {
          const tag = await gate.write(() => state.store.createTag(typeof input.name === 'string' ? input.name : ''));
          await broadcast();
          return result(t('tool.tagCreated', { name: tag.name, id: tag.id }));
        }
        if (action === 'rename_tag') {
          const tag = await findTag(typeof input.tag === 'string' ? input.tag : '', state.store);
          const name = typeof input.name === 'string' ? input.name.trim() : '';
          await gate.write(() => state.store.renameTag(tag.id, name));
          await broadcast();
          return result(t('tool.tagRenamed', { name, id: tag.id }));
        }
        if (action === 'delete_tag') {
          const tag = await findTag(typeof input.tag === 'string' ? input.tag : '', state.store);
          // Documents are never deleted with the tag, but re-filing a batch by accident should
          // not be silent either, so a tag that still holds documents needs an explicit retry.
          if (tag.count > 0 && input.force !== true) {
            return result(t('tool.tagNotEmpty', { name: tag.name, count: tag.count, uncategorized: t('tool.uncategorized') }), true);
          }
          const outcome = await gate.write(() => state.store.deleteTag(tag.id));
          await broadcast();
          return result(t('tool.tagDeleted', { name: tag.name, count: outcome.affected, orphaned: outcome.orphaned, uncategorized: t('tool.uncategorized') }));
        }
        if (action === 'tag_document' || action === 'untag_document') {
          // A document may carry several tags; these add or remove one without touching the rest.
          const tag = await findTag(typeof input.tag === 'string' ? input.tag : '', state.store);
          const id = typeof input.documentId === 'string' ? input.documentId : '';
          const removing = action === 'untag_document';
          const updated = await gate.write(async () => {
            await (removing ? state.store.removeTag(id, tag.id) : state.store.addTag(id, tag.id));
            return (await state.store.document(id))?.tags ?? [];
          });
          await broadcast({ kind: 'tagToggle', documentId: id, tags: updated });
          return result(t(removing ? 'tool.documentUntagged' : 'tool.documentTagged', { id, tag: tag.name }));
        }
        if (action === 'sync') {
          // Re-indexes the sources that changed and drops the ones that are gone.
          void state.store;
          const outcome = await syncSources(
            (message, percent) => exec.progress?.report({ message, percent }),
            exec.signal,
          );
          const lines = [t(outcome.paused ? 'tool.syncPaused' : 'tool.syncDone', {
            updated: outcome.updated.length, removed: outcome.removed.length, unchanged: outcome.unchanged,
          })];
          if (outcome.moved.length) lines.push(t('tool.syncMoved', { count: outcome.moved.length }));
          if (outcome.skipped.length) lines.push(t('tool.syncSkipped', { count: outcome.skipped.length, list: outcome.skipped.map(item => `${item.name}: ${t(`index.skip.${item.reason}`)}`).join('\n') }));
          if (outcome.updated.length) lines.push(t('tool.syncUpdated', { list: outcome.updated.join(' · ') }));
          if (outcome.removed.length) lines.push(t('tool.syncRemoved', { list: outcome.removed.join(' · ') }));
          if (outcome.unreachable.length) lines.push(t('tool.syncUnreachable', { list: outcome.unreachable.join(' · ') }));
          if (outcome.failed.length) {
            lines.push(t('tool.syncFailed', {
              count: outcome.failed.length,
              list: outcome.failed.map((item) => t('tool.importFailureLine', { path: item.name, reason: item.reason })).join('\n'),
            }));
          }
          if (!outcome.updated.length && !outcome.removed.length && !outcome.unreachable.length && !outcome.failed.length && !outcome.skipped.length && !outcome.moved.length) lines.push(t('tool.syncNothing'));
          return result(lines.join('\n'), outcome.failed.length > 0);
        }
        if (action === 'index') {
          const importRoot = state.store.directoryRoot;
          if (!importRoot) return result(t('tool.workspaceRequired'), true);
          const requests = readImportRequests(input);
          if (!requests.length) return result(t('tool.fileRequired'), true);
          const expanded = await expandImportTargets(importRoot, requests, { recursive: input.recursive !== false });
          const skipLabels: Record<SkipReason, string> = {
            hidden: t('tool.skipHidden'), unsupported: t('tool.skipUnsupported'), symlink: t('tool.skipSymlink'),
            notFile: t('tool.skipNotFile'), empty: t('tool.skipEmpty'), tooLarge: t('tool.skipTooLarge', { max: MAX_FILE_MB }), limit: t('tool.skipLimit', { max: MAX_BATCH_FILES }),
          };
          const counted = new Map<SkipReason, number>();
          for (const entry of expanded.skipped) counted.set(entry.reason, (counted.get(entry.reason) ?? 0) + 1);
          const skipDetail = [...counted].map(([reason, count]) => `${skipLabels[reason]} ${count}`).join(' · ');
          const failureList = (list: ImportFailure[]) => list
            .map((item) => t('tool.importFailureLine', { path: basename(item.path) || item.path, reason: errorText(item.error) }))
            .join('\n');
          if (!expanded.targets.length) {
            // Nothing usable: surface the caller's own mistake first, then anything a folder held.
            const head = expanded.failures.length ? failureList(expanded.failures) : t('tool.importNothing');
            return result(skipDetail ? `${head}\n${t('tool.importSkipped', { count: expanded.skipped.length, detail: skipDetail })}` : head, true);
          }
          const label = (tag: { id: string; name: string }) => tag.id === DEFAULT_TAG ? t('tool.uncategorized') : tag.name;
          const tagIds = new Map<string, { id: string; name: string }>();
          for (const tag of await state.store.tags()) tagIds.set(label(tag).toLowerCase(), { id: tag.id, name: label(tag) });
          const createdTags: string[] = [];
          const ensureTag = async (requested?: string): Promise<{ id: string; name: string }> => {
            const value = (requested ?? '').trim();
            if (!value) return { id: DEFAULT_TAG, name: t('tool.uncategorized') };
            const known = tagIds.get(value.toLowerCase()) ?? (await state.store.tags()).find((tag) => tag.id === value);
            if (known) return { id: known.id, name: known.id === DEFAULT_TAG ? t('tool.uncategorized') : known.name };
            // Classifying a batch often names a tag that does not exist yet; creating it keeps one call enough.
            const created = await gate.write(() => state.store.createTag(value));
            createdTags.push(created.name);
            tagIds.set(created.name.toLowerCase(), { id: created.id, name: created.name });
            return { id: created.id, name: created.name };
          };
          const fallback = await ensureTag(typeof input.tag === 'string' ? input.tag : '');
          const finished: Array<{ file: ImportedFile; tag: string }> = [];
          const failed: ImportFailure[] = [];
          const perTag = new Map<string, number>();
          for (const [index, target] of expanded.targets.entries()) {
            if (exec.signal?.aborted) break;
            const tag = target.tag ? await ensureTag(target.tag) : fallback;
            try {
              exec.progress?.report({ message: t('progress.indexing', { name: target.name }), percent: Math.floor(index / expanded.targets.length * 100) });
              const outcome: ImportedFile = await gate.write(async () => {
                const path = await assertSourcePath(importRoot, target.path);
                const indexed = await state.store.importFile(path, basename(path), tag.id);
                return { name: target.name, documentId: indexed.document.id, unchanged: indexed.unchanged };
              });
              finished.push({ file: outcome, tag: tag.name });
              perTag.set(tag.name, (perTag.get(tag.name) ?? 0) + 1);
            } catch (error) {
              failed.push({ path: target.path, error: error instanceof Error ? error : new Error(String(error)) });
            }
          }
          await broadcast();
          if (failed.length && !finished.length) return result(failureList(failed), true);
          // A plain one-file call keeps the short answer it has always given.
          if (finished.length === 1 && !failed.length && !expanded.skipped.length && !expanded.failures.length && !createdTags.length) {
            const only = finished[0];
            return result(t(only.file.unchanged ? 'tool.importUnchanged' : 'tool.imported',
              { name: only.file.name, id: only.file.documentId, tag: only.tag }));
          }
          const unchanged = finished.filter((item) => item.file.unchanged).length;
          const lines = [finished.length
            ? unchanged > 0
              ? t('tool.importDoneUnchanged', { ok: finished.length, unchanged })
              : t('tool.importDone', { ok: finished.length })
            : t('tool.importNothing')];
          if (createdTags.length) lines.push(t('tool.importCreatedTags', { list: createdTags.join(' · ') }));
          if (perTag.size) lines.push(t('tool.importByTag', { list: [...perTag].map(([name, count]) => `${name} ${count}`).join(' · ') }));
          if (expanded.skipped.length) lines.push(t('tool.importSkipped', { count: expanded.skipped.length, detail: skipDetail }));
          const problems = [...expanded.failures, ...failed].map((item) => t('tool.importFailureLine', {
            path: basename(item.path) || item.path, reason: errorText(item.error),
          }));
          if (problems.length) lines.push(t('tool.importFailures', { count: problems.length, list: problems.join('\n') }));
          return result(lines.join('\n'), failed.length > 0);
        }
        let tagId: string | null = null;
        if (typeof input.tag === 'string' && input.tag.trim()) tagId = (await findTag(input.tag, state.store)).id;
        if (action === 'documents') {
          const offset = typeof input.offset === 'number' && Number.isFinite(input.offset) ? input.offset : 0;
          const limit = typeof input.limit === 'number' && Number.isFinite(input.limit) ? input.limit : 50;
          const page = await state.store.page(tagId, 'updated', offset, limit);
          const tags = await state.store.tags();
          return result(t('tool.documentsTotal', { total: page.total, offset: Math.max(0, Math.floor(offset)) }) + '\n' +
            (page.documents.map((doc) => t('tool.documentEntry', {
              name: doc.name, id: doc.id,
              tag: doc.tags.length ? doc.tags.map((tagId) => tags.find((tag) => tag.id === tagId)?.name ?? tagId).join(' · ') : t('tool.uncategorized'),
            })).join('\n') || t('tool.empty')));
        }
        if (action !== 'search') return result(t('tool.actionUnknown'), true);
        const query = typeof input.query === 'string' ? input.query.trim().slice(0, 500) : '';
        if (!query) return result(t('tool.queryRequired'), true);
        const limit = typeof input.limit === 'number' && Number.isFinite(input.limit) ? input.limit : 5;
        const matches = await state.store.search(query, limit, tagId);
        if (!matches.length) return result(t('tool.empty'));
        const tags = await state.store.tags();
        return result(matches.map((row, index) =>
          `[${index + 1}] ${row.name} · ${t('tool.chunk', { number: row.chunk })} · ${tags.find((tag) => tag.id === row.tag_id)?.name || t('tool.uncategorized')} · ${t('tool.documentId', { id: row.document_id })}\n${t('tool.source')}: ${row.path}\n${row.text}`,
        ).join('\n\n---\n\n'));
        }
      } catch (error) {
        return result(errorText(error), true);
      }
    },
  }));
}

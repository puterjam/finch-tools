import type * as finch from 'finch';
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_TAG, KnowledgeStore, MAX_FILE_MB, SIZE_LIMIT_MESSAGE, engineForExtension, type DocumentSort } from './store.js';
import { UploadReceiver } from './uploads.js';
import { expandImportTargets, importFromPath, importFromWorkspace, MAX_BATCH_FILES, type ImportedFile, type ImportFailure, type ImportRequest, type SkipReason } from './tool-import.js';
import { loadEngine as loadDocumentEngine, ENGINE_VERSION as DOCUMENT_ENGINE_VERSION, isEngineInstalled as isDocumentEngineInstalled } from './document-engine.js';
import { loadEngine as loadOcrEngine, ENGINE_VERSION as OCR_ENGINE_VERSION, isEngineInstalled as isOcrEngineInstalled, engineBinaryPath } from './ocr-engine.js';
import { listModels as listOcrModels } from './ocr-runner.js';
import { loadLanceDB, isEngineInstalled as isLanceEngineInstalled, engineVersion as lanceEngineVersion } from './lancedb-engine.js';
import { BackupGate } from './backup-gate.js';
import { createLibraryBackup } from './backup.js';
import { adoptExistingLibrary, assertUsableTarget, hasLibrary, inspectLibrary, relocateLibrary, resolveLibraryAction } from './library.js';
import { EnvironmentManager, type EnvironmentSnapshot } from './environment.js';
import { fetchArticle, normalizeUrl, ArticleUnreachableError } from './article.js';
import { createKnowledgeComposer } from './composer.js';
export { createKnowledgeComposer } from './composer.js';
import { mkdir, writeFile } from 'node:fs/promises';
export { KnowledgeStore, vectorize, chunkText, DEFAULT_TAG, engineForExtension, ACCEPTED, MAX_FILE_BYTES, MAX_FILE_MB } from './store.js';
export { highlightTerms, snippetParts, snippetText } from './snippet.js';
export { openInPreview, openListedDocument, previewRoute } from './preview.js';
export { inScope, UNCLASSIFIED } from './scope.js';
export { UploadReceiver } from './uploads.js';
export { importFromWorkspace, expandImportTargets, MAX_BATCH_FILES } from './tool-import.js';
export { BackupGate } from './backup-gate.js';
export { createLibraryBackup } from './backup.js';
export { rebaseImportPath, rebaseStoredPaths, inspectLibrary, assertUsableTarget, createEmptyLibrary, relocateLibrary, adoptExistingLibrary, hasLibrary, resolveLibraryAction, within } from './library.js';
export { EnvironmentManager } from './environment.js';
export { extractArticle, normalizeUrl, fetchArticle } from './article.js';
export { downloadWithProgress, formatBytes, oncePerPercent } from './download.js';

const execFileAsync = promisify(execFile);
interface ViewRequest { type?: string; requestId?: string; id?: string; ids?: string[]; key?: string; tagId?: string | null; name?: string; size?: number; data?: string; query?: string; offset?: number; sort?: string; mode?: string }
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

/** Reveal the indexed source. Picker/drag imports point to managed copies, not originals. */
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
  else await execFileAsync('open', [path]);
}

export function activate(ctx: finch.MiniToolContext): void {
  const panels = new Set<finch.AppPanel>();
  const gate = new BackupGate();
  const uploadReleases = new Map<finch.AppPanel, () => void>();
  const bound = new WeakSet<finch.AppPanel>();
  const uploads = new Map<finch.AppPanel, UploadReceiver>();
  const t = (key: string, values?: Record<string, string | number>) => ctx.i18n.t(key, values);
  const releaseUpload = (panel: finch.AppPanel): void => { uploadReleases.get(panel)?.(); uploadReleases.delete(panel); };
  const forwardProgress = (message: string): void => {
    for (const panel of panels) void panel.postMessage({ type: 'progress', message }).catch(() => {});
  };

  /** The library directory is chosen at runtime, so the store is swapped in place instead of rebuilt. */
  const state = {
    root: ctx.storagePath,
    store: new KnowledgeStore(ctx.storagePath, { cachePath: ctx.storagePath, progress: forwardProgress, requireEngine }),
  };
  let unavailable: string | null = null;

  async function swapTo(root: string): Promise<void> {
    const next = new KnowledgeStore(root, { cachePath: ctx.storagePath, progress: forwardProgress, requireEngine });
    const previous = state.store;
    for (const panel of panels) { releaseUpload(panel); await uploads.get(panel)?.abort(); }
    uploads.clear();
    state.root = root;
    state.store = next;
    await previous.close();
  }

  const ready = (async () => {
    const saved = await ctx.storage.get<string>('libraryRoot');
    // A missing directory (unmounted drive) keeps the pointer so it resumes once the volume is back.
    if (!saved || saved === state.root) return;
    if (!(await hasLibrary(saved))) { unavailable = saved; return; }
    await swapTo(saved);
  })();

  /**
   * Drops entries whose source file is gone, so a library that lost files does not
   * keep showing them. Throttled because it stats every document.
   */
  let lastReconcile = 0;
  async function reconcileMissing(force = false): Promise<void> {
    if (!force && Date.now() - lastReconcile < 5_000) return;
    lastReconcile = Date.now();
    const removed = await state.store.reconcileMissing().catch(() => []);
    if (!removed.length) return;
    for (const panel of panels) {
      void panel.postMessage({ type: 'removed', names: removed.map((doc) => doc.name), count: removed.length }).catch(() => {});
    }
    await broadcast();
  }
  void ready.then(() => reconcileMissing(true));

  /**
   * Follows every recorded source file: re-indexes the ones whose content changed and drops
   * the ones that are gone. This is the "keep up with edits made outside the app" path, and
   * it stays explicit — nothing reads the disk behind the user's back.
   */
  interface SyncOutcome { updated: string[]; removed: string[]; unchanged: number; unreachable: string[]; failed: Array<{ name: string; reason: string }> }

  async function syncSources(report?: (message: string, percent: number) => void, signal?: AbortSignal): Promise<SyncOutcome> {
    const outcome: SyncOutcome = { updated: [], removed: [], unchanged: 0, unreachable: [], failed: [] };
    const states = await state.store.sourceStates();
    const pending = states.filter((entry) => entry.state === 'changed' || entry.state === 'deleted').length;
    let done = 0;
    for (const entry of states) {
      if (entry.state === 'same') { outcome.unchanged++; continue; }
      if (entry.state === 'unreachable') { outcome.unreachable.push(entry.document.name); continue; }
      if (signal?.aborted) break;
      done++;
      report?.(t('progress.sync', { name: entry.document.name }), Math.floor(done / Math.max(1, pending) * 100));
      try {
        if (entry.state === 'deleted') {
          await gate.write(() => state.store.remove(entry.document.id));
          outcome.removed.push(entry.document.name);
          continue;
        }
        const source = entry.document.source_path!;
        await gate.write(() => importFromPath(state.root, state.store, source, entry.document.tags[0] ?? DEFAULT_TAG, undefined, signal));
        outcome.updated.push(entry.document.name);
      } catch (error) {
        outcome.failed.push({ name: entry.document.name, reason: errorText(error) });
      }
    }
    if (outcome.updated.length || outcome.removed.length) await broadcast();
    return outcome;
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
        // Proves the native binding actually loads and can open the vector store.
        await state.store.tags();
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
    snapshot: async () => { await ready; return unavailable ? null : state.store.summary(); },
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

  function receiverFor(panel: finch.AppPanel): UploadReceiver {
    let receiver = uploads.get(panel);
    if (!receiver) { receiver = new UploadReceiver(state.root, state.store); uploads.set(panel, receiver); }
    return receiver;
  }

  async function libraryInfo(): Promise<Record<string, unknown>> {
    // summary() reads the catalogue only, so the first paint never waits on an engine download.
    const { documents, tags } = await state.store.summary();
    return { root: state.root, isDefault: state.root === ctx.storagePath, documents, tags: tags.length, unavailable };
  }

  async function chooseDirectory(title: string, hint: string, label: string, confirm: string, cancel: string, previous: string): Promise<string | null> {
    if (process.platform === 'darwin') {
      try {
        const { stdout } = await execFileAsync('osascript', [
          '-e', 'on run argv',
          '-e', 'POSIX path of (choose folder with prompt (item 1 of argv))',
          '-e', 'end run', '--', title,
        ]);
        return stdout.trim() || null;
      } catch (error) {
        if (String(error).includes('-128')) return null; // The user dismissed the native picker.
        throw error;
      }
    }
    const response = await ctx.ui.showModalDialog({
      title, message: hint,
      fields: [{ key: 'directory', type: 'text', label, required: true, default: previous }],
      actions: [{ id: 'cancel', label: cancel }, { id: 'select', label: confirm, variant: 'primary' }],
    });
    return response.action === 'select' ? String(response.values?.directory ?? '').trim() || null : null;
  }

  const errorText = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('UNIQUE constraint failed: tags.name')) return t('error.duplicateTag');
    if (message === 'Tag no longer exists.') return t('error.missingTag');
    if (message === 'Tag name must be 1–60 characters.') return t('error.tagName');
    if (message === 'Document no longer exists.') return t('error.missingDocument');
    if (message === 'Indexed file is no longer on disk.' || message.includes('ENOENT')) return t('error.missingFile');
    if (message === 'Specify a local file path.') return t('tool.fileRequired');
    if (message === 'The file must be inside the current workspace.') return t('tool.fileOutside');
    if (message === 'Choose a regular file, not a symbolic link.') return t('tool.fileSymlink');
    if (message === SIZE_LIMIT_MESSAGE) return t('tool.fileSize', { max: MAX_FILE_MB });
    if (message === 'File import cancelled.') return t('tool.fileCancelled');
    if (message === 'Finish current imports or edits before backing up.') return t('backup.busy');
    if (message === 'A library backup is in progress. Try again when it finishes.') return t('backup.writing');
    if (message === 'The backup directory cannot be inside the live library.') return t('backup.inside');
    if (message === 'Choose an absolute backup directory.' || message === 'Choose a backup directory.') return t('backup.invalidDirectory');
    if (message === 'Choose a library directory.' || message === 'Choose an absolute library directory.' || message === 'Choose a directory, not a file.') return t('library.invalidDirectory');
    if (message === 'This is already the working library directory.') return t('library.same');
    if (message === 'The library directory cannot contain or sit inside the current one.') return t('library.nested');
    if (message === 'That folder is neither a library nor empty.') return t('library.notEmpty');
    if (message === 'The library copy did not match the original; nothing was switched.') return t('library.mismatch');
    if (message === 'The library folder is no longer on disk.') return t('library.unavailable');
    return message;
  };
  const supported = new Set(['ready', 'page', 'locate', 'tags', 'tagCreate', 'tagRename', 'tagDelete', 'tagToggle', 'tagReorder', 'uploadStart', 'uploadChunk', 'uploadFinish', 'uploadAbort', 'delete', 'search', 'reveal', 'backup', 'sync', 'library', 'libraryAction', 'libraryReveal', 'environment', 'environmentInstall', 'environmentHelp']);

  /**
   * Tells every open page what changed. `change` describes a change that concerns a single row, so
   * a page can patch that row instead of reloading the list under the user.
   */
  async function broadcast(change?: { kind: 'tagToggle'; documentId: string; tags: string[] }): Promise<void> {
    composerAction.notifyUpdate();
    const tags = await state.store.tags();
    for (const panel of panels) void panel.postMessage({ type: 'changed', tags, ...(change ? { change } : {}) }).catch(() => {});
  }
  async function handle(panel: finch.AppPanel, raw: unknown): Promise<void> {
    const message = raw as ViewRequest;
    if (!message || typeof message !== 'object' || !supported.has(message.type ?? '')) return;
    const requestId = typeof message.requestId === 'string' ? message.requestId.slice(0, 80) : '';
    const reply = (payload: Record<string, unknown>) => panel.postMessage({ requestId, ...payload });
    try {
      await ready;
      switch (message.type) {
        case 'ready': {
          // Everything here must be engine-free: on a fresh machine the vector engine is still
          // downloading, and the setup screen cannot wait for it.
          const { tags } = await state.store.summary();
          await reply({ type: 'tags', tags, library: await libraryInfo(),
            backupDirectory: await ctx.storage.get<string>('backupDirectory'),
            environment: await environment.probe() });
          void reconcileMissing();
          break;
        }
        case 'environment':
          await reply({ type: 'environment', environment: environment.snapshot() });
          break;
        case 'environmentInstall': {
          // Reply immediately so the page can render, then stream updates as steps run.
          const snapshot = environment.snapshot();
          await reply({ type: 'environment', environment: snapshot });
          void environment.install(true);
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
        case 'libraryReveal':
          await revealDirectory(state.root);
          await reply({ type: 'libraryRevealed' });
          break;
        case 'libraryAction': {
          if (message.mode !== 'choose') throw new Error(t('library.invalidDirectory'));
          const title = t('library.title.choose', { root: state.root });
          const chosen = await chooseDirectory(title, t('library.pathHint'), t('library.directory'), t('library.choose'), t('backup.cancel'), state.root);
          if (!chosen) { await reply({ type: 'libraryCanceled' }); break; }
          const target = await assertUsableTarget(chosen, state.root);
          // The picker asks for a folder, not for a verb: a library already inside it is adopted
          // where it lies, an empty folder receives a full copy of the current one.
          const mode = await resolveLibraryAction(target);
          const previousRoot = state.root;
          // Counted from the catalogue, never through the engine: on a first run the engine may
          // still be downloading while the user is picking a folder.
          const counts = await state.store.summary();
          const before = { documents: counts.documents, tags: counts.tags.length };
          const after = await gate.snapshot(() => mode === 'move' ? relocateLibrary(state.store, target) : adoptExistingLibrary(target));
          // Never switch away from a library that did not survive the copy intact.
          if (mode === 'move' && (after.documents !== before.documents || after.tags !== before.tags)) {
            throw new Error('The library copy did not match the original; nothing was switched.');
          }
          await swapTo(target);
          await ctx.storage.set('libraryRoot', target);
          unavailable = null;
          await reply({ type: 'libraryDone', mode, previousRoot, library: await libraryInfo(),
            verified: { before, after: { documents: after.documents, tags: after.tags }, missing: after.missing } });
          await broadcast();
          break;
        }
        case 'tags':
          await reply({ type: 'tags', tags: await state.store.tags() });
          break;
        case 'page': {
          const tagId = typeof message.tagId === 'string' ? message.tagId : null;
          const sort = (['name', 'added', 'updated'].includes(message.sort ?? '') ? message.sort : 'updated') as DocumentSort;
          const page = await state.store.page(tagId, sort, Number(message.offset ?? 0), 50);
          await reply({ type: 'page', ...page, offset: Math.max(0, Math.floor(Number(message.offset ?? 0)) || 0) });
          break;
        }
        case 'locate': {
          const tagId = typeof message.tagId === 'string' ? message.tagId : null;
          const sort = (['name', 'added', 'updated'].includes(message.sort ?? '') ? message.sort : 'updated') as DocumentSort;
          const id = String(message.id ?? '');
          const position = await state.store.position(id, tagId, sort);
          if (position === null) throw new Error('Document is not in the selected tag.');
          const offset = Math.floor(position / 50) * 50;
          await reply({ type: 'page', ...(await state.store.page(tagId, sort, offset, 50)), offset, focusId: id });
          break;
        }
        case 'tagCreate': {
          const tag = await gate.write(() => state.store.createTag(String(message.name ?? '')));
          await reply({ type: 'tagCreated', tag });
          await broadcast();
          break;
        }
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
        case 'uploadStart': {
          releaseUpload(panel);
          const release = gate.reserveWrite();
          uploadReleases.set(panel, release);
          await receiverFor(panel).begin(message.name ?? '', message.size ?? NaN, String(message.tagId ?? DEFAULT_TAG));
          await reply({ type: 'uploadReady' });
          break;
        }
        case 'uploadChunk': {
          const received = await receiverFor(panel).chunk(message.data ?? '');
          await reply({ type: 'uploadChunk', received });
          break;
        }
        case 'uploadFinish': {
          await panel.postMessage({ type: 'progress', message: t('progress.indexing', { name: message.name ?? '' }) });
          const indexed = await receiverFor(panel).finish();
          releaseUpload(panel);
          await reply({ type: 'done', imported: indexed.unchanged ? 0 : 1, unchanged: indexed.unchanged ? 1 : 0 });
          await broadcast();
          break;
        }
        case 'uploadAbort':
          await receiverFor(panel).abort();
          releaseUpload(panel);
          break;
        case 'delete': {
          const removed = await gate.write(() => state.store.remove(String(message.id ?? '')));
          await reply({ type: 'deleted', removed });
          await broadcast();
          break;
        }
        case 'search': {
          const query = String(message.query ?? '').trim().slice(0, 500);
          const tagId = typeof message.tagId === 'string' ? message.tagId : null;
          await reply({ type: 'matches', matches: await state.store.search(query, 10, tagId) });
          break;
        }
        case 'sync': {
          // Answer first so the page can show the hairline, then stream progress into it.
          await reply({ type: 'syncStarted' });
          const outcome = await syncSources(
            (message, percent) => { void panel.postMessage({ type: 'progress', message, percent }).catch(() => {}); },
            undefined,
          );
          await reply({ type: 'syncDone', sync: outcome });
          break;
        }
        case 'backup': {
          const previous = await ctx.storage.get<string>('backupDirectory');
          const destination = await chooseDirectory(t('backup.pickPrompt'), t('backup.pathHint'), t('backup.directory'), t('backup.start'), t('backup.cancel'), previous ?? '');
          if (!destination) { await reply({ type: 'backupCanceled' }); break; }
          await reply({ type: 'progress', message: t('backup.copying') });
          const snapshot = await gate.snapshot(() => createLibraryBackup(state.store, state.root, destination, (step) => {
            void panel.postMessage({ type: 'progress', message: t(step === 'verify' ? 'backup.verifying' : 'backup.copying') }).catch(() => {});
          }));
          await ctx.storage.set('backupDirectory', destination);
          await reply({ type: 'backupDone', path: snapshot.path, count: snapshot.documentCount,
            missing: snapshot.missingSources.length, backupDirectory: destination });
          break;
        }
        case 'reveal': {
          const doc = await state.store.document(String(message.id ?? ''));
          if (!doc) throw new Error('Document no longer exists.');
          await revealFile(doc.path);
          await reply({ type: 'revealed' });
          break;
        }
      }
    } catch (error) {
      if (message.type?.startsWith('upload')) { await uploads.get(panel)?.abort(); releaseUpload(panel); }
      await reply({ type: 'error', error: errorText(error) });
    }
  }

  ctx.subscriptions.push(ctx.ui.onDidOpenPanel((panel) => {
    if (panel.view !== 'appView') return;
    panels.add(panel);
    if (bound.has(panel)) return;
    bound.add(panel);
    ctx.subscriptions.push(
      panel.onDidReceiveMessage((message) => handle(panel, message)),
      panel.onDidDispose(() => { panels.delete(panel); releaseUpload(panel); void uploads.get(panel)?.abort(); uploads.delete(panel); }),
    );
  }));

  async function findTag(value: string): Promise<{ id: string; name: string; count: number }> {
    const requested = value.trim();
    if (!requested) throw new Error(t('tool.tagRequired'));
    const tags = await state.store.tags();
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
    if (entry.status !== 'running' && !state.running) void environment.install().catch(() => {});
    const installing = entry.status === 'running' || state.running;
    throw new Error(t(installing ? 'import.engineInstalling' : 'import.engineMissing', {
      name: t(step === 'ocr' ? 'engine.ocr' : 'engine.anydoc'),
    }));
  }

  /** A page title has to survive as a file name on every platform. */
  function articleFileName(title: string, fallback: string): string {
    const cleaned = title
      .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\.+$/, '')
      .slice(0, 120)
      .trim();
    return `${cleaned || fallback}.md`;
  }

  /** Writes Markdown into the library's managed copies and indexes it, the same path a file import takes. */
  async function storeArticle(name: string, markdown: string, tagId: string): Promise<{ id: string; chunks: number }> {
    const target = await state.store.uploadTarget(tagId, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, markdown, 'utf8');
    const indexed = await state.store.importFile(target, name, tagId);
    return { id: indexed.document.id, chunks: indexed.document.chunks };
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
        action: { type: 'string', enum: ['search', 'tags', 'documents', 'library', 'environment', 'import', 'sync', 'import_url', 'save_document', 'create_tag', 'rename_tag', 'delete_tag', 'tag_document', 'untag_document'], description: 'Operation. Defaults to search for backwards compatibility.' },
        query: { type: 'string', description: 'Search question or keywords (search only).' },
        tag: { type: 'string', description: 'Tag name or id: search/documents filter; rename_tag and delete_tag target; tag_document/import/import_url destination. A missing tag is created for import. Omit for all tags in search/documents, or Unclassified when importing.' },
        name: { type: 'string', description: 'New tag name (create_tag or rename_tag). Renaming is how a tag is edited — its name is the only field it has.' },
        force: { type: 'boolean', description: 'delete_tag: required to remove a tag that still holds documents. The documents are never deleted and keep their other tags; one that had only this tag lands in Unclassified. The retry keeps a batch from being re-filed by accident.' },
        documentId: { type: 'string', description: 'Document ID from documents/search (tag_document, untag_document).' },
        path: { type: 'string', description: 'import: one file or one folder inside the current workspace, absolute or relative to the session directory. A folder is read recursively.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'import: several files and/or folders in one call. Every entry lands in the tag given by `tag`.' },
        items: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, tag: { type: 'string' } }, required: ['path'] }, description: 'import: per-file destinations, for classifying a batch yourself — read the files, then send each one with the tag it belongs to. Overrides `tag`. Example: [{"path":"a/合同.pdf","tag":"合同"},{"path":"b/发票.pdf","tag":"发票"}].' },
        recursive: { type: 'boolean', description: 'import: read subfolders too (default true). Set false to read only the folder itself.' },
        url: { type: 'string', description: 'Article URL to fetch (import_url), or the origin of content being saved (save_document).' },
        refine: { type: 'boolean', description: 'import_url only: return the extracted text instead of indexing it, so it can be cleaned up and stored with save_document. Use it when the first attempt was flagged as suspect.' },
        title: { type: 'string', description: 'Document title, used as the file name (save_document).' },
        content: { type: 'string', description: 'Markdown body to store and index (save_document).' },
        offset: { type: 'number', description: 'Document list offset (documents; default 0).' },
        limit: { type: 'number', description: 'Maximum passages (1–20) or documents (1–50).' },
      },
    },
    async execute(input, exec) {
      try {
        await ready;
        const action = input.action ?? 'search';
        if (action === 'library') {
          const info = await libraryInfo();
          return result(t('tool.libraryEntry', { root: String(info.root), documents: Number(info.documents), tags: Number(info.tags) }) +
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
        if (action === 'import_url' || action === 'save_document') {
          const tag = typeof input.tag === 'string' && input.tag.trim()
            ? await findTag(input.tag) : { id: DEFAULT_TAG, name: t('tool.uncategorized') };
          if (action === 'save_document') {
            const title = typeof input.title === 'string' ? input.title.trim() : '';
            const content = typeof input.content === 'string' ? input.content.trim() : '';
            if (!title || !content) return result(t('tool.documentRequired'), true);
            const name = articleFileName(title, t('tool.untitledArticle'));
            const source = typeof input.url === 'string' && input.url.trim() ? `${t('tool.articleSource')}: ${normalizeUrl(input.url)}\n\n` : '';
            const saved = await gate.write(() => storeArticle(name, `${source}${content}`, tag.id));
            await broadcast();
            return result(t('tool.documentSaved', { name, tag: tag.name, chunks: saved.chunks, id: saved.id }));
          }
          const requested = typeof input.url === 'string' ? input.url.trim() : '';
          if (!requested) return result(t('tool.urlRequired'), true);
          const refine = input.refine === true;
          let article;
          try {
            article = await fetchArticle(requested);
          } catch (error) {
            if (!(error instanceof ArticleUnreachableError)) throw error;
            // Node's fetch ignores the system proxy, so this is a common failure with an easy way out.
            return result([
              t('tool.urlUnreachable', { url: error.url, reason: error.reason }),
              t('tool.urlManualHint'),
            ].join('\n'), true);
          }
          if (refine) {
            // Hand the raw extraction back for cleanup without indexing it yet.
            const body = article.markdown.slice(0, 60_000);
            return result([
              t('tool.urlRefine', { title: article.title || t('tool.untitledArticle'), url: article.url, length: article.length }),
              ...(article.reason ? [t('tool.urlSuspect', { reason: article.reason })] : []),
              '',
              '```markdown',
              body,
              '```',
            ].join('\n'));
          }
          const name = articleFileName(article.title, t('tool.untitledArticle'));
          const saved = await gate.write(() => storeArticle(name, `${t('tool.articleSource')}: ${article.url}\n\n${article.markdown}`, tag.id));
          await broadcast();
          return result([
            t('tool.urlFetched', { name, tag: tag.name, chars: article.length, chunks: saved.chunks, id: saved.id, url: article.url }),
            ...(article.suspect ? [t('tool.urlSuspect', { reason: article.reason ?? t('environment.unknownFailure') }), t('tool.urlRefineHint', { url: article.url })] : []),
          ].join('\n'));
        }
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
          const tag = await findTag(typeof input.tag === 'string' ? input.tag : '');
          const name = typeof input.name === 'string' ? input.name.trim() : '';
          await gate.write(() => state.store.renameTag(tag.id, name));
          await broadcast();
          return result(t('tool.tagRenamed', { name, id: tag.id }));
        }
        if (action === 'delete_tag') {
          const tag = await findTag(typeof input.tag === 'string' ? input.tag : '');
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
          const tag = await findTag(typeof input.tag === 'string' ? input.tag : '');
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
          const outcome = await syncSources(
            (message, percent) => exec.progress?.report({ message, percent }),
            exec.signal,
          );
          const lines = [t('tool.syncDone', {
            updated: outcome.updated.length, removed: outcome.removed.length, unchanged: outcome.unchanged,
          })];
          if (outcome.updated.length) lines.push(t('tool.syncUpdated', { list: outcome.updated.join(' · ') }));
          if (outcome.removed.length) lines.push(t('tool.syncRemoved', { list: outcome.removed.join(' · ') }));
          if (outcome.unreachable.length) lines.push(t('tool.syncUnreachable', { list: outcome.unreachable.join(' · ') }));
          if (outcome.failed.length) {
            lines.push(t('tool.syncFailed', {
              count: outcome.failed.length,
              list: outcome.failed.map((item) => t('tool.importFailureLine', { path: item.name, reason: item.reason })).join('\n'),
            }));
          }
          if (!outcome.updated.length && !outcome.removed.length && !outcome.unreachable.length) lines.push(t('tool.syncNothing'));
          return result(lines.join('\n'), outcome.failed.length > 0);
        }
        if (action === 'import') {
          if (!exec?.cwd) return result(t('tool.workspaceRequired'), true);
          const requests = readImportRequests(input);
          if (!requests.length) return result(t('tool.fileRequired'), true);
          const expanded = await expandImportTargets(exec.cwd, requests, { recursive: input.recursive !== false });
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
              const outcome = await gate.write(() => importFromWorkspace(state.root, state.store, exec.cwd!, target.path, tag.id,
                (received, total) => {
                  const percent = Math.floor(((index + received / total) / expanded.targets.length) * 100);
                  const position = expanded.targets.length > 1 ? ` · ${index + 1}/${expanded.targets.length}` : '';
                  exec.progress?.report({ message: t('progress.copying', { name: target.name, percent }) + position, percent });
                }, exec.signal));
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
        if (typeof input.tag === 'string' && input.tag.trim()) tagId = (await findTag(input.tag)).id;
        if (action === 'documents') {
          const offset = typeof input.offset === 'number' && Number.isFinite(input.offset) ? input.offset : 0;
          const limit = typeof input.limit === 'number' && Number.isFinite(input.limit) ? input.limit : 50;
          await reconcileMissing();
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
      } catch (error) {
        return result(errorText(error), true);
      }
    },
  }));
}

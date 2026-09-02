import type * as finch from 'finch';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { type DocumentState, type EditSpec, applyEditSpecs, documentTitle, preserveTextEnvelope } from './document.js';
import { cancelPendingDraftWrite, deleteDraft, flushPendingDraftWrite, readFileWithDraft, scheduleDraftWrite } from './drafts.js';
import { renderWithBm } from './renderer.js';


interface RecentDocument {
  path: string;
  relativePath: string;
  fileName: string;
  title: string;
  preview: string;
  modifiedAt: number;
  spaceId?: string;
  spaceName?: string;
  /** User-facing Space name; workspace/other labels localize in the panel. */
  scopeLabel?: string;
  scopeKind?: 'space' | 'workspace' | 'external';
}

interface PanelMessage {
  type: string;
  path?: string;
  markdown?: string;
  base?: string;
  title?: string;
  markdownStyle?: string;
  customCss?: string;
  requestId?: number;
  itemId?: string;
  patch?: { label?: string; icon?: string; tooltip?: string; disabled?: boolean; checked?: boolean };
  toolbar?: finch.AppPanelToolbarItem[];
  message?: string;
  data?: string;
  ext?: string;
  fileName?: string;
  slot?: number;
  css?: string;
  label?: string;
  mimeType?: string;
  urls?: string[];
  url?: string;
  cwd?: string;
  sessionId?: string;
  spaceId?: string;
  requirement?: string;
  selectedText?: string;
  startLine?: number;
  endLine?: number;
  rewriteMode?: 'replace' | 'continue';
  baseStyle?: string;
}

// Pasted-image extension → file extension. Kept tiny and explicit rather
// than a generic mime-type library dependency.
const PASTE_IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
};
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
};
const MAX_CLIPBOARD_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;

// Convert only this mini tool's own pasted-image assets to data URLs for a
// clipboard payload. This deliberately validates real (symlink-resolved)
// paths, so Markdown cannot use a `finch-file:` URL as an arbitrary local
// file read primitive.
async function readClipboardImageDataUrls(ctx: finch.MiniToolContext, urls: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const assetsRoot = await realpath(path.join(ctx.storagePath, 'assets'));
  for (const originalUrl of urls.slice(0, 30)) {
    try {
      const parsed = new URL(originalUrl);
      const requested = parsed.protocol === 'finch-file:' && parsed.hostname === 'local'
        ? parsed.searchParams.get('path') : null;
      if (!requested) continue;
      const target = await realpath(requested);
      const relative = path.relative(assetsRoot, target);
      const mimeType = IMAGE_MIME_BY_EXT[path.extname(target).toLowerCase()];
      if ((!relative || (!relative.startsWith('..' + path.sep) && relative !== '..')) && mimeType) {
        const info = await stat(target);
        if (info.size > MAX_CLIPBOARD_INLINE_IMAGE_BYTES) continue;
        result[originalUrl] = `data:${mimeType};base64,${(await readFile(target)).toString('base64')}`;
      }
    } catch {
      // Missing/unreadable assets are simply left as their original src.
    }
  }
  return result;
}

// Mirrors Finch Delivery: the native preview receives the original absolute
// file path directly. Do not resolve/canonicalize it through URL or realpath
// again here—the Panel has already decoded `finch-file://local?path=...`.
async function openLocalImagePreview(ctx: finch.MiniToolContext, filePath: string): Promise<void> {
  if (!path.isAbsolute(filePath) || !IMAGE_MIME_BY_EXT[path.extname(filePath).toLowerCase()]) {
    throw new Error('Unsupported local image file.');
  }
  await ctx.ui.openFilePreview(filePath);
}

async function openMarkdownImagePreview(ctx: finch.MiniToolContext, rawUrl: string): Promise<void> {
  const url = new URL(rawUrl);
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    await ctx.browser.open(url.href);
    return;
  }
  throw new Error(`Unsupported image URL: ${url.protocol}`);
}

interface StyleSlot {
  css: string;
  label: string;
}

const STYLE_SLOT_COUNT = 3;

function result(message: string, isError = false): finch.ToolResult {
  return { content: [{ type: 'text', text: message }], isError };
}

// Remember the last successfully opened file, so the user doesn't have to
// re-open it by hand every time. The primary key is panel.id: each Panel scope
// gets its own stable instance, including different Space Home scopes, and a
// Home → Session relocation preserves the same id. Older session/global keys
// remain readable for migration.
/** In-flight AI-style-design turn, mirrors RewriteOperation — restored on
 * panelReady so the wand icon's loading spinner survives a panel
 * destroy/rebind while the Agent Session is still working. */
interface StyleOperation {
  sessionId: string;
  turnId: string;
  startedAt: number;
}

/** A style `set_style` produced but that hasn't been saved to a reusable
 * slot yet. Persisted per-path so it survives the user navigating away
 * (or the App View panel getting destroyed) before they get a chance to
 * see the "save as style N" prompt — restored the next time that document's
 * panel reconnects. Cleared once the user saves any slot for that file. */
interface PendingStyle {
  css: string;
  label: string;
}

interface RewriteOperation {
  sessionId: string;
  turnId: string;
  startLine?: number;
  endLine?: number;
  rewriteMode: 'continue' | 'replace';
  startedAt: number;
}

interface LastPathState {
  /** @deprecated Global pre-0.1.8 list; read only for one-time migration. */
  recentPaths?: string[];
  /** Latest real cwd from a no-Space Agent Session; Home uses it only while the app omits cwd. */
  homePath?: string;
  /** Recent Markdown paths, deduplicated newest-first within a real cwd scope. */
  recentPathsByScope?: Record<string, string[]>;
  /** Last known recent-list scope for each live/rebindable Panel. */
  panelRecentScopes?: Record<string, string>;
  /** Per-Panel last-opened path. A Panel id stays stable for its scope and also follows Home → Session relocation. */
  panels?: Record<string, string>;
  /** @deprecated Pre-0.8 per-Session state, retained as a read fallback. */
  sessions?: Record<string, string>;
  /** @deprecated Legacy pre-0.6 global value; still read as a fallback for the '__global__' bucket. */
  lastPath?: string;
  /** Per-file rewrite Session id, so successive rewrites reuse one conversation. */
  rewriteSessions?: Record<string, string>;
  /** Per-file AI-style-design Session id (AppView only), mirrors rewriteSessions. */
  styleSessions?: Record<string, string>;
  /** In-flight AI turns, retained across a panel destroy/rebind so the new
   * page can restore its loading range and completion state. */
  rewriteOperations?: Record<string, RewriteOperation>;
  /** In-flight AI-style-design turns, mirrors rewriteOperations. */
  styleOperations?: Record<string, StyleOperation>;
  /** Per-file style design that's been applied to the preview but not yet
   * saved to a slot — see PendingStyle. */
  pendingStyles?: Record<string, PendingStyle>;
}

function stateFile(ctx: finch.MiniToolContext): string {
  return path.join(ctx.storagePath, 'state.json');
}

// Deliberately GLOBAL to the whole mini tool (one file in ctx.storagePath),
// not scoped per Panel/Session — an AI-designed style is meant to be
// reusable across different articles and different editor windows, not
// thrown away the moment this particular panel reloads (which is what
// happened before: the CSS only ever lived in an in-memory `customCss`
// variable inside panel.html).
function styleSlotsFile(ctx: finch.MiniToolContext): string {
  return path.join(ctx.storagePath, 'style-slots.json');
}

function normalizeStyleSlots(raw: unknown): (StyleSlot | null)[] {
  const arr = Array.isArray(raw) ? raw : [];
  const slots: (StyleSlot | null)[] = [];
  for (let i = 0; i < STYLE_SLOT_COUNT; i++) {
    const item = arr[i];
    if (item && typeof item === 'object' && typeof (item as StyleSlot).css === 'string') {
      slots.push({ css: (item as StyleSlot).css, label: String((item as StyleSlot).label ?? '自定义风格') });
    } else {
      slots.push(null);
    }
  }
  return slots;
}

async function readStyleSlots(ctx: finch.MiniToolContext): Promise<(StyleSlot | null)[]> {
  try {
    const raw = await readFile(styleSlotsFile(ctx), 'utf8');
    return normalizeStyleSlots(JSON.parse(raw));
  } catch {
    return normalizeStyleSlots([]);
  }
}

async function writeStyleSlot(ctx: finch.MiniToolContext, slot: number, value: StyleSlot): Promise<(StyleSlot | null)[]> {
  const slots = await readStyleSlots(ctx);
  slots[slot] = value;
  await mkdir(ctx.storagePath, { recursive: true });
  await writeFile(styleSlotsFile(ctx), JSON.stringify(slots), 'utf8');
  return slots;
}

function sessionBucketKey(panel: finch.AppPanel): string {
  return panel.sessionId || '__global__';
}

async function readLastPathState(ctx: finch.MiniToolContext): Promise<LastPathState> {
  try {
    const raw = await readFile(stateFile(ctx), 'utf8');
    return JSON.parse(raw) as LastPathState;
  } catch {
    return {};
  }
}

interface RecentScopeResolution {
  /** The real cwd key used for storage, if one is available. */
  scope?: string;
  /** The cwd a no-cwd Home panel should display as its fallback. */
  fallbackCwd?: string;
}

function resolveRecentScope(state: LastPathState, cwd: string, sessionId: string, spaceId: string): RecentScopeResolution {
  if (path.isAbsolute(cwd)) {
    // A real ordinary Chat Session establishes the path Home must use while
    // the app is still omitting cwd for its pre-session Home view.
    if (sessionId && !spaceId) state.homePath = cwd;
    return { scope: cwd };
  }
  if (!cwd && !sessionId && !spaceId && path.isAbsolute(state.homePath ?? '')) {
    return { scope: state.homePath, fallbackCwd: state.homePath };
  }
  return {};
}

function addRecentPath(state: LastPathState, scope: string, sourcePath: string): void {
  const existing = state.recentPathsByScope?.[scope] ?? [];
  state.recentPathsByScope = {
    ...state.recentPathsByScope,
    [scope]: [sourcePath, ...existing]
      .filter((value, index, values) => path.isAbsolute(value) && values.indexOf(value) === index)
      .slice(0, 50),
  };
}

function pathBelongsTo(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function resolveDocumentScope(ctx: finch.MiniToolContext, sourcePath: string, fallbackCwd?: string): Promise<{ scope: string; spaceId?: string; spaceName?: string; scopeLabel?: string; scopeKind: 'space' | 'workspace' | 'external' }> {
  const spaces = await ctx.spaces.list().catch(() => []);
  const matches = spaces
    .filter((space) => path.isAbsolute(space.directoryPath ?? '') && pathBelongsTo(space.directoryPath!, sourcePath))
    .sort((a, b) => (b.directoryPath?.length ?? 0) - (a.directoryPath?.length ?? 0));
  const space = matches[0];
  if (space?.directoryPath) {
    // `name` is Finch's user-facing display name (unlike directoryPath).
    // Prefer it over the directory basename; alias is only a fallback for
    // legacy/imported entries that may lack a normal display name.
    const spaceName = space.name || space.alias || path.basename(space.directoryPath);
    return { scope: space.directoryPath, spaceId: space.id, spaceName, scopeLabel: spaceName, scopeKind: 'space' };
  }
  const workspaceRoot = ctx.workspace.projectPath;
  if (workspaceRoot && pathBelongsTo(workspaceRoot, sourcePath)) {
    return { scope: workspaceRoot, scopeKind: 'workspace' };
  }
  // AppView Home can have no live cwd, so it falls back to homePath. That
  // fallback is still a real working directory, not an external location.
  if (fallbackCwd && path.isAbsolute(fallbackCwd) && pathBelongsTo(fallbackCwd, sourcePath)) {
    return { scope: fallbackCwd, scopeKind: 'workspace' };
  }
  return { scope: path.dirname(sourcePath), scopeKind: 'external' };
}

/** Records the panel's actual finch:env scope and migrates its current file
 * into that scope. This handles opens/creates that happened just before the
 * panel received its first env push. */
async function rememberPanelRecentScope(ctx: finch.MiniToolContext, panel: finch.AppPanel, cwd: string, sessionId: string, spaceId: string): Promise<RecentScopeResolution> {
  try {
    await mkdir(ctx.storagePath, { recursive: true });
    const state = await readLastPathState(ctx);
    const resolved = resolveRecentScope(state, cwd, sessionId, spaceId);
    if (resolved.scope) {
      state.panelRecentScopes = { ...state.panelRecentScopes, [panel.id]: resolved.scope };
      const panelPath = state.panels?.[panel.id];
      if (panelPath) addRecentPath(state, resolved.scope, panelPath);
    }
    await writeFile(stateFile(ctx), JSON.stringify(state), 'utf8');
    return resolved;
  } catch (error) {
    ctx.logger.warn(`Could not persist panel recent scope: ${String(error)}`);
    return {};
  }
}

async function rememberLastPath(ctx: finch.MiniToolContext, panel: finch.AppPanel, sourcePath: string): Promise<void> {
  try {
    await mkdir(ctx.storagePath, { recursive: true });
    const state = await readLastPathState(ctx);
    state.panels = { ...state.panels, [panel.id]: sourcePath };
    // Keep the previous shape warm for downgrade compatibility, but always
    // prefer the Panel id on reads so Home scopes in different Spaces cannot
    // overwrite one shared '__global__' bucket.
    state.sessions = { ...state.sessions, [sessionBucketKey(panel)]: sourcePath };
    let scope = state.panelRecentScopes?.[panel.id];
    if (!scope && panel.view === 'appView') {
      scope = (await resolveDocumentScope(ctx, sourcePath)).scope;
      state.panelRecentScopes = { ...state.panelRecentScopes, [panel.id]: scope };
    }
    if (scope) addRecentPath(state, scope, sourcePath);
    await writeFile(stateFile(ctx), JSON.stringify(state), 'utf8');
  } catch (error) {
    ctx.logger.warn(`Could not persist last-opened path: ${String(error)}`);
  }
}

/** Lightweight sibling of `rememberLastPath` for AI `apply` writes without
 * a Panel. Its true Session cwd is the key when available; a no-cwd Home
 * write waits for a real ordinary Session to establish homePath first. */
async function rememberRecentPath(ctx: finch.MiniToolContext, sourcePath: string, panel?: finch.AppPanel): Promise<void> {
  try {
    await mkdir(ctx.storagePath, { recursive: true });
    const state = await readLastPathState(ctx);
    const scope = panel
      ? state.panelRecentScopes?.[panel.id]
      : resolveRecentScope(state, ctx.session.cwd ?? '', ctx.session.id ?? '', ctx.session.spaceId ?? '').scope;
    if (scope) addRecentPath(state, scope, sourcePath);
    await writeFile(stateFile(ctx), JSON.stringify(state), 'utf8');
  } catch (error) {
    ctx.logger.warn(`Could not persist recent path: ${String(error)}`);
  }
}

async function readLastPath(ctx: finch.MiniToolContext, panel: finch.AppPanel): Promise<string | undefined> {
  const state = await readLastPathState(ctx);
  const perPanel = state.panels?.[panel.id];
  if (typeof perPanel === 'string') return perPanel;
  const key = sessionBucketKey(panel);
  const perSession = state.sessions?.[key];
  if (typeof perSession === 'string') return perSession;
  // Legacy fallback: pre-0.6 versions stored one global lastPath with no
  // per-session bucketing — only honor it for the global bucket so an old
  // value doesn't leak into an unrelated Session.
  if (key === '__global__' && typeof state.lastPath === 'string') return state.lastPath;
  return undefined;
}

const RECENT_LIMIT = 50;
const RECENT_PREVIEW_CHARS = 220;

function isMarkdownPath(filePath: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(filePath);
}

/** First ATX heading, else first non-empty line, as the card title. */
function deriveTitle(markdown: string, fallback: string): string {
  for (const line of markdown.split('\n', 60)) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*\S)\s*$/);
    if (heading) return heading[1].slice(0, 80);
  }
  for (const line of markdown.split('\n', 60)) {
    const text = line.trim();
    if (text) return text.replace(/^[>*\-+\s]+/, '').slice(0, 80) || fallback;
  }
  return fallback;
}

/** Plain-ish excerpt for the card body — enough to recognize the document. */
function derivePreview(markdown: string): string {
  return markdown
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[*_`>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, RECENT_PREVIEW_CHARS);
}

/**
 * Markdown files this editor has actually opened or created, narrowed to the
 * panel's own working directory and ordered by the file's current mtime — so
 * the Home card list doubles as "where I left off", and a document edited
 * elsewhere still floats back to the top.
 *
 * `requestedCwd` is whatever the page's own `finch:env` handed back — for a
 * real Session panel that's always the session's cwd, but for a Home panel
 * (`view === 'home'`) the platform may hand back an empty string (see
 * `AppPanelEnvMessage.cwd`'s own doc comment).
 *
 * A Home panel with no cwd/session/Space falls back to the persisted
 * `homePath`: the last real cwd observed from an ordinary no-Space Session.
 * That makes Home and normal chat use the same real cwd key. Do NOT use
 * `ctx.workspace` here: it is shared across the whole mini tool process and
 * can point at an unrelated Space/chat.
 */
async function collectRecentDocuments(ctx: finch.MiniToolContext, requestedCwd: string, sessionId: string, spaceId: string): Promise<{ documents: RecentDocument[]; fallbackCwd?: string }> {
  const cwd = requestedCwd;
  const state = await readLastPathState(ctx);
  const resolved = resolveRecentScope(state, cwd, sessionId, spaceId);
  if (!resolved.scope) return { documents: [] };
  const scope = resolved.scope;
  const candidates = (state.recentPathsByScope?.[scope] ?? [])
    .filter((value, index, values) =>
      typeof value === 'string' &&
      path.isAbsolute(value) &&
      isMarkdownPath(value) &&
      values.indexOf(value) === index,
    );

  const documents = await Promise.all(
    candidates.map(async (filePath): Promise<RecentDocument | undefined> => {
      try {
        const info = await stat(filePath);
        if (!info.isFile()) return undefined;
        const markdown = await readFile(filePath, 'utf8');
        const fileName = path.basename(filePath);
        return {
          path: filePath,
          relativePath: path.relative(scope, filePath),
          fileName,
          title: deriveTitle(markdown, fileName.replace(/\.[^.]+$/, '')),
          preview: derivePreview(markdown),
          modifiedAt: info.mtimeMs,
        };
      } catch {
        // Deleted, renamed or unreadable — silently drop from the list.
        return undefined;
      }
    }),
  );

  return {
    documents: documents
      .filter((entry): entry is RecentDocument => Boolean(entry))
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
      .slice(0, RECENT_LIMIT),
    fallbackCwd: resolved.fallbackCwd,
  };
}

async function collectLibraryDocuments(ctx: finch.MiniToolContext): Promise<RecentDocument[]> {
  const state = await readLastPathState(ctx);
  const candidates = Object.values(state.recentPathsByScope ?? {}).flat()
    .concat(Object.values(state.panels ?? {}))
    .filter((value, index, values) => path.isAbsolute(value) && isMarkdownPath(value) && values.indexOf(value) === index);
  const documents = await Promise.all(candidates.map(async (filePath): Promise<RecentDocument | undefined> => {
    try {
      const [info, markdown, scope] = await Promise.all([stat(filePath), readFile(filePath, 'utf8'), resolveDocumentScope(ctx, filePath, state.homePath)]);
      if (!info.isFile()) return undefined;
      const fileName = path.basename(filePath);
      return {
        path: filePath,
        relativePath: path.relative(scope.scope, filePath),
        fileName,
        title: deriveTitle(markdown, fileName.replace(/\.[^.]+$/, '')),
        preview: derivePreview(markdown),
        modifiedAt: info.mtimeMs,
        spaceId: scope.spaceId,
        spaceName: scope.spaceName,
        scopeLabel: scope.scopeLabel,
        scopeKind: scope.scopeKind,
      };
    } catch {
      return undefined;
    }
  }));
  return documents.filter((entry): entry is RecentDocument => Boolean(entry))
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
    .slice(0, RECENT_LIMIT);
}

// The document currently being delivered to each live Panel. This is
// deliberately in-memory only: Home must start document-neutral on a later
// open, but a Home panel that is still loading/rebinding must not lose a
// document an AI just created or opened before the page announced `panelReady`.
const livePanelDocuments = new Map<string, DocumentState>();
const openPanels = new Map<string, finch.AppPanel>();
// Every path delivery gets a monotonic revision. A page may receive late
// watcher/rebind messages, so the guest uses this to ignore an older snapshot
// that finishes after a newer write has already been delivered.
const fileRevisions = new Map<string, number>();

function nextFileRevision(sourcePath: string): number {
  const next = (fileRevisions.get(sourcePath) ?? 0) + 1;
  fileRevisions.set(sourcePath, next);
  return next;
}

async function sendDocument(panel: finch.AppPanel, state: DocumentState): Promise<void> {
  const revision = state.path && path.isAbsolute(state.path)
    ? (state.revision ?? nextFileRevision(state.path))
    : state.revision;
  const delivered = revision === undefined ? state : { ...state, revision };
  livePanelDocuments.set(panel.id, delivered);
  await panel.postMessage({ type: 'document', ...delivered });
}

/** Publish a known successful file write directly to every live panel that
 * has that exact path open. This is the primary AI-write sync path; fs.watch
 * remains only a fallback for writes originating outside this mini tool. */
async function publishFileUpdate(ctx: finch.MiniToolContext, sourcePath: string): Promise<void> {
  const markdown = await readFile(sourcePath, 'utf8');
  const revision = nextFileRevision(sourcePath);
  const state: DocumentState = { path: sourcePath, markdown, title: documentTitle(markdown, sourcePath), revision };
  const targets = Array.from(openPanels.values()).filter((panel) => livePanelDocuments.get(panel.id)?.path === sourcePath);
  await Promise.all(targets.map((panel) => sendDocument(panel, state).catch((error) => {
    ctx.logger.warn(`Could not deliver written file to panel ${panel.id}: ${String(error)}`);
  })));
}

/** Sends whatever this panel currently has cached in memory — but re-reads
 * it through `readFileWithDraft` first when it points at a real file. The
 * cache exists to survive a page reload/rebind racing an AI's `open`/
 * `create` push landing on this very panel before `panelReady` arrives; by
 * the time this panel *reconnects* (rather than freshly loads), our own
 * draft-write debounce or an external edit may well have moved on from
 * whatever markdown was cached at push time, so blindly resending the
 * cached copy could paper right over an unsaved draft that exists now.
 * A document with no `path` yet (unsaved, brand new) has nothing to
 * re-read and is sent as-is. */
async function sendLiveDocument(ctx: finch.MiniToolContext, panel: finch.AppPanel, liveDocument: DocumentState): Promise<void> {
  if (liveDocument.path && path.isAbsolute(liveDocument.path)) {
    try {
      const { markdown, diskMarkdown, draftRestored, draftConflict } = await readFileWithDraft(ctx, liveDocument.path);
      // A reconnect re-read may observe a newer disk write than the cached
      // delivery. Drop the cached revision so sendDocument mints a fresh one.
      await sendDocument(panel, { ...liveDocument, revision: undefined, markdown, title: documentTitle(markdown, liveDocument.path), draftRestored, draftConflict, diskMarkdown });
      return;
    } catch (error) {
      ctx.logger.warn(`Could not re-read ${liveDocument.path} for a reconnecting panel, resending cached copy: ${String(error)}`);
    }
  }
  await sendDocument(panel, liveDocument);
}

function payloadPath(panel: finch.AppPanel): string | undefined {
  const payload = panel.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const value = (payload as { path?: unknown }).path;
  return typeof value === 'string' && path.isAbsolute(value) ? value : undefined;
}

/** Restore only after the guest has announced that its message listener is
 * installed. Prefer persisted per-Panel state; the retained opening payload
 * covers a tool's first-open race before persistence completes. */
async function restoreDocument(ctx: finch.MiniToolContext, panel: finch.AppPanel): Promise<boolean> {
  // Home is document-neutral, but the application-level App View is a stable
  // writing workspace and restores its own last document by panel id.
  if (!panel.sessionId && panel.view !== 'appView') return false;
  // Persisted state wins after the user opens a different file from inside an
  // existing single-instance panel; payload is the first-open race fallback.
  const sourcePath = await readLastPath(ctx, panel) ?? payloadPath(panel);
  if (!sourcePath) return false;
  try {
    const { markdown, diskMarkdown, draftRestored, draftConflict } = await readFileWithDraft(ctx, sourcePath);
    watchSource(ctx, panel, sourcePath);
    await rememberLastPath(ctx, panel, sourcePath);
    await sendDocument(panel, { path: sourcePath, markdown, title: documentTitle(markdown, sourcePath), draftRestored, draftConflict, diskMarkdown });
    return true;
  } catch (error) {
    ctx.logger.warn(`Could not restore ${sourcePath}: ${String(error)}`);
    return false;
  }
}

// Debounce timer lives alongside the watcher (not as a bare closure local)
// so stopWatching() can cancel an *already-scheduled* refresh, not just stop
// future fs events. Without this, closing the FSWatcher right after our own
// saveMarkdown write (e.g. the "save and return to Home" flow) still left a
// pending 150ms timer armed — it fired anyway and pushed the document right
// back onto a panel that had just reset to the Home screen.
interface SourceWatch { watcher: FSWatcher; timer?: ReturnType<typeof setTimeout>; }
const panelWatchers = new Map<string, SourceWatch>();
let lastPanel: finch.AppPanel | undefined;

function stopWatching(panelId: string): void {
  const entry = panelWatchers.get(panelId);
  if (entry) {
    entry.watcher.close();
    if (entry.timer) clearTimeout(entry.timer);
  }
  panelWatchers.delete(panelId);
}

function watchSource(ctx: finch.MiniToolContext, panel: finch.AppPanel, sourcePath: string): void {
  stopWatching(panel.id);
  try {
    const entry: SourceWatch = { watcher: undefined as unknown as FSWatcher };
    entry.watcher = watch(sourcePath, () => {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(async () => {
        // Snapshot the write revision before the asynchronous read. If an AI
        // write directly publishes newer content while this read is pending,
        // this older watcher callback must not later overwrite the panel.
        const revisionBeforeRead = fileRevisions.get(sourcePath) ?? 0;
        try {
          const markdown = await readFile(sourcePath, 'utf8');
          if (panelWatchers.get(panel.id) !== entry || (fileRevisions.get(sourcePath) ?? 0) !== revisionBeforeRead) return;
          await sendDocument(panel, { path: sourcePath, markdown, title: documentTitle(markdown, sourcePath) });
        } catch (error) {
          ctx.logger.warn(`Source refresh failed: ${String(error)}`);
          // The file the panel is watching just vanished (deleted, moved, or
          // its containing folder was removed) — surface this instead of
          // silently leaving the user editing a buffer with nowhere to save
          // back to. The panel keeps the in-memory buffer either way; this
          // is purely informational so a subsequent Save doesn't surprise
          // them by recreating a file at a now-unexpected path.
          const code = (error as NodeJS.ErrnoException)?.code;
          if (code === 'ENOENT') {
            await panel.postMessage({ type: 'sourceMissing', path: sourcePath }).catch(() => {});
          }
        }
      }, 150);
    });
    panelWatchers.set(panel.id, entry);
  } catch (error) {
    ctx.logger.warn(`Could not watch ${sourcePath}: ${String(error)}`);
  }
}

// The user's Finch assistant name ("帕亚", or the default "Finch"). Resolved
// once and reused for every `ready` payload so the empty-state copy can
// greet the user by their assistant's actual name without a round trip.
let cachedAssistantName: string | undefined;
async function getAssistantName(ctx: finch.MiniToolContext): Promise<string> {
  if (cachedAssistantName) return cachedAssistantName;
  try {
    cachedAssistantName = (await ctx.app.getInfo()).assistantName || 'Finch';
  } catch (error) {
    ctx.logger.warn(`Failed to resolve assistant name: ${String(error)}`);
    cachedAssistantName = 'Finch';
  }
  return cachedAssistantName;
}

async function sendReady(ctx: finch.MiniToolContext, panel: finch.AppPanel): Promise<void> {
  const pickFileSupported = ctx.api.supports('ui.pickFile');
  const styleSlots = await readStyleSlots(ctx);
  const assistantName = await getAssistantName(ctx);
  ctx.logger.info(`sending ready to panel; pickFileSupported = ${pickFileSupported}`);
  await panel.postMessage({
    type: 'ready', locale: ctx.i18n.locale, pickFileSupported, styleSlots, assistantName,
    // So the page can render `cwd` the OS-friendly way (`~/…`) without a
    // round trip — it never needs the raw value for anything but display.
    homeDir: os.homedir(),
  });
}

/** Reveal a path in the OS file manager (Finder / Explorer / the default file
 * manager on Linux). A file is revealed *and selected* in its containing
 * folder where the platform supports that (macOS `open -R`, Windows
 * `explorer /select,`); a directory is simply opened. Linux has no portable
 * "select this file" primitive, so a file there falls back to opening its
 * parent directory. Best-effort throughout: a missing/unsupported platform
 * tool just logs a warning, it never surfaces as a page-facing error. */
async function revealInFileManager(ctx: finch.MiniToolContext, targetPath: string): Promise<void> {
  try {
    const info = await stat(targetPath).catch(() => undefined);
    const isFile = info?.isFile() ?? false;
    if (process.platform === 'darwin') {
      spawn('open', isFile ? ['-R', targetPath] : [targetPath], { stdio: 'ignore', detached: true }).unref();
    } else if (process.platform === 'win32') {
      spawn('explorer', isFile ? [`/select,${targetPath}`] : [targetPath], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [isFile ? path.dirname(targetPath) : targetPath], { stdio: 'ignore', detached: true }).unref();
    }
  } catch (error) {
    ctx.logger.warn(`Could not open file manager for ${targetPath}: ${String(error)}`);
  }
}

async function readRewriteSession(ctx: finch.MiniToolContext, sourcePath: string): Promise<string | undefined> {
  const state = await readLastPathState(ctx);
  const id = state.rewriteSessions?.[sourcePath];
  if (!id) return undefined;
  // The persisted id may point at a deleted/archived Session — only reuse it
  // while it still resolves, otherwise fall through to creating a fresh one.
  const session = await ctx.sessions.get(id).catch(() => undefined);
  return session ? id : undefined;
}

async function rememberRewriteSession(ctx: finch.MiniToolContext, sourcePath: string, sessionId: string): Promise<void> {
  try {
    const state = await readLastPathState(ctx);
    state.rewriteSessions = { ...state.rewriteSessions, [sourcePath]: sessionId };
    await writeFile(stateFile(ctx), JSON.stringify(state), 'utf8');
  } catch (error) {
    ctx.logger.warn(`Could not persist rewrite session: ${String(error)}`);
  }
}

async function rememberStyleOperation(ctx: finch.MiniToolContext, sourcePath: string, operation: StyleOperation): Promise<void> {
  const state = await readLastPathState(ctx);
  state.styleOperations = { ...state.styleOperations, [sourcePath]: operation };
  await writeFile(stateFile(ctx), JSON.stringify(state), 'utf8');
}

async function clearStyleOperation(ctx: finch.MiniToolContext, sourcePath: string, turnId: string): Promise<void> {
  const state = await readLastPathState(ctx);
  if (state.styleOperations?.[sourcePath]?.turnId !== turnId) return;
  const operations = { ...state.styleOperations };
  delete operations[sourcePath];
  state.styleOperations = operations;
  await writeFile(stateFile(ctx), JSON.stringify(state), 'utf8');
}

async function rememberPendingStyle(ctx: finch.MiniToolContext, sourcePath: string, pending: PendingStyle): Promise<void> {
  const state = await readLastPathState(ctx);
  state.pendingStyles = { ...state.pendingStyles, [sourcePath]: pending };
  await writeFile(stateFile(ctx), JSON.stringify(state), 'utf8');
}

async function clearPendingStyle(ctx: finch.MiniToolContext, sourcePath: string): Promise<void> {
  const state = await readLastPathState(ctx);
  if (!state.pendingStyles?.[sourcePath]) return;
  const pending = { ...state.pendingStyles };
  delete pending[sourcePath];
  state.pendingStyles = pending;
  await writeFile(stateFile(ctx), JSON.stringify(state), 'utf8');
}

function findPanelsForPath(sourcePath: string): finch.AppPanel[] {
  return Array.from(openPanels.values()).filter((panel) => livePanelDocuments.get(panel.id)?.path === sourcePath);
}

async function rememberRewriteOperation(ctx: finch.MiniToolContext, sourcePath: string, operation: RewriteOperation): Promise<void> {
  const state = await readLastPathState(ctx);
  state.rewriteOperations = { ...state.rewriteOperations, [sourcePath]: operation };
  await writeFile(stateFile(ctx), JSON.stringify(state), 'utf8');
}

async function clearRewriteOperation(ctx: finch.MiniToolContext, sourcePath: string, turnId: string): Promise<void> {
  const state = await readLastPathState(ctx);
  if (state.rewriteOperations?.[sourcePath]?.turnId !== turnId) return;
  const operations = { ...state.rewriteOperations };
  delete operations[sourcePath];
  state.rewriteOperations = operations;
  await writeFile(stateFile(ctx), JSON.stringify(state), 'utf8');
}

async function notifyRewritePanels(sourcePath: string, message: Record<string, unknown>): Promise<void> {
  const targets = Array.from(openPanels.values()).filter((panel) => livePanelDocuments.get(panel.id)?.path === sourcePath);
  await Promise.all(targets.map((panel) => panel.postMessage(message).catch(() => {})));
}

async function startRewriteSession(ctx: finch.MiniToolContext, panel: finch.AppPanel, message: PanelMessage): Promise<void> {
  const sourcePath = String(message.path ?? '').trim();
  const selectedText = String(message.selectedText ?? '').trim();
  // 'continue' comes from a right-click with no selection: the user wants the
  // AI to write new content after a specific line rather than rewrite one.
  const rewriteMode = message.rewriteMode === 'continue' ? 'continue' : 'replace';
  const requirement = String(message.requirement ?? '').trim()
    || (rewriteMode === 'continue' ? '自然地承接上下文继续写作' : '让表达更清晰、自然，并保持原意');
  const hasTarget = rewriteMode === 'continue' ? !!message.startLine : !!selectedText;
  if (panel.view !== 'appView' || !path.isAbsolute(sourcePath) || !hasTarget) {
    await panel.postMessage({ type: 'rewriteSessionFailed', message: '改写需要 App View 中已保存的本地文档和选中文本或续写位置。' });
    return;
  }
  const scope = await resolveDocumentScope(ctx, sourcePath);
  // Successive rewrites of the same file reuse one persistent conversation so
  // the session accumulates context instead of restarting from scratch.
  let sessionId = await readRewriteSession(ctx, sourcePath);
  if (!sessionId) {
    const session = await ctx.sessions.create({
      ...(scope.spaceId ? { space: { spaceId: scope.spaceId } } : {}),
      title: `改写：${path.basename(sourcePath)}`,
      activity: 'interactive',
      permissionMode: 'acceptCalls',
    });
    sessionId = session.sessionId;
    await rememberRewriteSession(ctx, sourcePath, sessionId);
  }
  const lineText = message.startLine
    ? `位置：第 ${message.startLine}${message.endLine && message.endLine !== message.startLine ? `–${message.endLine}` : ''} 行。`
    : '';
  // Continue mode is summoned from an EMPTY line (the writer pressed space
  // on a blank line to ask for AI text right there) — the new content
  // belongs ON that line, replacing its emptiness, not inserted as a new
  // line after it. Telling the model to "insert after line N" would leave
  // the blank line N in place and push the new text down to N+1, which
  // reads as the AI having continued on the wrong line.
  const prompt = rewriteMode === 'continue'
    ? `请在下面这份 Markdown 文件的指定位置续写内容，并把结果写回文件。\n\n文件：${sourcePath}\n${lineText}\n要求：${requirement}\n\n请读取文件当前内容：第 ${message.startLine} 行当前是一个空行，请把续写的新内容直接写入这一行本身（把这个空行替换成新内容），不要在它前后额外插入新的空行，也不要改动第 ${message.startLine} 行之外的原有内容；调用 markdown_editor_document 的 apply，以 edits 做精确的局部替换。不要只给建议，不要重发全文；完成写回后简短说明。`
    : `请直接改写下面这段 Markdown，并把结果写回文件。\n\n文件：${sourcePath}\n${lineText}\n要求：${requirement}\n\n原文：\n${selectedText}\n\n请读取文件当前内容，调用 markdown_editor_document 的 apply，以 edits 做唯一、精确的局部替换。不要只给建议，不要重发全文；完成写回后简短说明。`;
  const receipt = await ctx.sessions.send(sessionId, {
    text: prompt,
    idempotencyKey: `rewrite-${createHash('sha256').update(`${sourcePath}:${rewriteMode}:${selectedText}:${requirement}:${message.startLine ?? ''}:${Date.now()}`).digest('hex')}`,
  });
  if (receipt.state === 'rejected') {
    await panel.postMessage({ type: 'rewriteSessionFailed', message: '改写会话队列繁忙，请稍后重试。' });
    return;
  }
  const operation: RewriteOperation = {
    sessionId, turnId: receipt.turnId, startLine: message.startLine,
    endLine: message.endLine ?? message.startLine, rewriteMode, startedAt: Date.now(),
  };
  await rememberRewriteOperation(ctx, sourcePath, operation).catch((error) => ctx.logger.warn(`Could not persist rewrite operation: ${String(error)}`));
  await notifyRewritePanels(sourcePath, {
    type: 'rewriteSessionStarted', sessionId, spaceName: scope.spaceName,
    title: `${rewriteMode === 'continue' ? '续写' : '改写'}：${path.basename(sourcePath)}`,
    startLine: operation.startLine, endLine: operation.endLine, rewriteMode,
  });
  void ctx.sessions.waitForTurn(sessionId, receipt.turnId, { timeoutMs: 600_000 }).then(async (result) => {
    const verb = rewriteMode === 'continue' ? '续写' : '改写';
    await clearRewriteOperation(ctx, sourcePath, receipt.turnId).catch((error) => ctx.logger.warn(`Could not clear rewrite operation: ${String(error)}`));
    await notifyRewritePanels(sourcePath, {
      type: result.state === 'completed' ? 'rewriteSessionFinished' : 'rewriteSessionFailed',
      sessionId,
      message: result.state === 'completed' ? `${verb}已完成。` : result.state === 'timeout' ? `${verb}仍在会话中继续。` : `${verb}会话未完成。`,
    });
  });
}

async function readStyleSession(ctx: finch.MiniToolContext, sourcePath: string): Promise<string | undefined> {
  const state = await readLastPathState(ctx);
  const id = state.styleSessions?.[sourcePath];
  if (!id) return undefined;
  const session = await ctx.sessions.get(id).catch(() => undefined);
  return session ? id : undefined;
}

async function rememberStyleSession(ctx: finch.MiniToolContext, sourcePath: string, sessionId: string): Promise<void> {
  try {
    const state = await readLastPathState(ctx);
    state.styleSessions = { ...state.styleSessions, [sourcePath]: sessionId };
    await writeFile(stateFile(ctx), JSON.stringify(state), 'utf8');
  } catch (error) {
    ctx.logger.warn(`Could not persist style session: ${String(error)}`);
  }
}

// AppView has no chat Composer to hand an "annotation" context off to
// (view === 'appView' means no Session and no Composer draft — see
// AppPanelEnvMessage), so "let AI design a layout" there can't reuse
// askAiStyle()'s `api.composer.addContexts()` path the way the AppPanel
// sidebar does. Mirror startRewriteSession() instead: spin up (or reuse) a
// small Space-bound Agent Session and drive `markdown_editor_document`
// set_style directly, with no upfront slot question — set_style now applies
// straight to the live preview when `slot` is omitted, and the panel offers
// its own lightweight "save to slot" affordance once the CSS lands.
async function startStyleSession(ctx: finch.MiniToolContext, panel: finch.AppPanel, message: PanelMessage): Promise<void> {
  const sourcePath = String(message.path ?? '').trim();
  if (panel.view !== 'appView' || !path.isAbsolute(sourcePath)) {
    await panel.postMessage({ type: 'styleSessionFailed', message: '让 AI 设计排版需要 App View 中已保存的本地文档。' });
    return;
  }
  const requirement = String(message.requirement ?? '').trim() || '让排版更清晰美观，贴合文章内容和语气';
  const baseStyle = String(message.baseStyle ?? '').trim();
  const baseNote = baseStyle === 'custom'
    ? '当前基础风格是 kami（自定义 CSS 叠加其上）'
    : baseStyle ? `当前基础风格是 ${baseStyle}` : '';
  const scope = await resolveDocumentScope(ctx, sourcePath);
  let sessionId = await readStyleSession(ctx, sourcePath);
  if (!sessionId) {
    const session = await ctx.sessions.create({
      ...(scope.spaceId ? { space: { spaceId: scope.spaceId } } : {}),
      title: `设计排版：${path.basename(sourcePath)}`,
      activity: 'interactive',
      permissionMode: 'acceptCalls',
    });
    sessionId = session.sessionId;
    await rememberStyleSession(ctx, sourcePath, sessionId);
  }
  const prompt = `请为这篇公众号文章设计一套自定义排版 CSS。${baseNote ? baseNote + '，' : ''}你的 CSS 会叠加在基础风格之上。要求：只写普通 CSS 规则，选择器限定在 #bm-md 下的标签/结构（如 #bm-md h1、#bm-md p、#bm-md blockquote、#bm-md pre code、#bm-md a、#bm-md strong、#bm-md table 等），不要使用 class，必要时用 !important 覆盖基础风格。可参考 bm.md 内置风格的设计语言：kami（暖色纸感）、bauhaus（几何撞色）、blueprint（技术蓝图网格）、botanical（清新绿意）、newsprint（报刊衬线）、retro（复古怀旧）、sketch（手绘风）、terminal（等宽暗色终端风）。文章路径：${sourcePath}。要求：${requirement}。设计好后直接调用 markdown_editor_document 的 set_style（传 path="${sourcePath}"，css 和简短 label，不要传 slot——传 path 是为了让它能找到这篇文档对应的预览窗口，即使用户已经切换到别的界面），让它应用到预览；不要在这里询问要覆盖哪个槽位——面板会自己给用户一个轻量的“保存为自定义风格”按钮，用户回到这篇文档时也还能看到。完成后用一两句话简短说明设计思路即可。`;
  const receipt = await ctx.sessions.send(sessionId, {
    text: prompt,
    idempotencyKey: `style-${createHash('sha256').update(`${sourcePath}:${requirement}:${Date.now()}`).digest('hex')}`,
  });
  if (receipt.state === 'rejected') {
    await panel.postMessage({ type: 'styleSessionFailed', message: '排版设计会话队列繁忙，请稍后重试。' });
    return;
  }
  await rememberStyleOperation(ctx, sourcePath, { sessionId, turnId: receipt.turnId, startedAt: Date.now() });
  await panel.postMessage({ type: 'styleSessionStarted', sessionId, spaceName: scope.spaceName });
  void ctx.sessions.waitForTurn(sessionId, receipt.turnId, { timeoutMs: 600_000 }).then(async (result) => {
    await clearStyleOperation(ctx, sourcePath, receipt.turnId);
    // The panel that asked may have been destroyed/rebound while this ran
    // (user navigated away and back, closed and reopened the document…) —
    // resolve fresh targets by path instead of trusting the captured
    // `panel` reference, so the loading spinner reliably clears wherever
    // this document is open now, not just where the design was requested.
    const targets = findPanelsForPath(sourcePath);
    await Promise.all((targets.length ? targets : [panel]).map((target) => target.postMessage({
      type: result.state === 'completed' ? 'styleSessionFinished' : 'styleSessionFailed',
      sessionId,
      message: result.state === 'completed' ? '排版设计已完成。' : result.state === 'timeout' ? '排版设计仍在会话中继续。' : '排版设计会话未完成。',
    }).catch(() => {})));
  });
}

async function handleMessage(ctx: finch.MiniToolContext, panel: finch.AppPanel, raw: unknown): Promise<void> {
  const message = raw as PanelMessage;
  switch (message.type) {
    case 'clientLog': {
      // Temporary diagnostic bridge: surfaces panel.html-side events (e.g. a
      // toolbar click actually reaching the panel) in the mini tool console.
      ctx.logger.info(`[panel] ${String(message.message ?? '')}`);
      return;
    }
    case 'panelReady': {
      // Authoritative handshake: visibility/open events can precede guest
      // listener installation. First replay a document that was sent while
      // this very panel was loading; only otherwise fall back to persisted
      // Session state. Home therefore stays empty on a later open, while an
      // AI-created Home document reliably reaches a freshly loaded panel.
      await sendReady(ctx, panel);
      const liveDocument = livePanelDocuments.get(panel.id);
      if (liveDocument) {
        await sendLiveDocument(ctx, panel, liveDocument);
      } else if (!await restoreDocument(ctx, panel)) {
        await panel.postMessage({ type: 'lastFileUnavailable' });
      }
      // The Agent Session outlives a destroyed/rebound page. Restore its
      // in-flight range after restoring the document so the writer knows an
      // AI turn is still working on this file.
      const currentPath = livePanelDocuments.get(panel.id)?.path;
      if (currentPath) {
        const state = await readLastPathState(ctx);
        const operation = state.rewriteOperations?.[currentPath];
        if (operation) await panel.postMessage({
          type: 'rewriteSessionStarted', sessionId: operation.sessionId,
          startLine: operation.startLine, endLine: operation.endLine,
          rewriteMode: operation.rewriteMode,
        });
        // Same idea for an AI-style-design Session still running for this
        // file — restores the wand icon's loading spinner.
        const styleOperation = state.styleOperations?.[currentPath];
        if (styleOperation) await panel.postMessage({ type: 'styleSessionStarted', sessionId: styleOperation.sessionId });
        // And a design that already landed but hasn't been saved to a slot
        // yet — the user may have navigated away before seeing the one-tap
        // save prompt, so replay it now that they're back on this document.
        const pendingStyle = state.pendingStyles?.[currentPath];
        if (pendingStyle) await panel.postMessage({ type: 'customStyleSet', css: pendingStyle.css, label: pendingStyle.label });
      }
      return;
    }
    case 'openImage': {
      const filePath = String(message.path ?? '').trim();
      const rawUrl = String(message.url ?? '').trim();
      try {
        if (filePath) await openLocalImagePreview(ctx, filePath);
        else await openMarkdownImagePreview(ctx, rawUrl);
      } catch (error) {
        ctx.logger.warn(`Ignored Markdown image preview: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    case 'openLink': {
      const rawUrl = String(message.url ?? '').trim();
      let target: URL;
      try {
        target = new URL(rawUrl);
      } catch {
        ctx.logger.warn(`Ignored invalid Markdown link: ${rawUrl}`);
        return;
      }
      // `ctx.browser.open()` accepts only explicit web URLs. Validate again on
      // the trusted side even though CodeMirror already filters decorations,
      // because Panel messages are untrusted input.
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        ctx.logger.warn(`Ignored unsupported Markdown link protocol: ${target.protocol}`);
        return;
      }
      await ctx.browser.open(target.href);
      return;
    }
    case 'requestOpen': {
      // No client-side timeout here on purpose: a real native picker dialog can
      // legitimately stay open for minutes while the user browses the tree, and
      // racing it against a timer only means we might `close()` a dialog the
      // user is still actively using — plus every fallback path taken this way
      // permanently disables the native picker for the rest of the panel's
      // session (see `pickFileSupported` in panel.html), which is worse than
      // just waiting. The host itself already has its own multi-minute safety
      // net for a truly stuck dialog, so we simply await the result here.
      ctx.logger.info('requestOpen received; calling ctx.ui.pickFile()');
      try {
        const handle = ctx.ui.pickFile({
          title: '选择Markdown文件',
          filter: { extensions: ['.md', '.markdown'] },
          allowSpaceSwitch: panel.view === 'appView',
        });
        ctx.logger.info('ctx.ui.pickFile() call returned a handle, awaiting resolution…');
        const picked = await handle;
        ctx.logger.info(`pickFile() resolved: action=${picked.action}, files=${picked.files.length}`);
        if (picked.action !== 'select' || picked.files.length === 0) {
          // The user cancelled — not an error, but the panel is still waiting
          // on *some* reply to clear its "a native request is pending" guard
          // (see `nativePickPending` in panel.html). Without this ack, the
          // very next click would wrongly think a request is still hanging
          // and jump straight to the (unreliable, no real user gesture)
          // browser fallback instead of opening the native picker again.
          await panel.postMessage({ type: 'pickCancelled' });
          return;
        }
        const sourcePath = picked.files[0].path;
        const { markdown, diskMarkdown, draftRestored, draftConflict } = await readFileWithDraft(ctx, sourcePath);
        watchSource(ctx, panel, sourcePath);
        await rememberLastPath(ctx, panel, sourcePath);
        await sendDocument(panel, { path: sourcePath, markdown, title: documentTitle(markdown, sourcePath), draftRestored, draftConflict, diskMarkdown });
      } catch (error) {
        ctx.logger.error(`pickFile() threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
        await panel.postMessage({
          type: 'error',
          fallback: true,
          message: `Native file picker failed, falling back to the browser dialog: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }
    case 'loadPath': {
      const sourcePath = String(message.path ?? '').trim();
      if (!path.isAbsolute(sourcePath)) {
        await panel.postMessage({ type: 'error', message: 'Please provide an absolute Markdown path.' });
        return;
      }
      try {
        const { markdown, diskMarkdown, draftRestored, draftConflict } = await readFileWithDraft(ctx, sourcePath);
        watchSource(ctx, panel, sourcePath);
        await rememberLastPath(ctx, panel, sourcePath);
        await sendDocument(panel, { path: sourcePath, markdown, title: documentTitle(markdown, sourcePath), draftRestored, draftConflict, diskMarkdown });
      } catch (error) {
        await panel.postMessage({ type: 'error', message: `Cannot read file: ${error instanceof Error ? error.message : String(error)}` });
      }
      return;
    }
    case 'watchPath': {
      const sourcePath = String(message.path ?? '').trim();
      if (!path.isAbsolute(sourcePath)) return;
      watchSource(ctx, panel, sourcePath);
      await rememberLastPath(ctx, panel, sourcePath);
      await panel.postMessage({ type: 'watchStarted', path: sourcePath });
      return;
    }
    case 'requestLastFile': {
      // Covers the panel's delayed retry too, in case the first `panelReady`
      // reply raced a page navigation/rebind.
      const liveDocument = livePanelDocuments.get(panel.id);
      if (liveDocument) {
        await sendLiveDocument(ctx, panel, liveDocument);
      } else if (!await restoreDocument(ctx, panel)) {
        await panel.postMessage({ type: 'lastFileUnavailable' });
      }
      return;
    }
    case 'openPath': {
      const targetPath = String(message.path ?? '').trim();
      if (targetPath && path.isAbsolute(targetPath)) await revealInFileManager(ctx, targetPath);
      return;
    }
    case 'goHome': {
      // User explicitly navigated back to the launch page: stop watching the
      // now-unopened file and drop the in-memory cache so a stray watcher
      // tick or a delayed `requestLastFile` retry can't silently pull the
      // document back onto the screen from under them.
      stopWatching(panel.id);
      livePanelDocuments.delete(panel.id);
      return;
    }
    case 'requestRecentDocuments': {
      const cwd = String(message.cwd ?? '').trim();
      const sessionId = String(message.sessionId ?? '').trim();
      const spaceId = String(message.spaceId ?? '').trim();
      try {
        if (panel.view === 'appView') {
          const documents = await collectLibraryDocuments(ctx);
          await panel.postMessage({ type: 'recentDocuments', cwd, documents, library: true });
        } else {
          await rememberPanelRecentScope(ctx, panel, cwd, sessionId, spaceId);
          const recent = await collectRecentDocuments(ctx, cwd, sessionId, spaceId);
          await panel.postMessage({ type: 'recentDocuments', cwd, documents: recent.documents, fallbackCwd: recent.fallbackCwd });
        }
      } catch (error) {
        ctx.logger.warn(`Could not collect recent documents: ${String(error)}`);
        await panel.postMessage({ type: 'recentDocuments', cwd, documents: [], library: panel.view === 'appView' });
      }
      return;
    }
    case 'requestRewrite': {
      await startRewriteSession(ctx, panel, message);
      return;
    }
    case 'requestStyleSession': {
      await startStyleSession(ctx, panel, message);
      return;
    }
    case 'saveMarkdown': {
      const sourcePath = String(message.path ?? '').trim();
      if (!path.isAbsolute(sourcePath)) return;
      try {
        await writeFile(sourcePath, String(message.markdown ?? ''), 'utf8');
        // A real save always supersedes any pending draft for this path —
        // including one still queued in the debounce, which must not be
        // allowed to land afterward and resurrect a "draft" for a file that
        // was just properly saved.
        cancelPendingDraftWrite(panel.id);
        await deleteDraft(ctx, sourcePath);
        await panel.postMessage({ type: 'savedMarkdown', path: sourcePath, requestId: message.requestId });
      } catch (error) {
        await panel.postMessage({ type: 'error', message: `Could not save Markdown: ${error instanceof Error ? error.message : String(error)}` });
      }
      return;
    }
    case 'saveDraft': {
      // Fire-and-forget mirror of unsaved edits, posted on *every* keystroke
      // (the panel no longer debounces this send itself — see the comment
      // above `scheduleDraftWrite`). The actual disk write is debounced
      // here instead, in this long-running host process, so a tab close
      // can't race a client-side timer that never gets to fire.
      // `base` is the panel's last disk-confirmed content (its `savedMarkdown`)
      // — recorded as the draft's baseline so a later reopen can tell whether
      // anything else changed the file in the meantime.
      const sourcePath = String(message.path ?? '').trim();
      if (!path.isAbsolute(sourcePath)) return;
      const base = typeof message.base === 'string' ? message.base : undefined;
      scheduleDraftWrite(ctx, panel.id, sourcePath, String(message.markdown ?? ''), base);
      return;
    }
    case 'discardDraft': {
      const sourcePath = String(message.path ?? '').trim();
      if (!path.isAbsolute(sourcePath)) return;
      cancelPendingDraftWrite(panel.id);
      await deleteDraft(ctx, sourcePath);
      return;
    }
    case 'renderBm': {
      try {
        const html = await renderWithBm(String(message.markdown ?? ''), String(message.markdownStyle ?? 'kami'), message.customCss);
        await panel.postMessage({ type: 'bmRendered', html, requestId: message.requestId });
      } catch (error) {
        await panel.postMessage({ type: 'error', message: `bm.md rendering failed: ${error instanceof Error ? error.message : String(error)}` });
      }
      return;
    }
    case 'updateToolbar': {
      const itemId = String(message.itemId ?? '').trim();
      if (!itemId || !message.patch) return;
      try {
        await panel.updateToolbarItem(itemId, message.patch as finch.AppPanelToolbarItemPatch);
      } catch (error) {
        ctx.logger.warn(`Could not update toolbar item ${itemId}: ${String(error)}`);
      }
      return;
    }
    case 'setToolbar': {
      if (!Array.isArray(message.toolbar)) return;
      try {
        await panel.setToolbar(message.toolbar);
      } catch (error) {
        ctx.logger.warn(`Could not replace toolbar: ${String(error)}`);
      }
      return;
    }
    case 'applyReplacement': {
      const sourcePath = String(message.path ?? '').trim();
      const markdown = String(message.markdown ?? '');
      if (!sourcePath || !path.isAbsolute(sourcePath)) {
        await panel.postMessage({ type: 'error', message: 'Pasted documents can be revised in the editor, but source-file apply needs an absolute path.' });
        return;
      }
      try {
        // No `openDiff` here on purpose — see the matching comment on the
        // `apply` tool action below.
        const current = await readFile(sourcePath, 'utf8');
        const appliedMarkdown = preserveTextEnvelope(current, markdown);
        await writeFile(sourcePath, appliedMarkdown, 'utf8');
        await publishFileUpdate(ctx, sourcePath);
        await rememberRecentPath(ctx, sourcePath, panel);
        await panel.postMessage({ type: 'applied', path: sourcePath, title: documentTitle(appliedMarkdown, sourcePath) });
      } catch (error) {
        await panel.postMessage({ type: 'error', message: `Could not apply revision: ${error instanceof Error ? error.message : String(error)}` });
      }
      return;
    }
    case 'readClipboardImages': {
      try {
        const images = await readClipboardImageDataUrls(ctx, Array.isArray(message.urls) ? message.urls.filter((url): url is string => typeof url === 'string') : []);
        await panel.postMessage({ type: 'clipboardImages', requestId: message.requestId, images });
      } catch (error) {
        await panel.postMessage({ type: 'clipboardImagesError', requestId: message.requestId, message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    case 'pasteImage': {
      const dataBase64 = String(message.data ?? '');
      if (!dataBase64) {
        await panel.postMessage({ type: 'pasteImageError', requestId: message.requestId, message: 'Empty image data.' });
        return;
      }
      try {
        const ext = PASTE_IMAGE_EXT[String(message.mimeType ?? '').toLowerCase()] ?? 'png';
        const buffer = Buffer.from(dataBase64, 'base64');
        // Content-addressed filename: pasting the same clipboard image twice
        // (common while iterating on a screenshot) reuses the same file
        // instead of accumulating duplicates.
        const digest = createHash('sha256').update(buffer).digest('hex').slice(0, 20);
        // Lives under this mini tool's own storage dir (already on the
        // `finch-file://` host's allowlist for extension-owned data) rather
        // than next to the source .md file — the document may have no path
        // at all (pasted/unsaved draft), and this keeps every pasted asset
        // in one predictable, always-writable place regardless.
        const dir = path.join(ctx.storagePath, 'assets');
        await mkdir(dir, { recursive: true });
        const targetPath = path.join(dir, `${digest}.${ext}`);
        const alreadyExists = await stat(targetPath).then(() => true).catch(() => false);
        if (!alreadyExists) await writeFile(targetPath, buffer);
        const url = `finch-file://local?path=${encodeURIComponent(targetPath)}`;
        await panel.postMessage({ type: 'pastedImage', requestId: message.requestId, url, path: targetPath });
      } catch (error) {
        await panel.postMessage({ type: 'pasteImageError', requestId: message.requestId, message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    case 'saveStyleSlot': {
      const slot = Number(message.slot);
      if (!Number.isInteger(slot) || slot < 0 || slot >= STYLE_SLOT_COUNT) return;
      const css = String(message.css ?? '').trim();
      if (!css) {
        await panel.postMessage({ type: 'error', message: 'Nothing to save: the active style has no custom CSS.' });
        return;
      }
      try {
        const slots = await writeStyleSlot(ctx, slot, { css, label: String(message.label ?? '').trim() || '自定义风格' });
        const sourcePath = String(message.path ?? '').trim();
        if (sourcePath) await clearPendingStyle(ctx, sourcePath);
        await panel.postMessage({ type: 'styleSlots', styleSlots: slots, savedSlot: slot });
      } catch (error) {
        await panel.postMessage({ type: 'error', message: `Could not save style slot: ${error instanceof Error ? error.message : String(error)}` });
      }
      return;
    }
    case 'exportFile': {
      const dataBase64 = String(message.data ?? '');
      const ext = String(message.ext ?? 'bin').replace(/[^a-z0-9]/gi, '') || 'bin';
      if (!dataBase64) {
        await panel.postMessage({ type: 'error', message: 'Nothing to export.' });
        return;
      }
      try {
        const sourcePath = String(message.path ?? '').trim();
        // Save next to the open Markdown file when there is one — that's the
        // most predictable place for the user to look — otherwise fall back
        // to Downloads (and finally the mini tool's own storage dir, which
        // always exists) so this never fails just because the document was
        // opened via paste and has no path on disk.
        let dir = path.isAbsolute(sourcePath) ? path.dirname(sourcePath) : '';
        if (!dir) {
          const downloads = path.join(os.homedir(), 'Downloads');
          dir = await stat(downloads).then((s) => s.isDirectory()).catch(() => false) ? downloads : ctx.storagePath;
        }
        const rawName = String(message.fileName ?? '').trim() || documentTitle(String(message.markdown ?? ''), sourcePath || undefined);
        const safeName = rawName.replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 120) || 'article';
        const targetPath = path.join(dir, `${safeName}.${ext}`);
        await writeFile(targetPath, Buffer.from(dataBase64, 'base64'));
        await panel.postMessage({ type: 'exported', path: targetPath, requestId: message.requestId });
      } catch (error) {
        await panel.postMessage({ type: 'error', message: `Could not export file: ${error instanceof Error ? error.message : String(error)}` });
      }
      return;
    }
  }
}

export function activate(ctx: finch.MiniToolContext): void {
  ctx.subscriptions.push(ctx.icons.register('markdown-editor-icons', {
    'folder-open': {
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>',
    },
    save: {
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/></svg>',
    },
    'save-check': {
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h10.2a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4v4.35"/><path d="m16 19 2 2 4-4"/><path d="M17 15.13V14a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/></svg>',
    },
    'file-pen-line': {
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.364 13.634a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506l4.013-4.009a1 1 0 0 0-3.004-3.004z"/><path d="M14.487 7.858A1 1 0 0 1 14 7V2"/><path d="M20 19.645V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l2.516 2.516"/><path d="M8 18h1"/></svg>',
    },
    type: {
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-type-icon lucide-type"><path d="M12 4v16"/><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2"/><path d="M9 20h6"/></svg>',
    },
    'wechat-copy': {
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path stroke-linecap="round" stroke-width="2" d="M7 7h.009m5.982 0H13m4.991 7.5H18m-4 0h.009"></path><path stroke-width="2" d="M10 16c0 2.761 2.686 5 6 5c.907 0 1.767-.168 2.538-.468c.189-.073.393-.1.592-.063L22 21l-.652-2.03a1.13 1.13 0 0 1 .11-.89A4.3 4.3 0 0 0 22 16c0-2.761-2.686-5-6-5s-6 2.239-6 5Z"></path><path stroke-width="2" d="M17.873 11.249Q18 10.639 18 10c0-3.866-3.582-7-8-7s-8 3.134-8 7c0 1.112.297 2.164.824 3.098c.147.26.196.567.108.853L2 17l3.914-.76c.208-.041.422-.013.617.07a9 9 0 0 0 3.589.69"></path></svg>',
    },
    feather: {
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.086 18.412A2 2 0 0 1 12.67 19H5v-7.672a2 2 0 0 1 .586-1.414L11.75 3.75a6 6 0 1 1 8.49 8.49z"/><path d="M16 8 2 22"/><path d="M17.488 15H9"/></svg>',
    },
    'swatch-book': {
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 17a4 4 0 0 1-8 0V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2Z"/><path d="M16.7 13H19a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H7"/><path d="M 7 17h.01"/><path d="m11 8 2.3-2.3a2.4 2.4 0 0 1 3.404.004L18.6 7.6a2.4 2.4 0 0 1 .026 3.434L9.9 19.8"/></svg>',
    },
    // Static hourglass shown on the Preview button while bm.md rendering is
    // in flight — a plain status hint, deliberately not animated (SMIL does
    // not run on host-rendered SVGs and frame-swapping felt janky).
    'hourglass': {
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/></svg>',
    },
  }));

  ctx.subscriptions.push(ctx.ui.onDidOpenPanel((panel) => {
    openPanels.set(panel.id, panel);
    if (panel.visible) lastPanel = panel;
    ctx.subscriptions.push(panel.onDidReceiveMessage((message) => {
      // `handleMessage` is async and its rejections are not implicitly awaited
      // by whatever fires this event — an internal failure (e.g. `postMessage`
      // back to a panel that's mid-teardown/rebind across a Session switch)
      // would otherwise surface as a bare, unhelpful `unhandledRejection`
      // instead of a clean log line, and worse, could leave the panel-side
      // guard state (like `nativePickPending`) stuck forever since the reply
      // that would have cleared it never arrives. Always catch here.
      handleMessage(ctx, panel, message).catch((error) => {
        ctx.logger.warn(`handleMessage failed for '${(message as PanelMessage)?.type}': ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      });
    }));
    ctx.subscriptions.push(panel.onDidChangeVisibility((visible) => {
      if (visible) lastPanel = panel;
      else if (lastPanel === panel) lastPanel = undefined;
    }));
    ctx.subscriptions.push(panel.onDidDispose(() => {
      stopWatching(panel.id);
      openPanels.delete(panel.id);
      livePanelDocuments.delete(panel.id);
      // The panel is gone for real now (Cmd/Ctrl+W, closing a Session, app
      // quit…) — don't wait out the debounce for whatever draft edit was
      // last in flight, write it immediately.
      flushPendingDraftWrite(ctx, panel.id);
      if (lastPanel === panel) lastPanel = undefined;
    }));
    // Best-effort immediate push: page-originated `panelReady` is the
    // authoritative restore handshake and remains retryable after navigation.
    void sendReady(ctx, panel).catch((error) => ctx.logger.warn(String(error)));
  }));

  ctx.subscriptions.push(ctx.tools.register({
    name: 'markdown_editor_document',
    title: '写字',
    description: `Open, create, revise, or restyle a Markdown document in Markdown Editor.
action:
  open — read an absolute local Markdown path and open it as an editable WeChat article preview
  create — write brand-new Markdown content to an absolute path that does not exist yet, then open it in Markdown Editor. Use this whenever the user asks to write an article, start writing, write a post, create, or draft a new document — even if they do not mention Markdown. If title/topic or destination is missing, guide the user to provide it; once known, create and open the document rather than returning prose only. If they only want to begin, create a minimal titled starter document. Markdown Editor's own UI has no "new file" button on purpose — this tool action is the intended way to start a new document
  apply — revise a source document (requires path). For a small, targeted change, pass edits instead of markdown: an array of {old_string, new_string} replacements matched against the file's current on-disk content, the same find-and-replace contract as a code editor's Edit tool — this avoids resending the whole document and keeps the on-screen highlight scoped to what actually changed. Reserve markdown (the full updated document) for a genuine full rewrite. Once this conversation has started editing a .md document through Markdown Editor, always use this apply/edits path for subsequent changes to that same file before considering the built-in Edit tool: it refreshes the panel and highlights the exact change. Fall back to the built-in Edit tool only after this apply actually fails. The open panel refreshes in place, no Diff window. Whenever you propose a rewrite and wait for approval before applying it, calling Session action=suggest with 1-3 one-tap confirmations is MANDATORY, not optional, and part of that same turn — sending the proposal text alone does not complete the confirmation step, so do not end the turn without also calling it
  set_style — apply an AI-designed custom CSS layout to the currently open Markdown Editor preview (requires css). Apply it right away, without asking the user which reusable slot to use first — omit \`slot\` and it only updates the live preview; the panel itself then shows a lightweight one-tap prompt so the user decides whether to save it into a reusable custom-style slot, no chat back-and-forth needed. Only pass \`slot\` when the user already told you which of the 3 slots (1/2/3) to save into. Write plain CSS scoped under #bm-md using tag/id selectors (no classes), use !important where needed to override the base style, and take inspiration from bm.md's built-in styles: kami (warm paper), bauhaus (geometric primary colors), blueprint (technical grid), botanical (soft green), newsprint (editorial serif), retro (nostalgic), sketch (hand-drawn), terminal (monospace dark).`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'create', 'apply', 'set_style'], description: 'Operation to perform.' },
        path: { type: 'string', description: 'Absolute path to the Markdown file. Required for open, create, and apply. For create, the file must not already exist. Recommended (though optional) for set_style: passing it lets Markdown Editor find the right panel for this document even if it is not the most recently focused one — e.g. the user switched away while an App View design Session was still working. Without it, set_style falls back to whichever panel was last focused.' },
        markdown: { type: 'string', description: "Full Markdown content. Required for create. For apply, use this only for a genuine full rewrite — prefer `edits` for a small, targeted change." },
        edits: {
          type: 'array',
          description: "For apply only: targeted local replacements instead of resending the whole document. Each old_string is matched against the file's current on-disk content (already reflecting earlier items in this same array) and must match exactly once unless replace_all is set. Prefer this over `markdown` for anything short of a full rewrite.",
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string', description: 'Exact existing text to replace; must be unique in the file unless replace_all is true.' },
              new_string: { type: 'string', description: 'Replacement text.' },
              replace_all: { type: 'boolean', description: 'Replace every occurrence of old_string instead of requiring it to be unique.' },
            },
            required: ['old_string', 'new_string'],
          },
        },
        css: { type: 'string', description: 'Custom CSS to layer on top of the current base style, required for set_style.' },
        label: { type: 'string', description: 'Short label describing the custom style, optional for set_style.' },
        slot: { type: 'number', enum: [1, 2, 3], description: 'Optional for set_style. Omit it to just apply the design to the live preview — the panel will offer the user a one-tap way to save it afterward. Only pass this when the user already picked which of the 3 reusable custom style slots (1, 2, or 3) to overwrite.' },
      },
      required: ['action'],
    },
    risk: 'medium',
    async execute(input): Promise<finch.ToolResult> {
      const action = String(input.action ?? '');
      if (action === 'open' || action === 'create' || action === 'apply') {
        const sourcePath = String(input.path ?? '').trim();
        if (!path.isAbsolute(sourcePath)) return result('`path` must be an absolute local path.', true);
        if (action === 'open') {
          try {
            const { markdown, diskMarkdown, draftRestored, draftConflict } = await readFileWithDraft(ctx, sourcePath);
            const panel = ctx.ui.createPanel({ instanceMode: 'single', payload: { path: sourcePath } });
            await panel.reveal();
            watchSource(ctx, panel, sourcePath);
            await rememberLastPath(ctx, panel, sourcePath);
            await sendDocument(panel, { path: sourcePath, markdown, title: documentTitle(markdown, sourcePath), draftRestored, draftConflict, diskMarkdown });
            return result(`Opened Markdown Editor for ${path.basename(sourcePath)}.`);
          } catch (error) {
            return result(`Could not read ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`, true);
          }
        }
        if (action === 'create') {
          const markdown = String(input.markdown ?? '');
          try {
            const alreadyExists = await stat(sourcePath).then(() => true).catch(() => false);
            if (alreadyExists) return result(`${sourcePath} already exists. Use action 'open' to view it or 'apply' to revise it instead.`, true);
            await mkdir(path.dirname(sourcePath), { recursive: true });
            await writeFile(sourcePath, markdown, 'utf8');
            const panel = ctx.ui.createPanel({ instanceMode: 'single', payload: { path: sourcePath } });
            await panel.reveal();
            watchSource(ctx, panel, sourcePath);
            await rememberLastPath(ctx, panel, sourcePath);
            await sendDocument(panel, { path: sourcePath, markdown, title: documentTitle(markdown, sourcePath) });
            return result(`Created ${path.basename(sourcePath)} and opened it in Markdown Editor.`);
          } catch (error) {
            return result(`Could not create ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`, true);
          }
        }
        // Deliberately no `ctx.ui.openDiff` here: this action is meant to
        // land an already-reviewed revision straight into the document
        // (and, if a panel for this path is open, straight onto the
        // screen via `watchSource`'s fs.watch push) — popping a native
        // Diff window on every single edit was surprising/unwanted, since
        // the user typically reviews the change directly in the editor or
        // preview, not in a separate Diff dialog.
        const rawEdits = Array.isArray(input.edits) ? input.edits as unknown[] : undefined;
        if (rawEdits && rawEdits.length > 0) {
          const edits: EditSpec[] = rawEdits.map((entry) => {
            const item = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
            return {
              old_string: typeof item.old_string === 'string' ? item.old_string : '',
              new_string: typeof item.new_string === 'string' ? item.new_string : '',
              replace_all: Boolean(item.replace_all),
            };
          });
          try {
            const current = await readFile(sourcePath, 'utf8');
            const applied = applyEditSpecs(current, edits);
            if (!applied.ok) return result(applied.error, true);
            await writeFile(sourcePath, applied.content, 'utf8');
            await publishFileUpdate(ctx, sourcePath);
            await rememberRecentPath(ctx, sourcePath);
            return result(`Applied ${edits.length} targeted edit${edits.length > 1 ? 's' : ''} to ${path.basename(sourcePath)}.`);
          } catch (error) {
            return result(`Could not apply edits: ${error instanceof Error ? error.message : String(error)}`, true);
          }
        }
        const markdown = String(input.markdown ?? '');
        if (!markdown) return result("`apply` requires either `edits` (targeted replacements) or non-empty `markdown` (full document).", true);
        try {
          const current = await readFile(sourcePath, 'utf8');
          await writeFile(sourcePath, preserveTextEnvelope(current, markdown), 'utf8');
          await publishFileUpdate(ctx, sourcePath);
          await rememberRecentPath(ctx, sourcePath);
          return result(`Applied reviewed Markdown to ${path.basename(sourcePath)}.`);
        } catch (error) {
          return result(`Could not apply revision: ${error instanceof Error ? error.message : String(error)}`, true);
        }
      }
      if (action === 'set_style') {
        const css = String(input.css ?? '').trim();
        if (!css) return result('`set_style` requires non-empty `css`.', true);
        // Prefer resolving the panel(s) actually showing `path` (works even
        // if that document's panel isn't the most recently focused one, e.g.
        // a background App View design Session) and only fall back to
        // `lastPanel` when no path was given, for backward compatibility.
        const pathHint = String(input.path ?? '').trim();
        const targets = pathHint ? findPanelsForPath(pathHint) : [];
        const panel = targets[0] ?? lastPanel;
        if (!panel && !pathHint) return result('No Markdown Editor panel is open. Ask the user to open a document first.', true);
        try {
          const label = String(input.label ?? '') || 'AI style';
          // `slot` is optional: apply the design to the live preview right
          // away and let the panel itself offer a light one-tap "save to
          // slot" affordance, instead of forcing a chat round-trip asking
          // which of the 3 reusable slots to overwrite before anything shows.
          // Only persist here if the caller already knows the slot (e.g. the
          // user explicitly said "save this as style 2").
          const hasSlot = input.slot !== undefined && input.slot !== null && String(input.slot).trim() !== '';
          if (!hasSlot) {
            // Persist regardless of whether a live panel is open right now —
            // the user may have navigated away mid-design (App View has no
            // Composer to keep the request "in view"). The panel replays
            // this as the same one-tap save prompt the next time it opens
            // this path, so the design isn't silently lost.
            if (pathHint) await rememberPendingStyle(ctx, pathHint, { css, label });
            if (panel) {
              await panel.postMessage({ type: 'customStyleSet', css, label });
              return result('Custom style applied to the open Markdown Editor preview. It is not saved to a reusable slot yet — the panel now shows a one-tap prompt for the user to save it themselves; do not ask which slot in chat unless the user asks you to save it directly.');
            }
            return result('No Markdown Editor panel is currently open for this document, so the style was saved for later — it will apply automatically (with the same one-tap save prompt) the next time the user opens this file in Markdown Editor.');
          }
          const slot = Number(input.slot);
          if (!Number.isInteger(slot) || slot < 1 || slot > STYLE_SLOT_COUNT) {
            return result('`slot` must be 1, 2, or 3 when provided.', true);
          }
          const slots = await writeStyleSlot(ctx, slot - 1, { css, label });
          if (pathHint) await clearPendingStyle(ctx, pathHint);
          if (panel) {
            await panel.postMessage({ type: 'customStyleSet', css, label, styleSlots: slots, savedSlot: slot - 1 });
            return result(`Custom style saved to slot ${slot} and applied to the open Markdown Editor panel.`);
          }
          return result(`Custom style saved to slot ${slot}. No Markdown Editor panel is currently open for this document — it will apply automatically the next time the user opens this file.`);
        } catch (error) {
          return result(`Could not apply custom style: ${error instanceof Error ? error.message : String(error)}`, true);
        }
      }
      return result(`Unknown action: ${action}`, true);
    },
  }));

  ctx.logger.info('finch-markdown-editor activated');
}

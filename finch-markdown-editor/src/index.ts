import type * as finch from 'finch';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

interface DocumentState {
  path?: string;
  markdown: string;
  title: string;
  /** True when `markdown` came from a recovered unsaved draft rather than
   * the file's actual on-disk content — the panel marks the document dirty
   * and tells the user, instead of pretending it matches disk. */
  draftRestored?: boolean;
  /** True when a draft existed but disk had already moved on since the
   * draft's baseline (an external save happened) — `markdown` here is the
   * current disk content, not the draft, and the stale draft was kept
   * on disk rather than silently applied or discarded. */
  draftConflict?: boolean;
  /** The file's *actual* on-disk content, only meaningfully different from
   * `markdown` when `draftRestored` is true. The panel must track this
   * (not the restored draft it's displaying) as its "last disk-confirmed"
   * baseline — otherwise the next draft it mirrors back would record its
   * `baseHash` against the *draft*, not disk, so a later reopen would see
   * disk still sitting at the true baseline and wrongly report an
   * external-edit conflict that never happened. */
  diskMarkdown?: string;
}

interface RecentDocument {
  path: string;
  relativePath: string;
  fileName: string;
  title: string;
  preview: string;
  modifiedAt: number;
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

/** `apply`'s targeted-edit mode — the same find-and-replace contract as a
 * code editor's Edit tool: each `old_string` is matched against the file's
 * *current* content (already reflecting any earlier edits in this same
 * call), not against the original snapshot, so a batch of edits composes
 * left-to-right. This lets the caller send a handful of small replacements
 * instead of the entire document for anything short of a full rewrite. */
interface EditSpec { old_string: string; new_string: string; replace_all?: boolean }

type EditSpecsResult = { ok: true; content: string } | { ok: false; error: string };

type TextEnvelope = { bom: string; lineEnding: '\r\n' | '\n'; text: string };

/** Preserve the source's BOM and dominant newline convention while matching
 * edit strings against LF-normalized content. Models almost always emit LF,
 * while user-authored Markdown can be CRLF (or carry a UTF-8 BOM). */
function unwrapTextEnvelope(content: string): TextEnvelope {
  const bom = content.startsWith('\ufeff') ? '\ufeff' : '';
  const text = bom ? content.slice(1) : content;
  const firstCrLf = text.indexOf('\r\n');
  const firstLf = text.indexOf('\n');
  const lineEnding: '\r\n' | '\n' = firstCrLf !== -1 && (firstLf === -1 || firstCrLf <= firstLf) ? '\r\n' : '\n';
  return { bom, lineEnding, text: text.replace(/\r\n/g, '\n').replace(/\r/g, '\n') };
}

function normalizeToLf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function rewrapTextEnvelope(envelope: TextEnvelope, normalizedText: string): string {
  const restored = envelope.lineEnding === '\r\n' ? normalizedText.replace(/\n/g, '\r\n') : normalizedText;
  return envelope.bom + restored;
}

/** Used by full-document replacement too, so apply never silently strips a
 * BOM or rewrites every line ending merely because the model sent LF text. */
function preserveTextEnvelope(existingContent: string, replacement: string): string {
  const envelope = unwrapTextEnvelope(existingContent);
  return rewrapTextEnvelope(envelope, normalizeToLf(replacement.replace(/^\ufeff/, '')));
}

function applyEditSpecs(content: string, edits: EditSpec[]): EditSpecsResult {
  const envelope = unwrapTextEnvelope(content);
  let working = envelope.text;
  for (let i = 0; i < edits.length; i++) {
    const { old_string: rawOldString, new_string: rawNewString, replace_all: replaceAll } = edits[i];
    if (typeof rawOldString !== 'string' || rawOldString.length === 0) {
      return { ok: false, error: `edits[${i}]: 'old_string' must be a non-empty string.` };
    }
    if (typeof rawNewString !== 'string') {
      return { ok: false, error: `edits[${i}]: 'new_string' must be a string.` };
    }
    const oldString = normalizeToLf(rawOldString);
    const newString = normalizeToLf(rawNewString);
    if (oldString === newString) {
      return { ok: false, error: `edits[${i}]: 'old_string' and 'new_string' are identical — nothing to change.` };
    }
    const occurrences = working.split(oldString).length - 1;
    if (occurrences === 0) {
      return { ok: false, error: `edits[${i}]: 'old_string' was not found in the file's current content. Check the exact text (including whitespace/line breaks) — the file may differ from what you last saw.` };
    }
    if (occurrences > 1 && !replaceAll) {
      return { ok: false, error: `edits[${i}]: 'old_string' matches ${occurrences} places in the file. Include more surrounding context to make it unique, or set 'replace_all: true' to replace every match.` };
    }
    if (replaceAll) {
      working = working.split(oldString).join(newString);
    } else {
      const index = working.indexOf(oldString);
      working = working.slice(0, index) + newString + working.slice(index + oldString.length);
    }
  }
  return { ok: true, content: rewrapTextEnvelope(envelope, working) };
}

function documentTitle(markdown: string, filePath?: string): string {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || (filePath ? path.basename(filePath, path.extname(filePath)) : 'Untitled article');
}

// Remember the last successfully opened file, so the user doesn't have to
// re-open it by hand every time. The primary key is panel.id: each Panel scope
// gets its own stable instance, including different Space Home scopes, and a
// Home → Session relocation preserves the same id. Older session/global keys
// remain readable for migration.
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

// Editor-style unsaved-draft recovery: while a document has a real path on
// disk, every edit is mirrored (debounced, panel-side) into a small sidecar
// file keyed by a hash of that path. Reopening the same file — even after
// quitting Finch entirely — resumes from the draft instead of the last
// saved-to-disk content, exactly like a desktop editor's crash recovery.
// Saving for real deletes the draft; there is deliberately no user-facing
// "restore draft?" prompt in the common case (that would just be new
// friction) — the draft is simply the freshest version of the user's own
// last edit, so it wins silently and the small status line already used
// elsewhere says so.
//
// `baseHash` records a hash of the on-disk content the draft was *edited on
// top of* (the panel's `savedMarkdown` at the time). On reopen this lets us
// tell two very different situations apart:
//   - disk still matches baseHash  → nothing else touched the file since the
//     draft was taken; restoring it silently is safe.
//   - disk no longer matches       → someone (another editor, an AI apply,
//     a sync tool) saved a *different* version of the file after the draft
//     was taken. Silently preferring the draft here would quietly discard
//     that external save; silently preferring disk would quietly discard the
//     user's own unsaved edit. Neither is a good "silent" default, so this
//     case loads disk (the only version anyone else can see or has actually
//     confirmed) and surfaces the conflict instead of guessing.
interface DraftFile { path: string; markdown: string; baseHash?: string; savedAt: number }

function draftPathFor(ctx: finch.MiniToolContext, sourcePath: string): string {
  const digest = createHash('sha256').update(sourcePath).digest('hex').slice(0, 32);
  return path.join(ctx.storagePath, 'drafts', `${digest}.json`);
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function readDraft(ctx: finch.MiniToolContext, sourcePath: string): Promise<DraftFile | undefined> {
  try {
    const raw = JSON.parse(await readFile(draftPathFor(ctx, sourcePath), 'utf8')) as DraftFile;
    // Hash collisions are astronomically unlikely, but never trust a draft
    // for a different absolute path than the one requested.
    return raw && raw.path === sourcePath && typeof raw.markdown === 'string' ? raw : undefined;
  } catch {
    return undefined;
  }
}

async function writeDraft(ctx: finch.MiniToolContext, sourcePath: string, markdown: string, base: string | undefined): Promise<void> {
  try {
    const file = draftPathFor(ctx, sourcePath);
    await mkdir(path.dirname(file), { recursive: true });
    const entry: DraftFile = { path: sourcePath, markdown, savedAt: Date.now() };
    if (typeof base === 'string') entry.baseHash = hashText(base);
    await writeFile(file, JSON.stringify(entry), 'utf8');
  } catch (error) {
    ctx.logger.warn(`Could not persist draft for ${sourcePath}: ${String(error)}`);
  }
}

async function deleteDraft(ctx: finch.MiniToolContext, sourcePath: string): Promise<void> {
  await rm(draftPathFor(ctx, sourcePath), { force: true }).catch(() => {});
}

// ---- Draft write coalescing ----
// The panel now posts `saveDraft` on *every* keystroke (no client-side
// timer) so the backend always has the latest content in hand the instant
// it's typed — a tab close (Cmd/Ctrl+W) tears the panel down with no
// reliable opportunity for page-lifecycle JS to run first, so anything that
// depended on the panel itself flushing before teardown was inherently
// racy. Debouncing the actual disk write moves here instead, where the
// timer lives in this long-running extension host, not in the panel that
// can disappear out from under it — the timer keeps ticking (and still
// writes) even after the panel that scheduled it is gone. `onDidDispose`
// additionally flushes immediately, so real teardown never waits out the
// debounce at all.
const DRAFT_WRITE_DEBOUNCE_MS = 600;
interface PendingDraftWrite { path: string; markdown: string; base: string | undefined; timer: ReturnType<typeof setTimeout> | null }
const pendingDraftWrites = new Map<string, PendingDraftWrite>();

function scheduleDraftWrite(ctx: finch.MiniToolContext, panelId: string, sourcePath: string, markdown: string, base: string | undefined): void {
  const existing = pendingDraftWrites.get(panelId);
  if (existing?.timer) clearTimeout(existing.timer);
  const entry: PendingDraftWrite = { path: sourcePath, markdown, base, timer: null };
  entry.timer = setTimeout(() => {
    entry.timer = null;
    pendingDraftWrites.delete(panelId);
    void writeDraft(ctx, sourcePath, markdown, base);
  }, DRAFT_WRITE_DEBOUNCE_MS);
  pendingDraftWrites.set(panelId, entry);
}

/** Writes out whatever's pending right now, bypassing the debounce — used
 * when we know for certain the panel is going away (`onDidDispose`). */
function flushPendingDraftWrite(ctx: finch.MiniToolContext, panelId: string): void {
  const entry = pendingDraftWrites.get(panelId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  pendingDraftWrites.delete(panelId);
  void writeDraft(ctx, entry.path, entry.markdown, entry.base);
}

/** Drops a pending write without persisting it — used when a real save or
 * an explicit discard has just made it stale, so it can't land afterward
 * and resurrect a draft for a file that was just handled. */
function cancelPendingDraftWrite(panelId: string): void {
  const entry = pendingDraftWrites.get(panelId);
  if (entry?.timer) clearTimeout(entry.timer);
  pendingDraftWrites.delete(panelId);
}

/** Reads a file from disk and reconciles it against any pending draft:
 * - no draft, or draft identical to disk → plain disk content.
 * - draft's baseline still matches disk (nothing else changed the file) →
 *   silently resume the draft (`draftRestored: true`).
 * - draft's baseline no longer matches disk (an external save happened
 *   since the draft was taken) → keep disk content (never silently drop an
 *   external save), leave the draft file in place, and flag the conflict
 *   (`draftConflict: true`) so the panel can tell the user instead of
 *   guessing on their behalf. */
async function readFileWithDraft(
  ctx: finch.MiniToolContext,
  sourcePath: string,
): Promise<{ markdown: string; diskMarkdown: string; draftRestored: boolean; draftConflict: boolean }> {
  const diskMarkdown = await readFile(sourcePath, 'utf8');
  const draft = await readDraft(ctx, sourcePath);
  if (!draft || draft.markdown === diskMarkdown) return { markdown: diskMarkdown, diskMarkdown, draftRestored: false, draftConflict: false };
  const diskMatchesBaseline = draft.baseHash === undefined || draft.baseHash === hashText(diskMarkdown);
  if (diskMatchesBaseline) return { markdown: draft.markdown, diskMarkdown, draftRestored: true, draftConflict: false };
  return { markdown: diskMarkdown, diskMarkdown, draftRestored: false, draftConflict: true };
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
    const scope = state.panelRecentScopes?.[panel.id];
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

// The document currently being delivered to each live Panel. This is
// deliberately in-memory only: Home must start document-neutral on a later
// open, but a Home panel that is still loading/rebinding must not lose a
// document an AI just created or opened before the page announced `panelReady`.
const livePanelDocuments = new Map<string, DocumentState>();

async function sendDocument(panel: finch.AppPanel, state: DocumentState): Promise<void> {
  livePanelDocuments.set(panel.id, state);
  await panel.postMessage({ type: 'document', ...state });
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
      await sendDocument(panel, { ...liveDocument, markdown, title: documentTitle(markdown, liveDocument.path), draftRestored, draftConflict, diskMarkdown });
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
  // Home is a document-neutral launch point: it must always show the empty
  // state and let the user explicitly open a file or ask the AI to create
  // one. Only Session-scoped panels may restore their last working document.
  if (!panel.sessionId) return false;
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

// bmmd is LGPL-3.0-only as of 0.3.0, so its published CLI payload is
// bundled under dist/bmmd/bin at build time. Keeping its files intact (rather
// than rebundling) preserves the CLI's dynamic imports between chunk files.
const BMMD_BIN_PATH = fileURLToPath(new URL('./bmmd/bin/bmmd.mjs', import.meta.url));

async function runBmmd(args: string[], input: string): Promise<string> {
  const binPath = BMMD_BIN_PATH;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; });
    child.stderr.on('data', (chunk: string) => { errors += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(errors.trim() || `bmmd exited with code ${code}`));
    });
    child.stdin.end(input, 'utf8');
  });
}

// bmmd sanitizes `img[src]` and deliberately removes both unknown protocols
// (including Finch's `finch-file:`) and data: URLs. Preserve the Markdown
// source URL unchanged, but temporarily turn each local image into a unique
// harmless HTTPS placeholder. HTTPS survives bmmd's sanitizer; after bmmd
// has finished its layout/inlining work we restore the original URL in the
// generated HTML. The panel webview can then resolve it through Finch's
// already-allowlisted `finch-file://local` protocol.
const FINCH_FILE_IMAGE_RE = /finch-file:\/\/local\?path=[^\s)"']+/g;
const FINCH_IMAGE_PLACEHOLDER_ORIGIN = 'https://finch-local.invalid/markdown-image/';

function substituteFinchFileImagesForBm(markdown: string): { markdown: string; urls: Map<string, string> } {
  const urls = new Map<string, string>();
  let sequence = 0;
  const substituted = markdown.replace(FINCH_FILE_IMAGE_RE, (originalUrl) => {
    // The random-ish digest plus monotonically increasing suffix makes a
    // collision within one render practically impossible, including when
    // the same source URL is deliberately pasted more than once.
    const placeholder = `${FINCH_IMAGE_PLACEHOLDER_ORIGIN}${createHash('sha256')
      .update(`${originalUrl}:${sequence++}`).digest('hex')}`;
    urls.set(placeholder, originalUrl);
    return placeholder;
  });
  return { markdown: substituted, urls };
}

async function renderWithBm(markdown: string, markdownStyle: string, customCss: string | undefined): Promise<string> {
  const args = ['render', '--platform', 'wechat', '--markdown-style', markdownStyle || 'kami'];
  if (customCss && customCss.trim()) args.push('--custom-css', customCss);
  const prepared = substituteFinchFileImagesForBm(markdown);
  let html = await runBmmd(args, prepared.markdown);
  for (const [placeholder, originalUrl] of prepared.urls) html = html.split(placeholder).join(originalUrl);
  return html;
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
        try {
          const markdown = await readFile(sourcePath, 'utf8');
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
      // The page owns the cwd (it arrives with `finch:env`), so it tells us
      // which directory to scope the list to instead of us guessing per panel.
      const cwd = String(message.cwd ?? '').trim();
      const sessionId = String(message.sessionId ?? '').trim();
      const spaceId = String(message.spaceId ?? '').trim();
      try {
        await rememberPanelRecentScope(ctx, panel, cwd, sessionId, spaceId);
        const recent = await collectRecentDocuments(ctx, cwd, sessionId, spaceId);
        await panel.postMessage({ type: 'recentDocuments', cwd, documents: recent.documents, fallbackCwd: recent.fallbackCwd });
      } catch (error) {
        ctx.logger.warn(`Could not collect recent documents: ${String(error)}`);
        await panel.postMessage({ type: 'recentDocuments', cwd, documents: [] });
      }
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
    'loader-circle': {
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><g><path d="M12 3a9 9 0 1 0 9 9"/><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite"/></g></svg>',
    },
  }));

  ctx.subscriptions.push(ctx.ui.onDidOpenPanel((panel) => {
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
  set_style — apply an AI-designed custom CSS layout to the currently open Markdown Editor preview (requires css). Write plain CSS scoped under #bm-md using tag/id selectors (no classes), use !important where needed to override the base style, and take inspiration from bm.md's built-in styles: kami (warm paper), bauhaus (geometric primary colors), blueprint (technical grid), botanical (soft green), newsprint (editorial serif), retro (nostalgic), sketch (hand-drawn), terminal (monospace dark).`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'create', 'apply', 'set_style'], description: 'Operation to perform.' },
        path: { type: 'string', description: 'Absolute path to the Markdown file. Required for open, create, and apply. For create, the file must not already exist.' },
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
        slot: { type: 'number', enum: [1, 2, 3], description: 'Required for AI-designed styles: user-selected reusable custom style slot to overwrite.' },
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
          await rememberRecentPath(ctx, sourcePath);
          return result(`Applied reviewed Markdown to ${path.basename(sourcePath)}.`);
        } catch (error) {
          return result(`Could not apply revision: ${error instanceof Error ? error.message : String(error)}`, true);
        }
      }
      if (action === 'set_style') {
        const css = String(input.css ?? '').trim();
        if (!css) return result('`set_style` requires non-empty `css`.', true);
        if (!lastPanel) return result('No Markdown Editor panel is open. Ask the user to open a document first.', true);
        try {
          const label = String(input.label ?? '') || 'AI style';
          const slot = Number(input.slot);
          if (!Number.isInteger(slot) || slot < 1 || slot > STYLE_SLOT_COUNT) {
            return result('Ask the user which reusable custom style slot (1, 2, or 3) to overwrite, then call `set_style` again with that `slot`.', true);
          }
          const slots = await writeStyleSlot(ctx, slot - 1, { css, label });
          await lastPanel.postMessage({ type: 'customStyleSet', css, label, styleSlots: slots, savedSlot: slot - 1 });
          return result(`Custom style saved to slot ${slot} and applied to the open Markdown Editor panel.`);
        } catch (error) {
          return result(`Could not apply custom style: ${error instanceof Error ? error.message : String(error)}`, true);
        }
      }
      return result(`Unknown action: ${action}`, true);
    },
  }));

  ctx.logger.info('finch-markdown-editor activated');
}

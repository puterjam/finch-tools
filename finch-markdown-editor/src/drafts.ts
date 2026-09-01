import type * as finch from 'finch';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

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

export async function deleteDraft(ctx: finch.MiniToolContext, sourcePath: string): Promise<void> {
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

export function scheduleDraftWrite(ctx: finch.MiniToolContext, panelId: string, sourcePath: string, markdown: string, base: string | undefined): void {
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
export function flushPendingDraftWrite(ctx: finch.MiniToolContext, panelId: string): void {
  const entry = pendingDraftWrites.get(panelId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  pendingDraftWrites.delete(panelId);
  void writeDraft(ctx, entry.path, entry.markdown, entry.base);
}

/** Drops a pending write without persisting it — used when a real save or
 * an explicit discard has just made it stale, so it can't land afterward
 * and resurrect a draft for a file that was just handled. */
export function cancelPendingDraftWrite(panelId: string): void {
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
export async function readFileWithDraft(
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

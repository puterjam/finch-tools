import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ACCEPTED, type KnowledgeStore } from './store.js';
import { CHUNK_BYTES, MAX_UPLOAD_BYTES, UploadReceiver } from './uploads.js';

export interface ImportedFile { name: string; documentId: string; unchanged: boolean }

/** One thing the caller asked for; a tag makes it a classification request. */
export interface ImportRequest { path: string; tag?: string }
/** One file to index, after folders have been expanded. */
export interface ImportTarget { path: string; name: string; tag?: string }
export type SkipReason = 'hidden' | 'unsupported' | 'symlink' | 'notFile' | 'empty' | 'tooLarge' | 'limit';
/** Something found inside a folder that is not worth indexing. Counted, not fatal. */
export interface SkippedEntry { path: string; reason: SkipReason }
/** Something the caller asked for by name that cannot be used. Fatal for that request. */
export interface ImportFailure { path: string; error: Error }
export interface ExpandedImport { targets: ImportTarget[]; skipped: SkippedEntry[]; failures: ImportFailure[] }

/** One call never indexes more than this many files, so a stray folder cannot run away. */
export const MAX_BATCH_FILES = 200;

/** Everything an import is allowed to touch sits inside the session workspace, symlinks resolved. */
async function workspaceScope(cwd: string) {
  const root = resolve(cwd);
  const canonicalRoot = await realpath(root);
  const contains = (base: string, path: string): boolean => {
    const inside = relative(base, path);
    return inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
  };
  return { root, canonicalRoot, contains };
}

function usableSize(size: number): boolean {
  return size > 0 && size <= MAX_UPLOAD_BYTES;
}

/**
 * Turns the caller's requests into a flat list of files to index.
 *
 * Folders expand recursively. Anything inside a folder that cannot be indexed is
 * reported as a skip and never fails the call, while a path the caller named
 * directly reports its own error. Hidden entries (`.DS_Store`, drafts) and
 * symlinks are always passed over: the first is noise, the second could point
 * outside the workspace.
 */
export async function expandImportTargets(
  cwd: string,
  requests: ImportRequest[],
  options: { recursive?: boolean; maxFiles?: number } = {},
): Promise<ExpandedImport> {
  const recursive = options.recursive !== false;
  const maxFiles = Math.max(1, Math.min(options.maxFiles ?? MAX_BATCH_FILES, MAX_BATCH_FILES));
  const { root, canonicalRoot, contains } = await workspaceScope(cwd);
  const targets: ImportTarget[] = [];
  const skipped: SkippedEntry[] = [];
  const failures: ImportFailure[] = [];

  const walk = async (directory: string, tag?: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    // Sorted so the same folder always imports in the same order.
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (targets.length >= maxFiles) return;
      const full = join(directory, entry.name);
      if (entry.name.startsWith('.')) { skipped.push({ path: full, reason: 'hidden' }); continue; }
      if (entry.isSymbolicLink()) { skipped.push({ path: full, reason: 'symlink' }); continue; }
      if (entry.isDirectory()) { if (recursive) await walk(full, tag); continue; }
      if (!entry.isFile()) { skipped.push({ path: full, reason: 'notFile' }); continue; }
      const extension = extname(entry.name).toLowerCase();
      if (!ACCEPTED.includes(extension)) { skipped.push({ path: full, reason: 'unsupported' }); continue; }
      const info = await stat(full).catch(() => null);
      if (!info?.isFile()) { skipped.push({ path: full, reason: 'notFile' }); continue; }
      if (!usableSize(info.size)) { skipped.push({ path: full, reason: info.size <= 0 ? 'empty' : 'tooLarge' }); continue; }
      targets.push({ path: full, name: entry.name, tag });
    }
  };

  for (const request of requests) {
    const requested = typeof request.path === 'string' ? request.path : '';
    if (!requested.trim() || requested.includes('\0')) {
      failures.push({ path: requested, error: new Error('Specify a local file path.') });
      continue;
    }
    if (targets.length >= maxFiles) {
      skipped.push({ path: requested, reason: 'limit' });
      continue;
    }
    const selected = resolve(root, requested);
    if (!contains(root, selected)) {
      failures.push({ path: requested, error: new Error('The file must be inside the current workspace.') });
      continue;
    }
    const entry = await lstat(selected).catch(() => null);
    if (!entry) {
      failures.push({ path: requested, error: new Error(`ENOENT: ${requested}`) });
      continue;
    }
    if (entry.isSymbolicLink()) {
      failures.push({ path: requested, error: new Error('Choose a regular file, not a symbolic link.') });
      continue;
    }
    if (entry.isDirectory()) {
      // The real path is checked only to be sure the folder lives in the workspace; the
      // walk itself stays on the path as given, so results match the root the caller used
      // (on macOS /var and /private/var are the same folder under two names).
      const canonical = await realpath(selected).catch(() => null);
      if (!canonical || !contains(canonicalRoot, canonical)) {
        failures.push({ path: requested, error: new Error('The file must be inside the current workspace.') });
        continue;
      }
      const before = targets.length;
      await walk(selected, request.tag);
      if (targets.length === before && !skipped.some((item) => item.path.startsWith(selected))) {
        failures.push({ path: requested, error: new Error(`No importable files in ${basename(requested) || requested}.`) });
      }
      continue;
    }
    if (!entry.isFile()) {
      failures.push({ path: requested, error: new Error('Choose a regular file, not a symbolic link.') });
      continue;
    }
    const info = await stat(selected).catch(() => null);
    if (!info?.isFile() || !usableSize(info.size)) {
      failures.push({ path: requested, error: new Error('Choose a nonempty file smaller than 64 MB.') });
      continue;
    }
    const extension = extname(selected).toLowerCase();
    if (!ACCEPTED.includes(extension)) {
      failures.push({ path: requested, error: new Error(`Unsupported file type: ${extension || '(none)'}.`) });
      continue;
    }
    targets.push({ path: selected, name: basename(selected), tag: request.tag });
  }
  return { targets, skipped, failures };
}

/** Agent imports use the same managed-copy and rollback path as the App View. */
export async function importFromWorkspace(
  storagePath: string,
  store: KnowledgeStore,
  cwd: string,
  file: string,
  tagId: string,
  progress?: (received: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ImportedFile> {
  if (typeof file !== 'string' || !file.trim() || file.includes('\0')) throw new Error('Specify a local file path.');
  const { root, canonicalRoot, contains } = await workspaceScope(cwd);
  const selected = resolve(root, file);
  if (!contains(root, selected)) throw new Error('The file must be inside the current workspace.');
  if (!(await lstat(selected)).isFile()) throw new Error('Choose a regular file, not a symbolic link.');
  const source = await realpath(selected);
  if (!contains(canonicalRoot, source)) {
    throw new Error('The file must be inside the current workspace.');
  }
  return importFromPath(storagePath, store, selected, tagId, progress, signal);
}

/**
 * Indexes one absolute file and keeps a managed copy. Callers decide what paths they are
 * willing to reach: a workspace import checks containment first, while a sync only ever
 * follows a source the user already imported.
 */
export async function importFromPath(
  storagePath: string,
  store: KnowledgeStore,
  selected: string,
  tagId: string,
  progress?: (received: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ImportedFile> {
  if (!(await lstat(selected).catch(() => null))?.isFile()) throw new Error('Choose a regular file, not a symbolic link.');
  const handle = await open(selected, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const receiver = new UploadReceiver(storagePath, store);
  try {
    const info = await handle.stat();
    if (!info.isFile() || !usableSize(info.size)) throw new Error('Choose a nonempty file smaller than 64 MB.');
    const name = basename(selected);
    await receiver.begin(name, info.size, tagId);
    let received = 0;
    for await (const chunk of handle.createReadStream({ highWaterMark: CHUNK_BYTES, autoClose: false, signal })) {
      if (signal?.aborted) throw new Error('File import cancelled.');
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      await receiver.chunk(bytes.toString('base64'));
      received += bytes.length;
      progress?.(received, info.size);
    }
    if (signal?.aborted) throw new Error('File import cancelled.');
    // The file it came from is the source a later sync follows; the copy is only the index target.
    return await receiver.finish(selected);
  } catch (error) {
    await receiver.abort();
    throw error;
  } finally {
    await handle.close().catch(() => {});
  }
}

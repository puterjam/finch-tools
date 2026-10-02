import { mkdir, readdir, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { KnowledgeStore } from './store.js';

/** Library data files. Engine caches are deliberately excluded: they are local and re-downloadable. */
const DATA_ENTRIES = ['catalog.sqlite', 'vectors.lance', 'imports'];

export interface LibraryStats { documents: number; tags: number; managed: number; missing: number }
export interface LibraryInfo extends LibraryStats { root: string; isDefault: boolean }
/**
 * Callers ask for a location, never for a verb: the folder decides what happens. An existing
 * library in the chosen folder is opened where it lies; an empty folder becomes the new home of
 * the current library. Engines are excluded from the copy either way.
 */
export type LibraryAction = 'choose';
export type LibraryOutcome = 'open' | 'move';

export function within(base: string, target: string): boolean {
  const path = relative(base, target);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Managed copies are stored under `<root>/imports`, so their recorded path moves with the library. */
export function rebaseImportPath(path: string, root: string): string | null {
  const match = /(?:^|[/\\])imports[/\\](.+)$/.exec(path);
  const tail = match?.[1];
  if (!tail) return null;
  const parts = tail.split(/[/\\]+/).filter((part) => part && part !== '.');
  if (!parts.length || parts.includes('..')) return null;
  return join(root, 'imports', ...parts);
}

export async function hasLibrary(directory: string): Promise<boolean> {
  return (await stat(join(directory, 'catalog.sqlite')).catch(() => null))?.isFile() ?? false;
}

export async function directoryEntries(directory: string): Promise<string[]> {
  return readdir(directory).catch(() => [] as string[]);
}

/** Read-only inspection; used both before and after a switch to prove nothing was lost. */
export async function inspectLibrary(root: string): Promise<LibraryStats> {
  const catalog = new DatabaseSync(join(root, 'catalog.sqlite'));
  try {
    const documents = (catalog.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n;
    const tags = (catalog.prepare('SELECT COUNT(*) AS n FROM tags').get() as { n: number }).n;
    const rows = catalog.prepare('SELECT path FROM documents').all() as Array<{ path: string }>;
    let managed = 0;
    let missing = 0;
    for (const row of rows) {
      if (rebaseImportPath(row.path, root)) managed++;
      if (!(await stat(row.path).catch(() => null))?.isFile()) missing++;
    }
    return { documents, tags, managed, missing };
  } finally { catalog.close(); }
}

/** Rewrites managed-copy paths so a copied or imported library points at its new home. */
export async function rebaseStoredPaths(catalogPath: string, root: string): Promise<number> {
  const catalog = new DatabaseSync(catalogPath);
  try {
    const rows = catalog.prepare('SELECT id, path FROM documents').all() as Array<{ id: string; path: string }>;
    const update = catalog.prepare('UPDATE documents SET path = ? WHERE id = ?');
    let rebased = 0;
    catalog.exec('BEGIN');
    try {
      for (const row of rows) {
        const next = rebaseImportPath(row.path, root);
        if (next && next !== row.path) { update.run(next, row.id); rebased++; }
      }
      catalog.exec('COMMIT');
    } catch (error) { catalog.exec('ROLLBACK'); throw error; }
    return rebased;
  } finally { catalog.close(); }
}

/**
 * Validates a chosen directory and rejects targets that would destroy or nest data. A folder that
 * already holds a library passes; any other folder has to be empty, so a stray catalogue is never
 * dropped into a folder full of unrelated files.
 */
export async function assertUsableTarget(directory: string, currentRoot: string): Promise<string> {
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('Choose a library directory.');
  const target = resolve(directory.trim());
  if (!isAbsolute(directory.trim())) throw new Error('Choose an absolute library directory.');
  const root = resolve(currentRoot);
  if (target === root) throw new Error('This is already the working library directory.');
  if (within(root, target) || within(target, root)) throw new Error('The library directory cannot contain or sit inside the current one.');
  const info = await stat(target).catch(() => null);
  if (info && !info.isDirectory()) throw new Error('Choose a directory, not a file.');
  if (!(await hasLibrary(target)) && info) {
    const entries = (await directoryEntries(target)).filter((entry) => !entry.startsWith('.'));
    if (entries.length) throw new Error('That folder is neither a library nor empty.');
  }
  return target;
}

/** Turns "the user picked a folder" into the operation that folder actually needs. */
export async function resolveLibraryAction(directory: string): Promise<LibraryOutcome> {
  return (await hasLibrary(directory)) ? 'open' : 'move';
}

export async function createEmptyLibrary(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const store = new KnowledgeStore(root);
  await store.close();
}

/** Copies the current library into a directory, then repoints the copies at their new home. */
export async function relocateLibrary(store: KnowledgeStore, target: string): Promise<LibraryStats> {
  await mkdir(target, { recursive: true });
  await store.copyLibraryTo(target);
  await rebaseStoredPaths(join(target, 'catalog.sqlite'), target);
  return inspectLibrary(target);
}

/** Opens an existing library in place, fixing managed-copy paths that came from another location. */
export async function adoptExistingLibrary(root: string): Promise<LibraryStats> {
  await rebaseStoredPaths(join(root, 'catalog.sqlite'), root);
  return inspectLibrary(root);
}

export { DATA_ENTRIES };

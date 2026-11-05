import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { KnowledgeStore, type LibraryOptions } from './store.js';

const openings = new Map<string, Promise<void>>();

/** Rebuild only recognized legacy catalogues. Back up the entire old index, never source files. */
export async function openIndexWithRebuild(index: string, options: LibraryOptions): Promise<KnowledgeStore> {
  const key = process.platform === 'win32' ? resolve(index).toLowerCase() : resolve(index);
  const previous = openings.get(key) ?? Promise.resolve();
  const opening = previous.then(async () => {
    // Preparation shares the rebuild lock: another opener must not recreate the directory
    // between backing up a legacy index and creating its replacement.
    await options.sourceGuard?.();
    const entry = await lstat(index).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error('.knowledge must be a regular directory.');
    await mkdir(index, { recursive: true });
    for (const name of ['catalog.sqlite', 'catalog.sqlite-wal', 'catalog.sqlite-shm', 'vectors.lance']) {
      const data = await lstat(join(index, name)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      if (data?.isSymbolicLink()) throw new Error('Knowledge index data must not be a symbolic link.');
    }
    try { return new KnowledgeStore(index, options); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'KNOWLEDGE_LEGACY_INDEX') throw error;
    }
    await options.sourceGuard?.();
    const suffix = `${Date.now()}-${randomUUID()}`;
    const backup = join(dirname(index), `${basename(index)}-backup-${suffix}`);
    await rename(index, backup);
    let created = false;
    try {
      await mkdir(index); created = true;
      const store = new KnowledgeStore(index, options);
      store.rebuiltIndex = true;
      return store;
    } catch (error) {
      // A failed new catalogue is recoverable too. Never overwrite a directory created elsewhere.
      if (created) await rename(index, join(dirname(index), `${basename(index)}-failed-${suffix}`));
      const current = await lstat(index).catch((failure: NodeJS.ErrnoException) => {
        if (failure.code === 'ENOENT') return null;
        throw failure;
      });
      if (!current) await rename(backup, index);
      throw error;
    }
  });
  const settled = opening.then(() => {}, () => {});
  openings.set(key, settled);
  try { return await opening; }
  finally { if (openings.get(key) === settled) openings.delete(key); }
}

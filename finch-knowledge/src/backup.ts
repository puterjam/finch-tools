import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import type { KnowledgeStore, TagSummary } from './store.js';

export interface BackupSource { id: string; name: string; originalPath: string; archivePath?: string }
export interface BackupFile { path: string; bytes: number; sha256: string }
export interface BackupManifest {
  format: 'finch-knowledge-snapshot';
  version: 1;
  createdAt: string;
  documents: number;
  tags: Array<Pick<TagSummary, 'id' | 'name'>>;
  sources: BackupSource[];
  missingSources: BackupSource[];
  files: BackupFile[];
}
export interface BackupResult { path: string; documentCount: number; missingSources: BackupSource[] }

function within(base: string, target: string): boolean {
  const path = relative(base, target);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function collectFiles(root: string, directory = root): Promise<BackupFile[]> {
  const files: BackupFile[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('A snapshot contains a symbolic link.');
    if (entry.isDirectory()) files.push(...await collectFiles(root, path));
    else if (entry.isFile()) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      files.push({ path: relative(root, path).split(sep).join('/'), bytes: (await stat(path)).size, sha256: hash.digest('hex') });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** A finished directory is published only after every file and the manifest are complete. */
export async function createLibraryBackup(
  store: KnowledgeStore,
  libraryRoot: string,
  chosenDirectory: string,
  progress?: (step: string) => void,
): Promise<BackupResult> {
  if (!isAbsolute(chosenDirectory)) throw new Error('Choose an absolute backup directory.');
  const root = await realpath(chosenDirectory);
  if (!(await stat(root)).isDirectory()) throw new Error('Choose a backup directory.');
  const library = await realpath(libraryRoot);
  if (within(library, root)) throw new Error('The backup directory cannot be inside the live library.');
  const id = randomUUID();
  const staging = join(root, `.finch-knowledge-${id}.partial`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const final = join(root, `finch-knowledge-${stamp}-${id.slice(0, 8)}`);
  await mkdir(staging);
  try {
    progress?.('snapshot');
    const { documents, tags } = await store.copyLibraryTo(staging);
    const sources: BackupSource[] = [];
    const missingSources: BackupSource[] = [];
    const managed = join(library, 'imports') + sep;
    for (const doc of documents) {
      const source: BackupSource = { id: doc.id, name: doc.name, originalPath: doc.path };
      if (doc.path.startsWith(managed)) {
        const stored = join(staging, 'imports', relative(managed, doc.path));
        if ((await stat(stored).catch(() => null))?.isFile()) source.archivePath = relative(staging, stored).split(sep).join('/');
      } else {
        const file = await stat(doc.path).catch(() => null);
        if (file?.isFile()) {
          const target = join(staging, 'external', `${doc.id}${extname(doc.name) || extname(doc.path)}`);
          await mkdir(join(staging, 'external'), { recursive: true });
          await copyFile(doc.path, target);
          source.archivePath = relative(staging, target).split(sep).join('/');
        }
      }
      sources.push(source);
      if (!source.archivePath) missingSources.push(source);
    }
    progress?.('verify');
    const manifest: BackupManifest = {
      format: 'finch-knowledge-snapshot', version: 1, createdAt: new Date().toISOString(),
      documents: documents.length, tags: tags.map(({ id, name }) => ({ id, name })),
      sources, missingSources, files: await collectFiles(staging),
    };
    // The manifest is intentionally written last. Incomplete cloud-sync transfers are not valid snapshots.
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    await rename(staging, final);
    return { path: final, documentCount: documents.length, missingSources };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

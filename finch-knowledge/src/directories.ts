export interface IndexedDirectory { path: string; parent: string | null; name: string; count: number }
export const TAG_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'] as const;

/** Directory identifiers are relative catalogue paths, never filesystem commands. */
export function directoryKey(path: string): string {
  if (!path || path.startsWith('/') || /^[a-z]:/i.test(path) || path.includes('\\') || path.includes('\0')) throw new Error('Invalid indexed directory.');
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('Invalid indexed directory.');
  return parts.join('/');
}
export function insideDirectory(relativePath: string, directory: string | null): boolean {
  return directory === null || relativePath.startsWith(`${directoryKey(directory)}/`);
}
/** Merge source folders (including empty ones) with committed index paths and index counts. */
export function indexedDirectories(paths: string[], folders: string[] = []): IndexedDirectory[] {
  const root: IndexedDirectory = { path: '', parent: null, name: '', count: paths.length };
  const entries = new Map<string, IndexedDirectory>([['', root]]);
  for (const path of paths) {
    const parts = path.split('/');
    let parent = '';
    for (const name of parts.slice(0, -1)) {
      const current = parent ? `${parent}/${name}` : name;
      const entry = entries.get(current) ?? { path: current, parent, name, count: 0 };
      entry.count++;
      entries.set(current, entry);
      parent = current;
    }
  }
  for (const folder of folders) {
    let parent = '';
    for (const name of directoryKey(folder).split('/')) {
      const path = parent ? `${parent}/${name}` : name;
      if (!entries.has(path)) entries.set(path, { path, parent, name, count: 0 });
      parent = path;
    }
  }
  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

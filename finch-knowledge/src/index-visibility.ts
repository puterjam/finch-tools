import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
interface VisibilityOptions {
  platform?: NodeJS.Platform;
  run?: (command: string, args: string[]) => Promise<unknown>;
}

/** Hide only the index directory itself. Never recurse, set System, or change source attributes. */
export async function hideKnowledgeDirectory(directory: string, options: VisibilityOptions = {}): Promise<boolean> {
  if (basename(directory).toLowerCase() !== '.knowledge') return false;
  if ((options.platform ?? process.platform) !== 'win32') return true;
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    const command = join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'System32', 'attrib.exe');
    const run = options.run ?? ((file: string, args: string[]) => execute(file, args, { windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024 }));
    await run(command, ['+H', directory]);
    return true;
  } catch {
    // Visibility is cosmetic: unsupported attributes or permissions must not prevent indexing.
    return false;
  }
}

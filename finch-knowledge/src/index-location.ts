import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { posix, win32, join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export interface SourceFilesystem { network: boolean; identity: string }
export interface FilesystemProbe {
  run?: (command: string, args: string[]) => Promise<string>;
  read?: (path: string) => Promise<string>;
}
const runCommand = async (command: string, args: string[]): Promise<string> => {
  try { return (await execute(command, args, { timeout: 8000, maxBuffer: 1024 * 1024, windowsHide: true })).stdout; }
  catch { throw new Error('Unable to determine the source filesystem. Reconnect the mounted drive and retry.'); }
};
const networkTypes = new Set(['smbfs', 'cifs', 'smb3', 'nfs', 'nfs4', 'afpfs', 'webdav', 'davfs', 'davfs2', 'fuse.sshfs', 'fuse.rclone', 'fuse.smbnetfs', '9p']);
const decodeMount = (value: string) => value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
const within = (mount: string, root: string) => root === mount || root.startsWith(mount.endsWith('/') ? mount : `${mount}/`);
interface WindowsDrive { type?: number; root?: string }
const fixedWindowsDrives = new Map<string, Promise<WindowsDrive>>();

/** The selected share and its subdirectory, not a reusable drive letter, identify remote indexes. */
export async function inspectSourceFilesystem(root: string, platform: NodeJS.Platform = process.platform, probe: FilesystemProbe = {}): Promise<SourceFilesystem> {
  const run = probe.run ?? runCommand;
  if (platform === 'win32') {
    const normal = win32.normalize(root).replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\(?=[a-z]:\\)/i, '');
    if (normal.startsWith('\\\\') && !normal.startsWith('\\\\?\\') && !normal.startsWith('\\\\.\\')) return { network: true, identity: `smb:${normal.toLowerCase().replace(/\\+$/, '')}` };
    const drive = /^[a-z]:/i.exec(normal)?.[0].toUpperCase();
    if (!drive) throw new Error('Unable to determine the source filesystem. Reconnect the mounted drive and retry.');
    let pending = !probe.run ? fixedWindowsDrives.get(drive) : undefined;
    if (!pending) {
      pending = (async (): Promise<WindowsDrive> => {
        // Only the validated two-character drive ID enters this script, never a source filename.
        const script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'" -ErrorAction Stop; if ($null -eq $d) { throw 'Drive unavailable' }; @{ type = [int]$d.DriveType; root = [string]$d.ProviderName } | ConvertTo-Json -Compress`;
        return JSON.parse((await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])).trim()) as WindowsDrive;
      })();
      if (!probe.run) fixedWindowsDrives.set(drive, pending);
    }
    let value: WindowsDrive;
    try { value = await pending; }
    catch (error) { fixedWindowsDrives.delete(drive); throw error; }
    // Retain only fixed-drive metadata, never a network mapping or a subdirectory identity.
    if (value.type === 4) {
      fixedWindowsDrives.delete(drive);
      if (typeof value.root !== 'string' || !value.root.startsWith('\\\\')) throw new Error('Network share identity is unavailable.');
      const source = win32.join(value.root, win32.relative(`${drive}\\`, normal));
      return { network: true, identity: `smb:${source.toLowerCase().replace(/\\+$/, '')}` };
    }
    if (![2, 3, 5, 6].includes(value.type ?? -1)) { fixedWindowsDrives.delete(drive); throw new Error('Drive type is unavailable.'); }
    return { network: false, identity: normal.toLowerCase() };
  }
  const mounts: Array<{ path: string; source: string; type: string; subroot?: string }> = [];
  if (platform === 'darwin') {
    for (const line of (await run('/sbin/mount', [])).split('\n')) {
      const match = /^(.*?) on (.*?) \(([^,)]+)/.exec(line);
      if (match) mounts.push({ source: decodeMount(match[1]!), path: decodeMount(match[2]!), type: match[3]!.trim() });
    }
  } else if (platform === 'linux') {
    const data = await (probe.read ?? (path => readFile(path, 'utf8')))('/proc/self/mountinfo');
    for (const line of data.split('\n')) {
      const [left, right] = line.split(' - ');
      const fields = left?.split(' '), details = right?.split(' ');
      if (fields?.[4] && details?.[0] && details?.[1]) mounts.push({ path: decodeMount(fields[4]), subroot: decodeMount(fields[3] ?? '/'), type: details[0], source: decodeMount(details[1]) });
    }
  } else throw new Error('Unable to determine the source filesystem on this platform.');
  const mount = mounts.filter(entry => within(entry.path, root)).sort((a, b) => b.path.length - a.path.length)[0];
  if (!mount) throw new Error('Unable to determine the source filesystem. Reconnect the mounted drive and retry.');
  const selected = posix.relative(mount.path, root);
  const subdirectory = mount.subroot ? posix.join(mount.subroot, selected) : selected;
  return { network: networkTypes.has(mount.type), identity: `${mount.type}:${mount.source}:${subdirectory}` };
}

export function remoteIndexKey(identity: string): string {
  // A 128-bit opaque key keeps native Windows vector-file paths below legacy path limits.
  return createHash('sha256').update(identity).digest('hex').slice(0, 32);
}
export function remoteIndexRoot(cachePath: string, key: string): string {
  if (!/^[a-f0-9]{32}$/.test(key)) throw new Error('Invalid remote index identity.');
  return join(cachePath, 'remote', key);
}

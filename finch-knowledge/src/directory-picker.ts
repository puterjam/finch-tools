import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sep, win32 } from 'node:path';
import { windowsDirectoryScript } from './windows-directory-dialog.js';

const execute = promisify(execFile);
export interface PickerCommand { command: string; args: string[] }

/** Parameters are data, never executable PowerShell/AppleScript source. */
export function directoryPickerCommand(platform: string, title: string, previous = ''): PickerCommand {
  if (platform === 'win32') {
    const script = windowsDirectoryScript(title, previous);
    return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] };
  }
  if (platform === 'darwin') return {
    command: 'osascript', args: ['-e', 'on run argv', '-e', 'POSIX path of (choose folder with prompt (item 1 of argv))', '-e', 'end run', '--', title],
  };
  return { command: 'zenity', args: ['--file-selection', '--directory', '--title', title, ...(previous ? ['--filename', previous.endsWith(sep) ? previous : previous + sep] : [])] };
}

/** Parse only the picker's framed payload; PowerShell output must never become a filename. */
function windowsDirectoryResult(stdout: string): string | null {
  const lines = stdout.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const cancelled = lines.filter(line => line === 'FINCH_DIRECTORY_CANCELLED');
  const responses = lines.filter(line => line.startsWith('FINCH_DIRECTORY:'));
  if (cancelled.length === 1 && responses.length === 0) return null;
  if (responses.length !== 1 || cancelled.length) throw new Error('INVALID_DIRECTORY_PICKER_RESPONSE');
  const encoded = responses[0]!.slice('FINCH_DIRECTORY:'.length);
  const bytes = Buffer.from(encoded, 'base64');
  if (!encoded || bytes.toString('base64') !== encoded) throw new Error('INVALID_DIRECTORY_PICKER_RESPONSE');
  const path = bytes.toString('utf8');
  if (!Buffer.from(path, 'utf8').equals(bytes) || /[\x00-\x1f]/.test(path)) throw new Error('INVALID_DIRECTORY_PICKER_RESPONSE');
  const normalized = win32.normalize(path);
  const drive = /^(?:\\\\\?\\)?[a-z]:\\/i.test(normalized);
  const unc = /^(?:\\\\\?\\UNC\\|\\\\(?![?.]\\))[^\\]+\\[^\\]+(?:\\|$)/i.test(normalized);
  if (!win32.isAbsolute(normalized) || (!drive && !unc)) throw new Error('INVALID_DIRECTORY_PICKER_RESPONSE');
  return normalized;
}

/** Cancellation is a no-op; unavailable desktop pickers fail visibly, never request typed paths. */
export async function pickDirectory(title: string, previous = '', run = execute, platform = process.platform): Promise<string | null> {
  const command = directoryPickerCommand(platform, title, previous);
  try {
    const { stdout } = await run(command.command, command.args, { encoding: 'utf8', windowsHide: true, timeout: 600_000, maxBuffer: 1024 * 1024 });
    if (platform === 'win32') return windowsDirectoryResult(String(stdout));
    return String(stdout).replace(/^\uFEFF/, '').trim() || null;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (platform === 'darwin' && String(error).includes('-128')) return null;
    if (platform !== 'darwin' && platform !== 'win32' && Number(failure.code) === 1) return null;
    if (platform !== 'darwin' && platform !== 'win32' && failure.code === 'ENOENT') {
      try {
        const { stdout } = await run('kdialog', ['--getexistingdirectory', previous || '.', '--title', title], { encoding: 'utf8', timeout: 600_000, maxBuffer: 1024 * 1024 });
        return String(stdout).trim() || null;
      } catch (fallback) {
        if (Number((fallback as NodeJS.ErrnoException).code) === 1) return null;
        throw fallback;
      }
    }
    throw error;
  }
}

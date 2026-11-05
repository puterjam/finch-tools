import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { win32 } from 'node:path';
import { directoryPickerCommand, pickDirectory } from '../dist/index.js';

test('Windows opens a native folder browser in STA mode with safe Unicode parameters', () => {
  const title = "选择目录 ' ; throw 'not code'";
  const previous = 'C:\\资料\\目录 A';
  const command = directoryPickerCommand('win32', title, previous);
  assert.equal(command.command, 'powershell.exe');
  assert.ok(command.args.includes('-STA'));
  const script = Buffer.from(command.args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /interface IFileDialog/);
  assert.match(script, /dialog\.Show\(owner\)/);
  assert.match(script, /SIGDN_FILESYSPATH/);
  assert.match(script, /FINCH_DIRECTORY:/);
  assert.match(script, /\[void\]\$owner\.Activate\(\)/);
  assert.doesNotMatch(script, /FolderBrowserDialog/);
  assert.ok(script.includes(Buffer.from(title, 'utf8').toString('base64')));
  assert.ok(script.includes(Buffer.from(previous, 'utf8').toString('base64')));
  assert.equal(script.includes(title), false, 'user text is never executable PowerShell');
});

test('selection returns the exact Unicode path, cancellation never asks for typed input', async () => {
  const selected = await pickDirectory('Choose', '', async () => ({ stdout: '\uFEFFTrue\r\nFINCH_DIRECTORY:' + Buffer.from('C:\\资料\\A B').toString('base64') + '\r\n' }), 'win32');
  assert.equal(selected, 'C:\\资料\\A B');
  assert.equal(await pickDirectory('Choose', '', async () => ({ stdout: '' }), 'win32'), null);
  await assert.rejects(pickDirectory('Choose', '', async () => { throw new Error('Picker unavailable'); }, 'win32'), /Picker unavailable/);
});

test('macOS and Linux use native desktop directory pickers, including dismissal', async () => {
  assert.equal(directoryPickerCommand('darwin', 'Choose').command, 'osascript');
  assert.ok(directoryPickerCommand('linux', 'Choose').args.includes('--directory'));
  assert.equal(await pickDirectory('Choose', '', async () => { throw Object.assign(new Error('cancel'), { code: 1 }); }, 'linux'), null);
  const calls = [];
  assert.equal(await pickDirectory('Choose', '', async command => {
    calls.push(command);
    if (command === 'zenity') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { stdout: '/home/test/docs\n' };
  }, 'linux'), '/home/test/docs');
  assert.deepEqual(calls, ['zenity', 'kdialog']);
});

const payload = path => 'FINCH_DIRECTORY:' + Buffer.from(path, 'utf8').toString('base64');
for (const path of ['C:\\', 'D:\\资料\\Folder A', 'Z:\\工作', '\\\\NAS\\资料', '\\\\NAS\\资料\\工作 A', '\\\\?\\UNC\\nas\\资料\\工作', '\\\\?\\C:\\资料', 'C:/资料/Folder A']) {
  test(`Windows picker accepts a fully qualified filesystem location: ${path}`, async () => {
    const selected = await pickDirectory('Choose', '', async () => ({ stdout: '\uFEFFstartup output\r\n' + payload(path) }), 'win32');
    assert.equal(selected, win32.normalize(path));
    assert.equal(win32.isAbsolute(selected), true);
  });
}
for (const path of ['relative\\folder', 'C:folder', '\\folder', 'smb://nas/share', '\\\\.\\PhysicalDrive0', '\\\\nas', 'C:\\bad\u0000name']) {
  test(`Windows picker rejects invalid paths without loosening the absolute path guard: ${JSON.stringify(path)}`, async () => {
    await assert.rejects(pickDirectory('Choose', '', async () => ({ stdout: payload(path) }), 'win32'), /INVALID_DIRECTORY_PICKER_RESPONSE/);
  });
}
test('Windows cancellation is explicit and stray stdout cannot masquerade as a path', async () => {
  assert.equal(await pickDirectory('Choose', '', async () => ({ stdout: 'True\r\nFINCH_DIRECTORY_CANCELLED' }), 'win32'), null);
  for (const stdout of ['True', 'FINCH_DIRECTORY:!', payload('C:\\A') + '\n' + payload('C:\\B'), 'FINCH_DIRECTORY_CANCELLED\n' + payload('C:\\A')]) {
    await assert.rejects(pickDirectory('Choose', '', async () => ({ stdout }), 'win32'), /INVALID_DIRECTORY_PICKER_RESPONSE/);
  }
});
test('Windows Shell interop declarations compile on the native runtime without opening a picker', { skip: process.platform !== 'win32' }, () => {
  const script = Buffer.from(directoryPickerCommand('win32', 'Choose').args.at(-1), 'base64').toString('utf16le');
  const declaration = script.match(/Add-Type -TypeDefinition @'\n([\s\S]*?)\n'@/)[0];
  const encoded = Buffer.from(`$ErrorActionPreference = 'Stop'\n${declaration}`, 'utf16le').toString('base64');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], { timeout: 30000, windowsHide: true });
});

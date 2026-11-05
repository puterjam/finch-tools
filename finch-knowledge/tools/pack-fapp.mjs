import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { crc32, deflateRawSync } from 'node:zlib';
import { normalizeFappPaths } from './fapp-paths.mjs';

// Pack a trusted npm release tarball, not a source tree. Never auto-install or grant permissions.
const [tarball, destination] = process.argv.slice(2);
assert.ok(tarball && destination, 'Usage: node tools/pack-fapp.mjs release.tgz output.fapp');
const stage = await mkdtemp(join(tmpdir(), 'knowledge-fapp-'));
try {
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xf', resolve(tarball), '-C', stage]);
  const root = join(stage, 'package'), files = [];
  async function walk(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), info = await lstat(path);
      assert.ok(!info.isSymbolicLink(), 'Symlinks cannot be packaged');
      if (info.isDirectory()) await walk(path);
      else {
        assert.ok(info.isFile());
        const name = relative(root, path).split('\\').join('/');
        assert.ok(!/(^|\/)(src|tools|node_modules|\.git|\.env[^/]*)(\/|$)/.test(name), 'Only bundled runtime assets may be packaged');
        files.push({ name, data: await readFile(path) });
      }
    }
  }
  await walk(root);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const finch = manifest.finch ?? JSON.parse(await readFile(join(root, 'finch.json'), 'utf8'));
  for (const path of [finch.main, finch.contributes?.appView?.source?.path].filter(Boolean)) assert.ok(files.some(file => file.name === path), `Missing runtime entry ${path}`);
  const local = [], central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8'), packed = deflateRawSync(file.data), checksum = crc32(file.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8); header.writeUInt16LE(0x21, 12); header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(file.data.length, 22); header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x314, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8); record.writeUInt16LE(8, 10); record.writeUInt16LE(0x21, 14);
    record.writeUInt32LE(checksum, 16); record.writeUInt32LE(packed.length, 20); record.writeUInt32LE(file.data.length, 24);
    record.writeUInt16LE(name.length, 28); record.writeUInt32LE((0o100644 * 65536) >>> 0, 38); record.writeUInt32LE(offset, 42);
    local.push(header, name, packed); central.push(record, name); offset += header.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const bytes = Buffer.concat([...local, directory, end]);
  const checked = normalizeFappPaths(bytes);
  assert.ok(checked.bytes.equals(bytes), 'ZIP paths must already use portable forward slashes');
  assert.equal(checked.entries.length, files.length);
  for (const entry of checked.entries) assert.equal(entry.sha256, createHash('sha256').update(files.find(file => file.name === entry.name).data).digest('hex'));
  await writeFile(resolve(destination), bytes, { flag: 'wx' });
  console.log(JSON.stringify({ path: resolve(destination), version: manifest.version, files: files.length, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), verified: true }, null, 2));
} finally { await rm(stage, { recursive: true, force: true }); }

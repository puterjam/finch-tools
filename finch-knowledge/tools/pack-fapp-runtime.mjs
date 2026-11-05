import { lstat, readdir, readFile, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const LIMITS = { entries: 10_000, file: 32 * 1024 ** 2, total: 256 * 1024 ** 2, archive: 128 * 1024 ** 2 };
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Archive names are POSIX paths regardless of the build machine's OS.
export function archiveName(parts) {
  if (parts.some((part) => !part || part === '.' || part === '..'
    || /[\\\x00-\x1f\x7f:*?"<>|/]/.test(part) || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)
    || /^(?:\.git|\.env(?:\..*)?|\.enabled|\.finch-id|\.bundled|\.DS_Store)$/i.test(part))) {
    throw new Error(`Unsafe package path: ${parts.join('/')}`);
  }
  const name = parts.join('/');
  if (name.length > 1024) throw new Error('Package path is too long');
  return name;
}

export async function packFapp(root, output) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (Object.keys(pkg.dependencies ?? {}).length) throw new Error('Bundle runtime dependencies before packaging');
  if (!Array.isArray(pkg.files)) throw new Error('package.json must declare a runtime files allowlist');
  const files = new Map();
  const spelling = new Map();
  let total = 0;
  async function collect(parts) {
    const name = archiveName(parts);
    const path = join(root, ...parts);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`Unsupported file: ${name}`);
    const folded = name.normalize('NFC').toLowerCase();
    if (spelling.has(folded) && spelling.get(folded) !== name) throw new Error(`Case collision: ${name}`);
    spelling.set(folded, name);
    if (stat.isDirectory()) {
      for (const child of (await readdir(path)).sort()) await collect([...parts, child]);
      return;
    }
    if (files.has(name)) return;
    if (files.size >= LIMITS.entries || stat.size > LIMITS.file || (total += stat.size) > LIMITS.total) {
      throw new Error('Package exceeds Finch size limits');
    }
    const data = await readFile(path);
    if (data.length !== stat.size) throw new Error(`File changed during packaging: ${name}`);
    files.set(name, { data, executable: Boolean(stat.mode & 0o111) });
  }
  for (const entry of new Set(['package.json', ...pkg.files])) {
    if (typeof entry !== 'string') throw new Error('Invalid files allowlist');
    const parts = entry.replace(/\/$/, '').split('/');
    archiveName(parts);
    // Optional allowlist assets may be absent; an existing directory's errors must propagate.
    try { await lstat(join(root, ...parts)); } catch (error) {
      if (error.code === 'ENOENT' && entry !== 'package.json') continue;
      throw error;
    }
    await collect(parts);
  }
  const manifest = pkg.finch ?? JSON.parse(files.get('finch.json')?.data.toString() ?? 'null');
  if (!manifest || !pkg.name || !pkg.version) throw new Error('Missing package identity or Finch manifest');
  for (const required of [manifest.main ?? pkg.main,
    ...[manifest.contributes?.appView, manifest.contributes?.appPanel]
      .filter((view) => view?.source?.type === 'local').map((view) => view.source.path)]) {
    if (!required || !files.has(required)) throw new Error(`Missing runtime entry: ${required}`);
  }
  const local = [], central = [];
  let offset = 0;
  for (const [name, { data, executable }] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const filename = Buffer.from(name, 'utf8');
    const body = deflateRawSync(data);
    const checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8; no encryption or data descriptor.
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(33, 12); // 1980-01-01, fixed for reproducibility.
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(0x0314, 4); // Unix file attributes, ZIP 2.0.
    header.copy(record, 6, 4, 30);
    record.writeUInt32LE(((executable ? 0o100700 : 0o100600) << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    local.push(header, filename, body);
    central.push(record, filename);
    offset += header.length + filename.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  const archive = Buffer.concat([...local, directory, end]);
  if (archive.length > LIMITS.archive) throw new Error('Compressed package exceeds Finch size limits');
  // Never replace an existing installer or follow an output symlink.
  const handle = await open(output, 'wx');
  try { await handle.writeFile(archive); } finally { await handle.close(); }
  return { output, entries: files.size, bytes: archive.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const output = resolve(process.argv[2] ?? join(root, '..', `${pkg.name}-${pkg.version}-fixed.fapp`));
  console.log(JSON.stringify(await packFapp(root, output)));
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

/** Repair legacy Windows ZIP separators only; never relax path or file-type checks. */
export function normalizeFappPaths(input) {
  assert.ok(input.length >= 22 && input.length <= 128 * 1024 * 1024, 'Invalid archive size');
  const output = Buffer.from(input);
  let end = input.length - 22;
  while (end >= Math.max(0, input.length - 65557) && input.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0 && input.readUInt32LE(end) === 0x06054b50, 'Missing ZIP directory');
  assert.equal(end + 22 + input.readUInt16LE(end + 20), input.length, 'Invalid ZIP comment');
  assert.equal(input.readUInt16LE(end + 4), 0, 'Multipart ZIP is unsupported');
  assert.equal(input.readUInt16LE(end + 6), 0, 'Multipart ZIP is unsupported');
  const count = input.readUInt16LE(end + 10), start = input.readUInt32LE(end + 16);
  assert.ok(count > 0 && count < 10000);
  assert.equal(input.readUInt16LE(end + 8), count);
  assert.equal(start + input.readUInt32LE(end + 12), end, 'Invalid ZIP directory bounds');
  const entries = [], seen = new Set(), spans = [];
  let cursor = start, total = 0;
  for (let index = 0; index < count; index++) {
    assert.equal(input.readUInt32LE(cursor), 0x02014b50);
    const flags = input.readUInt16LE(cursor + 8), method = input.readUInt16LE(cursor + 10);
    assert.equal(flags & ~0x800, 0, 'Encrypted or streaming ZIP is unsupported');
    assert.ok(method === 0 || method === 8, 'Unsupported compression');
    const compressed = input.readUInt32LE(cursor + 20), size = input.readUInt32LE(cursor + 24);
    assert.ok(size <= 32 * 1024 * 1024);
    total += size; assert.ok(total <= 256 * 1024 * 1024);
    const length = input.readUInt16LE(cursor + 28), extra = input.readUInt16LE(cursor + 30), comment = input.readUInt16LE(cursor + 32);
    assert.equal(input.readUInt16LE(cursor + 34), 0, 'Multipart entry');
    const rawName = input.subarray(cursor + 46, cursor + 46 + length);
    const name = rawName.toString('utf8').replaceAll('\\', '/');
    assert.ok(!name.includes('\ufffd') && !/[\u0000-\u001f\u007f:]/u.test(name), 'Unsafe characters');
    assert.ok(name && !name.startsWith('/') && !name.startsWith('~'), 'Unsafe absolute path');
    const directory = name.endsWith('/');
    for (const part of (directory ? name.slice(0, -1) : name).split('/')) {
      assert.ok(part && part !== '.' && part !== '..' && !/[. ]$/.test(part), 'Unsafe path segment');
      assert.ok(!/^(\.enabled|\.finch-id|\.bundled|\.git|\.env(?:\..*)?)$/i.test(part), 'Forbidden runtime or private marker');
      assert.ok(!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part), 'Reserved filename');
    }
    assert.ok(!seen.has(name.toLowerCase()), 'Duplicate or case-colliding entry'); seen.add(name.toLowerCase());
    const attributes = input.readUInt32LE(cursor + 38), type = (attributes >>> 16) & 0xf000;
    assert.ok(type === 0 || type === (directory ? 0x4000 : 0x8000), 'Symlink or special entry');
    assert.equal(Boolean(attributes & 0x10), directory, 'Directory attribute mismatch');
    const local = input.readUInt32LE(cursor + 42);
    assert.ok(local + 30 <= start); assert.equal(input.readUInt32LE(local), 0x04034b50);
    assert.equal(input.readUInt16LE(local + 6), flags); assert.equal(input.readUInt16LE(local + 8), method);
    assert.equal(input.readUInt32LE(local + 14), input.readUInt32LE(cursor + 16), 'CRC metadata mismatch');
    assert.equal(input.readUInt32LE(local + 18), compressed); assert.equal(input.readUInt32LE(local + 22), size);
    assert.equal(input.readUInt16LE(local + 26), length);
    assert.ok(input.subarray(local + 30, local + 30 + length).equals(rawName), 'Local and central names differ');
    const dataStart = local + 30 + length + input.readUInt16LE(local + 28), dataEnd = dataStart + compressed;
    assert.ok(dataEnd <= start, 'Entry exceeds ZIP bounds');
    spans.push([local, dataEnd]);
    const packed = input.subarray(dataStart, dataEnd);
    const bytes = method === 8 ? inflateRawSync(packed, { maxOutputLength: 32 * 1024 * 1024 }) : packed;
    assert.equal(bytes.length, size, 'Uncompressed size mismatch');
    const normalized = Buffer.from(name, 'utf8'); assert.equal(normalized.length, length);
    normalized.copy(output, cursor + 46); normalized.copy(output, local + 30);
    entries.push({ name, size, sha256: createHash('sha256').update(bytes).digest('hex') });
    cursor += 46 + length + extra + comment;
  }
  assert.equal(cursor, end);
  spans.sort((a, b) => a[0] - b[0]);
  assert.equal(spans[0][0], 0, 'Unexpected archive prefix');
  for (let i = 1; i < spans.length; i++) assert.equal(spans[i][0], spans[i - 1][1], 'Overlapping entries or unexpected extra records');
  assert.equal(spans.at(-1)[1], start);
  assert.ok(seen.has('package.json'), 'package.json must be at the ZIP root');
  return { bytes: output, entries };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, target] = process.argv.slice(2);
  assert.ok(source && target && resolve(source) !== resolve(target), 'Usage: node tools/fapp-paths.mjs input.fapp output.fapp');
  const input = await readFile(source);
  const fixed = normalizeFappPaths(input);
  const verified = normalizeFappPaths(fixed.bytes);
  assert.deepEqual(verified.entries, fixed.entries, 'File contents changed');
  assert.ok(verified.bytes.equals(fixed.bytes), 'Path normalization must be idempotent');
  await writeFile(target, fixed.bytes, { flag: 'wx' });
  console.log(JSON.stringify({ path: resolve(target), files: fixed.entries.length, bytes: fixed.bytes.length, sha256: createHash('sha256').update(fixed.bytes).digest('hex'), entries: fixed.entries.map(entry => entry.name) }, null, 2));
}

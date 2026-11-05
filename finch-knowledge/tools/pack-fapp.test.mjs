import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { archiveName, packFapp } from './pack-fapp-runtime.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'finch-fapp-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist', 'index.js'), 'export function activate() {}');
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'test-mini', version: '1.0.0', files: ['dist/', 'icon.png'],
    finch: { manifestVersion: 1, main: 'dist/index.js' },
  }));
  return root;
}

function entries(buffer) {
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50);
  let cursor = buffer.readUInt32LE(end + 16);
  return Array.from({ length: buffer.readUInt16LE(end + 10) }, () => {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    const length = buffer.readUInt16LE(cursor + 28);
    const name = buffer.subarray(cursor + 46, cursor + 46 + length).toString();
    assert.equal(buffer.readUInt16LE(cursor + 8), 0x0800);
    const offset = buffer.readUInt32LE(cursor + 42);
    assert.equal(buffer.readUInt32LE(offset), 0x04034b50);
    const start = offset + 30 + buffer.readUInt16LE(offset + 26);
    const data = inflateRawSync(buffer.subarray(start, start + buffer.readUInt32LE(cursor + 20)));
    assert.equal(data.length, buffer.readUInt32LE(cursor + 24));
    cursor += 46 + length;
    return { name, data };
  });
}

test('uses POSIX archive paths on every OS and refuses embedded separators', () => {
  assert.equal(archiveName(['dist', 'index.js']), 'dist/index.js');
  for (const parts of [['dist\\index.js'], ['..', 'secret'], ['CON'], ['.env'], ['a/../b']]) {
    assert.throws(() => archiveName(parts), /Unsafe/);
  }
});

test('packages runtime allowlist at root, UTF-8 names and reproducible standard ZIP', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'dist', '说明.txt'), 'UTF-8 content');
  await writeFile(join(root, 'unlisted.txt'), 'not shipped');
  const a = join(root, 'a.fapp'), b = join(root, 'b.fapp');
  await packFapp(root, a);
  await packFapp(root, b);
  assert.deepEqual(await readFile(a), await readFile(b));
  const packed = entries(await readFile(a));
  assert.deepEqual(packed.map((item) => item.name).sort(), ['dist/index.js', 'dist/说明.txt', 'package.json']);
  assert.equal(packed.find((item) => item.name === 'dist/说明.txt').data.toString(), 'UTF-8 content');
  await assert.rejects(packFapp(root, a), { code: 'EEXIST' });
});

test('rejects missing runtime entries and unsafe assets before writing output', async (t) => {
  const root = await fixture(t);
  const output = join(root, 'bad.fapp');
  await writeFile(join(root, 'dist', '.env'), 'secret');
  await assert.rejects(packFapp(root, output), /Unsafe/);
  await assert.rejects(readFile(output), { code: 'ENOENT' });
});

test('rejects symlinks rather than shipping machine-dependent references', { skip: process.platform === 'win32' }, async (t) => {
  const root = await fixture(t);
  await symlink(join(root, 'package.json'), join(root, 'dist', 'link.json'));
  await assert.rejects(packFapp(root, join(root, 'bad.fapp')), /Unsupported/);
});

test('requires manifest local view assets', async (t) => {
  const root = await fixture(t);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  pkg.finch.contributes = { appView: { source: { type: 'local', path: 'dist/missing.html' } } };
  await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
  await assert.rejects(packFapp(root, join(root, 'bad.fapp')), /Missing runtime entry/);
});

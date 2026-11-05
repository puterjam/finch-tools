import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeFappPaths } from './fapp-paths.mjs';

function zip(names, attributes = 0) {
  const locals = [], records = [];
  let offset = 0;
  for (const value of ['package.json', ...names]) {
    const name = Buffer.from(value), local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(attributes >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name); records.push(central, name); offset += local.length + name.length;
  }
  const directory = Buffer.concat(records), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(names.length + 1, 8); end.writeUInt16LE(names.length + 1, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('Windows ZIP paths are normalized in both local and central headers without changing file data', () => {
  const input = zip(['dist\\index.js', 'i18n\\zh-CN.json']);
  const result = normalizeFappPaths(input);
  assert.deepEqual(result.entries.map(entry => entry.name), ['package.json', 'dist/index.js', 'i18n/zh-CN.json']);
  assert.equal(result.bytes.length, input.length);
  const changed = [...input].flatMap((value, index) => value === result.bytes[index] ? [] : [index]);
  assert.equal(changed.length, 4);
  for (const index of changed) { assert.equal(input[index], 92); assert.equal(result.bytes[index], 47); }
  assert.ok(normalizeFappPaths(result.bytes).bytes.equals(result.bytes));
});

test('already portable ZIP archives remain byte-for-byte unchanged', () => {
  const input = zip(['dist/index.js']);
  assert.ok(normalizeFappPaths(input).bytes.equals(input));
});

test('path traversal, absolute paths and reserved Windows names are still rejected', () => {
  for (const name of ['../outside', '..\\outside', '/absolute', '\\absolute', 'C:\\absolute', 'dist//bad', 'dist/./bad', 'dist/../bad', 'dist/NUL.txt', 'dist/COM1', 'dist/trailing.', 'dist/trailing ', 'dist/bad\u0000name']) {
    assert.throws(() => normalizeFappPaths(zip([name])), undefined, name);
  }
});

test('runtime markers, secrets and case-colliding paths are never repaired into acceptance', () => {
  for (const name of ['.enabled', '.finch-id', '.bundled', '.env', '.env.production', '.git/config', 'dist\\.enabled']) assert.throws(() => normalizeFappPaths(zip([name])), undefined, name);
  assert.throws(() => normalizeFappPaths(zip(['dist\\index.js', 'DIST/index.js'])), /colliding/);
});

test('symlinks and other special file attributes remain rejected', () => {
  for (const attributes of [0xa1ff0000, 0x21ff0000, 0x11ff0000]) assert.throws(() => normalizeFappPaths(zip(['dist/index.js'], attributes)), /special/);
});

test('local and central paths must agree before normalization', () => {
  const input = zip(['dist\\index.js']);
  input[30] = 88;
  assert.throws(() => normalizeFappPaths(input), /names differ/);
});

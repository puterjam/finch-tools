import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { MAX_FILE_BYTES, MAX_FILE_MB } from '../dist/index.js';

const root = new URL('../', import.meta.url);
const view = await readFile(new URL('src/view.ts', root), 'utf8');
const zh = JSON.parse(await readFile(new URL('i18n/zh-CN.json', root), 'utf8'));
const en = JSON.parse(await readFile(new URL('i18n/en-US.json', root), 'utf8'));

test('the cap is the one the store enforces, not a number someone remembered', () => {
  assert.equal(MAX_FILE_MB, MAX_FILE_BYTES / (1024 * 1024));
  assert.equal(MAX_FILE_MB, 200, 'a scanned or exported PDF clears the old 64 MB without effort');
});

test('the page caps uploads at the same size the backend accepts', () => {
  // The page bundle cannot import the store, so the two constants are kept in step here: a page
  // that lets a bigger file through only earns a confusing failure at the end of the upload.
  const [, bytes] = view.match(/const MAX_FILE = (\d+) \* 1024 \* 1024;/) ?? [];
  assert.ok(bytes, 'the page keeps its own copy of the cap');
  assert.equal(Number(bytes) * 1024 * 1024, MAX_FILE_BYTES);
});

test('every size message names the limit through {max}, never a hardcoded number', () => {
  const keys = ['tool.fileSize', 'tool.skipTooLarge'];
  for (const locale of [zh, en]) {
    for (const key of keys) assert.match(locale[key], /\{max\}/, `${key} still spells out a size`);
    assert.match(locale.ui.tooLarge, /\{max\}/, 'ui.tooLarge still spells out a size');
  }
  // The page's own English fallback is a third copy of the same sentence.
  assert.match(view.slice(view.indexOf('const english: Copy = {'), view.indexOf('\n};')), /tooLarge: '[^']*\{max\}/);
});

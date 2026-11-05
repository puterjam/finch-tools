import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { transform } from 'esbuild';
const source = await readFile(new URL('../src/color-picker.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { hexToHsv, hsvToHex } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

test('HSV primary colors, grayscale and bounds convert to exact HEX colors', () => {
  for (const [h, hex] of [[0, '#ff0000'], [60, '#ffff00'], [120, '#00ff00'], [180, '#00ffff'], [240, '#0000ff'], [300, '#ff00ff'], [360, '#ff0000'], [-120, '#0000ff']]) assert.equal(hsvToHex({ h, s: 1, v: 1 }), hex);
  assert.equal(hsvToHex({ h: 150, s: 0, v: 1 }), '#ffffff');
  assert.equal(hsvToHex({ h: 150, s: 1, v: 0 }), '#000000');
  assert.equal(hsvToHex({ h: 150, s: -1, v: 2 }), '#ffffff');
  assert.equal(hsvToHex({ h: 0, s: 0, v: .5 }), '#808080');
});

test('HEX roundtrips retain arbitrary custom colors including black and white', () => {
  for (const hex of ['#000000', '#ffffff', '#92969d', '#1A2B3C', '#ec635d', '#5393d8', ...Array.from({ length: 256 }, (_, index) => `#${((index * 65793 + 12345) % 16777216).toString(16).padStart(6, '0')}`)]) assert.equal(hsvToHex(hexToHsv(hex)), hex.toLowerCase());
  for (const hex of ['#abc', '#12345678', 'red', '#12zzzz']) assert.throws(() => hexToHsv(hex), /Invalid HEX/);
});

test('the inline surface has pointer cancellation and keyboard support without native color inputs', async () => {
  const view = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/view.css', import.meta.url), 'utf8');
  assert.match(source, /pointercancel.*lostpointercapture/);
  assert.match(source, /ArrowLeft/); assert.match(source, /ArrowUp/);
  assert.doesNotMatch(view, /color-well|well\.type = 'color'/);
  assert.match(view, /actions\.append\(rename, remove\)/);
  assert.match(view, /tag-color-trigger/);
  assert.match(css, /\.tag-color-trigger\s*\{[^}]*position:\s*absolute/);
  assert.doesNotMatch(css, /color-well/);
});

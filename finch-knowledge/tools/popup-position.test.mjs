import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { transform } from 'esbuild';

const source = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8');
const start = source.indexOf('function placeMenu(');
const end = source.indexOf('/** A multi-select flyout:', start);
const { code } = await transform(source.slice(start, end), { loader: 'ts' });
function position(anchor, side = 'below', width = 1200, height = 800, scrollX = 0, scrollY = 0) {
  const menu = { hidden: true, style: {}, getBoundingClientRect() { assert.equal(this.hidden, false); return { width: 216, height: 160 }; } };
  const context = createContext({ menu, anchor, side, window: { innerWidth: width, innerHeight: height, scrollX, scrollY } });
  runInContext(code + '\nplaceMenu(menu, anchor, side);', context);
  return { left: parseFloat(menu.style.left), top: parseFloat(menu.style.top) };
}
const point = (x, y) => ({ left: x, right: x, top: y, bottom: y, width: 0, height: 0 });
const item = x => ({ left: x, right: x + 216, top: 120, bottom: 152, width: 216, height: 32 });

test('context menus normally open to the right at the pointer', () => {
  assert.deepEqual(position(point(350, 120)), { left: 350, top: 120 });
});
test('context menus flip left only when the right edge lacks room', () => {
  assert.deepEqual(position(point(1180, 120)), { left: 964, top: 120 });
});
test('flyouts prefer the right and align with the parent item', () => {
  assert.deepEqual(position(item(350), 'right'), { left: 570, top: 120 });
});
test('flyouts flip completely to the left near the viewport edge', () => {
  assert.deepEqual(position(item(964), 'right'), { left: 744, top: 120 });
});
test('an explicitly left-facing popup also flips if that side has no room', () => {
  assert.deepEqual(position(item(20), 'left'), { left: 240, top: 120 });
});
test('menus flip upward near the lower edge and remain visible in narrow windows', () => {
  for (const width of [280, 520, 820]) {
    const result = position(point(width - 16, 780), 'below', width);
    assert.ok(result.left >= 8 && result.left + 216 <= width - 8);
    assert.equal(result.top, 620);
  }
});
test('button dropdown alignment is preserved and page scroll offsets are applied once', () => {
  assert.deepEqual(position(item(350)), { left: 350, top: 156 });
  assert.deepEqual(position(point(350, 120), 'below', 1200, 800, 30, 50), { left: 380, top: 170 });
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { transform } from 'esbuild';
const source = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8');
const { code } = await transform(source.slice(source.indexOf('let toastVersion'), source.indexOf('/** The footer hairline')), { loader: 'ts' });
function fixture(native) {
  const element = { textContent: '', classList: { toggle() {} } }, timers = new Map(); let next = 0;
  const context = createContext({ bridge: native ? { ui: { toast: native } } : undefined, byId: () => element,
    window: { setTimeout(callback, delay) { timers.set(++next, { callback, delay }); return next; } },
    clearTimeout(id) { timers.delete(id); },
  });
  runInContext(code, context);
  return { element, timers, notify: message => { context.message = message; runInContext("toast(message, 'info')", context); } };
}
test('native notifications explicitly request the top-center position', () => {
  let received; const f = fixture(options => { received = options; return Promise.resolve(); });
  f.notify('Scan finished'); assert.equal(received.position, 'TC'); assert.equal(f.element.textContent, '');
});
test('a rejected native notification falls back to the same transient top message', async () => {
  const f = fixture(() => Promise.reject(new Error('Gesture expired'))); f.notify('Scan finished');
  await Promise.resolve(); assert.equal(f.element.textContent, 'Scan finished');
  const timer = [...f.timers.values()][0]; assert.equal(timer.delay, 5000); timer.callback(); assert.equal(f.element.textContent, '');
});
test('the no-bridge path auto-dismisses and newer messages replace earlier timers', () => {
  const f = fixture(); f.notify('Old'); const old = [...f.timers.values()][0];
  f.notify('New'); assert.equal(f.timers.size, 1); old.callback(); assert.equal(f.element.textContent, 'New');
  [...f.timers.values()][0].callback(); assert.equal(f.element.textContent, '');
});
test('a delayed old native rejection cannot resurrect an obsolete completion message', async () => {
  let reject; let count = 0;
  const f = fixture(() => ++count === 1 ? new Promise((_resolve, fail) => { reject = fail; }) : Promise.resolve());
  f.notify('Old'); f.notify('New'); reject(new Error('Delayed')); await Promise.resolve();
  assert.equal(f.element.textContent, ''); assert.equal(f.timers.size, 0);
});
test('fallback notifications are fixed at the top and never anchored to the bottom', async () => {
  const css = await readFile(new URL('../src/view.css', import.meta.url), 'utf8');
  const rule = css.match(/\.status\s*\{([^}]+)\}/)[1];
  assert.match(rule, /position:\s*fixed/); assert.match(rule, /top:\s*16px/); assert.doesNotMatch(rule, /bottom:/);
});

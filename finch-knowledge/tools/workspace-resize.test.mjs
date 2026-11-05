import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { transform } from 'esbuild';

const source = await readFile(new URL('../src/workspace-resize.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { sidebarBounds, boundSidebar } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

test('sidebar width has hard 220–420px bounds', () => {
  assert.deepEqual(sidebarBounds(1200, 16), { min: 220, max: 420 });
  assert.equal(boundSidebar(-1000, 1200, 16), 220);
  assert.equal(boundSidebar(1000, 1200, 16), 420);
  assert.equal(boundSidebar(345, 1200, 16), 345);
});

test('a narrow two-column layout reserves at least 280px for document content', () => {
  assert.deepEqual(sidebarBounds(568, 12), { min: 220, max: 276 });
  assert.equal(boundSidebar(420, 568, 12), 276);
  assert.equal(boundSidebar(220, 568, 12), 220);
});

test('invalid remembered values have a bounded default', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.equal(boundSidebar(value, 1200, 16), 300);
    assert.equal(boundSidebar(value, 568, 12), 276);
  }
});

test('resizing updates layout only and includes cancellation, keyboard and mobile safeguards', () => {
  assert.doesNotMatch(source, /replaceChildren|innerHTML|postMessage|fetch\(/);
  assert.match(source, /pointercancel.*lostpointercapture/);
  assert.match(source, /ArrowLeft/); assert.match(source, /ArrowRight/);
  assert.match(source, /localStorage\.setItem/); assert.match(source, /localStorage\.removeItem/);
  assert.match(source, /max-width: 600px/); assert.match(source, /ResizeObserver/);
});

const { code: runtime } = await transform(source, { loader: 'ts', format: 'cjs' });
function fixture() {
  const events = {}, windowEvents = {}, rootClasses = new Set(), classes = new Set(), attrs = {}, saved = new Map();
  const tokens = set => ({ add: name => set.add(name), remove: name => set.delete(name) });
  let captured = null;
  const separator = {
    classList: tokens(classes),
    addEventListener: (name, fn) => { events[name] = fn; },
    setAttribute: (key, value) => { attrs[key] = value; },
    setPointerCapture: id => { captured = id; }, hasPointerCapture: id => captured === id,
    releasePointerCapture: () => { captured = null; }, focus: () => events.focus?.(),
  };
  const workspace = { getBoundingClientRect: () => ({ width: 1200 }), style: { setProperty() {} } };
  const context = createContext({
    module: { exports: {} }, separator, workspace,
    document: { documentElement: { classList: tokens(rootClasses) } },
    window: { matchMedia: () => ({ matches: false }), addEventListener: (name, fn) => { windowEvents[name] = fn; } },
    getComputedStyle: () => ({ columnGap: '8px' }), ResizeObserver: class { observe() {} },
    localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
  });
  runInContext(runtime + '\nmodule.exports.wireWorkspaceResize(workspace, separator);', context);
  const fire = (name, values = {}) => events[name]({ pointerId: 7, button: 0, clientX: 300, preventDefault() {}, ...values });
  return { fire, classes, rootClasses, attrs, saved, windowEvents };
}

test('release, cancellation and capture loss hide the guide without stealing keyboard focus', () => {
  for (const end of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    const f = fixture();
    f.fire('pointerdown'); f.fire('pointermove', { clientX: 340 });
    assert.ok(f.rootClasses.has('workspace-resizing'));
    f.fire(end);
    assert.equal(f.rootClasses.has('workspace-resizing'), false);
    assert.ok(f.classes.has('is-resting'), `${end} suppresses stale hover/focus styling`);
    assert.equal(f.saved.get('knowledge.sidebar.width'), '340');
    f.fire('keydown', { key: 'ArrowRight' });
    assert.equal(f.classes.has('is-resting'), false);
    assert.equal(f.attrs['aria-valuenow'], '350');
  }
});
test('a fresh pointer entry or focus restores the resize affordance', () => {
  for (const next of ['pointerenter', 'focus']) {
    const f = fixture(); f.fire('pointerdown'); f.fire('pointerup');
    assert.ok(f.classes.has('is-resting'));
    f.fire(next);
    assert.equal(f.classes.has('is-resting'), false);
  }
});
test('window blur ends the drag and a stale release cannot end a newer drag', () => {
  const f = fixture(); f.fire('pointerdown'); f.fire('pointermove', { clientX: 330 });
  f.windowEvents.blur();
  assert.equal(f.rootClasses.has('workspace-resizing'), false);
  assert.ok(f.classes.has('is-resting'));
  f.fire('pointerdown', { pointerId: 8 });
  assert.equal(f.classes.has('is-resting'), false);
  f.fire('pointerup', { pointerId: 7 });
  assert.ok(f.rootClasses.has('workspace-resizing'));
  f.fire('pointerup', { pointerId: 8 });
  assert.equal(f.rootClasses.has('workspace-resizing'), false);
});

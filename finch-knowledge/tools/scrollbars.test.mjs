import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { transform } from 'esbuild';
const source = await readFile(new URL('../src/scrollbars.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { wireScrollbars } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
function fixture() {
  const timers = new Map(), events = new Map(); let id = 0, options;
  class Element {
    constructor(scrollable = true) { this.scrollable = scrollable; this.classes = new Set(); }
    matches() { return this.scrollable; }
    classList = { add: name => this.classes.add(name), remove: name => this.classes.delete(name) };
  }
  const doc = { defaultView: { HTMLElement: Element, setTimeout(fn, delay) { timers.set(++id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); } },
    addEventListener(name, fn, spec) { events.set(name, fn); options = spec; }, removeEventListener(name) { events.delete(name); } };
  const dispose = wireScrollbars(doc);
  return { timers, events, Element, dispose, options: () => options, scroll: target => events.get('scroll')({ target }) };
}
test('scrolling shows only the active pane and expires after the idle interval', () => {
  const f = fixture(), first = new f.Element(), second = new f.Element();
  f.scroll(first); assert.equal(first.classes.has('is-scrolling'), true); assert.equal(second.classes.has('is-scrolling'), false);
  const timer = [...f.timers.values()][0]; assert.equal(timer.delay, 900); timer.fn();
  assert.equal(first.classes.has('is-scrolling'), false);
});
test('continued scrolling resets its timer and panes remain independent', () => {
  const f = fixture(), first = new f.Element(), second = new f.Element();
  f.scroll(first); const old = [...f.timers.keys()][0]; f.scroll(first); assert.equal(f.timers.has(old), false);
  f.scroll(second); assert.equal(f.timers.size, 2);
  [...f.timers.values()][0].fn(); assert.equal(first.classes.has('is-scrolling'), false); assert.equal(second.classes.has('is-scrolling'), true);
});
test('dynamic panes use one passive capture listener and disposal clears active timers', () => {
  const f = fixture(); assert.deepEqual(f.options(), { capture: true, passive: true });
  f.scroll(new f.Element(false)); assert.equal(f.timers.size, 0);
  const late = new f.Element(); f.scroll(late); f.dispose();
  assert.equal(f.timers.size, 0); assert.equal(f.events.size, 0); assert.equal(late.classes.has('is-scrolling'), false);
  assert.doesNotMatch(source, /preventDefault|scrollTop\s*=|overflow\s*=/);
});
test('scrollbar styling hides idle thumbs and arrows without removing scrollbar geometry', async () => {
  const css = await readFile(new URL('../src/view.css', import.meta.url), 'utf8');
  assert.match(css, /--scrollbar-thumb:\s*transparent/); assert.match(css, /:is\(:hover, \.is-scrolling\)/);
  assert.match(css, /::-webkit-scrollbar\s*\{\s*width:\s*8px/);
  assert.match(css, /::-webkit-scrollbar-button\s*\{\s*display:\s*none/);
  assert.match(css, /scrollbar-gutter:\s*stable/); assert.match(css, /prefers-reduced-motion/);
});

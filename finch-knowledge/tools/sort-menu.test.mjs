import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';

const source = await readFile(new URL('../src/sort-menu.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'cjs' });
const module = { exports: {} };
runInNewContext(code, { module });
const { createSortMenu } = module.exports;

function target() {
  const handlers = new Map();
  return { handlers,
    addEventListener(type, callback) { const list = handlers.get(type) ?? []; list.push(callback); handlers.set(type, list); },
    removeEventListener(type, callback) { handlers.set(type, (handlers.get(type) ?? []).filter(item => item !== callback)); },
    emit(type, details = {}) {
      const event = { target: this, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...details };
      for (const callback of [...(handlers.get(type) ?? [])]) callback(event);
      return event;
    },
  };
}
function fixture() {
  const doc = target(), viewport = { ...target(), innerWidth: 900, innerHeight: 600 };
  doc.defaultView = viewport;
  function element() {
    return { ...target(), ownerDocument: doc, attrs: {}, dataset: {}, style: {}, hidden: true,
      setAttribute(key, value) { this.attrs[key] = value; },
      contains(node) { while (node) { if (node === this) return true; node = node.parent; } return false; },
      focus() { doc.activeElement = this; doc.emit('focusin', { target: this }); },
    };
  }
  const trigger = element(), menu = element(), label = {};
  trigger.bounds = { left: 720, right: 850, top: 80, bottom: 110 };
  trigger.getBoundingClientRect = () => trigger.bounds;
  menu.getBoundingClientRect = () => ({ width: 190, height: 120 });
  const items = ['updated', 'added', 'name'].map(value => {
    const item = element(); item.hidden = false; item.parent = menu; item.dataset.sort = value; item.label = {};
    item.querySelector = () => item.label;
    return item;
  });
  menu.querySelectorAll = () => items;
  let value = 'updated', labels = { updated: 'Last indexed', added: 'Date added', name: 'File name' };
  const changes = [];
  const control = createSortMenu({ trigger, menu, label,
    getValue: () => value, getLabel: key => labels[key], onChange(next) { value = next; changes.push(next); } });
  return { doc, viewport, trigger, menu, label, items, changes, control, localize(next) { labels = next; control.refresh(); } };
}

test('the themed sort menu selects once, checks the current option and returns focus', () => {
  const f = fixture();
  assert.equal(f.label.textContent, 'Last indexed');
  f.trigger.emit('click');
  assert.equal(f.menu.hidden, false);
  assert.equal(f.trigger.attrs['aria-expanded'], 'true');
  assert.equal(f.doc.activeElement, f.items[0]);
  f.items[2].emit('click');
  assert.deepEqual(f.changes, ['name']);
  assert.equal(f.label.textContent, 'File name');
  assert.equal(f.items[2].attrs['aria-checked'], 'true');
  assert.equal(f.menu.hidden, true);
  assert.equal(f.doc.activeElement, f.trigger);
  f.trigger.emit('click'); f.items[2].emit('click');
  assert.deepEqual(f.changes, ['name'], 'reselecting the same sort does not reload the list');
});

test('arrow keys wrap, Home/End navigate and Enter/Space select without native select behaviour', () => {
  const f = fixture();
  assert.equal(f.trigger.emit('keydown', { key: 'ArrowDown' }).prevented, true);
  f.menu.emit('keydown', { key: 'ArrowUp' });
  assert.equal(f.doc.activeElement, f.items[2]);
  f.menu.emit('keydown', { key: 'Home' });
  assert.equal(f.doc.activeElement, f.items[0]);
  f.menu.emit('keydown', { key: 'End' });
  assert.equal(f.doc.activeElement, f.items[2]);
  f.menu.emit('keydown', { key: 'Enter' });
  assert.deepEqual(f.changes, ['name']);
  f.trigger.emit('keydown', { key: 'ArrowUp' });
  f.menu.emit('keydown', { key: 'ArrowUp' });
  f.menu.emit('keydown', { key: ' ' });
  assert.deepEqual(f.changes, ['name', 'added']);
});

test('Escape restores focus; Tab closes without blocking normal focus traversal', () => {
  const f = fixture();
  f.trigger.emit('click');
  assert.equal(f.menu.emit('keydown', { key: 'Escape' }).prevented, true);
  assert.equal(f.doc.activeElement, f.trigger);
  assert.equal(f.menu.hidden, true);
  f.trigger.emit('click');
  assert.equal(f.menu.emit('keydown', { key: 'Tab' }).prevented, false);
  assert.equal(f.menu.hidden, true);
});

test('the popup stays inside the viewport, closes on outside interaction and cleans up listeners', () => {
  const f = fixture();
  f.trigger.bounds = { left: 820, right: 950, top: 560, bottom: 590 };
  f.trigger.emit('click');
  assert.equal(f.menu.style.left, '702px');
  assert.equal(f.menu.style.top, '434px');
  f.doc.emit('pointerdown', { target: f.items[0] });
  assert.equal(f.menu.hidden, false, 'clicking an option is not an outside click');
  f.doc.emit('pointerdown', { target: {} });
  assert.equal(f.menu.hidden, true);
  f.trigger.emit('click'); f.viewport.emit('resize');
  assert.equal(f.menu.hidden, true);
  f.trigger.emit('click'); f.doc.emit('scroll', { target: {} });
  assert.equal(f.menu.hidden, true);
  f.control.dispose();
  f.trigger.emit('click');
  assert.equal(f.menu.hidden, true);
  for (const list of f.doc.handlers.values()) assert.equal(list.length, 0);
});

test('changing locale refreshes the trigger and every menu option', () => {
  const f = fixture();
  f.localize({ updated: '最后索引更新时间', added: '添加时间', name: '文件名' });
  assert.equal(f.label.textContent, '最后索引更新时间');
  assert.equal(f.items[1].label.textContent, '添加时间');
  f.trigger.emit('click'); f.items[2].emit('click');
  assert.equal(f.label.textContent, '文件名');
});

test('the shipped page uses themed radio menu items, not a native system select', async () => {
  const html = await readFile(new URL('../src/view.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/view.css', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /<select\b/);
  assert.match(html, /id="sort"[^>]*aria-haspopup="menu"/);
  assert.equal((html.match(/role="menuitemradio"/g) ?? []).length, 6);
  assert.match(css, /\.menu\.sort-menu\s*\{[^}]*position:\s*fixed/);
  assert.match(css, /\.menu\s*\{[^}]*background:\s*var\(--finch-bg-elevated/);
  assert.match(css, /\.sort-trigger[^}]*color:\s*var\(--finch-text-primary/);
});

test('keyboard navigation skips hidden index-only sort options in the issue list', () => {
  const f = fixture(); f.items[0].hidden = true; f.items[1].hidden = true;
  f.trigger.emit('keydown', { key: 'ArrowDown' }); assert.equal(f.doc.activeElement, f.items[2]);
  f.menu.emit('keydown', { key: 'ArrowDown' }); assert.equal(f.doc.activeElement, f.items[2]);
  f.items[0].emit('click'); assert.deepEqual(f.changes, [], 'hidden options cannot be selected');
  f.menu.emit('keydown', { key: 'Enter' }); assert.deepEqual(f.changes, ['name']);
  f.items[0].hidden = false; f.items[1].hidden = false;
  f.trigger.emit('click'); f.menu.emit('keydown', { key: 'Home' }); assert.equal(f.doc.activeElement, f.items[0]);
});

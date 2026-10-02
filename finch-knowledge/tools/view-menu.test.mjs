import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { transform } from 'esbuild';

const view = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/view.css', import.meta.url), 'utf8');
const declarations = view.slice(0, view.indexOf('\nmountStaticIcons();')).replace(/^import .*\n/gm, '');
const { code } = await transform(declarations, { loader: 'ts' });

function fixture(selectedTops = [900], height = 300, contentHeight = 1000) {
  const box = { top: 40, bottom: 340, left: 40, right: 248, width: 208, height };
  const attrs = new Map();
  const submenu = {
    hidden: true, scrollTop: 150, scrollHeight: contentHeight, clientHeight: height, clientTop: 1, style: {},
    getBoundingClientRect() { assert.equal(this.hidden, false, 'measure after revealing'); return box; },
    querySelector(selector) {
      assert.equal(selector, '[aria-checked="true"]');
      return selectedTops.length ? { getBoundingClientRect: () => ({ top: box.top + this.clientTop + selectedTops[0] - this.scrollTop, height: 32 }) } : null;
    },
  };
  const anchor = { getBoundingClientRect: () => box, setAttribute() {}, closest: () => ({ classList: { remove() {} } }) };
  const row = { querySelector: () => anchor, classList: { add() {} } };
  const elements = new Map([
    ['row-submenu', submenu],
    ['row-classify', { setAttribute(key, value) { attrs.set(key, value); }, getBoundingClientRect: () => box, closest: () => null }],
    ['row-menu', { hidden: false, style: {}, getBoundingClientRect: () => box }],
    ['row-menu-note', { textContent: '' }],
    ['documents', { querySelector: () => row }],
    ['documents-scroll', { scrollTop: 2400 }],
    ['library-menu', { hidden: true }],
    ['library-menu-button', { setAttribute() {} }],
  ]);
  const context = createContext({
    window: { scrollX: 0, scrollY: 0, innerWidth: 1200, innerHeight: 800 },
    document: { getElementById: (id) => elements.get(id) },
  });
  runInContext(code, context);
  return { submenu, attrs, elements, run: (script) => runInContext(script, context) };
}

test('all menu actions use medium weight and secondary text before interaction', () => {
  assert.match(css, /\.menu-item\s*\{[^}]*color:\s*var\(--finch-text-secondary[^}]*font-weight:\s*500/);
  assert.match(css, /\.menu-item svg\s*\{[^}]*color:\s*inherit/);
});

test('hover, keyboard focus and expanded entries share a full-row band and primary text', () => {
  assert.match(css, /\.menu-item:not\(:disabled\):hover, \.menu-item:not\(:disabled\):focus-visible, \.menu-item\[aria-expanded="true"\]\s*\{[^}]*background:\s*var\(--finch-bg-hover[^}]*color:\s*var\(--finch-text-primary/);
  assert.doesNotMatch(css, /\.menu[^{}]*\{[^}]*color:\s*var\(--finch-accent/);
  assert.match(css, /\.row-submenu \.menu-item \.menu-check\s*\{[^}]*color:\s*var\(--finch-text-primary/);
});

test('Remove keeps a danger highlight for pointer and keyboard, after the shared rule', () => {
  const selector = '.menu-item.menu-danger:not(:disabled):hover, .menu-item.menu-danger:not(:disabled):focus-visible';
  assert.ok(css.indexOf(selector) > css.indexOf('.menu-item:not(:disabled):hover'));
  assert.match(css.slice(css.indexOf(selector)), /^[^{]+\{[^}]*color:\s*var\(--finch-danger/);
});

test('opening the flyout reveals a checked category near the bottom without scrolling sources', () => {
  const f = fixture();
  f.run('openRowSubmenu();');
  assert.equal(f.submenu.hidden, false);
  assert.equal(f.submenu.scrollTop, 700, 'scroll clamps to the end of the category list');
  assert.equal(f.attrs.get('aria-expanded'), 'true');
  assert.equal(f.elements.get('documents-scroll').scrollTop, 2400);
});

test('a multi-tag document locates the first checked category in menu order', () => {
  const f = fixture([450, 900]);
  f.run('openRowSubmenu();');
  assert.equal(f.submenu.scrollTop, 316);
});

test('an unclassified document and a short menu open at the beginning', () => {
  for (const f of [fixture([]), fixture([32], 120, 120)]) {
    f.run('openRowSubmenu();');
    assert.equal(f.submenu.scrollTop, 0);
  }
});

test('hovering an already open flyout does not reset its user-chosen scroll position', () => {
  const f = fixture();
  f.run('openRowSubmenu();');
  f.submenu.scrollTop = 400;
  f.run('openRowSubmenu();');
  assert.equal(f.submenu.scrollTop, 400);
});

test('a tag update restores the flyout scroll position after rebuilding its checkboxes', () => {
  const f = fixture();
  f.submenu.hidden = false;
  f.submenu.scrollTop = 450;
  f.run(`fillRowSubmenu = () => { document.getElementById('row-submenu').scrollTop = 0; };
    restoreRowMenu({ id: 'one', indexed_at: 0 }, true);`);
  assert.equal(f.submenu.scrollTop, 450);
  assert.equal(f.elements.get('documents-scroll').scrollTop, 2400);
});

test('opening library actions closes the document menu and its flyout', () => {
  const f = fixture();
  f.submenu.hidden = false;
  f.run('setMenu(true);');
  assert.equal(f.submenu.hidden, true);
  assert.equal(f.elements.get('row-menu').hidden, true);
  assert.equal(f.elements.get('library-menu').hidden, false);
  f.run(`fillRowSubmenu = () => {};
    openRowMenu({ id: 'one', indexed_at: 0 }, document.getElementById('row-classify'));`);
  assert.equal(f.elements.get('library-menu').hidden, true);
  assert.equal(f.elements.get('row-menu').hidden, false);
});

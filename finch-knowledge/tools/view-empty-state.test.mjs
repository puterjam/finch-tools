import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { transform } from 'esbuild';

const view = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8');
const start = view.indexOf('function buildEmptyState('), end = view.indexOf('function renderDocs(', start);
const { code } = await transform(view.slice(start, end), { loader: 'ts' });
function node(tag, className = '', textContent = '') {
  return { tag, className, textContent, children: [], attrs: {}, dataset: {},
    append(...children) { this.children.push(...children); }, setAttribute(key, value) { this.attrs[key] = value; } };
}
function all(root) { return [root, ...root.children.flatMap(all)]; }
async function fixture(locale = 'zh-CN') {
  const { ui } = JSON.parse(await readFile(new URL(`../i18n/${locale}.json`, import.meta.url), 'utf8'));
  const context = createContext({ node, svg: glyph => node('svg', glyph), Files: 'files', TagIcon: 'tag', Loader: 'loader', FolderOpen: 'folder',
    scanBusy: false, loadingPage: false, selectedTag: null, selectedDirectory: null, libraryPath: 'E:\\knowledge', DEFAULT_TAG: 'default', tagName: () => 'Research',
    tr: (key, values = {}) => { assert.ok(ui[key], `Missing ui.${key}`); return Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), ui[key]); },
  });
  runInContext(code, context);
  return { context, ui, build: () => runInContext('buildEmptyState()', context) };
}

test('the empty library has an illustration, directory and three steps, without duplicate action buttons', async () => {
  for (const locale of ['zh-CN', 'en-US']) {
    const f = await fixture(locale), section = f.build(), tree = all(section);
    assert.equal(section.dataset.mode, 'library');
    assert.equal(section.attrs.role, 'status');
    assert.equal(tree.find(item => item.className === 'empty-heading').textContent, f.ui.emptyTitle);
    assert.equal(tree.find(item => item.className === 'empty-directory').attrs.title, 'E:\\knowledge');
    assert.equal(tree.filter(item => item.tag === 'li').length, 3);
    assert.equal(tree.some(item => item.tag === 'button'), false);
    assert.ok(tree.find(item => item.className === 'empty-types'));
  }
});

test('an empty category explains classification, not missing source files', async () => {
  const f = await fixture(); f.context.selectedTag = 'research';
  const section = f.build(), tree = all(section);
  assert.equal(section.dataset.mode, 'category');
  assert.match(tree.find(item => item.className === 'empty-heading').textContent, /Research/);
  assert.equal(tree.some(item => item.className === 'empty-directory'), false);
  assert.equal(tree.some(item => item.className === 'empty-steps'), false);
});

test('scanning and loading use distinct busy empty views instead of claiming the library is empty', async () => {
  const f = await fixture();
  f.context.scanBusy = true;
  let section = f.build();
  assert.equal(section.dataset.mode, 'scanning');
  assert.equal(section.attrs['aria-busy'], 'true');
  assert.equal(all(section).find(item => item.className === 'empty-heading').textContent, f.ui.emptyScanningTitle);
  f.context.scanBusy = false; f.context.loadingPage = true;
  section = f.build();
  assert.equal(section.dataset.mode, 'loading');
  assert.equal(all(section).find(item => item.className === 'empty-heading').textContent, f.ui.emptyLoadingTitle);
});

test('paths remain plain text and the empty layout centers within the pane using theme tokens', async () => {
  const f = await fixture();
  f.context.libraryPath = '<img src=x onerror=alert(1)>';
  const section = f.build();
  assert.equal(all(section).find(item => item.className === 'empty-directory-path').textContent, f.context.libraryPath);
  assert.equal(all(section).some(item => item.tag === 'img'), false);
  const css = await readFile(new URL('../src/view.css', import.meta.url), 'utf8');
  assert.match(css, /\.documents:has\(> \.library-empty\)[^}]*place-items:\s*center/);
  assert.match(css, /\.empty-illustration[^}]*var\(--finch-accent/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test('column headers are hidden for every empty state and restored only when rows exist', async () => {
  const begin = view.indexOf('function renderDocs('), finish = view.indexOf('\n/**', begin);
  const rendered = await transform(view.slice(begin, finish), { loader: 'ts' });
  const elements = new Map();
  const byId = id => {
    if (!elements.has(id)) elements.set(id, { children: [], hidden: false, classList: { toggle() {} }, replaceChildren(...items) { this.children = items; }, append(...items) { this.children.push(...items); } });
    return elements.get(id);
  };
  const context = createContext({ byId, node, showIssues: false, loadingPage: false, docs: [], total: 0, rowMenuDoc: null, rowMenuFlyoutOpen: false,
    closeRowMenu() {}, hideRowMenu() {}, restoreRowMenu() {}, tr: () => '', buildEmptyState: () => ({ empty: true }), buildRow: doc => ({ doc }) });
  runInContext(rendered.code, context);
  for (const mode of ['library', 'tag', 'loading', 'scanning']) {
    context.docs = []; runInContext('renderDocs()', context);
    assert.equal(byId('document-columns').hidden, true, mode);
    assert.equal(byId('documents').children[0].empty, true);
  }
  context.docs = [{ id: 'file' }]; context.total = 1; runInContext('renderDocs()', context);
  assert.equal(byId('document-columns').hidden, false);
  context.docs = []; context.total = 0; runInContext('renderDocs()', context);
  assert.equal(byId('document-columns').hidden, true, 'removing the final row hides column labels again');
  const html = await readFile(new URL('../src/view.html', import.meta.url), 'utf8');
  assert.match(html, /id="document-columns"[^>]*\bhidden\b/, 'headers also stay hidden before first render');
});

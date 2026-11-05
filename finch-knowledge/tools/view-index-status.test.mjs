import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { transform } from 'esbuild';

const source = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/view.css', import.meta.url), 'utf8');
const formatting = source.slice(source.indexOf('function fileSize('), source.indexOf('/**', source.indexOf('function fileSize(')));
const { code } = await transform(formatting + source.slice(source.indexOf('function buildRow('), source.indexOf('function renderDocs(')), { loader: 'ts' });

function element(className = '', textContent = '') {
  return { className, textContent, children: [], attributes: {}, dataset: {},
    append(...children) { this.children.push(...children); },
    setAttribute(key, value) { this.attributes[key] = value; }, addEventListener() {} };
}

test('the real file row displays LanceDB coverage with localized labels, never assumes success', async () => {
  for (const locale of ['zh-CN', 'en-US']) {
    const { ui } = JSON.parse(await readFile(new URL(`../i18n/${locale}.json`, import.meta.url), 'utf8'));
    const context = createContext({
      copy: ui, english: ui, document: { documentElement: { lang: locale } },
      URL, location: { href: 'http://localhost/dist/view.html' }, libraryPath: '/sources', MAX_ROW_BADGES: 3, DEFAULT_TAG: 'default',
      node: (_tag, className = '', text = '') => element(className, text), svg: name => element(name), icon: () => element('button'),
      CircleCheck: 'check', Circle: 'circle', CircleAlert: 'alert', Loader: 'loader', Eye: 'eye', FolderOpen: 'folder', EllipsisVertical: 'more',
      iconForFile: () => 'markdown.svg', tagName: () => 'Unclassified', previewRoute: () => 'text',
      tr: (key, values = {}) => Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), ui[key] ?? key),
    });
    runInContext(code, context);
    for (const [state, key] of [['processing', 'statusProcessing'], ['ready', 'statusReady'], ['outdated', 'statusOutdated'], ['pending', 'statusPending'], ['incomplete', 'statusIncomplete'], ['failed', 'statusFailed'], ['source_missing', 'statusSourceMissing'], ['source_unavailable', 'statusSourceUnavailable'], ['unverified', 'statusUnverified'], [undefined, 'statusUnverified']]) {
      context.doc = { id: 'doc', path: '/sources/notes.md', name: 'notes.md', tags: [], chunks: 4, indexedChunks: state === 'ready' ? 4 : 1,
        status: state, statusReason: 'Parser rejected this document', added_at: Date.now(), indexed_at: Date.now() };
      const row = runInContext('buildRow(doc)', context);
      const status = row.children.find(child => child.className === 'doc-status');
      assert.ok(status, 'status is part of the actual document row');
      assert.equal(status.children[1].textContent, ui[key]);
      assert.equal(status.dataset.state, state ?? 'unverified');
      assert.equal(status.attributes['aria-label'], ui[key]);
      assert.doesNotMatch(`${status.textContent} ${status.attributes['aria-label']} ${status.attributes.title}`, /LanceDB|SQLite|已收录/i);
      assert.ok(status.attributes.title.includes(ui[`${key}Hint`]));
      if (state === 'failed') assert.match(status.attributes.title, /Parser rejected/);
      if (state !== 'ready') assert.notEqual(status.children[0].className, 'check');
    }
  }
});

test('status and actions share a fixed trailing slot without layout changes', () => {
  assert.match(css, /\.doc-status\s*\{[^}]*justify-content:\s*flex-end[^}]*min-width:\s*66px[^}]*margin-left:\s*auto/);
  assert.match(css, /\.doc-tools\s*\{[^}]*opacity:\s*0[^}]*visibility:\s*hidden[^}]*pointer-events:\s*none/);
  assert.match(css, /\.doc-tools\s*\{[^}]*position:\s*absolute[^}]*right:\s*9px/);
  assert.match(css, /\.doc\s*\{[^}]*min-height:\s*46px/);
  for (const selector of ['.doc:hover', '.doc:focus-within', '.doc.menu-open']) {
    assert.ok(css.includes(`${selector} .doc-tools`));
  }
  assert.match(css, /\.doc:hover \.doc-status[^}]*opacity:\s*0[^}]*visibility:\s*hidden/);
  for (const selector of ['.doc:hover', '.doc:focus-within', '.doc.menu-open']) assert.ok(css.includes(`${selector} .doc-status`));
  assert.match(css, /\.doc:hover \.doc-tools[^}]*opacity:\s*1[^}]*visibility:\s*visible/);
});


test('unassigned rows have no placeholder badge while real categories and overflow remain', () => {
  const context = createContext({
    URL, location: { href: 'http://localhost/dist/view.html' }, libraryPath: '/sources', MAX_ROW_BADGES: 3, DEFAULT_TAG: 'default',
    copy: {}, english: {}, document: { documentElement: { lang: 'en' } },
    tags: ['a', 'b', 'c', 'd'].map(id => ({ id, name: id, color: 'blue' })),
    node: (_tag, className = '', text = '') => element(className, text), svg: name => element(name), icon: () => element('button'),
    CircleCheck: 'check', Circle: 'circle', CircleAlert: 'alert', Loader: 'loader', Eye: 'eye', FolderOpen: 'folder', EllipsisVertical: 'more',
    iconForFile: () => 'markdown.svg', tagName: id => id, tagDot: () => element('tag-dot'), previewRoute: () => 'text', tr: key => key,
  });
  runInContext(code, context);
  for (const assigned of [[], ['default'], ['default', 'a', 'b', 'c', 'd']]) {
    context.doc = { id: 'doc', path: '/sources/notes.md', name: 'notes.md', tags: assigned, chunks: 1, status: 'ready', added_at: 0, indexed_at: 0 };
    const row = runInContext('buildRow(doc)', context);
    assert.equal(row.children.filter(child => child.className.includes('unclassified')).length, 0);
    const badges = row.children.find(child => child.className === 'doc-name').children.filter(child => child.className.startsWith('doc-tag'));
    assert.equal(badges.length, assigned.includes('a') ? 4 : 0);
    if (badges.length) { assert.equal(badges[3].textContent, '+1'); assert.equal(badges[3].attributes.title, 'd'); }
    assert.equal(row.children.find(child => child.className === 'doc-tools').children.length, 2, 'primary and menu actions remain in every row');
  }
});

test('keyboard users reveal actions through a focusable row and status remains in its accessible label', () => {
  assert.match(source, /row\.tabIndex = 0/);
  assert.match(source, /row\.setAttribute\('aria-label', `\$\{displayPath\} · \$\{tr\(statusKey\)\}`\)/);
  assert.match(source, /event\.target !== row/);
  assert.match(css, /\.doc:focus-visible\s*\{[^}]*outline:/);
});

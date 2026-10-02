import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { openInPreview } from '../dist/index.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a listed document opens in the host built-in preview when the page bridge has one', () => {
  const calls = [];
  const appView = {
    openPreview(path) { calls.push([this === appView, path]); return Promise.resolve({ id: 'layer-1' }); },
  };
  const fallbacks = [];
  assert.equal(openInPreview({ appView }, '/library/imports/tag/notes.md', () => fallbacks.push('reveal')), true);
  assert.deepEqual(calls, [[true, '/library/imports/tag/notes.md']], 'the call keeps the host as its receiver');
  assert.deepEqual(fallbacks, [], 'a host that can preview never falls back');
});

test('an older host without the preview API asks the caller to reveal the file instead', () => {
  const fallbacks = [];
  const fallback = () => fallbacks.push('reveal');
  assert.equal(openInPreview(undefined, '/library/notes.md', fallback), false);
  assert.equal(openInPreview({}, '/library/notes.md', fallback), false);
  assert.equal(openInPreview({ appView: {} }, '/library/notes.md', fallback), false);
  assert.deepEqual(fallbacks, [], 'the caller reveals on a false return, not through the callback');
});

test('a refused file falls back once the host rejects, and a synchronous throw falls back too', async () => {
  // A .docx the preview cannot render rejects; by then the click handler has already returned.
  const rejected = [];
  assert.equal(
    openInPreview({ appView: { openPreview: () => Promise.reject(new Error('unsupported')) } }, '/library/report.docx', () => rejected.push('reveal')),
    true,
  );
  await tick();
  assert.deepEqual(rejected, ['reveal']);

  const threw = [];
  assert.equal(
    openInPreview({ appView: { openPreview: () => { throw new Error('no layer'); } } }, '/library/notes.md', () => threw.push('reveal')),
    false,
  );
  assert.deepEqual(threw, [], 'a false return is the caller’s cue, so the callback stays quiet');
});

test('a preview that opens successfully is never followed by a reveal', async () => {
  const fallbacks = [];
  openInPreview({ appView: { openPreview: () => new Promise(() => {}) } }, '/library/notes.md', () => fallbacks.push('reveal'));
  await tick();
  assert.deepEqual(fallbacks, [], 'a pending preview is not a failure');
});

test('the App View row previews, and locating the copy on disk stays reachable in the row menu', async () => {
  const view = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8');
  const html = await readFile(new URL('../src/view.html', import.meta.url), 'utf8');
  // Both entry points route through the one helper, so the row cannot drift from its own button.
  assert.match(view, /row\.addEventListener\('click',[\s\S]{0,200}openDocument\(doc\)/);
  assert.match(view, /const preview = icon\(Eye, tr\('preview'\)\);\s*\n\s*preview\.addEventListener\('click', \(\) => openDocument\(doc\)\)/);
  assert.match(view, /function openDocument\(doc: Document\): void \{[\s\S]{0,200}openInPreview\(bridge, doc\.path, reveal\)/);
  // The fallback target is the menu entry, which must keep its own wording and handler.
  assert.match(html, /id="row-open"/);
  assert.match(view, /byId\('row-open'\)\.addEventListener\('click', \(\) => \{\s*\n\s*if \(rowMenuDoc\) request\('reveal'/);
});

test('the preview label exists for both locales and in the page English fallback', async () => {
  const view = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8');
  const zh = JSON.parse(await readFile(new URL('../i18n/zh-CN.json', import.meta.url), 'utf8'));
  const en = JSON.parse(await readFile(new URL('../i18n/en-US.json', import.meta.url), 'utf8'));
  // Without the fallback entry a locale miss paints the raw key on the button tooltip.
  assert.equal(zh.ui.preview, '用内置预览打开');
  assert.equal(en.ui.preview, 'Open in the built-in preview');
  assert.equal(zh.ui.reveal, undefined, 'the old tooltip is gone from both locales');
  assert.equal(en.ui.reveal, undefined);
  assert.match(view, /preview: 'Preview', locate:/);
});

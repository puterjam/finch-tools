import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ACCEPTED, openInPreview, openListedDocument, previewRoute } from '../dist/index.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A host that records what it was asked to preview. */
function recordingHost(result = () => Promise.resolve({ id: 'layer-1' })) {
  const calls = [];
  const appView = { openPreview(path) { calls.push([this === appView, path]); return result(); } };
  return { host: { appView }, calls };
}

test('only Markdown and text go to Finch’s document preview', () => {
  for (const name of ['notes.md', 'NOTES.MD', 'readme.markdown', 'log.txt']) {
    assert.equal(previewRoute(name), 'text', name);
  }
});

test('images go to the host’s dedicated image viewer, not the document preview', () => {
  for (const name of ['scan.png', 'photo.JPG', 'shot.jpeg', 'art.webp', 'page.bmp', 'fax.tif', 'fax.tiff']) {
    assert.equal(previewRoute(name), 'image', name);
  }
});

test('PDF and Office files use the host document preview', () => {
  for (const name of ['report.PDF', 'brief.doc', 'brief.docx', 'table.xls', 'table.xlsx', 'slides.ppt', 'slides.pptx']) assert.equal(previewRoute(name), 'document', name);
});
test('unknown binary formats stay outside Finch', () => {
  for (const name of ['archive.zip', 'no-extension', '', 'folder.name/name', 'name.']) {
    assert.equal(previewRoute(name), 'external', name);
  }
});

test('every type the library accepts is routed somewhere on purpose', () => {
  // A new accepted extension that nobody routed would silently open externally.
  const expected = new Map([['.md', 'text'], ['.markdown', 'text'], ['.txt', 'text'], ['.png', 'image'], ['.jpg', 'image'],
    ['.jpeg', 'image'], ['.webp', 'image'], ['.bmp', 'image'], ['.tif', 'image'], ['.tiff', 'image'],
    ['.pdf', 'document'], ['.doc', 'document'], ['.docx', 'document'], ['.xls', 'document'], ['.xlsx', 'document'], ['.ppt', 'document'], ['.pptx', 'document']]);
  assert.deepEqual(ACCEPTED.slice().sort(), [...expected.keys()].sort(), 'the accepted list changed');
  for (const [extension, route] of expected) assert.equal(previewRoute(`file${extension}`), route, extension);
});

test('text and images reach the host preview, external types are left to the caller', async () => {
  const { host, calls } = recordingHost();
  const fallbacks = [];
  const onUnavailable = () => fallbacks.push('external');

  assert.equal(openListedDocument(host, 'notes.md', '/library/notes.md', onUnavailable), true);
  assert.equal(openListedDocument(host, 'scan.png', '/library/scan.png', onUnavailable), true);
  assert.deepEqual(calls, [[true, '/library/notes.md'], [true, '/library/scan.png']], 'the path alone tells the host which viewer to use');
  assert.deepEqual(fallbacks, []);

  assert.equal(openListedDocument(host, 'report.pdf', '/library/report.pdf', onUnavailable), true);
  assert.deepEqual(calls.at(-1), [true, '/library/report.pdf']);
  assert.equal(openListedDocument(host, 'program.exe', '/library/program.exe', onUnavailable), false);
  assert.equal(calls.length, 3, 'unknown binaries never reach the preview');
});

test('a listed document opens in the host built-in preview when the page bridge has one', () => {
  const { host, calls } = recordingHost();
  const fallbacks = [];
  assert.equal(openInPreview(host, '/library/imports/tag/notes.md', () => fallbacks.push('external')), true);
  assert.deepEqual(calls, [[true, '/library/imports/tag/notes.md']], 'the call keeps the host as its receiver');
  assert.deepEqual(fallbacks, [], 'a host that can preview never falls back');
});

test('an older host without the preview API asks the caller to open the file externally', () => {
  const fallbacks = [];
  const fallback = () => fallbacks.push('external');
  assert.equal(openInPreview(undefined, '/library/notes.md', fallback), false);
  assert.equal(openInPreview({}, '/library/notes.md', fallback), false);
  assert.equal(openInPreview({ appView: {} }, '/library/notes.md', fallback), false);
  assert.deepEqual(fallbacks, [], 'the caller opens externally on a false return, not through the callback');
});

test('a rejected preview falls back once the host rejects, and a synchronous throw falls back too', async () => {
  // By the time a preview rejects, the click handler has already returned — the callback is the
  // only way the row can still do something.
  const rejected = [];
  assert.equal(
    openInPreview({ appView: { openPreview: () => Promise.reject(new Error('unsupported')) } }, '/library/scan.tiff', () => rejected.push('external')),
    true,
  );
  await tick();
  assert.deepEqual(rejected, ['external']);

  const threw = [];
  assert.equal(
    openInPreview({ appView: { openPreview: () => { throw new Error('no layer'); } } }, '/library/notes.md', () => threw.push('external')),
    false,
  );
  assert.deepEqual(threw, [], 'a false return is the caller’s cue, so the callback stays quiet');
});

test('a preview that opens successfully is never followed by an external hand-off', async () => {
  const fallbacks = [];
  openInPreview({ appView: { openPreview: () => new Promise(() => {}) } }, '/library/notes.md', () => fallbacks.push('external'));
  await tick();
  assert.deepEqual(fallbacks, [], 'a pending preview is not a failure');
});

test('row clicks open documents but text-selection gestures do not', async () => {
  const view = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8');
  const html = await readFile(new URL('../src/view.html', import.meta.url), 'utf8');
  const buildRow = view.slice(view.indexOf('function buildRow('), view.indexOf('function buildEmptyState('));
  assert.match(buildRow, /row\.addEventListener\('click'/);
  assert.match(buildRow, /dragged \|\| moved \|\| selecting \|\| hasRowSelection\(\)/, 'both pointer movement and text selections suppress activation');
  assert.match(buildRow, /row\.addEventListener\('keydown',[\s\S]{0,220}openDocument\(doc\)/, 'focused keyboard activation remains explicit');
  assert.match(view, /function openDocument\(doc: Document\): void \{[\s\S]{0,200}openListedDocument\(bridge, doc\.name, doc\.path, reveal\)/);
  // The row previews; the separate folder button reveals the original without a duplicate menu entry.
  assert.match(buildRow, /const primary = icon\(FolderOpen, tr\('reveal'\)\);/);
  assert.match(buildRow, /primary\.addEventListener\('click', \(\) => request\('reveal', \{ id: doc\.id \}\)\);/);
  assert.doesNotMatch(html, /id="row-open"/);
  assert.match(html, /id="row-classify"/);
});

test('both tooltips exist for both locales and in the page English fallback', async () => {
  const view = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8');
  const zh = JSON.parse(await readFile(new URL('../i18n/zh-CN.json', import.meta.url), 'utf8'));
  const en = JSON.parse(await readFile(new URL('../i18n/en-US.json', import.meta.url), 'utf8'));
  assert.equal(zh.ui.preview, '用内置预览打开');
  assert.equal(en.ui.preview, 'Open in the built-in preview');
  assert.equal(zh.ui.reveal, '在文件管理器中定位原文件');
  assert.equal(en.ui.reveal, 'Show in file manager');
  // Without the fallback entries a locale miss paints raw keys on the hover tooltips.
  assert.match(view, /reveal: 'Show in file manager', preview: 'Preview', locate:/);
});

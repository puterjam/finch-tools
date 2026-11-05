import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { transform } from 'esbuild';
import { isLibraryScoped } from '../dist/index.js';

const source = (await readFile(new URL('../src/view.ts', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const declarations = source.slice(0, source.indexOf('\nmountStaticIcons();')).replace(/^import .*\r?\n/gm, '');
const start = source.indexOf('if (bridge) {\n  bridge.onMessage');
const end = source.indexOf("  resetPage(); request('ready');", start);
const { code } = await transform(`${declarations}\n${source.slice(start, end)}\n}`, { loader: 'ts' });
const copies = Object.fromEntries(await Promise.all(['zh-CN', 'en-US'].map(async locale => [locale, JSON.parse(await readFile(new URL(`../i18n/${locale}.json`, import.meta.url), 'utf8')).ui])));
function fixture(locale = 'en-US') {
  let receive;
  const elements = new Map(), toasts = [];
  const byId = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', hidden: false, attrs: {}, children: [], getBoundingClientRect: () => ({top:0,bottom:500}), replaceChildren(...children) { this.children = children; }, setAttribute(key, value) { this.attrs[key] = value; } });
    return elements.get(id);
  };
  const context = createContext({ isLibraryScoped,
    window: { finch: { onMessage(callback) { receive = callback; }, postMessage() {} } }, clearTimeout() {},
    document: { getElementById: byId }, captureToast: (...args) => toasts.push(args),
  });
  runInContext(code, context);
  context.ui = copies[locale];
  const run = script => runInContext(script, context);
  run("copy = ui; libraryPath = '/library'; renderDirectories = renderTags = renderDocs = updateSortSizer = updateLibrary = renderEnvironment = renderEnvironmentMenu = renderOnboardLibrary = renderActivity = setMenu = closeRowMenu = closeTagColor = closeSearch = () => {}; toast = captureToast;");
  return { run, receive, byId, toasts, elements };
}
const clean = { updated: [], removed: [], unchanged: 2, unreachable: [], failed: [] };
const noisy = { ...clean, skipped: [{ name: 'empty.txt', reason: 'empty_file' }], failed: [{ name: 'broken.pdf', reason: '<script>private details</script>' }], unreachable: ['System Volume Information', '$RECYCLE.BIN/SID'] };

for (const locale of Object.keys(copies)) {
  for (const [name, sync] of [['clean', clean], ['partial', noisy], ['empty', { ...clean, unchanged: 0 }]]) {
    test(`${locale}: ${name} manual scans show exactly one short completion without exception details`, () => {
      const f = fixture(locale); f.run("pending.set('scan', { type: 'sync' });");
      f.receive({ type: 'syncStarted', requestId: 'scan' });
      assert.equal(f.run("pending.has('scan')"), true);
      f.receive({ type: 'scanStarted', root: '/library' });
      f.receive({ type: 'scanDone', root: '/library', sync });
      assert.equal(f.toasts.length, 0, 'the broadcast must not duplicate the manual receipt');
      f.receive({ type: 'syncDone', requestId: 'scan', root: '/library', sync });
      assert.equal(f.run("pending.has('scan')"), false); assert.equal(f.run('scanBusy'), false);
      assert.equal(f.toasts.length, 1); assert.deepEqual(f.toasts[0], [copies[locale].syncFinished, 'success']);
      assert.equal([...f.elements.keys()].some(id => id.startsWith('scan-issues')), false, 'no report DOM is requested');
    });
  }
}

test('background completion also uses only the concise message', () => {
  const f = fixture('zh-CN'); f.receive({ type: 'scanDone', root: '/library', sync: noisy });
  assert.equal(f.toasts.length, 1); assert.deepEqual(f.toasts[0], [copies['zh-CN'].syncFinished, 'success']);
});
test('an aborted or failed scan resets busy state without claiming completion or showing exceptions', () => {
  const f = fixture(); f.run("pending.set('scan', { type: 'sync' }); setScanBusy(true);");
  f.receive({ type: 'scanFailed', root: '/library', error: 'Private path and error' });
  assert.equal(f.run('scanBusy'), false); assert.equal(f.toasts.length, 0);
  f.receive({ type: 'error', requestId: 'scan', error: 'Private path and error' });
  assert.equal(f.run("pending.has('scan')"), false); assert.equal(f.toasts.length, 0);
});
test('directory switches still reject late scan completions and release old requests', () => {
  const f = fixture();
  f.run("pending.set('old-scan', { type: 'sync' });");
  f.run("applyLibrary({ root: '/other', selected: true, isDefault: false, documents: 0, tags: 0, unavailable: null });");
  for (const type of ['scanDone', 'scanFailed', 'scanStarted', 'syncDone']) f.receive({ type, root: '/library', sync: noisy, error: 'old error' });
  f.receive({ type: 'syncDone', requestId: 'old-scan', root: '/library', sync: noisy });
  assert.equal(f.run("pending.has('old-scan')"), false);
  assert.equal(f.run('scanBusy'), false); assert.equal(f.toasts.length, 0);
});
test('the warning trigger, dialog and their event wiring are removed, not just hidden', async () => {
  const html = await readFile(new URL('../src/view.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/view.css', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /scan-issues|triangle-alert/);
  assert.doesNotMatch(css, /scan-issues/);
  assert.doesNotMatch(source, /function (renderScanIssues|closeScanIssues|wireScanIssues|reportScanIssues)/);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { transform } from 'esbuild';
import { isLibraryScoped } from '../dist/index.js';

const view = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8');
const declarations = view.slice(0, view.indexOf('\nmountStaticIcons();')).replace(/^import .*\r?\n/gm, '');
const { code } = await transform(declarations, { loader: 'ts' });
function fixture() {
  const elements = new Map(), sent = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { attrs: {}, hidden: false, disabled: false, textContent: '', setAttribute(key, value) { this.attrs[key] = value; } });
    return elements.get(id);
  };
  const context = createContext({ isLibraryScoped, window: { finch: { postMessage(message) { sent.push(message); } } }, document: { getElementById: element } });
  runInContext(code, context);
  const run = script => runInContext(script, context);
  run("libraryPath = '/library'; renderActivity = renderDocs = () => {};");
  return { element, sent, run };
}

test('the primary scan offers graceful pause without duplicate scan or pause requests', () => {
  const f = fixture();
  f.run('requestScan(); requestScan();');
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].type, 'sync'); assert.equal(f.sent[1].type, 'scanPause');
  assert.equal(f.sent[1].libraryRoot, '/library');
  f.run('requestScan();'); assert.equal(f.sent.length, 2, 'pause stays disabled until the current file settles');
  assert.equal(f.element('library-menu').hidden, true);
  assert.equal(f.element('sync').disabled, true);
  assert.equal(f.element('sync').attrs['aria-busy'], 'true');
  f.run('setScanBusy(false);');
  assert.equal(f.element('sync').disabled, false);
  f.run('requestScan();');
  assert.equal(f.sent.length, 3);
});

test('scanning is unavailable without a selected accessible directory or during directory operations', () => {
  const f = fixture();
  for (const setup of ["libraryPath = '';", "libraryPath = '/library'; libraryUnavailable = '/offline';", "libraryUnavailable = ''; libraryBusy = true;"]) {
    f.run(`${setup} setScanBusy(false); requestScan();`);
    assert.equal(f.sent.length, 0);
    assert.equal(f.element('sync').disabled, true);
  }
  f.run('libraryBusy = false; setScanBusy(false);');
  assert.equal(f.element('sync').disabled, false);
});

test('scanning has one primary entry while the footer menu contains only settings', async () => {
  const html = await readFile(new URL('../src/view.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="library-sync"/);
  assert.match(html, /id="library-location"/);
  assert.match(html, /id="library-environment"/);
  assert.match(view, /byId\('sync'\)\.addEventListener\('click', requestScan\)/);
  for (const locale of ['zh-CN', 'en-US']) {
    const { ui } = JSON.parse(await readFile(new URL(`../i18n/${locale}.json`, import.meta.url), 'utf8'));
    assert.ok(ui.librarySettings);
    assert.match(ui.syncHint, /SHA-256/);
  }
});

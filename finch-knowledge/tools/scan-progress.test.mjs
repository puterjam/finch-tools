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
function fixture() {
  const elements = new Map(), timers = new Map(), toasts = [];
  let receive, timerId = 0;
  const element = id => {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, { hidden: false, attrs: {}, style: {}, children: [], getBoundingClientRect: () => ({top:0,bottom:500}), replaceChildren() {}, classList: {
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name),
      }, setAttribute(key, value) { this.attrs[key] = value; }, removeAttribute(key) { delete this.attrs[key]; } });
    }
    return elements.get(id);
  };
  const context = createContext({ isLibraryScoped,
    window: { finch: { onMessage(callback) { receive = callback; }, postMessage() {} },
      setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; } },
    clearTimeout(id) { timers.delete(id); }, document: { getElementById: element }, toasts,
  });
  runInContext(code, context);
  runInContext("libraryPath = '/library'; libraryEntered = true; renderDocs = renderEnvironment = renderEnvironmentMenu = renderOnboardLibrary = () => {}; toast = (...args) => toasts.push(args);", context);
  return { element, timers, toasts, receive, run: script => runInContext(script, context) };
}

test('environment preparation and generic status pushes never show the footer scan bar', () => {
  const f = fixture();
  f.receive({ type: 'environment', environment: { usable: true, ready: false, running: true, steps: [{ id: 'ocr', status: 'running', optional: true, percent: 42 }] } });
  assert.equal(f.element('activity').hidden, true);
  f.receive({ type: 'progress', message: 'Checking the runtime' });
  assert.equal(f.element('activity').hidden, true);
  assert.equal(f.timers.size, 0);
  f.run('setLibraryBusy(true);');
  assert.equal(f.element('activity').hidden, true, 'directory operations do not occupy the scan bar');
});

test('scan progress is determinate, monotonic and independent of engine progress', () => {
  const f = fixture();
  f.receive({ type: 'scanStarted' });
  assert.equal(f.element('activity').hidden, false);
  assert.equal(f.element('activity').classList.contains('indeterminate'), true);
  f.receive({ type: 'scanProgress', root: '/library', percent: 0, message: 'Starting scan' });
  assert.equal(f.element('activity-fill').style.width, '0%');
  f.receive({ type: 'scanProgress', root: '/library', percent: 25, message: 'Checking notes.md' });
  assert.equal(f.element('activity-fill').style.width, '25%');
  assert.equal(f.element('activity').attrs['aria-valuenow'], '25');
  f.receive({ type: 'scanProgress', root: '/library', percent: 10 });
  assert.equal(f.element('activity-fill').style.width, '25%');
  f.receive({ type: 'environment', environment: { usable: true, ready: false, running: true, steps: [{ id: 'ocr', status: 'running', optional: true, percent: 70 }] } });
  assert.equal(f.element('activity-fill').style.width, '25%');
  f.receive({ type: 'scanProgress', root: '/library', percent: 150 });
  assert.equal(f.element('activity-fill').style.width, '100%');
  f.receive({ type: 'scanDone' });
  assert.equal(f.element('activity').hidden, true);
  assert.equal(f.timers.size, 0);
  f.receive({ type: 'scanProgress', root: '/library', percent: 90 });
  assert.equal(f.element('activity').hidden, true, 'late messages cannot restore a finished bar');
  f.receive({ type: 'scanStarted' });
  assert.equal(f.element('activity').classList.contains('indeterminate'), true, 'a new scan resets the old percentage');
});

test('progress from another library is ignored and failures end the bar immediately', () => {
  const f = fixture();
  f.receive({ type: 'scanStarted' });
  f.receive({ type: 'scanProgress', root: '/elsewhere', percent: 80 });
  assert.equal(f.element('activity').attrs['aria-valuenow'], undefined);
  f.receive({ type: 'scanFailed', error: 'Source unavailable' });
  assert.equal(f.element('activity').hidden, true);
  assert.equal(f.toasts.length, 0, 'failed scans stop progress without exposing exception details in a toast');
});

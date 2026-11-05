import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { transform } from 'esbuild';
import { isLibraryScoped } from '../dist/index.js';

const view = (await readFile(new URL('../src/view.ts', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const declarations = view.slice(0, view.indexOf('\nmountStaticIcons();')).replace(/^import .*\n/gm, '');
const { code } = await transform(declarations, { loader: 'ts' });

function fixture() {
  class El {
    constructor() { this.hidden = false; this.children = []; this.style = {}; this.options = [{}, {}, {}]; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    setAttribute() {}
  }
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, new El()); return elements.get(id); };
  const sent = [];
  const context = createContext({ isLibraryScoped, window: { finch: { postMessage: message => sent.push(message) } }, document: { getElementById: element, querySelector: () => null }, El });
  runInContext(code, context);
  runInContext(`
    node = () => new El(); svg = () => new El(); environmentIcon = () => null;
    renderActivity = renderEnvironmentMenu = renderDirectories = renderTags = renderDocs = updateLibrary = updateSortSizer = () => {};
  `, context);
  const run = script => runInContext(script, context);
  const state = (statuses = ['pending', 'pending', 'pending']) => ({
    ready: statuses.every(status => status === 'ready'), usable: statuses.slice(0, 2).every(status => status === 'ready'),
    running: statuses.some(status => status === 'running'),
    steps: ['lancedb', 'anydoc', 'ocr'].map((id, i) => ({ id, status: statuses[i], optional: id === 'ocr', lazy: id === 'ocr' })),
  });
  return { element, sent, run, apply: statuses => run(`applyEnvironment(${JSON.stringify(state(statuses))})`) };
}

test('all three engines remain visible and downloads start before selecting a directory', () => {
  const page = fixture();
  page.apply();
  assert.equal(page.element('onboard-steps').children.length, 3);
  assert.equal(page.element('onboard-enter').disabled, true);
  assert.equal(page.element('onboard-enter').hidden, false);
  assert.equal(page.element('onboard-library-status').textContent, 'waiting');
  assert.deepEqual(page.sent.map(message => message.type), ['environmentInstall']);
  page.apply();
  assert.equal(page.sent.length, 1, 'repeated status updates cannot start duplicate installs');
});

test('Enter Knowledge Base needs a directory and required engines, never lazy OCR', () => {
  const page = fixture();
  page.apply(['ready', 'ready', 'ready']);
  assert.equal(page.element('onboard-enter').disabled, true, 'engines alone are not sufficient');
  page.run("libraryPath = 'C:/Documents';");
  page.apply(['ready', 'ready', 'running']);
  assert.equal(page.element('onboard-enter').disabled, false, 'background OCR must not block entry');
  page.apply(['ready', 'ready', 'failed']);
  assert.equal(page.element('onboard-enter').disabled, false);
  assert.equal(page.element('onboard-retry').hidden, true, 'optional OCR failures do not demand setup repair');
  page.apply(['ready', 'failed', 'pending']);
  assert.equal(page.element('onboard-enter').disabled, true, 'document parsing remains required');
  assert.equal(page.element('onboard-retry').hidden, false);
  page.apply(['ready', 'ready', 'ready']);
  assert.equal(page.element('onboard-enter').hidden, false);
  assert.equal(page.element('onboard-enter').disabled, false);
  assert.equal(page.element('onboard-enter').textContent, 'Enter Knowledge Base');
  assert.equal(page.element('onboard').hidden, false, 'completion does not auto-navigate');
  page.run('libraryEntered = true; renderEnvironment(environment);');
  assert.equal(page.element('onboard').hidden, true);
});

test('locale repaint preserves setup state instead of restoring the old preparing-engine headline', () => {
  const page = fixture(); page.apply();
  page.run("copy = { ...english, onboardTitle: '准备你的知识库', onboardIntro: '下载与选目录同时进行' }; applyCopy();");
  assert.equal(page.element('onboard-title').textContent, '准备你的知识库');
  assert.equal(page.element('onboard-intro').textContent, '下载与选目录同时进行');
  assert.equal(page.element('onboard-steps').children.length, 3);
});

test('waiting, downloading, unpacking and ready retain identical detail and progress slots', async () => {
  const page = fixture();
  const slots = () => page.element('onboard-steps').children.map(row => row.children[1].children);
  for (const statuses of [['pending', 'pending', 'pending'], ['running', 'pending', 'pending'], ['ready', 'ready', 'ready']]) {
    page.apply(statuses);
    assert.deepEqual(slots().map(children => children.length), [3, 3, 3]);
    assert.equal(page.element('onboard-enter').hidden, false);
  }
  page.run(`applyEnvironment({ ...environment, ready: false, steps: environment.steps.map(step => ({ ...step, status: 'running', message: 'Downloading a very long engine name', percent: 42 })) });`);
  assert.equal(slots()[0][2].style.visibility, 'visible');
  page.run(`applyEnvironment({ ...environment, steps: environment.steps.map(step => ({ ...step, percent: undefined, message: 'Unpacking' })) });`);
  assert.equal(slots()[0][2].style.visibility, 'hidden', 'hidden progress still occupies its slot');
  assert.deepEqual(slots().map(children => children.length), [3, 3, 3]);
  const css = await readFile(new URL('../src/view.css', import.meta.url), 'utf8');
  assert.match(css, /\.onboard-step-detail\s*\{[^}]*height: 18px;[^}]*white-space: nowrap/);
  assert.match(css, /\.onboard-step-title\s*\{[^}]*height: 20px;/);
  assert.match(css, /\.onboard-bar\s*\{[^}]*height: 3px;/);
});

test('the entry action spans the card and keeps a large 48px target while disabled', async () => {
  const css = await readFile(new URL('../src/view.css', import.meta.url), 'utf8');
  assert.match(css, /#onboard-enter\s*\{[^}]*flex: 0 0 100%;[^}]*width: 100%;[^}]*height: 48px;[^}]*min-height: 48px;/);
  const page = fixture(); page.apply();
  assert.equal(page.element('onboard-enter').hidden, false);
  assert.equal(page.element('onboard-enter').disabled, true);
});

test('pending lazy OCR does not trigger downloads or reopen onboarding after required setup', () => {
  const page = fixture();
  page.run("libraryPath = 'C:/Documents';");
  page.apply(['ready', 'ready', 'pending']);
  assert.equal(page.element('onboard-enter').disabled, false);
  assert.equal(page.sent.length, 0, 'missing OCR alone never starts automatic installation');
  page.run('libraryEntered = true; renderEnvironment(environment);');
  assert.equal(page.element('onboard').hidden, true);
  page.apply(['ready', 'ready', 'running']);
  assert.equal(page.element('onboard').hidden, true);
});

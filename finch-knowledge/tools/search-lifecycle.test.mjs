import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { transform } from 'esbuild';
import { isLibraryScoped } from '../dist/index.js';
const source = (await readFile(new URL('../src/view.ts', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const declarations = source.slice(0, source.indexOf('\nmountStaticIcons();')).replace(/^import .*\n/gm, '');
const start = source.indexOf('if (bridge) {\n  bridge.onMessage');
const end = source.indexOf("  resetPage(); request('ready');", start);
const { code } = await transform(`${declarations}\n${source.slice(start, end)}\n}`, { loader: 'ts' });
class Element {
  constructor() { this.children = []; this.events = {}; this.attrs = {}; this.value = ''; this.open = false; this.scrollTop = 0; this.classes = new Set(); this.classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) }; }
  addEventListener(name, fn) { this.events[name] = fn; }
  setAttribute(name, value) { this.attrs[name] = value; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  contains(target) { return this === target || this.children.some(child => child.contains?.(target)); }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; this.events.close?.(); }
}
function fixture() {
  const elements = new Map(), timers = new Map(), requests = [], windowEvents = {};
  const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  element('search-dialog').append(element('query'), element('matches'));
  let receive, sequence = 0;
  const context = createContext({ isLibraryScoped, Node: Element, Element, document: { getElementById: element, createElement: () => new Element() },
    clearTimeout: id => timers.delete(id), window: { finch: { onMessage(fn) { receive = fn; }, postMessage: message => requests.push(message) },
      setTimeout(fn) { const id = ++sequence; timers.set(id, fn); return id; }, addEventListener(name, fn) { windowEvents[name] = fn; } },
  });
  runInContext(code, context);
  const run = script => runInContext(script, context);
  run("renderMatches = next => { matches = next; activeMatch = next.length ? 0 : -1; byId('matches').replaceChildren(...next.map(() => new Element())); byId('search-dialog').classList.toggle('has-results', next.length > 0); }; wireSearchDialog();");
  const open = () => element('browse').events.click();
  const type = value => { element('query').value = value; element('query').events.input(); };
  const flush = () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } };
  const reply = (request = requests.at(-1)) => receive({ type: 'matches', requestId: request.requestId, matches: [{ document_id: 'old', text: 'old result' }] });
  return { element, timers, requests, windowEvents, run, open, type, flush, reply };
}
function assertEmpty(f) {
  assert.equal(f.element('query').value, '');
  assert.equal(f.run('searchQuery'), ''); assert.equal(f.run('matches.length'), 0); assert.equal(f.run('activeMatch'), -1);
  assert.equal(f.element('search-dialog').classes.has('has-results'), false);
  assert.equal(f.timers.size, 0); assert.equal(f.element('matches').scrollTop, 0);
}

test('backdrop dismissal clears input, results and active selection before reopening', () => {
  const f = fixture(); f.open(); f.type('old'); f.flush(); f.reply();
  f.element('matches').scrollTop = 200;
  f.element('search-dialog').events.click({ target: f.element('search-dialog') });
  assertEmpty(f); assert.equal(f.element('search-dialog').open, false);
  f.open(); assertEmpty(f); assert.equal(f.requests.length, 1, 'reopening never reruns the old query');
});

test('Escape and programmatic close both reset search state', () => {
  for (const action of ['cancel', 'close']) {
    const f = fixture(); f.open(); f.type('old'); f.flush(); f.reply();
    if (action === 'cancel') { f.element('search-dialog').events.cancel(); f.element('search-dialog').close(); }
    else f.element('search-dialog').close();
    assertEmpty(f); f.open(); assertEmpty(f);
  }
});

test('leaving the window or palette clears search, but focusing a result does not', () => {
  const f = fixture(); f.open(); f.type('old'); f.flush(); f.reply();
  f.element('search-dialog').events.focusout({ relatedTarget: f.element('matches').children[0] });
  assert.equal(f.element('query').value, 'old'); assert.equal(f.run('matches.length'), 1);
  f.windowEvents.blur(); assertEmpty(f); assert.equal(f.element('search-dialog').open, false);
  f.open(); f.type('new');
  f.element('search-dialog').events.focusout({ relatedTarget: f.element('browse') });
  assertEmpty(f); assert.equal(f.element('search-dialog').open, false);
});

test('pending timers and late results cannot refill a dismissed or reopened search', () => {
  const f = fixture(); f.open(); f.type('not sent'); f.element('search-dialog').close(); f.flush();
  assert.equal(f.requests.length, 0);
  f.open(); f.type('old'); f.flush(); const old = f.requests.at(-1);
  f.element('search-dialog').close(); f.open(); f.reply(old); assertEmpty(f);
  f.type('current'); f.flush(); f.reply(old);
  assert.equal(f.run('matches.length'), 0);
  f.reply(); assert.equal(f.run('matches.length'), 1);
});

test('clearing the query also clears matches and their keyboard selection', () => {
  const f = fixture(); f.open(); f.type('old'); f.flush(); f.reply();
  f.type(''); assertEmpty(f);
});

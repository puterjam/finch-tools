import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { transform } from 'esbuild';
import * as lucide from 'lucide';

const view = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8');
// Only the icon names view.ts actually imports are handed to the sandbox: spreading all of lucide
// would shadow the standard globals (lucide ships a `Map`, a `Filter`, a `Select`…).
const lucideNames = view.match(/^import \{([^}]*)\} from 'lucide';/m)[1]
  .split(',')
  .map((entry) => entry.trim().split(/\s+as\s+/))
  .filter(([name]) => name !== 'IconNode');
const icons = Object.fromEntries(lucideNames.map(([name, alias]) => [alias ?? name, lucide[name]]));
const declarations = view.slice(0, view.indexOf('\nmountStaticIcons();')).replace(/^import .*\n/gm, '');
const { code } = await transform(declarations, { loader: 'ts' });

/**
 * The smallest DOM the tag column touches: enough class/dataset bookkeeping and a descendant
 * selector matcher, so renderTags() really builds rows instead of being pattern-matched in text.
 */
let doc = null;
class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.childNodes = [];
    this.parentElement = null;
    this.attrs = new Map();
    this.dataset = {};
    this.handlers = new Map();
    this.classes = new Set();
    this.textContent = '';
    this.style = {};
    this.value = '';
  }
  get classList() {
    return {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
      toggle: (name, on) => { if (on === undefined ? !this.classes.has(name) : on) this.classes.add(name); else this.classes.delete(name); },
    };
  }
  set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  setAttribute(key, value) { this.attrs.set(key, String(value)); if (key.startsWith('data-')) this.dataset[key.slice(5)] = String(value); }
  getAttribute(key) { return this.attrs.get(key) ?? null; }
  removeAttribute(key) { this.attrs.delete(key); }
  append(...children) { for (const child of children) { child.parentElement = this; this.childNodes.push(child); } }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.childNodes = []; this.append(...children); }
  contains(other) { for (let node = other; node; node = node.parentElement) if (node === this) return true; return false; }
  addEventListener(type, handler) { if (!this.handlers.has(type)) this.handlers.set(type, []); this.handlers.get(type).push(handler); }
  click() { for (const handler of this.handlers.get('click') ?? []) handler({ preventDefault() {}, target: this }); }
  focus() { if (doc) doc.activeElement = this; }
  blur() { if (doc && doc.activeElement === this) doc.activeElement = doc.body; }
  descendants() { return this.childNodes.flatMap((child) => [child, ...child.descendants()]); }
  querySelectorAll(selector) { return this.descendants().filter((node) => matches(node, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
function matchSimple(el, token) {
  const parsed = token.match(/^([a-z]*)((?:\.[\w-]+)*)$/);
  if (!parsed) throw new Error(`the fake DOM cannot match ${token}`);
  const [, tag, classes] = parsed;
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  return classes.split('.').filter(Boolean).every((name) => el.classes.has(name));
}
function matches(el, selector) {
  const parts = selector.trim().split(/\s+/);
  if (!matchSimple(el, parts[parts.length - 1])) return false;
  let node = el.parentElement;
  for (let i = parts.length - 2; i >= 0; i--) {
    let found = false;
    while (node) {
      if (matchSimple(node, parts[i])) { found = true; node = node.parentElement; break; }
      node = node.parentElement;
    }
    if (!found) return false;
  }
  return true;
}

/**
 * lucide's own createElement reaches for the realm's global document, which a vm sandbox has not
 * got, so the icon tree is built here from the same [tag, attrs, …children] shape.
 */
function buildNode([tag, attrs = {}, children = []]) {
  const element = new El(tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  for (const child of children) element.append(buildNode(child));
  return element;
}
function buildIcon(iconNode, attrs = {}) {
  const svg = new El('svg');
  for (const [key, value] of Object.entries({ stroke: 'currentColor', fill: 'none', ...attrs })) svg.setAttribute(key, String(value));
  for (const child of iconNode) svg.append(buildNode(child));
  return svg;
}

function fixture({ tags }) {
  const ids = ['tags', 'new-tag', 'drop-hint', 'query', 'library-title'];
  const elements = new Map(ids.map((id) => [id, new El('div')]));
  const document = {
    body: new El('body'),
    activeElement: null,
    getElementById: (id) => elements.get(id) ?? null,
    createElement: (tag) => new El(tag),
    createElementNS: (_ns, tag) => new El(tag),
    querySelectorAll: () => [],
  };
  document.activeElement = document.body;
  doc = document;
  const context = createContext({
    // The import lines are stripped, so every name they brought in has to come from the context.
    ...icons, createElement: buildIcon,
    highlightTerms: (text) => [{ text, matched: false }], snippetParts: () => [], inScope: () => true,
    openListedDocument: () => {}, previewRoute: () => null,
    document,
    window: { finch: { postMessage() {}, ui: { confirm: async () => ({ confirmed: false }), toast() {} } }, addEventListener() {} },
    setTimeout, clearTimeout, console,
  });
  runInContext(code, context);
  runInContext(`tags = ${JSON.stringify(tags)}; selectedTag = null; renderTags();`, context);
  return { tags: elements.get('tags'), document, run: (script) => runInContext(script, context) };
}
const names = (f) => f.tags.querySelectorAll('.tag-row').map((row) => row.dataset.id || (row.classes.has('creating') ? 'creating' : '?'));

test('the new-tag row opens even when Unclassified is not on screen', () => {
  // A fully classified library has no Unclassified row at all — the column showed All sources plus
  // the user's own tags, and "+" appended its input under a row that had been skipped.
  const f = fixture({ tags: [{ id: 'a', name: '市场分析', count: 1 }, { id: 'b', name: '工作职场', count: 3 }] });
  assert.deepEqual(names(f), ['all', 'a', 'b'], 'no Unclassified row when nothing is unclassified');
  assert.equal(f.tags.querySelector('.tag-row.creating'), null);
  f.run('startTagCreate();');
  assert.deepEqual(names(f), ['all', 'creating', 'a', 'b'], 'the row lands under All sources');
  const field = f.tags.querySelector('.tag-row.creating .tag-name-input');
  assert.ok(field, 'the input is really in the column');
  assert.equal(f.document.activeElement, field, 'and it holds focus so typing goes there');
});

test('the new-tag row still sits below Unclassified when that row is present', () => {
  const f = fixture({ tags: [{ id: 'default', name: 'Unclassified', count: 2 }, { id: 'a', name: '市场分析', count: 1 }] });
  f.run('startTagCreate();');
  assert.deepEqual(names(f), ['all', 'default', 'creating', 'a']);
});

test('cancelling drops the new-tag row again', () => {
  const f = fixture({ tags: [{ id: 'a', name: '市场分析', count: 1 }] });
  f.run('startTagCreate();');
  assert.equal(f.tags.querySelectorAll('.tag-row').length, 3);
  f.run('cancelTagCreate();');
  assert.deepEqual(names(f), ['all', 'a']);
});

test('a rename in progress does not swallow the click on +', () => {
  const f = fixture({ tags: [{ id: 'a', name: '市场分析', count: 1 }] });
  // The rename editor keeps focus, which is exactly when renderTags() refuses to rebuild.
  f.run("inlineTagEditing = 'a'; renderTags();");
  assert.ok(f.tags.querySelector('.tag-editor input'));
  f.run('startTagCreate();');
  assert.ok(f.tags.querySelector('.tag-row.creating .tag-name-input'), '+ wins over the open rename');
});

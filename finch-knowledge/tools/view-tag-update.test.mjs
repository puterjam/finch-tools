import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { transform } from 'esbuild';
import { inScope } from '../dist/index.js';

// Execute the real view functions and Bridge handler, without its page bootstrap. Only the DOM
// boundary is faked: scroll, row identity and outbound page requests remain observable.
async function fixture(scope = null) {
  const source = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8');
  const declarations = source.slice(0, source.indexOf('\nmountStaticIcons();')).replace(/^import .*\n/gm, '');
  const start = source.indexOf('if (bridge) {\n  bridge.onMessage');
  const end = source.indexOf('  resetPage(); request(\'ready\');', start);
  const { code } = await transform(`${declarations}\n${source.slice(start, end)}\n}`, { loader: 'ts' });
  const requests = [];
  const rows = new Map();
  const elements = new Map([
    ['documents-scroll', { scrollTop: 2400 }],
    ['documents', {
      querySelector(selector) { return rows.get(selector.match(/data-id="([^"]+)"/)[1]) ?? null; },
    }],
    ['search-dialog', { open: false }],
    ['count', { textContent: '' }],
    ['list-end', { textContent: '' }],
  ]);
  let receive;
  const context = createContext({
    window: { finch: { onMessage(fn) { receive = fn; }, postMessage(message) { requests.push(message); } } },
    document: { getElementById(id) { return elements.get(id); } },
    inScope,
    makeRow(doc) {
      const row = {
        id: doc.id, tags: doc.tags,
        replaceWith(next) { rows.set(doc.id, next); },
        remove() { rows.delete(doc.id); },
      };
      return row;
    },
  });
  runInContext(code, context);
  runInContext(`
    renderTags = () => {};
    buildRow = (doc) => makeRow(doc);
    renderDocs = () => { throw new Error('The document list was rebuilt'); };
    selectedTag = ${JSON.stringify(scope)};
    docs = Array.from({ length: 100 }, (_, i) => ({ id: String(i), tags: [] }));
    total = 150; beforeOffset = 0; nextOffset = 100;
  `, context);
  for (let i = 0; i < 100; i++) rows.set(String(i), context.makeRow({ id: String(i), tags: [] }));
  return {
    rows, requests, elements,
    change(id, nextTags, count = 150) {
      receive({ type: 'changed', tags: [{ id: 'default', name: 'Unclassified', count }, { id: 'a', name: 'A', count: 1 }],
        change: { kind: 'tagToggle', documentId: id, tags: nextTags } });
    },
    state() { return JSON.parse(runInContext('JSON.stringify({ total, beforeOffset, nextOffset, ids: docs.map(doc => doc.id) })', context)); },
  };
}

test('setting a category at the bottom patches only that row and keeps the scroll position', async () => {
  const view = await fixture();
  const untouched = view.rows.get('0');
  view.change('99', ['a']);
  assert.equal(view.rows.get('0'), untouched);
  assert.deepEqual(view.rows.get('99').tags, ['a']);
  assert.equal(view.elements.get('documents-scroll').scrollTop, 2400);
  assert.deepEqual(view.requests, []);
});

test('a toggle for a document outside the loaded window never refreshes the list', async () => {
  const view = await fixture();
  view.change('unloaded', ['a']);
  assert.equal(view.state().ids.length, 100);
  assert.equal(view.elements.get('documents-scroll').scrollTop, 2400);
  assert.deepEqual(view.requests, []);
});

test('moving a loaded row out of Unclassified corrects the next page offset', async () => {
  const view = await fixture('default');
  const untouched = view.rows.get('0');
  view.change('99', ['a'], 149);
  assert.equal(view.rows.has('99'), false);
  assert.equal(view.rows.get('0'), untouched);
  assert.equal(view.state().total, 149);
  assert.equal(view.state().nextOffset, 99, 'the following source must not be skipped');
  assert.equal(view.elements.get('documents-scroll').scrollTop, 2400);
  assert.deepEqual(view.requests, []);
});

test('another toggle after the row has left the category does not reset the page', async () => {
  const view = await fixture('default');
  view.change('99', ['a'], 149);
  view.change('99', ['a', 'b'], 149);
  assert.equal(view.state().total, 149, 'the same row is not subtracted twice');
  assert.equal(view.state().nextOffset, 99);
  assert.deepEqual(view.requests, []);
});

test('an offscreen toggle updates the filtered count from the backend catalogue', async () => {
  const view = await fixture('default');
  view.change('unloaded', ['a'], 149);
  assert.equal(view.state().total, 149);
  assert.deepEqual(view.requests, []);
});

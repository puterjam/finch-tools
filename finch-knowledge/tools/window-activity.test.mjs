import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { transform } from 'esbuild';

const source = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8');
const { code } = await transform(source.slice(source.indexOf('function wireWindowActivity()'), source.indexOf('function wireTagContextMenu()')), { loader:'ts' });
function fixture(kind = 'row') {
  const classes = new Set(), events = {}, windows = {}, closed = [];
  let blurred = 0, focused = true;
  const doc = {
    hidden:false, hasFocus:() => focused,
    documentElement:{classList:{add:(...names) => names.forEach(n => classes.add(n)),remove:name => classes.delete(name)}},
    activeElement:{closest:() => kind === 'row',matches:() => kind === 'button',blur:() => { blurred++; }},
    addEventListener:(name,fn) => { events[name] = fn; },
  };
  const context = createContext({ document:doc,window:{addEventListener:(name,fn) => { windows[name] = fn; }},
    closeRowMenu:() => closed.push('row'),closeTagColor:() => closed.push('color'),setMenu:() => closed.push('library'),
  });
  runInContext(code + '\nwireWindowActivity();',context);
  return {classes,events,windows,closed,doc,get blurred(){return blurred;},setFocused:value => { focused=value; }};
}

test('window blur clears transient row/button focus and closes menus', () => {
  for (const kind of ['row','button']) {
    const f=fixture(kind); f.windows.blur();
    assert.ok(f.classes.has('window-inactive')); assert.ok(f.classes.has('pointer-quiet'));
    assert.equal(f.blurred,1); assert.deepEqual(f.closed,['row','color','library']);
  }
});
test('switching applications keeps text drafts focused and untouched', () => {
  const f=fixture('input'); f.windows.blur(); assert.equal(f.blurred,0);
});
test('returning focus does not replay hover until fresh pointer activity', () => {
  const f=fixture(); f.windows.blur(); f.windows.focus();
  assert.equal(f.classes.has('window-inactive'),false); assert.ok(f.classes.has('pointer-quiet'));
  f.setFocused(false); f.events.pointermove(); assert.ok(f.classes.has('pointer-quiet'));
  f.setFocused(true); f.events.pointermove(); assert.equal(f.classes.has('pointer-quiet'),false);
});
test('fresh pointer input reconciles a missed focus event without reviving inactive hover', () => {
  const f = fixture(); f.windows.blur();
  f.setFocused(false); f.events.pointermove();
  assert.ok(f.classes.has('window-inactive')); assert.ok(f.classes.has('pointer-quiet'));
  f.setFocused(true); f.events.pointermove();
  assert.equal(f.classes.has('window-inactive'), false);
  assert.equal(f.classes.has('pointer-quiet'), false);
});

test('hidden/visible reconciliation also handles a view returning without a focus event', () => {
  const f=fixture(); f.doc.hidden=true; f.events.visibilitychange(); assert.ok(f.classes.has('window-inactive'));
  f.doc.hidden=false; f.events.visibilitychange(); assert.equal(f.classes.has('window-inactive'),false);
  assert.ok(f.classes.has('pointer-quiet'));
});

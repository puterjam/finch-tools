import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { DEFAULT_TAG, inScope, UNCLASSIFIED } from '../dist/index.js';

test('a row stays in the list unless the change moved it out of the open tag', () => {
  // Every category: a document belongs whatever it carries.
  assert.equal(inScope([], null), true);
  assert.equal(inScope(['a'], null), true);
  // Unclassified is the absence of every tag, not a tag of its own.
  assert.equal(inScope([], UNCLASSIFIED), true);
  assert.equal(inScope(['a'], UNCLASSIFIED), false);
  // A named tag: membership follows the document's own tags.
  assert.equal(inScope(['a', 'b'], 'a'), true);
  assert.equal(inScope(['b'], 'a'), false);
  assert.equal(inScope([], 'a'), false);
});

test('the page and the store call Unclassified the same thing', () => {
  assert.equal(UNCLASSIFIED, DEFAULT_TAG, 'two spellings of the sentinel would file documents wrongly');
});

test('re-filing patches one row instead of reloading the list', async () => {
  const view = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8');
  const backend = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');

  // The list and the patch share one row builder, so a patched row cannot drift from a rendered
  // one — and the patch itself only ever replaces that single row.
  assert.match(view, /for \(const doc of docs\) target\.append\(buildRow\(doc\)\);/);
  assert.match(view, /row\.replaceWith\(buildRow\(updated\)\);/);
  assert.match(view, /function patchTagToggle\(documentId: string, nextTags: string\[\]\): boolean \{/);
  assert.match(view, /if \(!inScope\(nextTags, selectedTag\)\) \{/);

  // A patched row must not reload the list: the tag-toggle branch has to return before the
  // resetPage() that every other change still needs.
  const start = view.indexOf("if (data.type === 'changed') {");
  const block = view.slice(start, view.indexOf("\n    }\n", start));
  const patch = block.indexOf("data.change?.kind === 'tagToggle'");
  const reload = block.indexOf('resetPage();');
  assert.ok(patch !== -1 && reload !== -1 && patch < reload, 'the tag toggle is handled before the reload');
  assert.match(block, /applyTags\(data\.tags \?\? \[\], false\);/, 'the left column updates without rebuilding the list');
  assert.match(block, /if \(patchTagToggle\(String\(data\.change\.documentId \?\? ''\), data\.change\.tags \?\? \[\]\)\) \{/);

  // The row the page patches needs to know what the toggle produced, so the backend reports the
  // document's new tags rather than just "something changed".
  assert.match(backend, /const updated = await gate\.write\(async \(\) => \{/);
  assert.match(backend, /return \(await state\.store\.document\(id\)\)\?\.tags \?\? \[\];/);
  assert.match(backend, /await broadcast\(\{ kind: 'tagToggle', documentId: id, tags: updated \}\)/);
});

test('the row menu also answers a right-click, and stays where the pointer put it', async () => {
  const view = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8');
  assert.match(view, /row\.addEventListener\('contextmenu', \(event\) => \{[\s\S]{0,200}event\.preventDefault\(\);[\s\S]{0,200}openRowMenu\(doc, more, \{ x: event\.clientX, y: event\.clientY \}\);/);
  // A right-click is a request to open, not to toggle what is already open.
  assert.match(view, /if \(!at && rowMenuAnchor === anchor && menuOpenFor\(menu\)\) \{ closeRowMenu\(\); return; \}/);
  // Re-anchoring after a row is rebuilt keeps the pointer placement.
  assert.match(view, /rowMenuBox = at \? \{ top: at\.y, bottom: at\.y, left: at\.x, right: at\.x, width: 0, height: 0 \} : null;/);
  assert.match(view, /placeMenu\(byId\('row-menu'\) as HTMLElement, rowMenuBox \?\? anchor\.getBoundingClientRect\(\)\);/);
});

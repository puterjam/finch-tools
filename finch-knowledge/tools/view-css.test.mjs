import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const css = await readFile(new URL('../src/view.css', import.meta.url), 'utf8');

test('the search icon is centered by layout, not inline baseline alignment', () => {
  assert.match(css, /\.ghost-icon\s*\{[^}]*display:\s*inline-flex/);
  assert.match(css, /\.ghost-icon\s*\{[^}]*align-items:\s*center/);
  assert.match(css, /\.ghost-icon\s*\{[^}]*justify-content:\s*center/);
  assert.match(css, /\.ghost-icon > svg\s*\{[^}]*display:\s*block/);
});

test('the file-drop cue outlines the pane the file lands in, not the tag column', () => {
  // Dropped files join the selected tag and appear in the list on the right, so that is the pane
  // that has to light up. Outlining the left column pointed at the wrong target.
  assert.match(css, /\.dragging-file \.library\s*\{[^}]*outline:[^;}]*dashed/);
  assert.doesNotMatch(css, /\.dragging-file \.sidebar\s*\{[^}]*outline:[^;}]*dashed/);
  // The instruction beside the Add button still turns accent so it reads as "you can drop now".
  assert.match(css, /\.dragging-file \.drop-hint\s*\{[^}]*color:\s*var\(--finch-accent/);
});

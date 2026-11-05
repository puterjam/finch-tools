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

test('the tag field writes at the same size as the label it replaces', () => {
  // `button, input, select { font: inherit }` hands the field the page's 15px, so an input left
  // without its own size renders a step bigger than the row it stands in for.
  const size = (selector) => css.match(new RegExp(`${selector}\\s*\\{[^}]*font-size:\\s*([^;]+)`))[1].trim();
  assert.match(size('.tag-name'), /var\(--tag-label-size\)/, 'the label size is a token, not a literal');
  assert.equal(size('.tag-editor input'), size('.tag-name'), 'field and label share one size');
});

test('tag editing is one comfortably padded input surface without an inner underline', () => {
  assert.match(css, /\.tag-editor\s*\{[^}]*min-height:\s*36px;[^}]*padding:\s*7px 10px;[^}]*border:\s*1px solid/);
  const field = css.match(/\.tag-editor input\s*\{[^}]*\}/)[0];
  assert.match(field, /padding:\s*0\s*;/);
  assert.match(field, /box-shadow:\s*none/);
  assert.match(field, /font-weight:\s*500/);
  assert.doesNotMatch(field, /border-bottom|inset 0 -1px/);
});

test('a new tag uses a neutral form surface and all available text width', () => {
  assert.match(css, /\.tag-editor\s*\{[^}]*background:\s*var\(--finch-bg-main/);
  assert.match(css, /\.tag-row\.creating \.tag-editor\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
});

test('tag counts yield to actions without moving names or hiding folder counts', () => {
  assert.match(css, /\.tag-actions\s*\{[^}]*right:\s*5px/, 'actions stay at the trailing edge');
  assert.match(css, /\.tag-row:has\(\.tag-actions\) \.tag-choice\s*\{[^}]*grid-template-columns:\s*18px minmax\(0, 1fr\) 50px/, 'a fixed slot is reserved before interaction');
  assert.match(css, /\.tag-row:has\(\.tag-actions\):hover \.tag-choice \.tag-count, \.tag-row:has\(\.tag-actions\):focus-within \.tag-choice \.tag-count\s*\{\s*visibility:\s*hidden/, 'hover and keyboard focus show actions instead of counts');
  assert.doesNotMatch(css, /\.tag-row[^{}]*:hover[^{}]*\{[^}]*padding-right/, 'hover does not resize the label');
  assert.doesNotMatch(css, /\.directory[^{}]*\.tag-count[^{}]*\{[^}]*visibility:\s*hidden/, 'folder tallies remain independent');
});

test('step numerals compensate for font metrics while the circle and list layout stay fixed', () => {
  const badge = css.match(/\.empty-step-number\s*\{([^}]+)\}/)[1];
  assert.match(badge, /display:\s*inline-flex/);
  assert.match(badge, /align-items:\s*center/);
  assert.match(badge, /justify-content:\s*center/);
  assert.match(badge, /line-height:\s*1\s*;/);
  assert.match(badge, /height:\s*20px/);
  assert.match(badge, /box-sizing:\s*border-box/);
  assert.match(badge, /padding-bottom:\s*2px/);
  assert.doesNotMatch(badge, /transform:/, 'the circular outline must not move');
});

test('footer progress never participates in grid sizing when it appears or disappears', () => {
  const footer = css.match(/\.sidebar-footer\s*\{([^}]+)\}/)[1];
  const progress = css.match(/\.activity\s*\{([^}]+)\}/)[1];
  assert.match(footer, /position:\s*relative/);
  assert.match(progress, /position:\s*absolute/);
  assert.match(progress, /bottom:\s*3px/);
  assert.match(progress, /height:\s*3px/);
  assert.match(progress, /left:\s*10px/);
  assert.match(progress, /right:\s*10px/);
  assert.doesNotMatch(progress, /(?:margin|padding|grid-row):/, 'visibility must not change the parent layout');
});

test('the spinning scan action uses standard refresh arrows, never a rotating folder', async () => {
  const html = await readFile(new URL('../src/view.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8');
  const button = html.match(/<button[^>]+id="sync"[^>]*>([\s\S]*?)<\/button>/)[1];
  assert.match(button, /data-icon="refresh-cw"/);
  assert.doesNotMatch(button, /folder-sync/);
  assert.match(source, /'refresh-cw': RefreshCw/);
  assert.match(css, /#sync\[aria-busy="true"\] svg\s*\{[^}]*animation:/);
});

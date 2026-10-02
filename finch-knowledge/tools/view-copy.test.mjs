import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const view = await readFile(new URL('src/view.ts', root), 'utf8');
const html = await readFile(new URL('src/view.html', root), 'utf8');
const composer = await readFile(new URL('src/composer.ts', root), 'utf8');
const zh = JSON.parse(await readFile(new URL('i18n/zh-CN.json', root), 'utf8'));
const en = JSON.parse(await readFile(new URL('i18n/en-US.json', root), 'utf8'));

/** The `copy key → element id` table applyCopy walks on every render. */
function copyMap() {
  const start = view.indexOf('const elements: Record<string, string> = {');
  const block = view.slice(start, view.indexOf('};', start));
  return [...block.matchAll(/([A-Za-z][A-Za-z0-9]*): '([a-z0-9-]+)'/g)].map((match) => ({ key: match[1], id: match[2] }));
}
/** The English fallback map the page ships with, so a locale miss still renders. */
function fallbackKeys() {
  const start = view.indexOf('const english: Copy = {');
  const block = view.slice(start, view.indexOf('\n};', start));
  // Several entries share a line, so match every `key: 'value'` rather than line starts.
  return new Set([...block.matchAll(/([A-Za-z][A-Za-z0-9]*):\s*'/g)].map((match) => match[1]));
}

test('every element the copy map writes to still exists', () => {
  // Removing a label from the markup while leaving it in the map throws during applyCopy, which
  // runs before anything is painted: the whole App View stays blank with no clue why.
  const map = copyMap();
  assert.ok(map.length >= 15, 'the map is read from the view');
  const missing = map.filter((entry) => !html.includes(`id="${entry.id}"`)).map((entry) => `${entry.key} → #${entry.id}`);
  assert.deepEqual(missing, [], 'a stale id breaks the first render');
});

test('every copy key is defined for both locales and in the fallback', () => {
  const fallback = fallbackKeys();
  const missing = [];
  for (const { key } of copyMap()) {
    if (!(key in zh.ui) || !(key in en.ui)) missing.push(`ui.${key}`);
    if (!fallback.has(key)) missing.push(`english.${key}`);
  }
  // Composer owns templates now; their runtime copy lives in both locale files.
  const keys = [...composer.matchAll(/const QUESTION_KEYS = \[([^\]]+)\]/g)].flatMap((match) => match[1].split(',').map((entry) => entry.trim().replace(/^'|'$/g, '')));
  assert.equal(keys.length, 7, 'the starting points are read from the Composer provider');
  for (const key of keys) {
    for (const field of [`ask.${key}`, `composer.${key}.label`, `composer.${key}.hint`]) {
      if (!(field in zh) || !(field in en)) missing.push(field);
    }
  }
  for (const match of composer.matchAll(/t\('(composer\.[^']+)'/g)) {
    if (!(match[1] in zh) || !(match[1] in en)) missing.push(match[1]);
  }
  for (const field of ['composer.close', 'composer.guideText']) {
    if (!(field in zh) || !(field in en)) missing.push(field);
  }
  assert.deepEqual(missing, [], 'copy gaps show as raw keys on screen');
});

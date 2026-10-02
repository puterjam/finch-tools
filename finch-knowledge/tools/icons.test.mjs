import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const view = await readFile(new URL('src/view.ts', root), 'utf8');
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));

const allowed = new Set(
  (/const ALLOWED = new Set\(\[([^\]]+)\]\)/.exec(view)?.[1] ?? '')
    .split(',').map((entry) => entry.trim().replace(/^'|'$/g, '')).filter(Boolean),
);
const entries = [...view.matchAll(/\{ extensions: \[([^\]]+)\], icon: '([^']+)' \}/g)]
  .map((match) => ({
    extensions: match[1].split(',').map((entry) => entry.trim().replace(/^'|'$/g, '')),
    icon: match[2],
  }));

test('every importable format gets its own icon', () => {
  assert.ok(allowed.size >= 13, 'the supported type list is read from the view');
  assert.ok(entries.length >= 5, 'the icon map is read from the view');
  const covered = new Set(entries.flatMap((entry) => entry.extensions));
  const missing = [...allowed].map((ext) => `.${ext}`).filter((ext) => !covered.has(ext));
  assert.deepEqual(missing, [], 'a supported extension with no icon falls back to a generic file');
  // The map is ordered: the first match wins, so nothing may shadow an earlier, more specific entry.
  const seen = new Set();
  for (const entry of entries) {
    for (const ext of entry.extensions) {
      assert.ok(!seen.has(ext), `${ext} is claimed twice`);
      seen.add(ext);
    }
  }
});

test('the file-type icons ship with the package, licence included', async () => {
  for (const entry of entries) {
    const info = await stat(new URL(`icons/${entry.icon}`, root)).catch(() => null);
    assert.ok(info?.isFile(), `icons/${entry.icon} is missing`);
  }
  assert.ok(pkg.files.includes('icons/'), 'the icons folder has to be published');
  // The set is MIT with an Apache-2.0 portion, so its terms travel with the files.
  const licence = await stat(new URL('icons/LICENSE.md', root)).catch(() => null);
  assert.ok(licence?.isFile(), 'icons/LICENSE.md must ship');
  // The view resolves them one level up, exactly like the fonts.
  assert.match(view, /new URL\(`\.\.\/icons\/\$\{iconForFile\(doc\.name\)\}`, location\.href\)/);
});

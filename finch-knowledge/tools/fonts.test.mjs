import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const css = await readFile(new URL('src/view.css', root), 'utf8');
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));

/** The codepoints a unicode-range descriptor covers, or null when the descriptor is malformed. */
function span(fragment) {
  const match = /^U\+([0-9A-F?]{1,6})(?:-([0-9A-F?]{1,6}))?$/i.exec(fragment.trim());
  if (!match) return null;
  const bound = (token, filler) => parseInt(token.replace(/\?/g, filler), 16);
  const low = bound(match[1], '0');
  return [low, match[2] === undefined ? bound(match[1], 'F') : bound(match[2], 'F')];
}
function covers(range, code) {
  for (const fragment of range.split(',')) {
    const bounds = span(fragment);
    if (bounds && code >= bounds[0] && code <= bounds[1]) return true;
  }
  return false;
}

test('every declared font face points at a file this package actually ships', async () => {
  const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => match[1]);
  assert.ok(faces.length >= 4, 'Outfit and JetBrains Mono, latin and latin-ext');
  const families = new Set();
  for (const body of faces) {
    const family = /font-family:\s*'([^']+)'/.exec(body)?.[1];
    const source = /url\(([^)]+)\)/.exec(body)?.[1];
    assert.ok(family && source, `face needs a family and a source: ${body.slice(0, 40)}`);
    families.add(family);
    // The CSS lives in dist/ and the fonts one level up, exactly like a packaged tool.
    const info = await stat(new URL(source.replace(/^\.\.\//, ''), root)).catch(() => null);
    assert.ok(info?.isFile(), `${source} is missing from the package`);
    assert.equal(span(/unicode-range:\s*([^;}]+)/.exec(body)?.[1] ?? ''), null, 'range must parse');
  }
  assert.deepEqual([...families].sort(), ['JetBrains Mono', 'Outfit']);
  assert.ok(pkg.files.includes('fonts/'), 'the fonts folder has to be published');
});

test('each family covers plain ASCII, or it silently falls back to the system font', () => {
  // A stray "U+?" instead of "U+??" kept every face technically valid while excluding the entire
  // Latin block: nothing errored, the App View just quietly rendered in the wrong font.
  const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => match[1]);
  for (const family of ['Outfit', 'JetBrains Mono']) {
    const ranges = faces
      .filter((body) => body.includes(`font-family: '${family}'`))
      .map((body) => /unicode-range:\s*([^;}]+)/.exec(body)?.[1] ?? '');
    assert.ok(ranges.length >= 1, `${family} needs a face`);
    for (const code of [0x41, 0x61, 0x30]) {
      assert.ok(ranges.some((range) => covers(range, code)), `${family} must cover U+${code.toString(16)}`);
    }
  }
});

test('the App View matches the host typography instead of drifting heavier', () => {
  // Finch sets all four on its own root; an App View without them renders visibly bolder.
  assert.match(css, /-webkit-font-smoothing:\s*antialiased/);
  assert.match(css, /-moz-osx-font-smoothing:\s*grayscale/);
  assert.match(css, /font-synthesis:\s*none/);
  assert.match(css, /text-rendering:\s*optimizeLegibility/);
  // The fallbacks name the bundled families, so the tokens are not the only way in.
  assert.match(css, /font-family:\s*var\(--finch-font-body,\s*Outfit,/);
  assert.match(css, /font-family:\s*var\(--finch-font-mono,\s*'JetBrains Mono',/);
});

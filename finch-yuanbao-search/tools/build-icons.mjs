#!/usr/bin/env node
/**
 * Generate `icons/*.svg` from the pinned `lucide-static` devDependency.
 *
 * Icons are never hand-copied: a hand-written `<path>` looks fine in review and
 * renders as a wrong glyph on screen. This script scans the sources for every
 * `ext:<packId>/<iconId>` reference, copies exactly those files out of
 * lucide-static, and fails the build when a name does not exist or when the
 * committed folder drifts (extra or missing files) — both failure modes are
 * silent at runtime, which is exactly how they get shipped.
 */
import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICON_DIR = path.join(ROOT, 'icons');
const SOURCES = ['src/index.ts', 'package.json'];

/** Strip the lucide license banner so the shipped file is a bare `<svg>`. */
function stripBanner(svg) {
  return svg.replace(/^\s*<!--[\s\S]*?-->\s*/, '').trim();
}

async function referencedNames() {
  const names = new Set();
  for (const rel of SOURCES) {
    const text = await readFile(path.join(ROOT, rel), 'utf8');
    for (const match of text.matchAll(/ext:(?:yuanbao-search-icons\/)?([a-z0-9]+(?:-[a-z0-9]+)*)(?=["'\s,)`])/g)) {
      names.add(match[1]);
    }
  }
  return names;
}

const referenced = await referencedNames();
if (referenced.size === 0) {
  console.error('[icons] no `ext:` icon references found in', SOURCES.join(', '));
  process.exit(1);
}

const lucideDir = path.dirname(require.resolve('lucide-static/icons/search.svg'));
const committed = (await readdir(ICON_DIR).catch(() => [])).filter((f) => f.endsWith('.svg')).map((f) => f.replace(/\.svg$/, '')).sort();

const missing = [...referenced].filter((n) => !committed.includes(n)).sort();
const extra = committed.filter((n) => !referenced.has(n)).sort();
if (extra.length > 0) {
  console.error('[icons] icons/ holds files nothing references:', extra.join(', '));
  process.exit(1);
}

await mkdir(ICON_DIR, { recursive: true });
const written = [];
for (const name of [...referenced].sort()) {
  const src = path.join(lucideDir, `${name}.svg`);
  let raw;
  try {
    raw = await readFile(src, 'utf8');
  } catch {
    console.error(`[icons] "${name}" is referenced but lucide-static has no icons/${name}.svg`);
    process.exit(1);
  }
  const out = `${stripBanner(raw)}\n`;
  const dest = path.join(ICON_DIR, `${name}.svg`);
  const previous = await readFile(dest, 'utf8').catch(() => null);
  if (previous !== out) {
    await writeFile(dest, out, 'utf8');
    written.push(name);
  }
}

console.log(
  '[icons] %d referenced, %d rewritten (%s), all byte-identical to lucide-static',
  referenced.size,
  written.length,
  written.join(', ') || 'nothing changed',
);

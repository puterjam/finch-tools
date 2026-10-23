/**
 * Regenerates the gallery's inline icons straight from `lucide-static`.
 *
 * Hand-copied path data is invisible in review and boring to check, so a stale
 * approximation looks like a custom icon on screen — this package shipped an
 * old `image-upscale` that way. Regenerating from the package keeps the page
 * and the shipped `icons/*.svg` files on the exact same geometry.
 *
 * Run with: npm run icons   (`npm run build` does it first)
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'src');

const SHAPE = /<(?:path|circle|rect|line|polyline|polygon|ellipse)\b[^>]*\/>/g;

/**
 * Every icon name the gallery page mentions: `icon(...)` calls (including the
 * branches of a ternary), `data-icon="x"` / `dataset.icon = 'x'`, and `icon: 'x'`
 * presets. Reading them from the sources means a new icon is picked up on its
 * own, and a typo fails the build instead of silently rendering the generic
 * picture — which is exactly what a missed name looks like on screen.
 */
export function usedNames() {
  const files = readdirSync(SRC).filter((name) => name === 'gallery.html' || /^gallery.*\.ts$/.test(name));
  const names = new Set();
  for (const file of files) {
    const text = readFileSync(join(SRC, file), 'utf8');
    for (const call of text.matchAll(/\bicon\(([^()]*)\)/g)) {
      for (const name of call[1].matchAll(/'([a-z0-9-]+)'/g)) names.add(name[1]);
    }
    for (const match of text.matchAll(/\bicon:\s*'([a-z0-9-]+)'/g)) names.add(match[1]);
    // An icon may also be named through the attribute the painter reads back.
    for (const line of text.split('\n')) {
      if (!/data-icon|dataset\.icon/.test(line)) continue;
      for (const name of line.matchAll(/data-icon="([a-z0-9-]+)"/g)) names.add(name[1]);
      for (const name of line.matchAll(/'([a-z0-9-]+)'/g)) names.add(name[1]);
    }
  }
  return [...names].sort();
}

/** The inner markup of one Lucide icon, whitespace collapsed away. */
export function lucideShape(name) {
  const file = join(root, 'node_modules/lucide-static/icons', `${name}.svg`);
  let svg;
  try {
    svg = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`lucide-static has no icon named "${name}" (${file})`);
  }
  const shapes = svg.match(SHAPE);
  if (!shapes?.length) throw new Error(`"${name}" has no drawable shapes`);
  return shapes.map((shape) => shape.replace(/\s+/g, ' ').trim()).join('');
}

export function collectIcons(names = usedNames()) {
  return Object.fromEntries(names.map((name) => [name, lucideShape(name)]));
}

export const ICONS_FILE = join(SRC, 'lucide-icons.json');

function main() {
  const icons = collectIcons();
  writeFileSync(ICONS_FILE, `${JSON.stringify(icons, null, 2)}\n`, 'utf8');
  console.log(`✓ ${Object.keys(icons).length} icons from lucide-static → src/lucide-icons.json`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

import { build } from 'esbuild';

// Bundles a `tools/*.ts` drill against the same sources the mini tool ships, so the
// real code paths can be exercised outside Finch. Usage: node tools/drill-build.mjs <entry.ts>
const entry = process.argv[2];
if (!entry) {
  console.error('usage: node tools/drill-build.mjs tools/<drill>.ts');
  process.exit(1);
}
const outfile = `/tmp/${entry.split('/').pop().replace(/\.ts$/, '')}.mjs`;

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  plugins: [{
    name: 'external-native-binding-loader',
    setup(builder) {
      builder.onResolve({ filter: /^\.\.?(?:\/native)(?:\.js)?$/ }, () => ({ path: './native.cjs', external: true }));
    },
  }],
});
console.log(`drill bundle written to ${outfile}`);

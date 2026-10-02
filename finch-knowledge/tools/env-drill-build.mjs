import { build } from 'esbuild';

// Drill-only build: bundles the same source the mini tool ships, so the real
// engine loaders and probe paths can be exercised outside Finch.
await build({
  entryPoints: ['tools/env-drill.ts'],
  outfile: '/tmp/kb-env-drill.mjs',
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
console.log('drill bundle written to /tmp/kb-env-drill.mjs');

import { build } from 'esbuild';
import { rmSync } from 'node:fs';
rmSync('dist', { recursive: true, force: true });
await build({
  entryPoints: ['src/index.ts'], outfile: 'dist/index.js', bundle: true,
  platform: 'node', format: 'esm', target: 'node24',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  plugins: [{
    name: 'external-native-binding-loader',
    setup(builder) {
      builder.onResolve({ filter: /^\.\.?(?:\/native)(?:\.js)?$/ }, () => ({ path: './native.cjs', external: true }));
    },
  }],
});
await build({ entryPoints: ['src/view.ts'], outfile: 'dist/view.js', bundle: true, platform: 'browser', format: 'iife', target: 'chrome120' });
await import('./copy-assets.mjs');

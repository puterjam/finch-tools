import { copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const sdk = require.resolve('@lancedb/lancedb');
const directory = dirname(sdk);
for (const name of ['view.html', 'view.css']) copyFileSync(join('src', name), join('dist', name));
copyFileSync(join(directory, 'native.js'), join('dist', 'native.cjs'));

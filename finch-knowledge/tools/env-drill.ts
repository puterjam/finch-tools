import { join } from 'node:path';
import { homedir } from 'node:os';
import { EnvironmentManager } from '../src/environment.js';
import { loadEngine as loadDocumentEngine, isEngineInstalled as isDocumentInstalled, ENGINE_VERSION as DOC } from '../src/document-engine.js';
import { isEngineInstalled as isOcrInstalled, engineBinaryPath, ENGINE_VERSION as OCR } from '../src/ocr-engine.js';
import { loadEngine as loadOcrEngine } from '../src/ocr-engine.js';
import { listModels } from '../src/ocr-runner.js';
import { loadLanceDB, isEngineInstalled as isLanceInstalled, engineVersion } from '../src/lancedb-engine.js';
import { KnowledgeStore } from '../src/store.js';

// Drives the real probes and loaders against an installed copy of this mini tool.
// Override the cache with KB_CACHE; set KB_WITH_OCR=1 to also download the OCR engine.
const cache = process.env.KB_CACHE ?? join(homedir(), '.finch', 'extension-data', 'finch-knowledge');
const includeOcr = process.env.KB_WITH_OCR === '1';
const store = new KnowledgeStore(cache, { cachePath: cache });

const manager = new EnvironmentManager([
  {
    id: 'lancedb',
    version: engineVersion(),
    probe: () => isLanceInstalled(cache),
    install: async (report) => { await loadLanceDB(cache, report); await store.tags(); },
  },
  {
    id: 'anydoc',
    version: DOC,
    probe: () => isDocumentInstalled(join(cache, 'anydoc')),
    install: async (report) => { await loadDocumentEngine(join(cache, 'anydoc'), report); },
  },
  {
    id: 'ocr',
    version: OCR,
    probe: () => isOcrInstalled(join(cache, 'ocr')),
    install: async (report) => {
      if (!includeOcr) throw new Error('skipped in this drill (set KB_WITH_OCR=1 to download ~50-70 MB)');
      const binary = await loadOcrEngine(join(cache, 'ocr'), report);
      await listModels(binary);
    },
  },
], (snapshot) => {
  console.log('  progress:', snapshot.steps.map((s) => `${s.id}=${s.status}${s.percent !== undefined ? `(${s.percent}%)` : ''}`).join('  '));
});

console.log('cache:', cache);
console.log('ocr binary expected at:', engineBinaryPath(join(cache, 'ocr')));
console.log('\nprobe:');
const probed = await manager.probe();
for (const step of probed.steps) console.log(`  ${step.id}: ${step.status}${step.detail ? ` (${step.detail})` : ''}`);
console.log('  ready:', probed.ready);

console.log('\ninstall (force):');
const after = await manager.install(true);
console.log('  ready:', after.ready, '| running:', after.running);
for (const step of after.steps) console.log(`  ${step.id}: ${step.status}${step.detail ? ` (${step.detail})` : ''}${step.error ? ` — ${step.error}` : ''}`);

await store.close();

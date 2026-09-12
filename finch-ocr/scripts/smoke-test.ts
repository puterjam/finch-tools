import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectTarget, loadEngine, isEngineInstalled } from '../src/engine.js';
import { runOcr } from '../src/ocr.js';

async function main() {
  console.log('target:', detectTarget());

  const storagePath = mkdtempSync(join(tmpdir(), 'finch-ocr-smoke-'));
  console.log('storagePath:', storagePath);

  const binaryPath = await loadEngine(storagePath, (message, percent) => {
    console.log(`[progress ${percent ?? ''}] ${message}`);
  });
  console.log('binaryPath:', binaryPath);
  console.log('installed?', isEngineInstalled(storagePath));

  const sampleImage = process.argv[2];
  if (!sampleImage) {
    console.log('No sample image passed as argv[2]; skipping recognize call.');
    return;
  }

  const result = await runOcr(binaryPath, { command: 'recognize', source: sampleImage, timeoutMs: 60_000 });
  console.log('OCR result:', JSON.stringify(result, null, 2).slice(0, 2000));
}

main().catch((error) => {
  console.error('SMOKE TEST FAILED:', error);
  process.exit(1);
});

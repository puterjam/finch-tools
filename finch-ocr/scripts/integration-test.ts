/**
 * Exercises activate() against a minimal mock MiniToolContext, so the actual
 * tool.execute() code path (not just engine.ts/ocr.ts in isolation) is
 * verified end to end: status -> recognize -> detect -> clear_cache.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activate } from '../src/index.js';

const SAMPLE_IMAGE =
  'https://raw.githubusercontent.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr/main/assets/receipt.jpg';

async function main() {
  const storagePath = mkdtempSync(join(tmpdir(), 'finch-ocr-itest-'));
  let registered: any;

  const ctx: any = {
    storagePath,
    subscriptions: [],
    i18n: { t: (key: string) => key },
    logger: { info: (...args: unknown[]) => console.log('[logger]', ...args) },
    tools: {
      register(def: any) {
        registered = def;
        return { dispose() {} };
      },
    },
  };

  activate(ctx);
  if (!registered) throw new Error('tool was not registered');

  const exec = {
    cwd: process.cwd(),
    signal: undefined,
    progress: { report: (p: any) => console.log('[progress]', p) },
  };

  console.log('\n--- status ---');
  console.log(await registered.execute({ action: 'status' }, exec));

  console.log('\n--- recognize (text) ---');
  const recognizeResult = await registered.execute({ action: 'recognize', path: SAMPLE_IMAGE }, exec);
  console.log(recognizeResult);
  if (recognizeResult.isError) throw new Error('recognize failed');
  if (!String(recognizeResult.content[0].text).includes('ALFAMART')) {
    throw new Error('recognize did not return expected text');
  }

  console.log('\n--- detect (json) ---');
  const detectResult = await registered.execute(
    { action: 'detect', path: SAMPLE_IMAGE, json: true },
    exec,
  );
  console.log(detectResult);
  if (detectResult.isError) throw new Error('detect failed');
  const parsed = JSON.parse(detectResult.content[0].text);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('detect did not return boxes array');

  console.log('\n--- detect (plain summary) ---');
  console.log(await registered.execute({ action: 'detect', path: SAMPLE_IMAGE }, exec));

  console.log('\n--- clear_cache ---');
  console.log(await registered.execute({ action: 'clear_cache' }, exec));

  console.log('\n--- status after clear_cache ---');
  console.log(await registered.execute({ action: 'status' }, exec));

  rmSync(storagePath, { recursive: true, force: true });
  console.log('\nALL CHECKS PASSED');
}

main().catch((error) => {
  console.error('INTEGRATION TEST FAILED:', error);
  process.exit(1);
});

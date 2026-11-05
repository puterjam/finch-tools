import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { transform } from 'esbuild';

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
const start = source.indexOf('  async function requireEngine(');
const end = source.indexOf('\n  ctx.subscriptions.push(ctx.tools.register', start);
const { code } = await transform(source.slice(start, end), { loader: 'ts' });
function gate(ensure) {
  const context = createContext({
    environment: { snapshot: () => ({ steps: [{ id: 'ocr', status: 'pending' }], running: false }), ensure,
      install() { assert.fail('Image demand must use targeted lazy setup'); } },
    engineForExtension: () => 'ocr', t: key => key,
  });
  runInContext(code, context);
  return runInContext('requireEngine', context);
}

test('the real image gate waits for background OCR setup and then continues the same request', async () => {
  let release, calls = 0, finished = false;
  const blocked = new Promise(resolve => { release = resolve; });
  const requireEngine = gate(async id => { assert.equal(id, 'ocr'); calls++; await blocked; return { steps: [{ id: 'ocr', status: 'ready' }] }; });
  const operation = requireEngine('.png').then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(finished, false);
  release();
  await operation;
  assert.equal(finished, true, 'no second scan or user retry is required after successful setup');
});

test('lazy OCR setup failures remain observable and OCR subprocesses stay hidden on Windows', async () => {
  const requireEngine = gate(async () => ({ steps: [{ id: 'ocr', status: 'failed', error: 'OCR download failed' }] }));
  await assert.rejects(requireEngine('.png'), /OCR download failed/);
  const runner = await readFile(new URL('../src/ocr-runner.ts', import.meta.url), 'utf8');
  assert.match(runner, /windowsHide:\s*true/);
  assert.match(source, /id: 'ocr',[\s\S]*?optional: true,\s*lazy: true/);
});

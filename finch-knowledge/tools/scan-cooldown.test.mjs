import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { transform } from 'esbuild';
const source = await readFile(new URL('../src/scan-cooldown.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { AutoScanCooldown, AUTO_SCAN_INTERVAL_MS } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
function fixture() {
  let time = 1000, count = 0;
  const values = new Map();
  const create = () => new AutoScanCooldown(async key => values.get(key), async (key, value) => { values.set(key, value); }, () => time);
  const scan = async (gate, root = '/library') => { count++; await gate.record(root); return count; };
  return { create, scan, values, count: () => count, advance: value => { time += value; } };
}
test('automatic opens skip repeated scans until the full 30-minute interval has passed', async () => {
  const f = fixture(), gate = f.create();
  assert.equal(AUTO_SCAN_INTERVAL_MS, 30 * 60 * 1000);
  await gate.run('/library', () => f.scan(gate));
  for (let i = 0; i < 5; i++) assert.equal(await gate.run('/library', () => f.scan(gate)), undefined);
  f.advance(AUTO_SCAN_INTERVAL_MS - 1); await gate.run('/library', () => f.scan(gate)); assert.equal(f.count(), 1);
  f.advance(1); await gate.run('/library', () => f.scan(gate)); assert.equal(f.count(), 2);
});
test('timestamps survive backend recreation and do not suppress a different directory', async () => {
  const f = fixture(); let gate = f.create();
  await gate.run('/library', () => f.scan(gate)); gate = f.create();
  await gate.run('/library', () => f.scan(gate)); assert.equal(f.count(), 1);
  await gate.run('/other', () => f.scan(gate, '/other')); assert.equal(f.count(), 2); assert.equal(f.values.size, 2);
});
test('manual scans bypass the automatic gate and refresh its interval', async () => {
  const f = fixture(), gate = f.create();
  await gate.run('/library', () => f.scan(gate));
  await f.scan(gate); await f.scan(gate); assert.equal(f.count(), 3);
  await gate.run('/library', () => f.scan(gate)); assert.equal(f.count(), 3);
});
test('concurrent panel opens share one pending automatic check and scan', async () => {
  const f = fixture(), gate = f.create(); let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const first = gate.run('/library', async () => { await blocked; return f.scan(gate); });
  const second = gate.run('/library', () => f.scan(gate)); assert.equal(first, second);
  release(); assert.deepEqual(await Promise.all([first, second]), [1, 1]); assert.equal(f.count(), 1);
});
test('failed attempts are throttled too, while manual retries remain possible', async () => {
  const f = fixture(), gate = f.create();
  await assert.rejects(gate.run('/library', async () => { await gate.record('/library'); throw new Error('Failed'); }));
  await gate.run('/library', () => f.scan(gate)); assert.equal(f.count(), 0);
  await f.scan(gate); assert.equal(f.count(), 1);
});
test('persistence failures do not turn a successful scan into a failure', async () => {
  let count = 0;
  const gate = new AutoScanCooldown(async () => { throw new Error('Read'); }, async () => { throw new Error('Write'); }, () => 1000);
  const scan = async () => { count++; await gate.record('/library'); };
  await gate.run('/library', scan); await gate.run('/library', scan); assert.equal(count, 1);
});
test('panel opens use the gated path but explicit scan actions still invoke the scanner directly', async () => {
  const index = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(index.slice(index.indexOf("case 'ready':"), index.indexOf("case 'environment':")), /autoScan\(\)/);
  assert.match(index.slice(index.indexOf("case 'sync':"), index.indexOf("case 'reveal':")), /await syncSources\(/);
  assert.match(index, /await scanCooldown\.record\(store\.directoryRoot\)/);
});

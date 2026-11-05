import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EnvironmentManager } from '../dist/index.js';

function task(id, { installed = false, fail, detail } = {}) {
  const calls = { probe: 0, install: 0 };
  return {
    calls,
    id,
    version: '1.0.0',
    probe: () => { calls.probe++; return installed; },
    install: async (report) => {
      calls.install++;
      report('working…', 40);
      if (fail) throw new Error(fail);
      return detail;
    },
  };
}

test('probe marks installed components ready without running any installer', async () => {
  const lancedb = task('lancedb', { installed: true });
  const anydoc = task('anydoc', { installed: false });
  const manager = new EnvironmentManager([lancedb, anydoc]);
  const snapshot = await manager.probe();
  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.running, false);
  assert.deepEqual(snapshot.steps.map((step) => step.status), ['ready', 'pending']);
  assert.equal(snapshot.steps[0].detail, '1.0.0');
  assert.equal(lancedb.calls.install, 0);
  assert.equal(anydoc.calls.install, 0);
});

test('an optional component does not block, so the library can be used while it installs', async () => {
  const lancedb = task('lancedb', { installed: true });
  const anydoc = task('anydoc', { installed: true });
  const ocr = { ...task('ocr'), optional: true };
  const manager = new EnvironmentManager([lancedb, anydoc, ocr]);

  const probed = await manager.probe();
  assert.equal(probed.usable, true, 'required parts are in, so the library works');
  assert.equal(probed.ready, false, 'not everything is installed yet');
  assert.equal(probed.steps[2].optional, true);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  ocr.install = async () => { await gate; };
  const run = manager.install(true);
  const during = manager.snapshot();
  assert.equal(during.running, true);
  assert.equal(during.usable, true, 'still usable while the optional download runs');
  assert.equal(during.ready, false);
  release();
  const after = await run;
  assert.equal(after.ready, true);
  assert.equal(after.usable, true);
});

test('a failing optional component never blocks usability', async () => {
  const lancedb = task('lancedb', { installed: true });
  const ocr = { ...task('ocr', { fail: 'download failed (503)' }), optional: true };
  const manager = new EnvironmentManager([lancedb, ocr]);
  const snapshot = await manager.install(true);
  assert.equal(snapshot.usable, true);
  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.steps[1].status, 'failed');
  assert.equal(snapshot.steps[1].error, 'download failed (503)');
});

test('a failing required component keeps the library blocked', async () => {
  const lancedb = task('lancedb', { fail: 'no native build' });
  const ocr = { ...task('ocr', { installed: true }), optional: true };
  const manager = new EnvironmentManager([lancedb, ocr]);
  const snapshot = await manager.install(true);
  assert.equal(snapshot.usable, false);
  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.steps[0].status, 'failed');
  assert.equal(snapshot.steps[1].status, 'ready');
});

test('install skips what is present, reports progress and only turns ready when everything is', async () => {
  const lancedb = task('lancedb', { installed: true });
  const anydoc = task('anydoc');
  const ocr = task('ocr', { detail: '6.5.1' });
  const seen = [];
  const manager = new EnvironmentManager([lancedb, anydoc, ocr], (snapshot) => {
    seen.push(snapshot.steps.map((step) => step.status).join(','));
  });
  const snapshot = await manager.install();
  assert.equal(snapshot.ready, true);
  assert.equal(lancedb.calls.install, 0, 'already-present components are not reinstalled');
  assert.equal(anydoc.calls.install, 1);
  assert.equal(ocr.calls.install, 1);
  assert.equal(snapshot.steps[2].detail, '6.5.1');
  assert.equal(snapshot.steps[1].percent, 100);
  assert.equal(seen.at(-1), 'ready,ready,ready');
  assert.equal(typeof snapshot.startedAt, 'number');
  assert.equal(typeof snapshot.finishedAt, 'number');
});

test('a failing step is recorded and the remaining steps still run for a complete picture', async () => {
  const lancedb = task('lancedb', { fail: 'download failed (403)' });
  const anydoc = task('anydoc');
  const manager = new EnvironmentManager([lancedb, anydoc]);
  const snapshot = await manager.install();
  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.steps[0].status, 'failed');
  assert.equal(snapshot.steps[0].error, 'download failed (403)');
  assert.equal(snapshot.steps[0].percent, undefined);
  assert.equal(snapshot.steps[1].status, 'ready', 'later steps still report their own state');
});

test('a second install joins the run in flight instead of starting a duplicate', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = {
    id: 'lancedb',
    probe: () => false,
    install: async () => { await gate; },
  };
  const manager = new EnvironmentManager([slow]);
  const first = manager.install();
  const second = manager.install();
  assert.equal(first, second, 'the same promise is handed back');
  assert.equal(manager.snapshot().running, true);
  release();
  await first;
  assert.equal(manager.snapshot().ready, true);
  assert.equal(manager.snapshot().running, false);
});

test('force re-runs components that are already present, which is how "update runtime" works', async () => {
  const lancedb = task('lancedb', { installed: true });
  const manager = new EnvironmentManager([lancedb]);
  await manager.probe();
  assert.equal(manager.snapshot().ready, true);
  const snapshot = await manager.install(true);
  assert.equal(snapshot.ready, true);
  assert.equal(lancedb.calls.install, 1, 'forced run re-verifies despite the probe reporting installed');
});

test('probe walks back a ready step when its files disappear', async () => {
  let installed = true;
  const manager = new EnvironmentManager([{
    id: 'ocr', probe: () => installed, install: async () => {},
  }]);
  await manager.probe();
  assert.equal(manager.snapshot().steps[0].status, 'ready');
  installed = false;
  await manager.probe();
  assert.equal(manager.snapshot().steps[0].status, 'pending');
  assert.equal(manager.snapshot().ready, false);
});

test('automatic and forced setup both leave lazy OCR untouched', async () => {
  const search = task('lancedb', { installed: true });
  const ocr = { ...task('ocr'), optional: true, lazy: true };
  const manager = new EnvironmentManager([search, ocr]);
  const snapshot = await manager.install();
  assert.equal(snapshot.usable, true);
  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.steps[1].lazy, true);
  await manager.install(true);
  assert.equal(ocr.calls.install, 0);
  assert.equal(ocr.calls.probe, 0, 'routine setup does not start the lazy component');
});

test('first OCR demand joins one download, keeps the library usable and emits final completion', async () => {
  const search = task('lancedb', { installed: true });
  let release, calls = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const ocr = { id: 'ocr', optional: true, lazy: true, probe: () => false,
    install: async report => { calls++; report('Downloading OCR', 25); await blocked; } };
  const seen = [];
  const manager = new EnvironmentManager([search, ocr], snapshot => seen.push(snapshot));
  await manager.install();
  const first = manager.ensure('ocr'), second = manager.ensure('ocr');
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(manager.snapshot().usable, true);
  assert.equal(manager.snapshot().running, true);
  release();
  const ready = await first;
  assert.equal(ready.ready, true);
  assert.equal(seen.at(-1).running, false);
});

test('OCR demand queues behind required setup without being lost or starting duplicate installers', async () => {
  let release, calls = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const required = { id: 'lancedb', probe: () => false, install: async () => { await blocked; } };
  const ocr = { id: 'ocr', optional: true, lazy: true, probe: () => false, install: async () => { calls++; } };
  const manager = new EnvironmentManager([required, ocr]);
  const setup = manager.install();
  const first = manager.ensure('ocr'), second = manager.ensure('ocr');
  assert.equal(calls, 0);
  release();
  await Promise.all([setup, first, second]);
  assert.equal(calls, 1);
  assert.equal(manager.snapshot().ready, true);
});

test('a failed lazy download stays nonblocking, does not loop, and can be explicitly retried', async () => {
  let fail = true, calls = 0;
  const ocr = { id: 'ocr', optional: true, lazy: true, probe: () => false,
    install: async () => { calls++; if (fail) throw new Error('Offline'); } };
  const manager = new EnvironmentManager([task('lancedb', { installed: true }), ocr]);
  await manager.install();
  const failed = await manager.ensure('ocr');
  assert.equal(failed.usable, true);
  assert.equal(failed.steps[1].error, 'Offline');
  assert.equal(calls, 1);
  await manager.install();
  assert.equal(calls, 1, 'general runtime checks do not retry OCR');
  fail = false;
  const ready = await manager.ensure('ocr');
  assert.equal(ready.ready, true);
  assert.equal(ready.steps[1].error, undefined);
  assert.equal(calls, 2);
});

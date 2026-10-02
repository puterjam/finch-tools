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

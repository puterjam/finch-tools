import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ScanUpdates } from '../dist/index.js';

const tick = () => new Promise(done => setImmediate(done));
test('scan updates coalesce checkpoints, never overlap and flush the final pending state', async () => {
  let release, calls = 0, active = 0, maximum = 0;
  const blocked = new Promise(done => { release = done; });
  const updates = new ScanUpdates(async () => {
    maximum = Math.max(maximum, ++active); calls++;
    if (calls === 1) await blocked;
    active--;
  }, 1000);
  updates.mark(); await tick();
  for (let i = 0; i < 100; i++) updates.mark();
  assert.equal(calls, 1);
  const done = updates.flush(); release(); await done;
  assert.equal(calls, 2); assert.equal(maximum, 1);
  updates.mark(); await tick(); assert.equal(calls, 2, 'closed publishers cannot leak stale updates');
});
test('a trailing timer publishes while the next slow file is still processing', async () => {
  let count = 0, finished;
  const second = new Promise(done => { finished = done; });
  const updates = new ScanUpdates(async () => { if (++count === 2) finished(); }, 5);
  updates.mark(); await tick(); updates.mark(); await second;
  assert.equal(count, 2); await updates.flush();
});
test('a transient panel refresh failure does not abort indexing or suppress the final state', async () => {
  let count = 0;
  const updates = new ScanUpdates(async () => { if (++count === 1) throw new Error('Panel navigating'); }, 1000);
  updates.mark(); await tick(); updates.mark(); await updates.flush(); assert.equal(count, 2);
});

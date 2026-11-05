import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LibraryGate } from '../dist/index.js';

test('directory switching excludes writes without any backup or copy mechanism', async () => {
  const gate = new LibraryGate();
  let release;
  const switching = gate.exclusive(() => new Promise(resolve => { release = resolve; }));
  await assert.rejects(gate.write(async () => assert.fail('write entered during a switch')), /directory is switching/);
  release(); await switching;
  assert.equal(await gate.write(async () => 42), 42);
});
test('an active index write prevents a directory switch until it finishes', async () => {
  const gate = new LibraryGate();
  let release;
  const writing = gate.write(() => new Promise(resolve => { release = resolve; }));
  await assert.rejects(gate.exclusive(async () => assert.fail('switched during a write')), /Finish current indexing/);
  release(); await writing;
  assert.equal(await gate.exclusive(async () => 'switched'), 'switched');
});
test('failed operations release both write and exclusive guards', async () => {
  const gate = new LibraryGate();
  await assert.rejects(gate.write(async () => { throw new Error('failed write'); }), /failed write/);
  await assert.rejects(gate.exclusive(async () => { throw new Error('failed switch'); }), /failed switch/);
  assert.equal(await gate.write(async () => 1), 1);
  assert.equal(await gate.exclusive(async () => 2), 2);
});

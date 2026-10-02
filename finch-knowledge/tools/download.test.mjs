import assert from 'node:assert/strict';
import { test } from 'node:test';
import { downloadWithProgress, formatBytes } from '../dist/index.js';

/** Builds a Response-like object whose body streams in the given chunk sizes. */
function streamingResponse(chunks, { contentLength, status = 200 } = {}) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-length' && contentLength !== undefined ? String(contentLength) : null) },
    body: {
      getReader: () => ({
        read: async () => (index < chunks.length ? { done: false, value: encoder.encode(chunks[index++]) } : { done: true, value: undefined }),
        cancel: async () => {},
        releaseLock: () => {},
      }),
    },
  };
}

test('progress reports real received bytes against the declared total', async () => {
  const payload = ['a'.repeat(400), 'b'.repeat(400), 'c'.repeat(200)];
  const total = payload.join('').length;
  globalThis.fetch = async () => streamingResponse(payload, { contentLength: total });
  const seen = [];
  const buffer = await downloadWithProgress('https://example.test/engine.tgz', {
    maxBytes: 10_000,
    onProgress: (received, reported) => seen.push([received, reported]),
  });
  assert.equal(buffer.length, total);
  assert.equal(buffer.toString(), payload.join(''));
  assert.deepEqual(seen.at(-1), [total, total], 'the final report is exact');
  const totals = new Set(seen.map(([, reported]) => reported));
  assert.deepEqual([...totals], [total], 'the declared total is used throughout');
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i][0] >= seen[i - 1][0], 'bytes never go backwards');
  }
});

test('a fallback total is used when the response declares no length', async () => {
  const payload = ['x'.repeat(500), 'y'.repeat(500)];
  globalThis.fetch = async () => streamingResponse(payload);
  const seen = [];
  await downloadWithProgress('https://example.test/engine.tgz', {
    totalBytes: 2000,
    maxBytes: 10_000,
    onProgress: (received, total) => seen.push([received, total]),
  });
  assert.ok(seen.length > 0);
  assert.equal(seen.at(-1)[1], 2000, 'the caller-supplied total is used');
});

test('the size cap aborts an oversized stream and a bad status is refused', async () => {
  globalThis.fetch = async () => streamingResponse(['z'.repeat(5000)], { contentLength: 5000 });
  await assert.rejects(
    downloadWithProgress('https://example.test/big.tgz', { maxBytes: 1000 }),
    /exceeds the size limit/,
  );
  globalThis.fetch = async () => streamingResponse(['nope'], { status: 404 });
  await assert.rejects(
    downloadWithProgress('https://example.test/missing.tgz', { maxBytes: 1000 }),
    /download failed \(404\)/,
  );
});

test('byte sizes are formatted for humans', () => {
  assert.equal(formatBytes(0), '');
  assert.equal(formatBytes(-5), '');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(7 * 1024 * 1024), '7.0 MB');
  assert.equal(formatBytes(68_400_000), '65.2 MB');
});

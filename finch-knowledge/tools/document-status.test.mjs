import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveDocumentStatus } from '../dist/index.js';

test('document states distinguish freshness, coverage and temporary access without vendor wording', () => {
  for (const [coverage, source, expected] of [
    ['indexed', 'same', 'ready'], ['indexed', 'changed', 'outdated'],
    ['missing', 'same', 'pending'], ['partial', 'same', 'incomplete'],
    ['unavailable', 'same', 'unverified'], ['indexed', 'missing', 'source_missing'],
    ['indexed', 'unavailable', 'source_unavailable'],
  ]) assert.equal(resolveDocumentStatus(coverage, source), expected);
});

test('processing and actionable source problems override an otherwise healthy index', () => {
  assert.equal(resolveDocumentStatus('indexed', 'same', 'processing'), 'processing');
  assert.equal(resolveDocumentStatus('indexed', 'changed', 'failed'), 'failed');
  assert.equal(resolveDocumentStatus('indexed', 'missing', 'failed'), 'source_missing');
  assert.equal(resolveDocumentStatus('unavailable', 'unavailable', 'processing'), 'processing');
  assert.equal(resolveDocumentStatus('missing', 'changed'), 'outdated');
});

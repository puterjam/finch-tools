import assert from 'node:assert/strict';
import { test } from 'node:test';
import { highlightTerms, snippetParts, snippetText } from '../dist/index.js';

const hits = (parts) => parts.filter((part) => part.hit).map((part) => part.text);

test('the window starts at the match, not at the start of the passage', () => {
  const passage = `${'Filler sentence about nothing in particular. '.repeat(12)}Boarding: onboarding to a new codebase takes hours, not weeks.`;
  const parts = snippetParts(passage, ['onboarding']);
  const text = snippetText(parts);
  assert.ok(text.startsWith('…'), 'a trimmed start is marked');
  assert.ok(text.includes('onboarding to a new codebase'), 'the hit is inside the window');
  assert.ok(text.length <= 200, `the window stays short: ${text.length}`);
  assert.deepEqual(hits(parts), ['onboarding']);
});

test('a passage that starts with the hit keeps its opening', () => {
  const parts = snippetParts('Onboarding is faster now. Nothing else to say here.', ['onboarding']);
  assert.equal(snippetText(parts).startsWith('Onboarding'), true);
  assert.equal(snippetText(parts).startsWith('…'), false);
  assert.deepEqual(hits(parts), ['Onboarding'], 'matching ignores case');
});

test('every occurrence in the window is marked, in order', () => {
  const parts = snippetParts('资料库位置可以任意指定；资料库位置确定后，索引与副本都跟着走。', ['资料库位置']);
  assert.deepEqual(hits(parts), ['资料库位置', '资料库位置']);
  assert.equal(snippetText(parts), '资料库位置可以任意指定；资料库位置确定后，索引与副本都跟着走。');
});

test('a phrase and its words are both terms, and the phrase wins where they overlap', () => {
  const terms = highlightTerms('library location');
  assert.deepEqual(terms.slice(0, 1), ['library location'], 'longest term first');
  assert.ok(terms.includes('library') && terms.includes('location'));
  const parts = snippetParts('Set the library location once.', terms);
  assert.deepEqual(hits(parts), ['library location'], 'one mark, not overlapping ones');
});

test('a passage with nothing to highlight is still a readable window', () => {
  const long = 'Nothing here matches the query. '.repeat(20);
  const parts = snippetParts(long, ['onboarding']);
  assert.deepEqual(hits(parts), []);
  assert.equal(snippetText(parts).startsWith('…'), false, 'no trim when there is nothing to centre on');
  assert.ok(snippetText(parts).length <= 180);
});

test('single characters and empty queries never highlight anything', () => {
  assert.deepEqual(highlightTerms('a'), []);
  assert.deepEqual(highlightTerms('  '), []);
  assert.deepEqual(snippetParts('a b c', []), [{ text: 'a b c', hit: false }]);
  // Punctuation separates words, so a CJK phrase stays one term and English words split.
  assert.deepEqual(highlightTerms('知识库，检索').sort(), ['知识库，检索', '知识库', '检索'].sort());
});

test('newlines collapse so two lines of prose are two lines on screen', () => {
  const parts = snippetParts('first line\n\nsecond   line\tthird', ['second']);
  assert.equal(snippetText(parts), 'first line second line third');
  assert.deepEqual(hits(parts), ['second']);
});

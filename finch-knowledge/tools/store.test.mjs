import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_TAG, KnowledgeStore, chunkText, vectorize } from '../dist/index.js';

test('local n-gram embeddings and overlapping chunks', () => {
  assert.equal(vectorize('LanceDB')[0] !== undefined, true);
  assert.equal(vectorize('hello').length, 512);
  assert.equal(chunkText('abcdefghij', 6, 2).join('|'), 'abcdef|efghij');
});

test('index, search, deduplicate, replace and remove a local document in LanceDB', async () => {
  const root = await mkdtemp(join(tmpdir(), 'finch-knowledge-test-'));
  try {
    const target = process.platform === 'darwin' ? 'darwin-arm64' : `${process.platform}-${process.arch}-gnu`;
    const native = resolve(`node_modules/@lancedb/lancedb-${target}/lancedb.${target}.node`);
    const engine = join(root, 'lancedb-engine', '0.39.0');
    await mkdir(engine, { recursive: true });
    await symlink(native, join(engine, `lancedb.${target}.node`));
    const store = new KnowledgeStore(root);
    assert.deepEqual(await store.list(), []);
    assert.deepEqual(await store.search('LanceDB'), []);
    const file = join(root, "reader's-notes.md");
    await writeFile(file, '# Field notes\n\nLanceDB stores vectors for local research. Mint tea tastes fresh.');
    const first = await store.importFile(file);
    assert.equal(first.unchanged, false);
    assert.equal((await store.list()).length, 1);
    assert.equal((await store.search('Mint tea')).length, 1);
    const repeat = await store.importFile(file);
    assert.equal(repeat.unchanged, true);
    assert.equal(repeat.document.id, first.document.id);
    await writeFile(file, '# Revised\n\nViolet flowers and updated research.');
    const revised = await store.importFile(file);
    assert.equal(revised.document.id, first.document.id, 'a revision keeps the document identity');
    assert.equal((await store.list()).length, 1);
    assert.match((await store.search('violet flowers'))[0].text, /Violet/);
    assert.equal((await store.search('Mint tea')).some((row) => /Mint tea/.test(row.text)), false, 'the replaced passages are gone');
    assert.equal(await store.remove(revised.document.id), true);
    assert.deepEqual(await store.list(), []);
    assert.deepEqual(await store.search('violet'), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the first paint reads an empty catalogue without touching the vector engine', async () => {
  // A fresh machine has no engine yet; the setup screen must appear before anything downloads.
  const root = await mkdtemp(join(tmpdir(), 'finch-knowledge-firstpaint-'));
  try {
    const store = new KnowledgeStore(root);
    const summary = await store.summary();
    assert.equal(summary.documents, 0);
    assert.equal(summary.lastIndexedAt, null);
    assert.deepEqual(summary.tags.map((tag) => tag.id), [DEFAULT_TAG]);
    assert.equal(summary.tags[0].count, 0);
    assert.equal(existsSync(join(root, 'lancedb-engine')), false, 'no engine was downloaded to answer the panel');
    assert.equal(existsSync(join(root, 'vectors.lance')), false, 'the vector store was not opened');
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing engine is reported before the library lock is taken', async () => {
  // The bug this pins: the engine check ran inside the write lock, so a format whose engine still
  // had to download froze every reader — the whole App View sat on a loading state until it landed.
  const root = await mkdtemp(join(tmpdir(), 'finch-knowledge-engine-'));
  const file = join(root, 'scan.png');
  await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  try {
    const seen = [];
    let readWhileChecking = null;
    let store; // assigned below, read from inside the hook
    store = new KnowledgeStore(root, {
      cachePath: join(root, 'cache'),
      requireEngine: async (extension) => {
        seen.push(extension);
        // A read has to be served while the engine check is still running. Inside the lock this
        // would never resolve, so the race reports 'blocked' and the test fails.
        readWhileChecking = await Promise.race([
          store.summary().then((summary) => summary.documents),
          new Promise((resolve) => setTimeout(() => resolve('blocked'), 800)),
        ]);
        throw new Error('the OCR engine is not installed yet');
      },
    });

    await assert.rejects(() => store.importFile(file, 'scan.png'), /OCR engine is not installed/);
    assert.deepEqual(seen, ['.png'], 'the format was checked with its own extension');
    assert.equal(readWhileChecking, 0, 'reads were served while the engine was being checked');

    // And the library keeps working afterwards: nothing was locked, nothing was half-written.
    assert.deepEqual(await store.list(), []);
    assert.equal((await store.summary()).documents, 0);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('formats that need no engine never consult it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'finch-knowledge-engine-none-'));
  const file = join(root, 'notes.md');
  await writeFile(file, '# Notes\n\nPlain text needs no engine at all.');
  try {
    let calls = 0;
    const store = new KnowledgeStore(root, {
      cachePath: join(root, 'cache'),
      requireEngine: async () => { calls++; },
    });
    const indexed = await store.importFile(file, 'notes.md');
    assert.equal(indexed.unchanged, false);
    assert.equal(calls, 0, 'markdown is read directly, so the engine hook stays out of the way');
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a query nothing mentions returns nothing, not the nearest passages', async () => {
  // Searching a name the library never contains used to come back with ten unrelated passages,
  // because a vector search always returns its nearest neighbours however far off they are.
  const root = await mkdtemp(join(tmpdir(), 'finch-knowledge-relevance-'));
  try {
    const store = new KnowledgeStore(root);
    const english = join(root, 'trends.md');
    await writeFile(english, '# Report\n\nThe 2028 outlook covers tail risks and redistribution.');
    await store.importFile(english, 'trends.md');
    const chinese = join(root, 'intro.md');
    await writeFile(chinese, '# 介绍\n\n这里介绍产品设计与本地知识库的实现。');
    await store.importFile(chinese, 'intro.md');

    assert.equal((await store.search('舜子')).length, 0, 'a name nothing mentions matches nothing');
    assert.equal((await store.search('ZZZ')).length, 0, 'so does a word nothing mentions');
    // A term that is present still finds its passage, and both scripts keep working.
    assert.equal((await store.search('redistribution'))[0].name, 'trends.md');
    assert.equal((await store.search('知识库'))[0].name, 'intro.md');
    // Several words rank the passage holding more of them first.
    assert.equal((await store.search('知识库 实现'))[0].name, 'intro.md');
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a phrase nothing contains falls back to its runs, and reports what it matched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'finch-knowledge-fallback-'));
  try {
    const store = new KnowledgeStore(root);
    await writeFile(join(root, 'notes.md'), '# 笔记\n\n这篇文章讨论知识的组织方式，也提到子舜这个名字出现的场合。');
    await store.importFile(join(root, 'notes.md'), 'notes.md');
    await writeFile(join(root, 'english.md'), '# English\n\nOnboarding is described here.');
    await store.importFile(join(root, 'english.md'), 'english.md');

    // "知识库" is nowhere verbatim, but "知识" is, so the passage is still found — and the reply says
    // which word matched, so the App View highlights a word that is really in the text.
    const widened = await store.search('知识库');
    assert.equal(widened.length, 1);
    assert.deepEqual(widened[0].matched, ['知识']);

    // A name that is present is matched as written, not widened.
    const named = await store.search('子舜');
    assert.equal(named.length, 1);
    assert.deepEqual(named[0].matched, ['子舜']);

    // Latin gets no fragment fallback: "onboardingx" must not match "onboarding" through "on".
    assert.deepEqual(await store.search('onboardingx'), []);
    assert.deepEqual((await store.search('onboarding'))[0].matched, ['onboarding']);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, realpath, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { nativeTarget } from './test-platform.mjs';
import { ACCEPTED, engineForExtension, openSourceDirectory, scanSourceDirectory } from '../dist/index.js';

test('Excel and PowerPoint extensions are accepted and require the existing AnyDoc engine', () => {
  for (const extension of ['.xls', '.xlsx', '.ppt', '.pptx']) {
    assert.ok(ACCEPTED.includes(extension)); assert.equal(engineForExtension(extension), 'anydoc');
  }
  assert.equal(engineForExtension('.txt'), null); assert.ok(!ACCEPTED.includes('.exe'));
});

// Explicit opt-in allows a real engine download without adding network requirements to unit tests.
const cache = process.env.FINCH_TEST_ANYDOC_CACHE;
const cases = [
  ...['xls', 'xlsx'].map(extension => ({ extension, file: new URL(`./fixtures/excel/workbook.${extension}`, import.meta.url), queries: ['Payrollneedle', 'Handoverneedle', '测试员工'] })),
  { extension: 'pptx', file: new URL('./fixtures/powerpoint/slides.pptx', import.meta.url), queries: ['Slideoneneedle', 'Slidetwoneedle', '季度汇报'] },
  // Optional Apache POI basic_test_ppt_file.ppt sample, kept outside the runtime/package.
  { extension: 'ppt', file: process.env.FINCH_TEST_PPT_FIXTURE, queries: ['test'] },
];
for (const { extension, file, queries } of cases) {
  test(`real ${extension} indexes document text, repairs old unsupported notices and preserves source bytes`, { skip: !cache || !file, timeout: 240_000 }, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'knowledge-excel-')));
    const source = join(root, 'source'); await mkdir(source); await mkdir(join(source, 'tables'));
    const engine = join(resolve(cache), 'lancedb-engine', '0.39.0'); await mkdir(engine, { recursive: true });
    await copyFile(resolve(`node_modules/@lancedb/lancedb-${nativeTarget}/lancedb.${nativeTarget}.node`), join(engine, `lancedb.${nativeTarget}.node`));
    const path = join(source, 'tables', `员工交接.${extension.toUpperCase()}`);
    const bytes = await readFile(file); await writeFile(path, bytes);
    const store = await openSourceDirectory(source, resolve(cache));
    t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
    await store.replaceSourceInventory(['tables'], [{ path: `tables/员工交接.${extension.toUpperCase()}`, kind: 'unsupported', reason: 'Previous version' }], [], await stat(source, { bigint: true }));
    assert.equal(await store.issueCount(), 1);
    const result = await scanSourceDirectory(store, undefined, undefined, { yieldMs: 0 });
    assert.deepEqual(result.failed, []); assert.equal(result.updated.length, 1); assert.equal(await store.issueCount(), 0);
    const docs = await store.list(); assert.equal(docs.length, 1); assert.ok(docs[0].chunks > 0);
    for (const query of queries) {
      const matches = await store.search(query); assert.ok(matches.length > 0, query);
    }
    assert.equal(await store.fileCount(), 1); assert.equal((await store.browsePage(null, 'name', 0, 50, 'tables')).total, 1);
    assert.deepEqual(await readFile(path), bytes);
    assert.equal((await scanSourceDirectory(store)).unchanged, 1);
    const tag = await store.createTag('Office'); await store.setTags(docs[0].id, [tag.id]);
    await writeFile(path, 'Not an Office document');
    const broken = await scanSourceDirectory(store);
    assert.equal(broken.failed.length, 1); assert.equal(await store.issueCount(), 1);
    assert.equal((await store.list()).length, 1, 'parse failures retain the previously committed index');
    assert.equal((await store.browsePage(null, 'name', 0)).documents[0].issueKind, 'failed');
    assert.equal((await store.browsePage(null, 'name', 0, 50, 'tables')).total, 0);
    await writeFile(path, bytes); await scanSourceDirectory(store);
    assert.equal(await store.issueCount(), 0); assert.equal((await store.browsePage(tag.id, 'name', 0)).total, 1);
    assert.deepEqual(await readFile(path), bytes);
  });
}

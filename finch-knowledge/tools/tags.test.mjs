import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import * as lancedb from '@lancedb/lancedb';
import { DatabaseSync } from 'node:sqlite';
import { KnowledgeStore, UploadReceiver, vectorize, DEFAULT_TAG } from '../dist/index.js';

const translations = JSON.parse(await readFile(new URL('../i18n/en-US.json', import.meta.url), 'utf8'));
function i18n(key, params = {}) {
  return Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), translations[key] || key);
}
/** Minimal stand-in for ctx.storage, which now also holds the chosen library directory. */
function storage() {
  const values = new Map();
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => { values.set(key, value); },
    delete: async (key) => { values.delete(key); },
    clear: async () => { values.clear(); },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'finch-knowledge-tags-'));
  const target = process.platform === 'darwin' ? 'darwin-arm64' : `${process.platform}-${process.arch}-gnu`;
  const native = resolve(`node_modules/@lancedb/lancedb-${target}/lancedb.${target}.node`);
  const engine = join(root, 'lancedb-engine', '0.39.0');
  await mkdir(engine, { recursive: true });
  await symlink(native, join(engine, `lancedb.${target}.node`));
  return root;
}
async function upload(receiver, tag, name, content) {
  const bytes = Buffer.from(content);
  await receiver.begin(name, bytes.length, tag);
  await receiver.chunk(bytes.toString('base64'));
  return receiver.finish();
}

test('migrates existing v1 passages into Unclassified without changing vectors, pages in sets of 50', async () => {
  const root = await fixture();
  try {
    const db = await lancedb.connect(join(root, 'vectors.lance'));
    const rows = Array.from({ length: 55 }, (_, i) => ({
      id: `passage-${i}`, document_id: `legacy-${i}`, path: join(root, `old-${i}.md`), name: `old-${i}.md`,
      hash: `hash-${i}`, indexed_at: 1000 + i, chunk: 1, text: `Legacy note number ${i}`, vector: vectorize(`Legacy note number ${i}`),
    }));
    await db.createTable('passages_v1', rows);
    const store = new KnowledgeStore(root);
    const tags = await store.tags();
    assert.equal(tags[0].id, DEFAULT_TAG);
    assert.equal(tags[0].count, 55);
    const first = await store.page(null, 'updated', 0);
    const second = await store.page(null, 'updated', 50);
    assert.equal(first.total, 55);
    assert.equal(first.documents.length, 50);
    assert.equal(second.documents.length, 5);
    assert.equal(first.documents[0].indexed_at, 1054);
    assert.equal((await store.page(DEFAULT_TAG, 'name', 0)).documents[0].name, 'old-0.md');
    assert.equal(await store.position(second.documents[0].id, null, 'updated'), 50);
    assert.equal((await store.search('Legacy note', 3, DEFAULT_TAG)).length, 3);
    const reopened = new KnowledgeStore(root);
    assert.equal((await reopened.list()).length, 55);
    assert.equal((await reopened.tags())[0].count, 55);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('tag-isolated indexes, same-name files, moving, renaming, deletion and scoped questions', async () => {
  const root = await fixture();
  try {
    const store = new KnowledgeStore(root);
    const law = await store.createTag('Law');
    const education = await store.createTag('Education');
    const receiver = new UploadReceiver(root, store);
    await upload(receiver, law.id, 'same.md', '# Evidence\n\nContract obligations and judicial rules.');
    await upload(receiver, education.id, 'same.md', '# Lesson\n\nCurriculum and classroom instruction.');
    const summaries = await store.list();
    assert.equal(summaries.length, 2);
    assert.notEqual(summaries[0].path, summaries[1].path);
    assert.equal((await store.page(law.id, 'added', 0)).total, 1);
    assert.equal((await store.page(education.id, 'updated', 0)).total, 1);
    const lawDoc = summaries.find((doc) => doc.tags.includes(law.id));
    const eduDoc = summaries.find((doc) => doc.tags.includes(education.id));
    assert.equal((await store.search('Contract obligations', 5, law.id))[0].document_id, lawDoc.id);
    assert.equal((await store.search('Curriculum and classroom', 5, education.id))[0].document_id, eduDoc.id);
    // The other tag holds nothing containing those words, and a lexical index now says so instead
    // of handing back whatever passage happened to be nearest.
    assert.deepEqual(await store.search('Contract obligations', 5, education.id), []);
    await store.renameTag(law.id, 'Legal');
    assert.equal((await store.tags()).find((tag) => tag.id === law.id).name, 'Legal');
    await assert.rejects(store.renameTag(law.id, 'Education'), /UNIQUE/);
    await store.move(lawDoc.id, DEFAULT_TAG);
    assert.equal((await store.search('Contract obligations', 5, law.id)).length, 0);
    assert.equal((await store.search('Contract obligations', 5, DEFAULT_TAG))[0].document_id, lawDoc.id);
    assert.equal((await store.document(lawDoc.id)).added_at, lawDoc.added_at);
    await store.deleteTag(education.id);
    assert.deepEqual((await store.document(eduDoc.id)).tags, [], 'deleting its only tag leaves it unclassified');
    assert.equal((await store.tags()).some((tag) => tag.id === education.id), false);
    assert.equal((await store.search('Curriculum and classroom', 5, DEFAULT_TAG))[0].document_id, eduDoc.id);
    await assert.rejects(store.search('any', 5, education.id), /no longer exists/);
    assert.equal(await store.remove(eduDoc.id), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('agent tool lists tags and restricts answers by tag name without broadening unknown tags', async () => {
  const root = await fixture();
  try {
    const store = new KnowledgeStore(root);
    const legal = await store.createTag('法律');
    const school = await store.createTag('教育');
    const file = join(root, 'guidance.md');
    await writeFile(file, '# Contract\n\nThe legal question mentions a contract.');
    await store.importFile(file, 'guidance.md', legal.id);
    await writeFile(join(root, 'school.md'), '# Classroom\n\nThe classroom has books.');
    await store.importFile(join(root, 'school.md'), 'school.md', school.id);
    const { activate } = await import('../dist/index.js');
    let tool;
    const ctx = {
      storagePath: root, subscriptions: [], storage: storage(),
      i18n: { t: i18n },
      ui: { onDidOpenPanel() { return { dispose() {} }; } },
      composerActions: { register() { return { dispose() {}, notifyUpdate() {} }; } },
      tools: { register(definition) { tool = definition; return { dispose() {} }; } },
    };
    activate(ctx);
    const tags = await tool.execute({ action: 'tags' });
    assert.match(tags.content[0].text, /法律 \(1\)/);
    assert.match(tags.content[0].text, /教育 \(1\)/);
    const scoped = await tool.execute({ query: 'contract', tag: '法律' });
    assert.match(scoped.content[0].text, /guidance\.md/);
    assert.doesNotMatch(scoped.content[0].text, /school\.md/);
    const unknown = await tool.execute({ query: 'contract', tag: 'Unknown' });
    assert.equal(unknown.isError, true);
    // Scoped to a tag that never mentions the word, the honest answer is that nothing matched —
    // not the nearest passage from elsewhere in the library.
    const educationOnly = (await tool.execute({ query: 'contract', tag: '教育' })).content[0].text;
    assert.doesNotMatch(educationOnly, /school\.md/);
    assert.doesNotMatch(educationOnly, /guidance\.md/);
    assert.match(educationOnly, /No indexed passages found/);
    // The same search inside the tag that does mention it still finds it.
    const classroom = (await tool.execute({ query: 'classroom', tag: '教育' })).content[0].text;
    assert.match(classroom, /school\.md/);
    assert.match(classroom, /classroom has books/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('agent manages tags and documents, imports a managed copy, and rejects paths outside the workspace', async () => {
  const root = await fixture();
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const source = join(workspace, 'notes.md');
    const outside = join(root, 'outside.md');
    await writeFile(source, '# Notes\n\nFinch keeps a local copy.');
    await writeFile(outside, '# Secret\n\nNot inside the workspace.');
    await symlink(outside, join(workspace, 'linked.md'));
    const { activate } = await import('../dist/index.js');
    let tool;
    activate({
      storagePath: root, subscriptions: [], storage: storage(), i18n: { t: i18n },
      ui: { onDidOpenPanel() { return { dispose() {} }; } },
      composerActions: { register() { return { dispose() {}, notifyUpdate() {} }; } },
      tools: { register(definition) { tool = definition; return { dispose() {} }; } },
    });
    const exec = { cwd: workspace, progress: { report() {} } };
    assert.equal(tool.risk, 'medium');
    const created = await tool.execute({ action: 'create_tag', name: 'Research' }, exec);
    assert.equal(created.isError, false);
    const tag = (await new KnowledgeStore(root).tags()).find((item) => item.name === 'Research');
    assert.ok(tag);
    assert.match((await tool.execute({ action: 'tags' }, exec)).content[0].text, new RegExp(tag.id));
    const imported = await tool.execute({ action: 'import', path: 'notes.md', tag: tag.id }, exec);
    assert.match(imported.content[0].text, /managed copy/);
    const store = new KnowledgeStore(root);
    const [doc] = await store.list();
    assert.deepEqual(doc.tags, [tag.id]);
    assert.match(doc.path, /imports/);
    assert.notEqual(doc.path, source);
    assert.equal(await readFile(doc.path, 'utf8'), await readFile(source, 'utf8'));
    assert.match((await tool.execute({ action: 'documents', tag: tag.id }, exec)).content[0].text, new RegExp(doc.id));
    assert.match((await tool.execute({ action: 'search', query: 'Finch keeps a local copy', tag: tag.id }, exec)).content[0].text, new RegExp(doc.id));
    const repeat = await tool.execute({ action: 'import', path: source, tag: 'Research' }, exec);
    assert.match(repeat.content[0].text, /already indexed/);
    assert.equal((await store.list()).length, 1);
    const renamed = await tool.execute({ action: 'rename_tag', tag: tag.id, name: 'Research notes' }, exec);
    assert.match(renamed.content[0].text, /Research notes/);
    // A second tag joins the first instead of replacing it.
    await tool.execute({ action: 'create_tag', name: 'Reading' }, exec);
    const added = await tool.execute({ action: 'tag_document', documentId: doc.id, tag: 'Reading' }, exec);
    assert.match(added.content[0].text, /Reading/);
    assert.equal((await store.document(doc.id)).tags.length, 2);
    assert.ok((await store.search('Finch keeps', 5, (await store.tags()).find((item) => item.name === 'Reading').id)).length);
    // Removing one leaves the other, and search scoped to it still finds the copy.
    const untagged = await tool.execute({ action: 'untag_document', documentId: doc.id, tag: 'Reading' }, exec);
    assert.match(untagged.content[0].text, /Reading/);
    assert.deepEqual((await store.document(doc.id)).tags, [tag.id]);
    assert.equal((await store.search('Finch keeps', 5, tag.id)).length, 1);
    // Taking the last tag away is what puts a document back in Unclassified.
    await tool.execute({ action: 'untag_document', documentId: doc.id, tag: tag.id }, exec);
    assert.deepEqual((await store.document(doc.id)).tags, []);
    assert.equal((await store.search('Finch keeps', 5, tag.id)).length, 0);
    for (const path of ['../outside.md', outside, 'linked.md']) {
      const denied = await tool.execute({ action: 'import', path }, exec);
      assert.equal(denied.isError, true);
    }
    assert.equal((await store.list()).length, 1);
    const oldCopy = await readFile(doc.path, 'utf8');
    await writeFile(source, '   ');
    const failed = await tool.execute({ action: 'import', path: source, tag: 'Unclassified' }, exec);
    assert.equal(failed.isError, true);
    assert.equal(await readFile(doc.path, 'utf8'), oldCopy);
    assert.equal((await store.search('Finch keeps', 5, DEFAULT_TAG))[0].document_id, doc.id);
    // Naming a tag that does not exist yet is how a classification import works, so it is created.
    await writeFile(source, '# Notes\n\nFinch keeps a local copy.');
    assert.equal((await tool.execute({ action: 'import', path: source, tag: 'Missing' }, exec)).isError, false);
    assert.equal((await store.tags()).some((tag) => tag.name === 'Missing'), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a new tag stays where its input row was, and the user can reorder the rest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'finch-knowledge-order-'));
  try {
    // No engine here: ordering is catalogue work, so it must not need one.
    const store = new KnowledgeStore(root, { cachePath: join(root, 'cache') });
    const alpha = await store.createTag('Alpha');
    const beta = await store.createTag('Beta');
    const gamma = await store.createTag('Gamma');
    const names = (await store.summary()).tags.map((tag) => tag.name);
    // Unclassified stays first, and each new tag sits directly below it instead of at the bottom.
    assert.deepEqual(names, ['', 'Gamma', 'Beta', 'Alpha']);
    assert.equal((await store.summary()).tags[0].id, DEFAULT_TAG);

    await store.reorderTags([alpha.id, gamma.id, beta.id]);
    assert.deepEqual((await store.summary()).tags.map((tag) => tag.name), ['', 'Alpha', 'Gamma', 'Beta']);
    // The pinned default tag is never part of an order, even if a caller names it.
    await store.reorderTags([DEFAULT_TAG, beta.id, alpha.id, gamma.id]);
    assert.deepEqual((await store.summary()).tags.map((tag) => tag.name), ['', 'Beta', 'Alpha', 'Gamma']);
    assert.equal((await store.summary()).tags[0].id, DEFAULT_TAG);

    // The order survives a reopen, which is the whole point of storing it.
    await store.close();
    const again = new KnowledgeStore(root, { cachePath: join(root, 'cache') });
    assert.deepEqual((await again.summary()).tags.map((tag) => tag.name), ['', 'Beta', 'Alpha', 'Gamma']);
    await again.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a library from before the ordering column keeps the order it already showed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'finch-knowledge-order-legacy-'));
  try {
    await mkdir(root, { recursive: true });
    // A pre-0.18 catalogue: tags without sort_order, stamped at schema version 4.
    const legacy = new DatabaseSync(join(root, 'catalog.sqlite'));
    legacy.exec('CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, created_at INTEGER NOT NULL)');
    const insert = legacy.prepare('INSERT INTO tags(id,name,created_at) VALUES (?,?,?)');
    insert.run('old-1', 'One', 1000);
    insert.run('old-2', 'Two', 2000);
    insert.run('old-3', 'Three', 3000);
    legacy.exec('PRAGMA user_version=4');
    legacy.close();

    const store = new KnowledgeStore(root, { cachePath: join(root, 'cache') });
    // Seeded by creation order, so nothing moves on screen after the upgrade.
    assert.deepEqual((await store.summary()).tags.map((tag) => tag.name), ['', 'One', 'Two', 'Three']);
    await store.close();
    // Reopening is a no-op rather than a re-seed.
    const again = new KnowledgeStore(root, { cachePath: join(root, 'cache') });
    assert.deepEqual((await again.summary()).tags.map((tag) => tag.name), ['', 'One', 'Two', 'Three']);
    assert.equal((await again.createTag('Four')).name, 'Four');
    assert.deepEqual((await again.summary()).tags.map((tag) => tag.name), ['', 'Four', 'One', 'Two', 'Three']);
    await again.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

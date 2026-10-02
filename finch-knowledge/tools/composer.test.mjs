import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { KnowledgeStore, createKnowledgeComposer } from '../dist/index.js';

async function providerFor(locale = 'zh-CN', initial = { documents: 3, lastIndexedAt: 1700000000000 }) {
  const copy = JSON.parse(await readFile(new URL(`../i18n/${locale}.json`, import.meta.url), 'utf8'));
  let snapshot = initial;
  const provider = createKnowledgeComposer({
    snapshot: async () => { if (snapshot instanceof Error) throw snapshot; return snapshot; },
    t: (key, values = {}) => Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), copy[key] ?? key),
    locale: () => locale, showGuide: async () => {},
  });
  return { provider, copy, change: value => { snapshot = value; } };
}

test('all localized templates append only to the current editable draft', async () => {
  for (const locale of ['zh-CN', 'en-US']) {
    const { provider, copy } = await providerFor(locale);
    const menu = await provider.getMenu({ surface: 'home' });
    for (const item of menu.filter(item => !item.disabled && !item.separator && item.id !== 'guide')) {
      assert.ok(item.iconName);
      assert.ok(item.hoverText);
      assert.notEqual(item.label, `composer.${item.id}.label`);
      for (const initial of ['', 'Existing draft']) {
        let current = initial;
        const actions = { composer: { fill: async (text, options) => {
          assert.equal(options.mode, 'append');
          assert.equal(text, copy[`ask.${item.id}`]);
          assert.doesNotMatch(text, /^\s/, 'no leading blank lines are inserted');
          current += text;
        } } };
        await provider.execute({ surface: 'session' }, item.id, actions);
        assert.equal(current, `${initial}${copy[`ask.${item.id}`]}`);
      }
    }
    assert.equal(menu.filter(item => !item.disabled && !item.separator).length, 8);
  }
});

test('an empty library reports no index time and hides irrelevant read templates', async () => {
  const { provider, copy } = await providerFor('zh-CN', { documents: 0, lastIndexedAt: null });
  assert.equal(await provider.getBadge({}), undefined);
  const menu = await provider.getMenu({});
  assert.equal(menu.find(item => item.id === 'library-indexed').description, copy['composer.neverIndexed']);
  assert.deepEqual(menu.filter(item => !item.disabled && !item.separator).map(item => item.id), ['guide', 'article']);
});

test('the last index time remains persisted when a menu is opened repeatedly', async () => {
  const { provider } = await providerFor();
  const first = (await provider.getMenu({})).find(item => item.id === 'library-indexed').description;
  assert.equal((await provider.getMenu({})).find(item => item.id === 'library-indexed').description, first);
  assert.equal(first, new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(1700000000000)));
});

test('a stale template cannot operate on a now-empty or unavailable library', async () => {
  const { provider, change } = await providerFor();
  const actions = { composer: { fill: async () => assert.fail('Stale action must not fill') } };
  change({ documents: 0, lastIndexedAt: null });
  await assert.rejects(provider.execute({}, 'search', actions), /添加资料/);
  change(null);
  await assert.rejects(provider.execute({}, 'article', actions));
  await provider.execute({}, 'library-count', actions);
  await provider.execute({}, 'unrecognized', actions);
});

test('metadata read errors are not turned into fabricated zero counts', async () => {
  const { provider } = await providerFor('en-US', new Error('Catalogue unavailable'));
  assert.equal(await provider.getBadge({}), undefined);
  await assert.rejects(provider.getMenu({}), /Catalogue unavailable/);
});

test('catalogue aggregate uses unique documents and the true maximum index timestamp without an engine', async () => {
  const root = await mkdtemp(join(tmpdir(), 'finch-knowledge-metadata-'));
  try {
    const store = new KnowledgeStore(root);
    await store.summary();
    const db = new DatabaseSync(join(root, 'catalog.sqlite'));
    const insert = db.prepare('INSERT INTO documents (id,path,name,hash,added_at,indexed_at,chunks) VALUES (?,?,?,?,?,?,?)');
    insert.run('one', '/fixture/one.md', 'one.md', 'one', 1000, 9000, 1);
    insert.run('two', '/fixture/two.md', 'two.md', 'two', 2000, 7000, 2);
    db.exec("INSERT INTO tags (id,name,created_at) VALUES ('a','A',1),('b','B',2); INSERT INTO document_tags VALUES ('one','a',1),('one','b',1),('two','a',1),('two','b',1)");
    const summary = await store.summary();
    assert.equal(summary.documents, 2);
    assert.equal(summary.lastIndexedAt, 9000);
    assert.equal(summary.tags.reduce((total, tag) => total + tag.count, 0), 4);
    assert.equal(existsSync(join(root, 'lancedb-engine')), false);
    assert.equal(existsSync(join(root, 'vectors.lance')), false);
    db.close();
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_TAG, KnowledgeStore } from '../dist/index.js';

const translations = JSON.parse(await readFile(new URL('../i18n/en-US.json', import.meta.url), 'utf8'));
function i18n(key, params = {}) {
  return Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), translations[key] || key);
}
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
  const root = await mkdtemp(join(tmpdir(), 'finch-knowledge-tag-edit-'));
  const target = process.platform === 'darwin' ? 'darwin-arm64' : `${process.platform}-${process.arch}-gnu`;
  const native = resolve(`node_modules/@lancedb/lancedb-${target}/lancedb.${target}.node`);
  const engine = join(root, 'lancedb-engine', '0.39.0');
  await mkdir(engine, { recursive: true });
  await symlink(native, join(engine, `lancedb.${target}.node`));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  return { root, workspace };
}

async function harness(root, workspace) {
  const { activate } = await import('../dist/index.js');
  let tool;
  activate({
    storagePath: root, subscriptions: [], storage: storage(), i18n: { t: i18n },
    ui: { onDidOpenPanel() { return { dispose() {} }; } },
    composerActions: { register() { return { dispose() {}, notifyUpdate() {} }; } },
    tools: { register(definition) { tool = definition; return { dispose() {} }; } },
  });
  return { tool, exec: { cwd: workspace, progress: { report() {} } } };
}

test('a tag can be renamed (edited), and an empty tag is removed without ceremony', async () => {
  const { root, workspace } = await fixture();
  try {
    const { tool, exec } = await harness(root, workspace);
    await tool.execute({ action: 'create_tag', name: 'Drafts' }, exec);

    const edited = await tool.execute({ action: 'rename_tag', tag: 'Drafts', name: 'Working drafts' }, exec);
    assert.equal(edited.isError, false);
    assert.match(edited.content[0].text, /Working drafts/);
    assert.ok((await new KnowledgeStore(root).tags()).some((tag) => tag.name === 'Working drafts'), 'the rename stuck');

    const removed = await tool.execute({ action: 'delete_tag', tag: 'Working drafts' }, exec);
    assert.equal(removed.isError, false);
    assert.match(removed.content[0].text, /0 document/);
    const names = (await new KnowledgeStore(root).tags()).map((tag) => tag.name);
    assert.equal(names.includes('Working drafts'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the declared action list is the whole contract, so nothing is reachable but undocumented', async () => {
  const { root, workspace } = await fixture();
  try {
    const { tool } = await harness(root, workspace);
    // The host validates `action` against this enum, so a name outside it can never be called.
    assert.deepEqual(tool.inputSchema.properties.action.enum,
      ['search', 'tags', 'documents', 'library', 'environment', 'import', 'sync', 'import_url', 'save_document', 'create_tag', 'rename_tag', 'delete_tag', 'tag_document', 'untag_document']);
    const description = translations['tool.description'];
    const documented = description.match(/action=([a-z_|]+)/)[1].split('|');
    for (const action of documented) {
      assert.equal(tool.inputSchema.properties.action.enum.includes(action), true, `${action} is documented but not callable`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('deleting a tag that still holds documents needs an explicit retry, then keeps every document', async () => {
  const { root, workspace } = await fixture();
  try {
    await writeFile(join(workspace, 'a.md'), '# Alpha\n\nFirst note.');
    await writeFile(join(workspace, 'b.md'), '# Beta\n\nSecond note.');
    const { tool, exec } = await harness(root, workspace);
    await tool.execute({ action: 'import', items: [{ path: 'a.md', tag: 'Contracts' }, { path: 'b.md', tag: 'Contracts' }] }, exec);

    const refused = await tool.execute({ action: 'delete_tag', tag: 'Contracts' }, exec);
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /still holds 2 document/);
    assert.match(refused.content[0].text, /force=true/);
    const store = new KnowledgeStore(root);
    assert.equal((await store.tags()).some((tag) => tag.name === 'Contracts'), true, 'nothing happened yet');

    const forced = await tool.execute({ action: 'delete_tag', tag: 'Contracts', force: true }, exec);
    assert.equal(forced.isError, false);
    assert.match(forced.content[0].text, /Deleted tag Contracts/);
    // Both documents lose the tag; both had only this one, so both land in Unclassified.
    assert.match(forced.content[0].text, /2 document\(s\) no longer carry it, 2 of which moved to Unclassified/);

    // The documents survive the tag and are searchable where they landed.
    const tags = await store.tags();
    assert.equal(tags.some((tag) => tag.name === 'Contracts'), false);
    assert.equal(tags.find((tag) => tag.id === DEFAULT_TAG).count, 2);
    const hits = await store.search('Second note', 3, DEFAULT_TAG);
    assert.equal(hits.some((hit) => hit.name === 'b.md'), true);
    assert.equal((await store.list()).length, 2);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Unclassified cannot be renamed or removed, and an unknown tag is reported', async () => {
  const { root, workspace } = await fixture();
  try {
    const { tool, exec } = await harness(root, workspace);
    for (const action of ['rename_tag', 'delete_tag']) {
      const guarded = await tool.execute({ action, tag: 'Unclassified', name: 'Nope', force: true }, exec);
      assert.equal(guarded.isError, true);
      assert.match(guarded.content[0].text, /default tag cannot be/);
    }
    const missing = await tool.execute({ action: 'delete_tag', tag: 'Nonexistent' }, exec);
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /Tag not found/);
    const stored = (await new KnowledgeStore(root).tags()).map((tag) => tag.id);
    assert.deepEqual(stored, [DEFAULT_TAG]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

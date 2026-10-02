import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
  const root = await mkdtemp(join(tmpdir(), 'finch-knowledge-sync-'));
  const target = process.platform === 'darwin' ? 'darwin-arm64' : `${process.platform}-${process.arch}-gnu`;
  const native = resolve(`node_modules/@lancedb/lancedb-${target}/lancedb.${target}.node`);
  const engine = join(root, 'lancedb-engine', '0.39.0');
  await mkdir(engine, { recursive: true });
  await symlink(native, join(engine, `lancedb.${target}.node`));
  const workspace = join(root, 'workspace');
  await mkdir(join(workspace, 'notes'), { recursive: true });
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

test('a workspace import remembers its source, and sync follows edits made outside the app', async () => {
  const { root, workspace } = await fixture();
  try {
    const { tool, exec } = await harness(root, workspace);
    const note = join(workspace, 'notes', 'plan.md');
    await writeFile(note, '# Plan\n\nStart with the first milestone.');

    const imported = await tool.execute({ action: 'import', path: 'notes/plan.md' }, exec);
    assert.equal(imported.isError, false);
    const store = new KnowledgeStore(root);
    const [doc] = await store.list();
    assert.equal(doc.source_path, note, 'the workspace file is recorded as the source');
    assert.notEqual(doc.path, note, 'the index still points at the managed copy');

    // Nothing touched yet: a sync is a no-op.
    const idle = await tool.execute({ action: 'sync' }, exec);
    assert.equal(idle.isError, false);
    assert.match(idle.content[0].text, /0 updated/);
    assert.match(idle.content[0].text, /Nothing needed syncing/);

    // Someone (usually the Agent) edits the file behind the app's back.
    await writeFile(note, '# Plan\n\nStart with the second milestone instead.');
    const synced = await tool.execute({ action: 'sync' }, exec);
    assert.equal(synced.isError, false, `sync failed: ${synced.content[0].text}`);
    assert.match(synced.content[0].text, /1 updated/);
    assert.match(synced.content[0].text, /plan\.md/);

    const [after] = await store.list();
    assert.equal(after.id, doc.id, 'the same document is re-indexed in place');
    assert.equal(await readFile(after.path, 'utf8'), await readFile(note, 'utf8'), 'the managed copy is refreshed');
    // Search has no distance threshold, so the check is on the passages themselves: the new
    // text is indexed and the old one has left the table.
    const hits = await store.search('second milestone', 3);
    assert.equal(hits.some((hit) => hit.document_id === doc.id && /second milestone/.test(hit.text)), true, 'the new text is searchable');
    const stale = await store.search('first milestone', 3);
    assert.equal(stale.some((hit) => /first milestone/.test(hit.text)), false, 'the old passage left the index');
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('sync drops entries whose source was deleted, but keeps ones whose volume is away', async () => {
  const { root, workspace } = await fixture();
  try {
    const { tool, exec } = await harness(root, workspace);
    await writeFile(join(workspace, 'notes', 'keep.md'), '# Keep\n\nStill edited in place.');
    await writeFile(join(workspace, 'notes', 'gone.md'), '# Gone\n\nWill be deleted.');
    await mkdir(join(workspace, 'detached'), { recursive: true });
    await writeFile(join(workspace, 'detached', 'offline.md'), '# Offline\n\nPretend the volume is unmounted.');
    await tool.execute({ action: 'import', path: 'notes' }, exec);
    await tool.execute({ action: 'import', path: 'detached/offline.md' }, exec);
    assert.equal((await new KnowledgeStore(root).list()).length, 3);

    await rm(join(workspace, 'notes', 'gone.md'));
    await rm(join(workspace, 'detached'), { recursive: true, force: true });
    await writeFile(join(workspace, 'notes', 'keep.md'), '# Keep\n\nEdited after the first index.');

    const synced = await tool.execute({ action: 'sync' }, exec);
    assert.equal(synced.isError, false);
    const text = synced.content[0].text;
    assert.match(text, /1 updated/);
    assert.match(text, /1 removed/);
    assert.match(text, /Not reachable right now/);

    const store = new KnowledgeStore(root);
    assert.deepEqual((await store.list()).map((doc) => doc.name).sort(), ['keep.md', 'offline.md']);
    assert.equal((await store.search('deleted', 3)).some((hit) => hit.name === 'gone.md'), false);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('documents without a source are left alone, and a second sync changes nothing', async () => {
  const { root, workspace } = await fixture();
  try {
    const { tool, exec } = await harness(root, workspace);
    // An App View upload never knows the original path, so it must simply be skipped.
    const receiver = new UploadStore(root);
    await receiver.upload('pasted.md', '# Pasted\n\nDragged in from somewhere.');
    await writeFile(join(workspace, 'notes', 'tracked.md'), '# Tracked\n\nImported from the workspace.');
    await tool.execute({ action: 'import', path: 'notes/tracked.md' }, exec);

    const store = new KnowledgeStore(root);
    assert.equal((await store.sourceStates()).length, 1, 'only the workspace import has a source');
    assert.equal((await store.list()).length, 2);
    const first = await tool.execute({ action: 'sync' }, exec);
    assert.match(first.content[0].text, /1 unchanged/);
    const second = await tool.execute({ action: 'sync' }, exec);
    assert.match(second.content[0].text, /1 unchanged/);
    assert.equal((await store.list()).length, 2, 'nothing is duplicated or dropped');
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

/** Minimal look-alike of a sandboxed upload: bytes in, managed copy out, no source path. */
class UploadStore {
  constructor(root) { this.root = root; }
  async upload(name, content) {
    const store = new KnowledgeStore(this.root);
    const target = await store.uploadTarget(DEFAULT_TAG, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    await store.importFile(target, name, DEFAULT_TAG);
    await store.close();
  }
}

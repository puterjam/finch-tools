import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_TAG, KnowledgeStore, expandImportTargets, MAX_BATCH_FILES } from '../dist/index.js';

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

/** A workspace tree that exercises nesting, hidden files, symlinks and unsupported types. */
async function workspaceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'finch-knowledge-batch-'));
  // Point the engine loader at the copy already in node_modules so nothing is downloaded.
  const target = process.platform === 'darwin' ? 'darwin-arm64' : `${process.platform}-${process.arch}-gnu`;
  const native = resolve(`node_modules/@lancedb/lancedb-${target}/lancedb.${target}.node`);
  const engine = join(root, 'lancedb-engine', '0.39.0');
  await mkdir(engine, { recursive: true });
  await symlink(native, join(engine, `lancedb.${target}.node`));
  const workspace = join(root, 'workspace');
  await mkdir(join(workspace, 'contracts', '2026'), { recursive: true });
  await mkdir(join(workspace, 'invoices'), { recursive: true });
  await mkdir(join(workspace, 'empty'), { recursive: true });
  await writeFile(join(workspace, 'contracts', 'nda.md'), '# NDA\n\nMutual confidentiality terms.');
  await writeFile(join(workspace, 'contracts', '2026', 'lease.md'), '# Lease\n\nShop lease agreement.');
  await writeFile(join(workspace, 'invoices', 'march.md'), '# March\n\nInvoice for March hosting.');
  await writeFile(join(workspace, 'readme.txt'), 'plain text notes');
  // Noise a folder import has to pass over rather than fail on.
  await writeFile(join(workspace, 'contracts', '.draft.md'), 'hidden draft, must not be indexed');
  await writeFile(join(workspace, 'contracts', 'sheet.xlsx'), 'unsupported type');
  const outside = join(root, 'outside.md');
  await writeFile(outside, '# Outside\n\nNot part of the workspace.');
  await symlink(outside, join(workspace, 'escape.md'));
  await symlink(outside, join(workspace, 'contracts', 'linked.md'));
  return { root, workspace, outside };
}

async function harness(root) {
  const { activate } = await import('../dist/index.js');
  let tool;
  activate({
    storagePath: root, subscriptions: [], storage: storage(), i18n: { t: i18n },
    ui: { onDidOpenPanel() { return { dispose() {} }; } },
    composerActions: { register() { return { dispose() {}, notifyUpdate() {} }; } },
    tools: { register(definition) { tool = definition; return { dispose() {} }; } },
  });
  return { tool, exec: { cwd: join(root, 'workspace'), progress: { report() {} } } };
}

test('a folder is imported recursively, and what cannot be indexed is counted not fatal', async () => {
  const { root, workspace } = await workspaceFixture();
  try {
    const { tool, exec } = await harness(root);
    const result = await tool.execute({ action: 'import', path: 'contracts' }, exec);
    assert.equal(result.isError, false);
    const text = result.content[0].text;
    // nda.md and the nested lease.md; the hidden draft, the xlsx and the symlink are passed over.
    assert.match(text, /Indexed 2 file\(s\)/);
    assert.match(text, /hidden files 1/);
    assert.match(text, /unsupported types 1/);
    assert.match(text, /symlinks 1/);
    assert.match(text, /Unclassified 2/);

    const store = new KnowledgeStore(root);
    assert.deepEqual((await store.list()).map((doc) => doc.name).sort(), ['lease.md', 'nda.md']);
    assert.equal((await store.search('Mutual confidentiality', 3))[0].name, 'nda.md');
    await store.close();

    // A second run changes nothing.
    const again = await tool.execute({ action: 'import', path: join(workspace, 'contracts') }, exec);
    assert.match(again.content[0].text, /unchanged/);
    assert.equal((await new KnowledgeStore(root).list()).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('recursive can be turned off, and an unusable folder reports why', async () => {
  const { root } = await workspaceFixture();
  try {
    const { tool, exec } = await harness(root);
    const shallow = await tool.execute({ action: 'import', path: 'contracts', recursive: false }, exec);
    assert.equal(shallow.isError, false);
    assert.match(shallow.content[0].text, /Indexed 1 file\(s\)/);
    assert.deepEqual((await new KnowledgeStore(root).list()).map((doc) => doc.name), ['nda.md']);

    const empty = await tool.execute({ action: 'import', path: 'empty' }, exec);
    assert.equal(empty.isError, true);
    assert.match(empty.content[0].text, /No importable files/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the agent classifies a batch itself, creating the tags it names', async () => {
  const { root } = await workspaceFixture();
  try {
    const { tool, exec } = await harness(root);
    const result = await tool.execute({
      action: 'import',
      items: [
        { path: 'contracts/nda.md', tag: '合同' },
        { path: 'contracts/2026/lease.md', tag: '合同' },
        { path: 'invoices/march.md', tag: '发票' },
        { path: 'readme.txt' },
      ],
    }, exec);
    assert.equal(result.isError, false);
    const text = result.content[0].text;
    assert.match(text, /Indexed 4 file\(s\)/);
    assert.match(text, /New tags: 合同 · 发票/);
    assert.match(text, /合同 2/);
    assert.match(text, /发票 1/);
    assert.match(text, /Unclassified 1/);

    const store = new KnowledgeStore(root);
    const tags = await store.tags();
    const byName = Object.fromEntries(tags.map((tag) => [tag.id === DEFAULT_TAG ? 'Unclassified' : tag.name, tag.count]));
    assert.equal(byName['合同'], 2);
    assert.equal(byName['发票'], 1);
    assert.equal(byName.Unclassified, 1);
    // Each file is really filed under the tag its item asked for, and nowhere else.
    const contracts = tags.find((tag) => tag.name === '合同');
    assert.equal((await store.search('Shop lease agreement', 3, contracts.id)).some((hit) => hit.name === 'lease.md'), true);
    assert.equal((await store.search('Shop lease agreement', 3, DEFAULT_TAG)).some((hit) => hit.name === 'lease.md'), false);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('one call accepts several paths, and a bad request reports its own reason', async () => {
  const { root, outside } = await workspaceFixture();
  try {
    const { tool, exec } = await harness(root);
    const batch = await tool.execute({ action: 'import', paths: ['readme.txt', 'contracts/2026'], tag: '资料' }, exec);
    assert.equal(batch.isError, false);
    assert.match(batch.content[0].text, /Indexed 2 file\(s\)/);
    assert.match(batch.content[0].text, /资料 2/);

    // A path the caller named directly must fail loudly, exactly as a single call always has.
    for (const path of ['../outside.md', outside, 'escape.md']) {
      const denied = await tool.execute({ action: 'import', path }, exec);
      assert.equal(denied.isError, true);
      assert.match(denied.content[0].text, /workspace|symbolic link/);
    }
    // A folder outside the workspace is refused as well.
    assert.equal((await tool.execute({ action: 'import', path: '..' }, exec)).isError, true);

    // Mixed batches keep what worked and name what did not.
    const mixed = await tool.execute({ action: 'import', paths: ['contracts/nda.md', '../outside.md'] }, exec);
    assert.equal(mixed.isError, false);
    assert.match(mixed.content[0].text, /Indexed 1 file\(s\)/);
    assert.match(mixed.content[0].text, /Failed 1/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('expansion stops at the batch cap and never follows a symlink out of the workspace', async () => {
  const { root, workspace } = await workspaceFixture();
  try {
    await mkdir(join(workspace, 'many'), { recursive: true });
    for (let index = 0; index < 12; index++) await writeFile(join(workspace, 'many', `note-${index}.md`), `# Note ${index}\n\nBody ${index}.`);

    const capped = await expandImportTargets(workspace, [{ path: 'many' }], { maxFiles: 5 });
    assert.equal(capped.targets.length, 5);
    assert.equal(capped.skipped.length, 0);
    assert.equal(capped.failures.length, 0);
    assert.equal((await expandImportTargets(workspace, [{ path: 'many' }])).targets.length, 12);
    assert.equal(MAX_BATCH_FILES, 200);

    // A folder holding only a symlinked file yields skips, not a crash or an escape.
    const linked = await expandImportTargets(workspace, [{ path: 'contracts' }]);
    assert.equal(linked.targets.length, 2);
    assert.equal(linked.skipped.filter((item) => item.reason === 'symlink').length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

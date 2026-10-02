import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { activate, KnowledgeStore } from '../dist/index.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'finch-knowledge-composer-'));
  const target = process.platform === 'darwin' ? 'darwin-arm64' : `${process.platform}-${process.arch}-gnu`;
  const native = resolve(`node_modules/@lancedb/lancedb-${target}/lancedb.${target}.node`);
  const engine = join(root, 'lancedb-engine', '0.39.0');
  await mkdir(engine, { recursive: true });
  await symlink(native, join(engine, `lancedb.${target}.node`));
  return root;
}

async function harness(root, { locale = 'zh-CN', savedRoot } = {}) {
  const copy = JSON.parse(await readFile(new URL(`../i18n/${locale}.json`, import.meta.url), 'utf8'));
  let provider, openPanel, receive, updates = 0;
  const subscriptions = [], dialogs = [], fills = [], sent = [];
  const handle = { dispose() {}, notifyUpdate() { updates++; } };
  const values = new Map(savedRoot ? [['libraryRoot', savedRoot]] : []);
  const panel = {
    view: 'appView', postMessage: async payload => { sent.push(payload); },
    onDidReceiveMessage(handler) { receive = handler; return { dispose() {} }; },
    onDidDispose() { return { dispose() {} }; },
  };
  activate({
    storagePath: root, subscriptions,
    storage: { get: async key => values.get(key), set: async (key, value) => { values.set(key, value); } },
    i18n: { t: (key, replacements = {}) => Object.entries(replacements).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), copy[key] ?? key) },
    app: { getInfo: () => ({ locale }) },
    composerActions: { register(id, definition) { assert.equal(id, 'knowledge'); provider = definition; return handle; } },
    ui: { onDidOpenPanel(handler) { openPanel = handler; return { dispose() {} }; }, showModalDialog: async spec => { dialogs.push(spec); return { action: 'close' }; } },
    tools: { register() { return { dispose() {} }; } },
    sessions: { create: async () => assert.fail('No session creation'), send: async () => assert.fail('No auto-send') },
    navigation: { openChat: async () => assert.fail('No chat navigation'), openSession: async () => assert.fail('No session navigation') },
  });
  openPanel(panel);
  assert.ok(subscriptions.includes(handle), 'provider lifetime belongs to the extension');
  const actions = { composer: { fill: async (text, options) => { fills.push({ text, options }); } } };
  return { provider, actions, copy, fills, sent, dialogs, receive, updates: () => updates };
}

test('the real toolbar provider fills the current Home and Session Composer without navigating or sending', async () => {
  const root = await fixture();
  try {
    const { provider, actions, fills, copy } = await harness(root);
    for (const surface of ['home', 'session']) {
      await provider.execute({ surface }, 'article', actions);
    }
    assert.deepEqual(fills, Array(2).fill({ text: copy['ask.article'], options: { mode: 'append' } }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('document counts remain in the menu after removal, never on the toolbar button', async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, 'notes.md'), '# Notes\n\nA real document.');
    const store = new KnowledgeStore(root);
    const imported = await store.importFile(join(root, 'notes.md'), 'notes.md');
    const summary = await store.summary();
    await store.close();
    const { provider, receive, updates } = await harness(root);
    assert.equal(await provider.getBadge({}), undefined);
    const menu = await provider.getMenu({});
    assert.equal(menu.find(item => item.id === 'library-count').description, '1 份资料');
    assert.equal(menu.find(item => item.id === 'library-indexed').description,
      new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(summary.lastIndexedAt)));
    await receive({ type: 'delete', requestId: 'delete', id: imported.document.id });
    assert.equal(await provider.getBadge({}), undefined);
    assert.equal((await provider.getMenu({})).find(item => item.id === 'library-count').description, '0 份资料');
    assert.ok(updates() > 0, 'library edits notify the Composer provider');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('guidance uses a native dialog and never touches the draft', async () => {
  const root = await fixture();
  try {
    const { provider, actions, dialogs, fills, copy } = await harness(root);
    await provider.execute({ surface: 'home' }, 'guide', actions);
    assert.equal(dialogs[0].title, copy['composer.guide']);
    assert.equal(dialogs[0].message, copy['composer.guideText']);
    assert.deepEqual(fills, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an unavailable external library is not misreported as an empty library', async () => {
  const root = await fixture();
  try {
    const { provider } = await harness(root, { savedRoot: join(root, 'unmounted') });
    assert.equal(await provider.getBadge({}), undefined);
    const menu = await provider.getMenu({});
    assert.ok(menu.some(item => item.id === 'library-unavailable'));
    assert.equal(menu.some(item => item.id === 'library-count'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

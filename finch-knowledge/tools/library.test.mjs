import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  adoptExistingLibrary, assertUsableTarget, createEmptyLibrary, hasLibrary,
  inspectLibrary, KnowledgeStore, rebaseImportPath, relocateLibrary, resolveLibraryAction, UploadReceiver,
} from '../dist/index.js';

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), 'finch-knowledge-library-'));
  const cache = join(root, 'cache');
  const target = process.platform === 'darwin' ? 'darwin-arm64' : `${process.platform}-${process.arch}-gnu`;
  const native = resolve(`node_modules/@lancedb/lancedb-${target}/lancedb.${target}.node`);
  await mkdir(join(cache, 'lancedb-engine', '0.39.0'), { recursive: true });
  await symlink(native, join(cache, 'lancedb-engine', '0.39.0', `lancedb.${target}.node`));
  return { root, cache };
}

function store(root, cache) { return new KnowledgeStore(root, { cachePath: cache }); }

async function upload(receiver, name, text, tagId) {
  const bytes = Buffer.from(text);
  await receiver.begin(name, bytes.length, tagId);
  await receiver.chunk(bytes.toString('base64'));
  return receiver.finish();
}

test('managed copy paths follow the library directory while external ones are left alone', () => {
  assert.equal(rebaseImportPath('/old/root/imports/tag/file.md', '/new/root'), join('/new/root', 'imports', 'tag', 'file.md'));
  assert.equal(rebaseImportPath('/old/root/imports/aa/bb/c.pdf', '/new/root'), join('/new/root', 'imports', 'aa', 'bb', 'c.pdf'));
  if (process.platform === 'win32') {
    assert.equal(rebaseImportPath('C:\\old\\root\\imports\\tag\\f.md', 'D:\\new'), join('D:\\new', 'imports', 'tag', 'f.md'));
  }
  assert.equal(rebaseImportPath('/home/me/Documents/notes.md', '/new/root'), null);
  assert.equal(rebaseImportPath('/old/imports/../escape.md', '/new/root'), null);
  assert.equal(rebaseImportPath('imports/only-tail.md', '/new/root'), join('/new/root', 'imports', 'only-tail.md'));
});

test('moving a library relocates data, rewrites stored paths and keeps searches working', async () => {
  const { root, cache } = await sandbox();
  try {
    const first = join(root, 'first');
    const second = join(root, 'nas', 'second');
    const store1 = store(first, cache);
    const tag = await store1.createTag('Research');
    const receiver = new UploadReceiver(first, store1);
    await upload(receiver, 'managed.md', '# Managed\n\nA violet Finch keeps notes in the library.', tag.id);
    const external = join(root, 'external.md');
    await writeFile(external, '# External\n\nOriginal file outside the library.');
    await store1.importFile(external, 'external.md');
    const originalManaged = (await store1.list()).find((doc) => doc.name === 'managed.md').path;
    const before = await inspectLibrary(first);
    assert.equal(before.documents, 2);
    assert.equal(before.tags, 1);
    assert.equal(before.managed, 1);
    assert.equal(before.missing, 0);

    const moved = await relocateLibrary(store1, second);
    assert.deepEqual(moved, { ...before, missing: 0 });

    const copy = new DatabaseSync(join(second, 'catalog.sqlite'));
    const paths = copy.prepare('SELECT path FROM documents ORDER BY name').all().map((row) => row.path);
    copy.close();
    assert.equal(paths.length, 2);
    assert.equal(paths[0], external, 'external originals stay where they are');
    assert.equal(paths[1], originalManaged.replace(first, second), 'the managed copy now points into the new root');
    assert.equal(paths[1].startsWith(second), true);
    assert.equal(paths[1].startsWith(first), false);
    assert.equal((await stat(paths[1])).isFile(), true);
    assert.equal(await readFile(paths[1], 'utf8'), '# Managed\n\nA violet Finch keeps notes in the library.');

    // The live store is closed before the new one opens, exactly as the runtime swap does.
    await store1.close();
    const reopened = store(second, cache);
    assert.equal((await reopened.list()).length, 2);
    assert.equal((await reopened.tags()).find((item) => item.id === tag.id).count, 1);
    assert.match((await reopened.search('violet Finch', 3))[0].name, /managed\.md/);
    assert.match((await reopened.search('outside the library', 3))[0].name, /external\.md/);
    await reopened.close();
    // The source directory is never touched by a move.
    assert.equal(await hasLibrary(first), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a new library starts empty, and an existing one is adopted with its paths repaired', async () => {
  const { root, cache } = await sandbox();
  try {
    const source = join(root, 'source');
    const fresh = join(root, 'fresh');
    const opened = join(root, 'opened');
    const original = store(source, cache);
    const tag = await original.createTag('Work');
    await upload(new UploadReceiver(source, original), 'report.md', '# Report\n\nQuarterly numbers.', tag.id);
    const [doc] = await original.list();

    await createEmptyLibrary(fresh);
    assert.equal(await hasLibrary(fresh), true);
    assert.equal((await inspectLibrary(fresh)).documents, 0);
    assert.equal((await original.list()).length, 1);

    // Simulate a library that arrived from another machine: same data, paths pointing at the old root.
    // The stale name is deliberately one that no copy here uses, so rebasing cannot find it by accident.
    await mkdir(join(opened, 'imports', tag.id), { recursive: true });
    await original.copyLibraryTo(opened);
    const stale = new DatabaseSync(join(opened, 'catalog.sqlite'));
    stale.prepare('UPDATE documents SET path = ? WHERE id = ?').run(join('/somewhere/else', 'imports', tag.id, 'offline-copy.md'), doc.id);
    stale.close();
    assert.equal((await inspectLibrary(opened)).missing, 1);
    const adopted = await adoptExistingLibrary(opened);
    assert.equal(adopted.documents, 1);
    assert.equal(adopted.missing, 1, 'the placeholder copy was never written, so it stays reported as missing');

    await writeFile(join(opened, 'imports', tag.id, 'offline-copy.md'), '# Report\n\nQuarterly numbers.');
    const repaired = await adoptExistingLibrary(opened);
    assert.equal(repaired.missing, 0);
    await original.close();
    const reopened = store(opened, cache);
    assert.match((await reopened.search('Quarterly numbers', 3))[0].name, /report\.md/);
    await reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('target validation refuses nesting, duplicates and the wrong kind of folder', async () => {
  const { root, cache } = await sandbox();
  try {
    const current = join(root, 'current');
    await createEmptyLibrary(current);
    const store1 = store(current, cache);
    await store1.createTag('Keep');
    await createEmptyLibrary(join(root, 'populated'));
    await writeFile(join(root, 'occupied.txt'), 'x');
    await mkdir(join(root, 'notEmpty'));
    await writeFile(join(root, 'notEmpty', 'stray.txt'), 'x');
    await assert.rejects(assertUsableTarget(current, current), /already the working library/);
    await assert.rejects(assertUsableTarget(join(current, 'inner'), current), /contain or sit inside/);
    await assert.rejects(assertUsableTarget(current, join(current, 'inner')), /contain or sit inside/);
    await assert.rejects(assertUsableTarget(join(root, 'occupied.txt'), current), /not a file/);
    await assert.rejects(assertUsableTarget(join(root, 'notEmpty'), current), /neither a library nor empty/);
    assert.equal(await assertUsableTarget(join(root, 'unborn'), current), join(root, 'unborn'));
    // A folder that already holds a library is a valid target: that is the "open it" half.
    assert.equal(await assertUsableTarget(join(root, 'populated'), current), join(root, 'populated'));
    await store1.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a closed store releases its handles so the same process can reopen elsewhere', async () => {
  const { root, cache } = await sandbox();
  try {
    const one = join(root, 'one');
    const two = join(root, 'two');
    const first = store(one, cache);
    await first.createTag('Alpha');
    await first.close();
    const second = store(two, cache);
    await second.createTag('Beta');
    assert.equal((await second.tags()).length, 2);
    await second.close();
    // The original directory still opens independently afterwards.
    const again = store(one, cache);
    const tags = await again.tags();
    assert.equal(tags.length, 2);
    assert.equal(tags.find((tag) => tag.name === 'Alpha').count, 0);
    await again.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the chosen folder alone decides between opening and copying', async () => {
  const root = await mkdtemp(join(tmpdir(), 'finch-knowledge-choose-'));
  try {
    const empty = join(root, 'fresh');
    const existing = join(root, 'already');
    await mkdir(empty, { recursive: true });
    await createEmptyLibrary(existing);
    const elsewhere = join(root, 'current');

    // An empty folder becomes the library's new home; a folder with a library is opened as it is.
    assert.equal(await resolveLibraryAction(empty), 'move');
    assert.equal(await resolveLibraryAction(existing), 'open');
    assert.equal(await assertUsableTarget(empty, elsewhere), resolve(empty));
    assert.equal(await assertUsableTarget(existing, elsewhere), resolve(existing));
    // A non-empty folder that holds no library can never receive one silently.
    const messy = join(root, 'messy');
    await mkdir(messy, { recursive: true });
    await writeFile(join(messy, 'notes.txt'), 'hello');
    await assert.rejects(() => assertUsableTarget(messy, elsewhere), /neither a library nor empty/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a fresh library moves into an empty folder without any engine present', async () => {
  const root = await mkdtemp(join(tmpdir(), 'finch-knowledge-move-fresh-'));
  try {
    const source = join(root, 'source');
    const target = join(root, 'target');
    await mkdir(target, { recursive: true });
    // A cache path with no engine: this must never be touched by a copy.
    const cache = join(root, 'cache');
    const store1 = new KnowledgeStore(source, { cachePath: cache });
    assert.equal((await store1.createTag('Ideas')).name, 'Ideas');
    await store1.close();

    const moved = store(source, cache);
    const stats = await relocateLibrary(moved, target);
    assert.equal(stats.documents, 0);
    assert.equal(stats.tags, 1, 'catalogue data travels with the copy');
    assert.equal(existsSync(join(target, 'catalog.sqlite')), true);
    assert.equal(existsSync(join(target, 'vectors.lance')), false, 'no vector store was invented');
    assert.equal(existsSync(join(cache, 'lancedb-engine')), false, 'the copy downloaded no engine');
    await moved.close();

    // The copy opens on its own and keeps the tag.
    const reopened = store(target, cache);
    assert.equal((await reopened.summary()).tags.length, 2, 'the default tag plus the copied one');
    await reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

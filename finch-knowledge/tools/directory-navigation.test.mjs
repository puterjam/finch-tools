import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { transform } from 'esbuild';
import { isLibraryScoped } from '../dist/index.js';
const source = (await readFile(new URL('../src/view.ts', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const { code } = await transform(source.slice(0, source.indexOf('\nmountStaticIcons();')).replace(/^import .*\n/gm, ''), { loader: 'ts' });
class Element {
  constructor() { this.children = []; this.attrs = {}; this.dataset = {}; this.style = {}; this.events = {}; this.scrollTop = 0; this.hidden = false; }
  get classList() { return { toggle: (name, on) => { const set = new Set((this.className ?? '').split(' ')); if (on) set.add(name); else set.delete(name); this.className = [...set].join(' '); }, add: name => { this.className = `${this.className ?? ''} ${name}`; } }; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(key, value) { this.attrs[key] = value; }
  addEventListener(name, fn) { this.events[name] = fn; }
  focus() {}
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.className?.split(' ').includes(selector.slice(1)) ? [child] : []), ...(child.querySelectorAll?.(selector) ?? [])]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
function fixture() {
  const elements = new Map(), requests = [];
  const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const context = createContext({ isLibraryScoped, window: { finch: { postMessage: message => requests.push(message) } }, document: { getElementById: element, createElement: () => new Element() }, URL, location: { href: 'http://localhost/view.html' }, iconForFile: () => 'text.svg', previewRoute: () => 'text', Element,
    ...Object.fromEntries(['Files', 'Folder', 'FolderOpen', 'ChevronRight', 'Circle', 'PenLine', 'Trash2', 'TagIcon', 'CircleCheck', 'CircleAlert', 'Loader', 'Eye', 'EllipsisVertical'].map(name => [name, name])),
  });
  runInContext(code, context);
  const run = script => runInContext(script, context);
  run("svg = () => new Element(); renderDocs = () => {}; libraryPath = '/library'; tags = [{ id: 'default', name: '', count: 3 }, { id: 'tag', name: 'Important', count: 2, color: 'red' }];");
  run("applyDirectories([{ path: '', parent: null, name: '', count: 4 }, { path: 'notes', parent: '', name: 'notes', count: 2 }, { path: 'notes/sub', parent: 'notes', name: 'sub', count: 1 }]); renderTags();");
  return { element, requests, run };
}

test('folder navigation sits above color tags and owns the unique All sources entry', async () => {
  const html = await readFile(new URL('../src/view.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('id="directories"') < html.indexOf('id="tags"'));
  assert.ok(html.indexOf('id="tags"') < html.indexOf('id="library-footer"'));
  const f = fixture();
  assert.equal(f.element('directories').querySelector('.directory-all').querySelector('.tag-count').textContent, '4', 'total is unique documents, not summed tag counts');
  assert.equal(f.element('tags').querySelectorAll('.tag-choice').length, 1);
  assert.equal(f.element('tags').querySelector('.tag-dot').style.backgroundColor, '#ec635d');
});

test('selecting folders and tags switches scope without conflating classifications and paths', () => {
  const f = fixture();
  f.run("selectDirectory('notes');");
  assert.equal(f.requests.at(-1).directory, 'notes'); assert.equal(f.requests.at(-1).tagId, null);
  assert.equal(f.element('library-title').textContent, 'notes');
  const custom = f.element('tags').querySelectorAll('.tag-choice')[0]; custom.events.click();
  assert.equal(f.requests.at(-1).directory, null); assert.equal(f.requests.at(-1).tagId, 'tag');
  assert.equal(f.element('library-title').textContent, 'Important');
  f.run('selectDirectory(null);');
  assert.equal(f.requests.at(-1).directory, null); assert.equal(f.requests.at(-1).tagId, null);
});

test('nested folders retain their own expansion and metadata refreshes retain tree scroll', () => {
  const f = fixture();
  assert.equal(f.element('directories').querySelectorAll('.directory-list')[1].hidden, true);
  f.element('directories').scrollTop = 150;
  f.run("expandedDirectories.add('notes'); renderDirectories();");
  assert.equal(f.element('directories').querySelectorAll('.directory-list')[1].hidden, false);
  assert.equal(f.element('directories').scrollTop, 150);
});

test('custom colors render safely while invalid colors retain the default gray', () => {
  const f = fixture();
  assert.equal(f.run("tagDot('#1A2b3c')").style.backgroundColor, '#1A2b3c');
  assert.equal(f.run("tagDot('url(https://example.test)')").style.backgroundColor, '#92969d');
  assert.equal(f.run("tagDot()").style.backgroundColor, '#92969d');
});

test('empty folders and tags retain neutral guidance instead of blank sections', () => {
  const f = fixture(); f.run('directories = []; tags = []; renderDirectories(); renderTags();');
  assert.match(f.element('directories').querySelector('.side-empty').textContent, /scanning/);
  assert.match(f.element('tags').querySelector('.side-empty').textContent, /create/);
  assert.equal(f.element('directories').querySelector('.directory-all').querySelector('.tag-count').textContent, '0');
});

test('tags have a capped natural height and both sections scroll independently', async () => {
  const css = await readFile(new URL('../src/view.css', import.meta.url), 'utf8');
  assert.match(css, /\.tags-section\s*\{[^}]*min-height:\s*min\(160px, 35%\)/);
  assert.match(css, /\.tags-section\s*\{[^}]*max-height:\s*min\(35%, 280px\)/);
  assert.match(css, /\.tags-section \.tag-list:has\(> \.side-empty\)\s*\{[^}]*align-items:\s*center;[^}]*justify-content:\s*center/);
  assert.match(css, /\.directories-section\s*\{[^}]*flex:\s*1/);
  assert.match(css, /\.directory-tree\s*\{[^}]*overflow:\s*auto/);
  assert.match(css, /\.tags-section \.tag-list\s*\{[^}]*overflow-y:\s*auto/);
  assert.doesNotMatch(css, /sidebar-splitter|folders-share/);
});

test('file rows show a basename and retain the relative path on hover', () => {
  const f = fixture();
  const row = f.run("buildRow({ id: 'doc', name: 'notes/sub/file.md', path: '/library/notes/sub/file.md', tags: ['tag'], chunks: 1, indexed_at: 0, added_at: 0, status: 'ready' });");
  const title = row.querySelector('.doc-title');
  assert.equal(title.textContent, 'file.md'); assert.equal(title.title, 'notes/sub/file.md');
  assert.equal(row.querySelector('.tag-dot').style.backgroundColor, '#ec635d');
});


test('a file-row badge selects that tag without opening the file or changing its classifications', () => {
  const f = fixture(); f.run("selectedDirectory='notes';");
  const row = f.run("buildRow({ id:'doc', name:'notes/file.md', path:'/library/notes/file.md', tags:['tag'], chunks:1, status:'ready', added_at:0, indexed_at:0 })");
  const badge = row.querySelector('.doc-tag'); let stopped = false;
  assert.equal(badge.type, 'button');
  badge.events.click({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true); assert.equal(f.requests.at(-1).type, 'page');
  assert.equal(f.requests.at(-1).tagId, 'tag'); assert.equal(f.requests.at(-1).directory, null);
  assert.equal(f.element('library-title').textContent, 'Important');
  assert.equal(f.requests.some(request => ['reveal','preview','tagToggle','tagDelete'].includes(request.type)), false);
});

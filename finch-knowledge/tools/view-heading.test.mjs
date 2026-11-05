import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { transform } from 'esbuild';

const source = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8');
const declarations = source.slice(0, source.indexOf('\nmountStaticIcons();')).replace(/^import .*\r?\n/gm, '');
const { code } = await transform(declarations, { loader: 'ts' });

test('the restored localized headline stays fixed when the source directory changes', async () => {
  for (const locale of ['zh-CN', 'en-US']) {
    const { ui } = JSON.parse(await readFile(new URL(`../i18n/${locale}.json`, import.meta.url), 'utf8'));
    const elements = new Map();
    const element = id => {
      if (!elements.has(id)) elements.set(id, { attrs: {}, replaceChildren() {}, classList: { toggle() {} }, setAttribute(key, value) { this.attrs[key] = value; } });
      return elements.get(id);
    };
    const context = createContext({ window: { finch: {} }, document: { getElementById: element }, localized: ui });
    runInContext(code, context);
    runInContext('copy = { ...english, ...localized };', context);
    for (const path of ['E:\\knowledge', 'D:\\资料目录', '/home/user/notes']) {
      context.nextPath = path;
      runInContext('libraryPath = nextPath; updateLibrary();', context);
      assert.equal(element('heading').textContent, ui.heading);
      assert.equal(element('heading').attrs.title, ui.heading);
      assert.equal(element('library-path').textContent, path);
    }
    if (locale === 'zh-CN') assert.equal(ui.heading, '让自己的知识，随时可查。');
  }
});

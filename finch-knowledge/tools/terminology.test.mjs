import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';

const root = new URL('../', import.meta.url);
const load = path => readFile(new URL(path, root), 'utf8');
const zh = JSON.parse(await load('i18n/zh-CN.json'));
const en = JSON.parse(await load('i18n/en-US.json'));
const oldTerms = /分类|归类|\b(?:categor(?:y|ies|i[sz]\w*)|(?:un)?classif\w*)\b/i;
function strings(value, prefix = '') {
  if (typeof value === 'string') return [[prefix,value]];
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key,item]) => strings(item, `${prefix}.${key}`));
  return [];
}
function check(value, label) {
  for (const [key,text] of strings(value)) assert.doesNotMatch(text,oldTerms,`${label}${key}: ${text}`);
}

test('all localized copy uses tags across UI, tools, prompts and errors', () => {
  check(zh,'zh-CN'); check(en,'en-US');
  assert.equal(zh.ui.menuClassify,'标签'); assert.equal(en.ui.menuClassify,'Tags');
  assert.equal(zh.ui.noTags,undefined); assert.equal(en.ui.noTags,undefined);
  assert.doesNotMatch(zh['tool.tagDeleted'],/移入|移动/);
  assert.doesNotMatch(en['tool.tagDeleted'],/moved to/i);
});
test('fallback UI copy and manifest use the same tag vocabulary', async () => {
  const view = await load('src/view.ts');
  const start = view.indexOf('const english: Copy = {');
  const block = view.slice(start,view.indexOf('\n};',start)+3);
  const { code } = await transform(block,{loader:'ts'});
  const fallback = JSON.parse(runInNewContext(code+'\nJSON.stringify(english);'));
  check(fallback,'fallback'); check(JSON.parse(await load('finch.json')),'manifest');
});
test('README and Agent schema descriptions never present tags as categories', async () => {
  assert.doesNotMatch(await load('README.md'),oldTerms);
  const index = await load('src/index.ts');
  for (const match of index.matchAll(/description:\s*'((?:[^'\\]|\\.)*)'/g)) assert.doesNotMatch(match[1],oldTerms);
});
test('shared translation placeholders stay aligned after the terminology audit', () => {
  const english = new Map(strings(en));
  const placeholders = text => [...text.matchAll(/\{([a-zA-Z]+)\}/g)].map(match => match[1]).sort();
  for (const [key,text] of strings(zh)) if (english.has(key)) assert.deepEqual(placeholders(text),placeholders(english.get(key)),key);
});

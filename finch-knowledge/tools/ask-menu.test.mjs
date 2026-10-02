import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const html = await readFile(new URL('../src/view.html', import.meta.url), 'utf8');
const view = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/view.css', import.meta.url), 'utf8');
const index = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../finch.json', import.meta.url), 'utf8'));

test('App View has no assistant trigger, stale event listeners or protocol navigation', () => {
  assert.doesNotMatch(html, /id="ask(?:-label|-menu)?"/);
  assert.doesNotMatch(view, /byId\('ask|request\('ask'|askAssistant|renderAskMenu|finishAsk/);
  assert.doesNotMatch(css, /ask-menu|ask-trigger/);
  assert.doesNotMatch(index, /case 'ask'|openQuestionDraft|openHomeQuestionUri|finch:\/\/chat/);
  assert.match(html, /id="browse"/);
});

test('one book button is declared for the native Composer toolbar with matching locale overrides', async () => {
  assert.deepEqual(manifest.contributes.composerActions, [{ id: 'knowledge', icon: 'book', tooltip: 'Knowledge Base' }]);
  assert.match(index, /composerActions\.register\('knowledge'/);
  assert.equal(manifest.name, 'Knowledge Base');
  for (const locale of ['zh-CN', 'en-US']) {
    const copy = JSON.parse(await readFile(new URL(`../i18n/${locale}.json`, import.meta.url), 'utf8'));
    const name = locale === 'zh-CN' ? '知识库' : 'Knowledge Base';
    assert.equal(copy.name, name, 'the host display-name fallback must also match');
    assert.equal(copy['tool.title'], name);
    assert.equal(copy.composerActions.knowledge.tooltip, name);
    assert.equal(copy['composerActions.knowledge.tooltip'], undefined);
  }
});

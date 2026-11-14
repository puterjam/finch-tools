import type { Note, SearchProResult, SearchResultPage } from './client';
import type { Translate } from './errors';

/**
 * Render results as compact model-facing text.
 *
 * The server happily returns a multi-thousand-character `content` per result;
 * ten of those would blow past a useful context budget for no benefit, so
 * snippets are truncated by default and the long summary is opt-in.
 * All labels come from i18n — this module holds no literals of its own.
 */

export interface RenderOptions {
  /** Max characters kept from the standard snippet. */
  snippetChars?: number;
  /** Also include the long dynamic summary (`content`). */
  includeContent?: boolean;
  /** Max characters kept from `content` when included. */
  contentChars?: number;
  /** Append the untouched JSON body. */
  includeRaw?: boolean;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}

/** `2026-10-20 15:28:00` -> `2026-10-20` */
function shortDate(date: string): string {
  return date.split(' ')[0] ?? date;
}

export function renderPage(t: Translate, page: SearchResultPage, index: number, options: RenderOptions = {}): string {
  const lines: string[] = [];
  lines.push(`${index + 1}. ${page.title || t('page.untitled')}`);
  if (page.url) lines.push(`   ${t('page.url')}: ${page.url}`);

  const meta: string[] = [];
  if (page.site) meta.push(`${t('page.site')}: ${page.site}`);
  if (page.date) meta.push(`${t('page.date')}: ${shortDate(page.date)}`);
  if (typeof page.score === 'number') meta.push(`${t('page.score')}: ${page.score.toFixed(2)}`);
  if (typeof page.authorityLevel === 'number') meta.push(`${t('page.authority')}: ${page.authorityLevel}/5`);
  if (meta.length > 0) lines.push(`   ${meta.join(' · ')}`);

  if (page.passage) lines.push(`   ${t('page.passage')}: ${clip(page.passage, options.snippetChars ?? 300)}`);
  if (options.includeContent && page.content && page.content !== page.passage) {
    lines.push(`   ${t('page.content')}: ${clip(page.content, options.contentChars ?? 1200)}`);
  }
  const deeplinks = (page.deeplinks ?? []).filter((d) => d.url).slice(0, 10);
  if (deeplinks.length > 0) {
    const links = deeplinks.map((d) => `${d.title ?? t('page.deeplink')}: ${d.url}`).join(' | ');
    lines.push(`   ${t('page.deeplinks')}: ${links}`);
  }

  return lines.join('\n');
}

/** Notes about inputs that were adjusted before sending. */
export function renderNotes(t: Translate, notes: Note[]): string[] {
  return notes.map((note) => `! ${t(`warn.${note.key}`, note.params)}`);
}

export function renderResult(t: Translate, result: SearchProResult, options: RenderOptions = {}): string {
  const lines: string[] = [];
  lines.push(t('result.header', {
    query: result.query,
    version: result.version ?? '?',
    count: result.pages.length,
  }));

  lines.push(...renderNotes(t, result.notes));
  if (result.msg) lines.push(`! ${t('result.serverMsg', { msg: result.msg })}`);

  if (result.pages.length === 0) {
    lines.push('', t('result.empty'));
  } else {
    lines.push('');
    result.pages.forEach((page, i) => lines.push(renderPage(t, page, i, options)));
  }

  lines.push('', t('result.requestId', { requestId: result.requestId }));

  if (options.includeRaw) {
    lines.push('', t('result.raw'), result.rawJson);
  }

  return lines.join('\n');
}

/**
 * Turning a stored passage into one compact result line. Kept apart from the view so the windowing
 * and the highlighting can be tested directly — they are the parts that break silently.
 */

/** How much passage text survives on either side of the first hit. Two lines' worth, roughly. */
const BEFORE = 32;
const LENGTH = 180;

/**
 * The words a query is matched on: the whole query plus its own words, so "library location" counts
 * both the phrase and each word inside it. `minLength` is 2 for highlighting, which skips single
 * characters, and 1 for the search filter, where a one-character query still has to mean something.
 */
export function queryTerms(query: string, minLength = 2): string[] {
  const whole = query.trim();
  const terms = new Set<string>();
  if (whole.length >= minLength) terms.add(whole);
  for (const token of whole.split(/[^\p{L}\p{N}]+/u)) if (token.length >= minLength) terms.add(token);
  // Longest first, so an overlapping pair prefers the fuller phrase at the same position.
  return [...terms].sort((a, b) => b.length - a.length);
}

/** What a result row highlights; single characters are too common to be worth marking. */
export function highlightTerms(query: string): string[] {
  return queryTerms(query, 2);
}

export interface SnippetPart { text: string; hit: boolean }

/**
 * A two-line window of `text`, starting just before the first hit rather than at the passage start,
 * with every term marked. A leading ellipsis marks the trim; the trailing one is the CSS clamp's.
 */
export function snippetParts(text: string, terms: string[]): SnippetPart[] {
  const flat = text.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  let first = -1;
  for (const term of terms) {
    const index = lower.indexOf(term.toLowerCase());
    if (index >= 0 && (first < 0 || index < first)) first = index;
  }
  const start = first > BEFORE ? first - BEFORE : 0;
  const window = flat.slice(start, start + LENGTH);
  const haystack = window.toLowerCase();
  const parts: SnippetPart[] = [];
  const push = (value: string, hit: boolean) => { if (value) parts.push({ text: value, hit }); };
  if (start > 0) push('…', false);
  let cursor = 0;
  while (cursor < window.length) {
    let at = -1;
    let found = '';
    for (const term of terms) {
      const index = haystack.indexOf(term.toLowerCase(), cursor);
      if (index >= 0 && (at < 0 || index < at)) { at = index; found = term; }
    }
    if (at < 0) break;
    push(window.slice(cursor, at), false);
    push(window.slice(at, at + found.length), true);
    cursor = at + found.length;
  }
  push(window.slice(cursor), false);
  return parts;
}

/** The plain text of a snippet, which is what a caller comparing against the source wants. */
export function snippetText(parts: SnippetPart[]): string {
  return parts.map((part) => part.text).join('');
}

/**
 * Weaker terms to fall back on when nothing contains the query verbatim. A written phrase rarely
 * appears as such — a library that always says "知识" answers nothing for "知识库" — and a two-
 * character run is the smallest unit of Chinese that still carries meaning. Latin words are left
 * alone: their two-character fragments ("no", "on") appear in everything and would match anything.
 */
export function fallbackTerms(terms: string[]): string[] {
  const runs = new Set<string>();
  for (const term of terms) {
    if (term.length < 3 || !/^[\p{Script=Han}]+$/u.test(term)) continue;
    for (let at = 0; at + 2 <= term.length; at++) runs.add(term.slice(at, at + 2));
  }
  return [...runs];
}

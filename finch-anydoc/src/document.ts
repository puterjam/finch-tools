/**
 * Turns a converted Markdown document into model friendly slices.
 *
 * Documents vary wildly in shape: a contract is many short lines, while a
 * spreadsheet is a few hundred lines that are each hundreds of characters
 * wide. Paging by line count alone would blow up the context window on the
 * second case, so every slice is bounded by a character budget as well.
 */

/** Default characters returned per read. Roughly 10k tokens. */
export const DEFAULT_MAX_CHARS = 40_000;

/** Hard ceiling a caller may request. */
export const MAX_CHARS_LIMIT = 120_000;

/** Default number of lines returned per read. */
export const DEFAULT_MAX_LINES = 1_000;

export interface DocumentStats {
  totalLines: number;
  totalChars: number;
  headings: Heading[];
  tableLines: number;
}

export interface Heading {
  level: number;
  text: string;
  line: number;
}

export interface Slice {
  text: string;
  startLine: number;
  endLine: number;
  hasMore: boolean;
  truncatedLine: boolean;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*$/;

export function analyze(markdown: string): DocumentStats {
  const lines = markdown.split('\n');
  const headings: Heading[] = [];
  let tableLines = 0;

  lines.forEach((line, index) => {
    const match = HEADING.exec(line);
    if (match) {
      headings.push({
        level: match[1]!.length,
        // Inline emphasis around headings is noise in an outline.
        text: match[2]!.replace(/\*\*/g, '').replace(/^\*|\*$/g, '').trim(),
        line: index + 1,
      });
      return;
    }
    if (line.startsWith('|')) tableLines += 1;
  });

  return {
    totalLines: lines.length,
    totalChars: markdown.length,
    headings,
    tableLines,
  };
}

/**
 * Extracts a slice starting at a 1-indexed line, bounded by both a line count
 * and a character budget. A single oversized line is cut rather than dropped,
 * so a very wide spreadsheet row still yields readable output.
 */
export function slice(
  markdown: string,
  startLine: number,
  maxLines: number,
  maxChars: number,
): Slice {
  const lines = markdown.split('\n');
  const from = Math.max(1, Math.min(startLine, lines.length));
  const limit = Math.max(1, maxLines);
  const budget = Math.max(1_000, maxChars);

  const collected: string[] = [];
  let used = 0;
  let cursor = from;
  let truncatedLine = false;

  while (cursor <= lines.length && collected.length < limit) {
    const line = lines[cursor - 1] ?? '';
    const cost = line.length + 1;

    if (used + cost > budget) {
      // Never return an empty slice: cut the first line down to the budget.
      if (collected.length === 0) {
        collected.push(line.slice(0, budget));
        truncatedLine = true;
        cursor += 1;
      }
      break;
    }

    collected.push(line);
    used += cost;
    cursor += 1;
  }

  const endLine = cursor - 1;

  return {
    text: collected.join('\n'),
    startLine: from,
    endLine,
    hasMore: endLine < lines.length,
    truncatedLine,
  };
}

/** Renders an indented outline, or an honest explanation when there is none. */
export function renderOutline(stats: DocumentStats): string {
  if (stats.headings.length === 0) {
    const shape =
      stats.tableLines > 0
        ? `It is mostly tabular: ${stats.tableLines} of ${stats.totalLines} lines are table rows.`
        : 'It is flat text without heading markers.';
    return `This document has no headings. ${shape}\nUse action=read to page through it.`;
  }

  const top = Math.min(...stats.headings.map((h) => h.level));

  return stats.headings
    .map((h) => `${'  '.repeat(h.level - top)}${h.text}  (line ${h.line})`)
    .join('\n');
}

import type * as finch from 'finch';

import kbData from './kb.json';
import { search, type KbData } from './search.js';

const KB = kbData as unknown as KbData;

const MAX_EXCERPT_CHARS = 3500;

function text(message: string, isError = false): finch.ToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError,
  };
}

/** Render one retrieved chunk for the model to read. */
function renderResult(
  result: ReturnType<typeof search>[number],
  index: number,
  total: number,
): string {
  const heading = result.heading ? ` › ${result.heading}` : '';
  const snippet =
    result.text.length > MAX_EXCERPT_CHARS
      ? `${result.text.slice(0, MAX_EXCERPT_CHARS)}\n… (truncated)`
      : result.text;
  return (
    `【${index + 1}/${total}】${result.lang === 'zh' ? '中文' : 'English'} · ` +
    `${result.title}${heading} (source: ${result.doc})\n` +
    `${snippet}`
  );
}

export function activate(ctx: finch.MiniToolContext): void {
  // Custom container icon: lucide message-circle-question-mark (see package.json
  // contributes.iconPacks -> "helper-icons"; referenced as ext:message-circle-question).
  const iconPack = ctx.icons.register('helper-icons', {
    'message-circle-question': {
      svg:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/>' +
        '<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>' +
        '<path d="M12 17h.01"/>' +
        '</svg>',
    },
  });
  ctx.subscriptions.push(iconPack);

  const searchTool = ctx.tools.register({
    name: 'finch_help_search',
    title: 'Finch Help Search',
    description:
      'Search the official Finch documentation knowledge base (usage, features, mini tool development; docs and changelog in zh/en). ' +
      'Call this before answering any question about how Finch works, what it can do, how to develop a mini tool, or what a feature is called. ' +
      'Returns the most relevant documentation excerpts with their source page titles. ' +
      'Use the user\'s question or its key phrases as the query; ask again with different phrasing when the first search returns nothing useful.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The user\'s question about Finch, or its key phrases, e.g. "how do I create a scheduled task" or "记忆 和 space".',
        },
        max_results: {
          type: 'integer',
          description: 'How many excerpts to return (1–8). Default 5.',
          minimum: 1,
          maximum: 8,
        },
      },
      required: ['query'],
    },
    risk: 'low',
    async execute(input, exec) {
      const query = String(input.query ?? '').trim();
      if (!query) {
        return text('finch_help_search requires a non-empty `query`.', true);
      }
      const maxResults = Math.min(
        8,
        Math.max(1, Number.isFinite(input.max_results) ? Number(input.max_results) : 5),
      );

      exec.progress.report({ message: 'Searching Finch documentation…' });
      const results = search(KB, query, maxResults);

      if (results.length === 0) {
        return text(
          'No relevant documentation found for this query. ' +
            'Try rephrasing with different keywords, or answer from general knowledge and mark it as not from the official docs.',
        );
      }

      const parts = [
        `Found ${results.length} relevant excerpt${results.length > 1 ? 's' : ''} from the official Finch documentation. ` +
          'Answer the user based on these excerpts and cite the source titles when helpful.',
        '',
        ...results.map((r, i) => renderResult(r, i, results.length)),
      ];
      return text(parts.join('\n\n'));
    },
  });

  ctx.subscriptions.push(searchTool);

  ctx.logger.info(
    `Finch Help activated (knowledge base: ${KB.chunkCount} chunks from ${KB.source}, generated ${KB.generatedAt.slice(0, 10)})`,
  );
}

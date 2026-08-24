import type * as finch from 'finch';

import { statSync } from 'node:fs';
import { basename, extname, isAbsolute, resolve } from 'node:path';

import {
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_LINES,
  MAX_CHARS_LIMIT,
  analyze,
  renderOutline,
  slice,
  type DocumentStats,
} from './document.js';
import { ENGINE_VERSION, detectTarget, isEngineInstalled, loadEngine } from './engine.js';

const SUPPORTED_EXTENSIONS = [
  '.doc',
  '.docm',
  '.docx',
  '.dot',
  '.dotx',
  '.epub',
  '.odp',
  '.ods',
  '.odt',
  '.pdf',
  '.ppt',
  '.pptm',
  '.pptx',
  '.rtf',
  '.xls',
  '.xlsm',
  '.xlsx',
  '.csv',
  '.tsv',
];

interface ReadInput {
  action?: 'read' | 'outline';
  path?: string;
  offset?: number;
  limit?: number;
  max_chars?: number;
}

interface CacheEntry {
  key: string;
  markdown: string;
  stats: DocumentStats;
}

/**
 * Remembers the last few converted documents so an outline call followed by
 * several paged reads converts the file once instead of once per call.
 */
const conversions: CacheEntry[] = [];
const CACHE_SIZE = 4;

function remember(entry: CacheEntry): void {
  const existing = conversions.findIndex((item) => item.key === entry.key);
  if (existing !== -1) conversions.splice(existing, 1);
  conversions.unshift(entry);
  if (conversions.length > CACHE_SIZE) conversions.length = CACHE_SIZE;
}

function recall(key: string): CacheEntry | undefined {
  return conversions.find((item) => item.key === key);
}

function resolvePath(input: string, cwd: string | undefined): string {
  const trimmed = input.trim().replace(/^['"]|['"]$/g, '');
  const expanded = trimmed.startsWith('~/')
    ? resolve(process.env.HOME ?? '', trimmed.slice(2))
    : trimmed;
  if (isAbsolute(expanded)) return expanded;
  return resolve(cwd ?? process.cwd(), expanded);
}

function text(message: string, isError = false): finch.ToolResult {
  return { content: [{ type: 'text', text: message }], isError };
}

/** Rewrites engine errors into something the model can act on.
 *
 * Since engine 0.2 the binding rejects with an Error carrying a structured
 * `code`; the message-text matching below is only a fallback for older
 * binaries and unexpected shapes.
 */
const ENGINE_ERROR_CODES = [
  'unsupported',
  'malformed',
  'encrypted',
  'resourceLimit',
  'missingPart',
  'io',
] as const;

type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number];

function engineErrorCode(error: unknown): EngineErrorCode | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return ENGINE_ERROR_CODES.find((candidate) => candidate === code);
}

function explainFailure(error: unknown, path: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const name = basename(path);
  const code = engineErrorCode(error);

  if (code === 'encrypted' || message.includes('password') || message.includes('encrypted')) {
    return `"${name}" is password protected. Ask the user for an unprotected copy.`;
  }

  if (code === 'unsupported' || message.includes('unrecognized file content')) {
    // A .pdf that fails as unsupported was recognized as a PDF but has no
    // extractable text, i.e. it is a scan; anything else was not understood.
    if (code === 'unsupported' && extname(path).toLowerCase() === '.pdf') {
      return (
        `"${name}" is a scanned or image-only PDF, so it contains no extractable text. ` +
        'AnyDoc cannot read it without OCR. Ask the user for a text-based copy, or use an OCR service.'
      );
    }

    return (
      `"${name}" is not a document format AnyDoc understands. ` +
      'If it is plain text, Markdown, JSON, code or a PDF with selectable text, use the built-in Read tool instead. ' +
      `Supported here: ${SUPPORTED_EXTENSIONS.join(' ')}.`
    );
  }

  if (code === 'malformed' || code === 'missingPart') {
    return (
      `"${name}" is structurally unusable: no meaningful content could be extracted. ` +
      'The file is likely damaged, truncated, or not really a document. Ask the user to verify the file.'
    );
  }

  if (code === 'resourceLimit') {
    return (
      `"${name}" crossed the engine safety limit (decompression, nesting or node count). ` +
      'Ask the user for a smaller export of the same content.'
    );
  }

  if (code === 'io') {
    return `AnyDoc could not read "${name}": ${message}. Check the file still exists and is readable.`;
  }

  return `Failed to read "${name}": ${message}`;
}

export function activate(ctx: finch.MiniToolContext): void {
  const t = (key: string, values?: Record<string, string | number>) => ctx.i18n.t(key, values);

  const readDocument = ctx.tools.register({
    name: 'anydoc_read_document',
    title: 'Read Document',
    description: `Read Word, Excel, PowerPoint, OpenDocument, RTF, EPUB, CSV and PDF files as clean Markdown.
Use this instead of writing conversion scripts, and instead of the built-in Read tool, for these formats:
doc docm docx dot dotx odt rtf | xls xlsm xlsx ods csv tsv | ppt pptm pptx odp | pdf epub
action:
  read    — return the document as Markdown, paged with offset/limit (default)
  outline — return the heading structure plus size stats, without the body
Call action=outline first on large or unfamiliar documents, then action=read with an offset to page to the part you need.
Tables, headings, lists, footnotes and speaker notes are preserved. Scanned image-only PDFs are not supported because they need OCR.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'outline'],
          description: 'Defaults to read.',
        },
        path: {
          type: 'string',
          description: 'Path to the document. Absolute, or relative to the working directory.',
        },
        offset: {
          type: 'number',
          description: '1-indexed line to start reading from. Use the next_offset from a previous call.',
        },
        limit: {
          type: 'number',
          description: `Maximum lines to return. Defaults to ${DEFAULT_MAX_LINES}.`,
        },
        max_chars: {
          type: 'number',
          description: `Maximum characters to return. Defaults to ${DEFAULT_MAX_CHARS}, hard limit ${MAX_CHARS_LIMIT}. Wide spreadsheets hit this before the line limit.`,
        },
      },
      required: ['path'],
    },
    risk: 'low',
    defaultEnabled: true,
    async execute(rawInput, exec) {
      const input = (rawInput ?? {}) as ReadInput;
      const action = input.action ?? 'read';

      if (!input.path || typeof input.path !== 'string') {
        return text('path is required.', true);
      }

      const path = resolvePath(input.path, exec.cwd);

      let fileStat;
      try {
        fileStat = statSync(path);
      } catch {
        return text(`No such file: ${path}`, true);
      }

      if (fileStat.isDirectory()) {
        return text(`${path} is a directory, not a document.`, true);
      }

      const extension = extname(path).toLowerCase();
      if (extension && !SUPPORTED_EXTENSIONS.includes(extension)) {
        return text(
          `AnyDoc does not handle "${extension}" files. Use the built-in Read tool for text, Markdown, JSON or code. ` +
            `AnyDoc handles: ${SUPPORTED_EXTENSIONS.join(' ')}.`,
          true,
        );
      }

      const cacheKey = `${path}:${fileStat.mtimeMs}:${fileStat.size}`;
      let entry = recall(cacheKey);

      if (!entry) {
        let engine;
        try {
          engine = await loadEngine(ctx.storagePath, (message, percent) =>
            exec.progress.report({ stage: 'engine', message: t(engineProgressKey(message)), percent }),
          );
        } catch (error) {
          // engine.ts already phrases these for the user; do not wrap them again.
          return text(error instanceof Error ? error.message : String(error), true);
        }

        if (exec.signal?.aborted) return text('Cancelled.', true);

        exec.progress.report({ stage: 'reading', message: t('progress.reading') });

        let markdown: string;
        try {
          markdown = await engine.toMarkdown(path);
        } catch (error) {
          return text(explainFailure(error, path), true);
        }

        entry = { key: cacheKey, markdown, stats: analyze(markdown) };
        remember(entry);
      }

      const { markdown, stats } = entry;
      const label = `${basename(path)} · ${stats.totalLines} lines · ${stats.totalChars} chars`;

      if (action === 'outline') {
        return text(`Outline of ${label}\n\n${renderOutline(stats)}`);
      }

      const maxChars = Math.min(
        Math.max(1_000, Number(input.max_chars) || DEFAULT_MAX_CHARS),
        MAX_CHARS_LIMIT,
      );
      const maxLines = Math.max(1, Number(input.limit) || DEFAULT_MAX_LINES);
      const startLine = Math.max(1, Number(input.offset) || 1);

      if (startLine > stats.totalLines) {
        return text(
          `offset ${startLine} is past the end of ${basename(path)} (${stats.totalLines} lines).`,
          true,
        );
      }

      const page = slice(markdown, startLine, maxLines, maxChars);

      const header = [`${label} · showing lines ${page.startLine}-${page.endLine}`];
      if (page.truncatedLine) {
        header.push('One very wide line was cut to fit max_chars; raise max_chars to see the rest.');
      }
      if (page.hasMore) {
        header.push(`More content follows. Continue with offset=${page.endLine + 1}.`);
      }

      return text(`${header.join('\n')}\n\n${page.text}`);
    },
  });

  ctx.subscriptions.push(readDocument);

  ctx.logger.info(
    `AnyDoc activated (engine ${ENGINE_VERSION}, target ${detectTarget() ?? 'unsupported'}, installed: ${
      isEngineInstalled(ctx.storagePath) ? 'yes' : 'no'
    })`,
  );
}

/** Maps an engine progress message to a localizable key. */
function engineProgressKey(message: string): string {
  if (message.startsWith('Locating')) return 'progress.locating';
  if (message.startsWith('Downloading')) return 'progress.downloading';
  if (message.startsWith('Verifying')) return 'progress.verifying';
  if (message.startsWith('Unpacking')) return 'progress.unpacking';
  return 'progress.reading';
}

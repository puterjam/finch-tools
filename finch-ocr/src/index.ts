import type * as finch from 'finch';

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import {
  ENGINE_VERSION,
  clearEngineCache,
  detectTarget,
  isEngineInstalled,
  loadEngine,
} from './engine.js';
import {
  clearModelCache,
  guessIsUrl,
  runOcr,
  type DetectResult,
  type OcrResult,
  type RecognizeResult,
} from './ocr.js';

interface OcrInput {
  action?: 'recognize' | 'detect' | 'status' | 'clear_cache';
  path?: string;
  json?: boolean;
  model?: string;
  min_confidence?: number;
}

function text(message: string, isError = false): finch.ToolResult {
  return { content: [{ type: 'text', text: message }], isError };
}

function resolveSource(input: string, cwd: string | undefined): string {
  const trimmed = input.trim().replace(/^['"]|['"]$/g, '');
  if (guessIsUrl(trimmed)) return trimmed;

  const expanded = trimmed.startsWith('~/')
    ? resolve(process.env.HOME ?? '', trimmed.slice(2))
    : trimmed;
  return isAbsolute(expanded) ? expanded : resolve(cwd ?? process.cwd(), expanded);
}

/** `recognize --json` returns `{ text, lines: [[{text, box, confidence}], ...] }`. */
function summarizeText(result: RecognizeResult): string {
  if (typeof result.text === 'string' && result.text.trim()) return result.text;

  if (Array.isArray(result.lines) && result.lines.length > 0) {
    return result.lines
      .flat()
      .map((box) => box.text)
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join('\n');
  }

  return '';
}

/** `detect --json` returns a bare array of `{x, y, width, height}` boxes. */
function summarizeBoxes(result: DetectResult): string {
  const count = Array.isArray(result) ? result.length : 0;
  return `${count} text region(s) detected.`;
}

export function activate(ctx: finch.MiniToolContext): void {
  const t = (key: string, values?: Record<string, string | number>) => ctx.i18n.t(key, values);

  const readImage = ctx.tools.register({
    name: 'ocr_read_image',
    title: 'OCR Read Image',
    description: `Recognize text in an image using a local, fully offline OCR engine (ppu-paddle-ocr). No image data is sent to any AI/cloud API.
action:
  recognize   — (default) run detection + recognition, return the recognized text (or structured JSON with json=true)
  detect      — run detection only, return the bounding boxes of text regions without recognizing characters
  status      — report whether the engine binary for this OS/arch is downloaded and cached
  clear_cache — remove the cached engine binary and its OCR model cache, forcing a fresh download next time
path is required for recognize/detect: a local absolute/relative file path, or an http(s) image URL — both are accepted directly by the engine.
The first recognize/detect call on a machine downloads a platform-specific engine binary (tens of MB, once) and a small OCR model (a few MB, once); everything after that runs locally with no further network access.
There is currently no engine build for Intel-based macOS (darwin x64) — Apple Silicon Macs, Linux x64/arm64 and Windows x64 are supported.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['recognize', 'detect', 'status', 'clear_cache'],
          description: 'Defaults to recognize.',
        },
        path: {
          type: 'string',
          description: 'Local image path or http(s) image URL. Required for recognize/detect.',
        },
        json: {
          type: 'boolean',
          description:
            'For recognize/detect: return the full structured JSON (per-line boxes and confidence for recognize; bounding boxes for detect) instead of plain text.',
        },
        model: {
          type: 'string',
          description:
            'Optional catalogue model preset, e.g. "v6-tiny" (default), "v6-small", "v5-en-mobile", "v5-thai-mobile".',
        },
        min_confidence: {
          type: 'number',
          description: 'Optional confidence filter (0-1) for recognize. Engine default is 0.5.',
        },
      },
      required: ['action'],
    },
    risk: 'low',
    defaultEnabled: true,
    async execute(rawInput, exec) {
      const input = (rawInput ?? {}) as OcrInput;
      const action = input.action ?? 'recognize';

      if (action === 'status') {
        const target = detectTarget();
        if (!target) {
          return text(
            `Unsupported platform ${process.platform}/${process.arch}. No ppu-paddle-ocr engine build is published for it (Intel macOS is not yet supported upstream).`,
          );
        }
        const installed = isEngineInstalled(ctx.storagePath);
        return text(
          `Engine v${ENGINE_VERSION} for ${target.assetPlatform}: ${
            installed ? 'installed and cached locally.' : 'not downloaded yet — the next recognize/detect call will fetch it.'
          }`,
        );
      }

      if (action === 'clear_cache') {
        try {
          if (isEngineInstalled(ctx.storagePath)) {
            const binaryPath = await loadEngine(ctx.storagePath);
            await clearModelCache(binaryPath).catch(() => {
              // Best effort — the engine binary is about to be deleted anyway.
            });
          }
        } finally {
          clearEngineCache(ctx.storagePath);
        }
        return text('Cleared the cached OCR engine binary and model cache.');
      }

      if (!input.path || typeof input.path !== 'string') {
        return text('path is required for recognize/detect.', true);
      }

      const source = resolveSource(input.path, exec.cwd);
      const isUrl = guessIsUrl(source);

      if (!isUrl) {
        if (!existsSync(source)) return text(`No such file: ${source}`, true);
        if (statSync(source).isDirectory()) return text(`${source} is a directory, not an image.`, true);
      }

      let binaryPath: string;
      try {
        binaryPath = await loadEngine(ctx.storagePath, (message, percent) =>
          exec.progress.report({ message: t(engineProgressKey(message)), percent }),
        );
      } catch (error) {
        return text(error instanceof Error ? error.message : String(error), true);
      }

      if (exec.signal?.aborted) return text('Cancelled.', true);

      let result: OcrResult;
      try {
        result = await runOcr(binaryPath, {
          command: action,
          source,
          model: input.model,
          minConfidence: input.min_confidence,
          timeoutMs: 60_000,
        });
      } catch (error) {
        return text(error instanceof Error ? error.message : String(error), true);
      }

      if (input.json) {
        return text(JSON.stringify(result, null, 2));
      }

      if (action === 'detect') {
        return text(summarizeBoxes(result as DetectResult));
      }

      const recognized = summarizeText(result as RecognizeResult);
      return text(recognized || '(no text detected)');
    },
  });

  ctx.subscriptions.push(readImage);

  ctx.logger.info(
    `OCR activated (engine ${ENGINE_VERSION}, target ${
      detectTarget()?.assetPlatform ?? 'unsupported'
    }, installed: ${isEngineInstalled(ctx.storagePath) ? 'yes' : 'no'})`,
  );
}

function engineProgressKey(message: string): string {
  if (message.startsWith('Locating')) return 'progress.locating';
  if (message.startsWith('Downloading')) return 'progress.downloading';
  if (message.startsWith('Verifying')) return 'progress.verifying';
  if (message.startsWith('Unpacking')) return 'progress.unpacking';
  if (message.startsWith('Clearing')) return 'progress.clearing_quarantine';
  return message;
}

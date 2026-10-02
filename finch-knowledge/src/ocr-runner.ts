/**
 * Thin wrapper around the ppu-paddle-ocr standalone binary. Recognized text
 * goes to stdout as JSON; progress/logs go to stderr, so parsing stdout is
 * safe even while the engine is chatty.
 */

import { execFile } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 64 * 1024 * 1024; // 64 MB — generous for batch/JSON output

export interface OcrBox {
  text?: string;
  confidence?: number;
  /** `detect` returns `{x, y, width, height}` boxes; recognize groups them per line. */
  box?: { x: number; y: number; width: number; height: number } | number[][];
  [key: string]: unknown;
}

/** `recognize --json` shape: full text plus per-line boxes (each line is itself an array). */
export interface RecognizeResult {
  text?: string;
  lines?: OcrBox[][];
  [key: string]: unknown;
}

/** `detect --json` returns a bare array of boxes, no wrapper object. */
export type DetectResult = Array<{ x: number; y: number; width: number; height: number }>;

export type OcrResult = RecognizeResult | DetectResult;

export interface RunOptions {
  /** "recognize" or "detect". */
  command: 'recognize' | 'detect';
  /** Local file path or http(s) URL — the engine accepts both directly. */
  source: string;
  /** Catalogue model preset, e.g. "v6-tiny", "v5-en-mobile". */
  model?: string;
  minConfidence?: number;
  timeoutMs?: number;
}

function isLikelyUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** Runs `recognize`/`detect --json` and returns the parsed result. */
export async function runOcr(binaryPath: string, options: RunOptions): Promise<OcrResult> {
  const args = [options.command, options.source, '--json'];
  if (options.model) args.push('--model', options.model);
  if (typeof options.minConfidence === 'number') {
    args.push('--min-confidence', String(options.minConfidence));
  }

  const { stdout } = await execFilePromise(binaryPath, args, options.timeoutMs);

  const jsonText = extractJson(stdout);
  if (!jsonText) {
    throw new Error(`engine produced no JSON output: ${stdout.slice(0, 500) || '(empty)'}`);
  }

  try {
    return JSON.parse(jsonText) as OcrResult;
  } catch {
    throw new Error(`engine produced invalid JSON: ${jsonText.slice(0, 500)}`);
  }
}

/** Runs `clear-cache` to drop the engine's own downloaded OCR model cache. */
export async function clearModelCache(binaryPath: string): Promise<void> {
  await execFilePromise(binaryPath, ['clear-cache'], 30_000);
}

/** Runs `models --json` to list available catalogue presets. */
export async function listModels(binaryPath: string): Promise<unknown> {
  const { stdout } = await execFilePromise(binaryPath, ['models', '--json'], 15_000);
  const jsonText = extractJson(stdout);
  return jsonText ? JSON.parse(jsonText) : null;
}

function execFilePromise(
  command: string,
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
          // Exit codes per upstream docs: 0 success, 1 runtime error, 2 usage error.
          reject(
            new Error(
              `ppu-paddle-ocr ${args[0]} failed (${code ?? 'unknown'}): ${
                stderr.trim() || error.message
              }`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

/**
 * The engine is documented to send JSON to stdout and logs to stderr, but in
 * practice a first-run model download logs `[PaddleOcrService] Downloading
 * resource: ...` / `Cached at: ...` lines to stdout ahead of the JSON. The
 * JSON result itself is emitted as a single line (no --pretty), so scan from
 * the end and take the last line that looks like a JSON value.
 */
function extractJson(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  const lines = trimmed.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? '';
    if (line.startsWith('{') || line.startsWith('[')) return line;
  }

  return null;
}

export function guessIsUrl(source: string): boolean {
  return isLikelyUrl(source);
}

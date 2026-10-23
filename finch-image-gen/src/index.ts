import type * as finch from 'finch';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-image-2.5-sunburst';
const DEFAULT_QUALITY = 'auto';

const BASE_URL_STORAGE_KEY = 'baseUrl';
const API_KEY_STORAGE_KEY = 'openaiApiKey';
const MODEL_STORAGE_KEY = 'defaultModel';
const QUALITY_STORAGE_KEY = 'defaultQuality';

/**
 * Model ids offered in the settings menu. Anything else is forwarded verbatim so
 * relay/proxy endpoints can expose their own ids — only the shorthands below are
 * expanded, never guessed at.
 */
const MODEL_CHOICES: Array<{ id: string; label: string }> = [
  { id: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst — editing precision' },
  { id: 'gpt-image-2.5-flare', label: 'GPT Image 2.5 Flare — fast everyday generation' },
  { id: 'gpt-image-2', label: 'GPT Image 2 — previous generation' },
  { id: 'gpt-image-1.5', label: 'GPT Image 1.5 — legacy' },
];

const MODEL_ALIASES: Record<string, string> = {
  sunburst: 'gpt-image-2.5-sunburst',
  'gpt-image-sunburst': 'gpt-image-2.5-sunburst',
  flare: 'gpt-image-2.5-flare',
  'gpt-image-flare': 'gpt-image-2.5-flare',
  'gpt-image-2.5': 'gpt-image-2.5-sunburst',
  'gpt-image-2.5-sun': 'gpt-image-2.5-sunburst',
};

/** Resolve a user/AI-supplied model name to a concrete model id. */
export function resolveModel(raw: unknown, fallback: string = DEFAULT_MODEL): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) return fallback;
  return MODEL_ALIASES[value] ?? value;
}

// ── size ─────────────────────────────────────────────────────────────────────

/** Sizes the docs call out as popular; any other valid WxH is accepted too. */
export const SIZE_PRESETS = [
  'auto',
  '1024x1024',
  '1536x1024',
  '1024x1536',
  '2048x2048',
  '2048x1152',
  '2560x1440',
  '3840x2160',
  '2160x3840',
] as const;

const MIN_PIXELS = 655_360;
const MAX_PIXELS = 8_294_400;
const MAX_EDGE = 3_840;
const MAX_RATIO = 3;

export type SizeCheck = { ok: true; size: string } | { ok: false; error: string };

/**
 * GPT Image 2.x accepts arbitrary `WIDTHxHEIGHT` dimensions within a set of
 * constraints; validate locally so the caller gets an actionable message
 * instead of an opaque 400 from the API.
 */
export function checkSize(raw: unknown, fallback = 'auto'): SizeCheck {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) return { ok: true, size: fallback };
  if (value === 'auto') return { ok: true, size: 'auto' };

  const match = /^(\d{3,4})x(\d{3,4})$/.exec(value);
  if (!match) {
    return {
      ok: false,
      error: `size must be "auto" or WIDTHxHEIGHT (e.g. 1024x1024), got "${raw}"`,
    };
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const pixels = width * height;

  if (width % 16 !== 0 || height % 16 !== 0) {
    return { ok: false, error: `size ${width}x${height}: both edges must be multiples of 16` };
  }
  if (long > MAX_EDGE) {
    return { ok: false, error: `size ${width}x${height}: no edge may exceed ${MAX_EDGE}px` };
  }
  if (long / short > MAX_RATIO) {
    return { ok: false, error: `size ${width}x${height}: aspect ratio must not exceed 3:1` };
  }
  if (pixels < MIN_PIXELS || pixels > MAX_PIXELS) {
    return {
      ok: false,
      error: `size ${width}x${height}: total pixels must be between ${MIN_PIXELS} and ${MAX_PIXELS}`,
    };
  }
  return { ok: true, size: `${width}x${height}` };
}

// ── enums ────────────────────────────────────────────────────────────────────

const QUALITY_ENUM = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const BACKGROUND_ENUM = ['auto', 'opaque', 'transparent'] as const;
const FORMAT_ENUM = ['png', 'jpeg', 'webp'] as const;
const MODERATION_ENUM = ['auto', 'low'] as const;

type QualityOption = (typeof QUALITY_ENUM)[number];
type BackgroundOption = (typeof BACKGROUND_ENUM)[number];
type FormatOption = (typeof FORMAT_ENUM)[number];

const EXT_BY_FORMAT: Record<FormatOption, string> = { png: 'png', jpeg: 'jpg', webp: 'webp' };

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function pickEnum<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw.trim().toLowerCase())
    ? (raw.trim().toLowerCase() as T)
    : fallback;
}

function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'image/png';
}

function sanitizeName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const num = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : NaN;
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function isValidHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// ── errors ───────────────────────────────────────────────────────────────────

interface ApiErrorBody {
  message?: string;
  type?: string;
  code?: string;
  param?: string;
  moderation_details?: {
    moderation_stage?: string;
    categories?: string[];
  };
}

/**
 * Turn an OpenAI image error into something the model can act on. `error.code`
 * is the stable discriminator the docs recommend; moderation blocks additionally
 * carry a stage and coarse categories worth surfacing as a remediation hint.
 */
export function formatApiError(error: ApiErrorBody | undefined, statusLine: string): string {
  const parts: string[] = [];
  const message = error?.message?.trim();
  parts.push(message ? `${statusLine}: ${message}` : statusLine);
  if (error?.code) parts.push(`(code: ${error.code})`);
  if (error?.param) parts.push(`(param: ${error.param})`);

  const details = error?.moderation_details;
  const stage = details?.moderation_stage;
  const categories = details?.categories?.length ? details.categories.join(', ') : '';

  let hint = '';
  switch (error?.code) {
    case 'moderation_blocked':
      if (stage === 'input') hint = 'The prompt or an input image was blocked — reword the prompt or swap the reference image, then retry.';
      else if (stage === 'output') hint = 'A generated image was blocked — change the prompt and generate again.';
      else hint = 'This request did not meet safety requirements — reword the prompt and try again.';
      if (categories) hint += ` Categories: ${categories}.`;
      break;
    case 'image_generation_user_error':
      hint = 'This error needs a changed request (prompt, size or input images) — do not retry it unchanged.';
      break;
    case 'content_policy_violation':
      hint = 'Reword the prompt to describe neutral visual details before retrying.';
      break;
    default:
      break;
  }

  const status = Number(statusLine.split(' ')[0]);
  if (!hint && status === 401) hint = 'Check the API key (Composer toolbar → Image Gen settings → OpenAI API Key).';
  if (!hint && status === 403) {
    hint = 'The key lacks access to this model. GPT Image models may require OpenAI API organization verification.';
  }
  if (!hint && status === 429) hint = 'Rate limit or quota reached — wait a moment, or lower quality/size.';

  return hint ? `${parts.join(' ')}\n${hint}` : parts.join(' ');
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: ApiErrorBody };
    return formatApiError(body?.error, `${response.status} ${response.statusText}`);
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

// ── API calls ────────────────────────────────────────────────────────────────

interface OpenAiImageItem {
  b64_json?: string;
  url?: string;
}

interface OpenAiImageResponse {
  data?: OpenAiImageItem[];
  /** True when streaming never delivered a final image and we fell back to the last preview. */
  fromPartial?: boolean;
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

async function callGenerate(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<OpenAiImageResponse> {
  const response = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return (await response.json()) as OpenAiImageResponse;
}

async function callEdit(
  baseUrl: string,
  apiKey: string,
  fields: Record<string, string>,
  referenceImagePaths: string[],
  maskPath: string | undefined,
  signal?: AbortSignal,
): Promise<OpenAiImageResponse> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  for (const refPath of referenceImagePaths) {
    const buf = await fs.readFile(refPath);
    form.append('image[]', new Blob([buf], { type: mimeForPath(refPath) }), path.basename(refPath));
  }
  if (maskPath) {
    const buf = await fs.readFile(maskPath);
    form.append('mask', new Blob([buf], { type: mimeForPath(maskPath) }), path.basename(maskPath));
  }
  const response = await fetch(`${baseUrl}/images/edits`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: form,
    signal,
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return (await response.json()) as OpenAiImageResponse;
}

/**
 * Streaming generation. Only used when the caller asked for intermediate
 * previews: each `partial_image` event is handed to `onPartial` so the tool call
 * can show progress during a request that may run for minutes. The final image
 * is taken from whichever event carries it; if the endpoint never sends one, the
 * last preview is used rather than failing a request that already produced art.
 */
async function callGenerateStreaming(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onPartial: (index: number, buf: Buffer) => void,
): Promise<OpenAiImageResponse> {
  const response = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  if (!response.body) throw new Error('The endpoint did not return a streaming body.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let final: OpenAiImageItem | undefined;
  const partials: OpenAiImageItem[] = [];

  const handleEvent = (payload: string) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }
    if (event.error) throw new Error(formatApiError(event.error as ApiErrorBody, 'stream error'));
    const type = String(event.type ?? '');
    if (type.includes('partial_image') && typeof event.b64_json === 'string') {
      partials.push({ b64_json: event.b64_json });
      onPartial(partials.length, Buffer.from(event.b64_json, 'base64'));
      return;
    }
    if (Array.isArray(event.data) && event.data.length) {
      final = event.data[event.data.length - 1] as OpenAiImageItem;
    } else if (typeof event.b64_json === 'string') {
      final = { b64_json: event.b64_json };
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of block.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        handleEvent(payload);
      }
    }
  }

  if (final) return { data: [final] };
  if (partials.length) return { data: [partials[partials.length - 1]], fromPartial: true };
  return { data: [] };
}

// ── saving ───────────────────────────────────────────────────────────────────

async function saveImages(
  items: OpenAiImageItem[],
  outDir: string,
  namePrefix: string,
  extension: string,
): Promise<string[]> {
  await fs.mkdir(outDir, { recursive: true });
  const saved: string[] = [];
  const stamp = Date.now();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let buf: Buffer;
    if (item.b64_json) {
      buf = Buffer.from(item.b64_json, 'base64');
    } else if (item.url) {
      const res = await fetch(item.url);
      if (!res.ok) throw new Error(`Failed to download generated image: ${res.status} ${res.statusText}`);
      buf = Buffer.from(await res.arrayBuffer());
    } else {
      continue;
    }
    const filePath = path.join(outDir, `${namePrefix}-${stamp}-${i + 1}.${extension}`);
    await fs.writeFile(filePath, buf);
    saved.push(filePath);
  }
  return saved;
}

/**
 * Keep reporting progress on a fixed interval while `work` is in flight, so the
 * UI still shows a live "N s elapsed" status if the user leaves and returns to
 * the session mid-generation, instead of freezing on the first message.
 */
async function withHeartbeat<T>(
  work: Promise<T>,
  progress: finch.ToolProgress,
  stage: string,
  baseMessage: string,
  intervalMs = 4000,
): Promise<T> {
  const startedAt = Date.now();
  progress.report({ stage, message: baseMessage });
  const timer = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    progress.report({ stage, message: `${baseMessage} (${elapsed}s elapsed)` });
  }, intervalMs);
  try {
    return await work;
  } finally {
    clearInterval(timer);
  }
}

// ── tool input ───────────────────────────────────────────────────────────────

interface CreateImageInput {
  prompt: string;
  reference_image_paths?: string[];
  mask_path?: string;
  size?: string;
  quality?: string;
  background?: string;
  output_format?: string;
  output_compression?: number;
  moderation?: string;
  n?: number;
  partial_images?: number;
  model?: string;
  output_name?: string;
  base_url?: string;
  safety_identifier?: string;
}

export function activate(ctx: finch.MiniToolContext): void {
  const t = (key: string, values?: Record<string, string | number>) => ctx.i18n.t(key, values);

  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'image_gen_create',
      title: t('tool.title'),
      description: t('tool.description'),
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              'What to generate, or how to edit the reference image(s). Be specific about subject, style, composition, lighting and mood.',
          },
          reference_image_paths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Local absolute file paths of reference image(s) for image-to-image / reference-guided editing. Omit for plain text-to-image.',
          },
          mask_path: {
            type: 'string',
            description:
              'Optional local absolute path to a mask PNG marking the area to edit. Must have the same format and size as the reference image. Requires reference_image_paths.',
          },
          size: {
            type: 'string',
            description: `Output size. "auto" (default) or WIDTHxHEIGHT — popular: 1024x1024 (square), 1536x1024 (landscape), 1024x1536 (portrait), 2048x2048, 2048x1152, 2560x1440, 3840x2160. Custom sizes need multiples of 16, aspect ratio within 3:1, edges ≤3840px, total pixels 655360-8294400.`,
          },
          quality: {
            type: 'string',
            enum: QUALITY_ENUM as unknown as string[],
            description:
              'Quality/cost tradeoff: low (fast drafts), medium, high, xhigh, max (GPT Image 2.5 only), or auto (default).',
          },
          background: {
            type: 'string',
            enum: BACKGROUND_ENUM as unknown as string[],
            description:
              'auto (default), opaque, or transparent. Transparent needs output_format png (default) or webp.',
          },
          output_format: {
            type: 'string',
            enum: FORMAT_ENUM as unknown as string[],
            description: 'png (default, best quality), jpeg (fastest), or webp.',
          },
          output_compression: {
            type: 'number',
            minimum: 0,
            maximum: 100,
            description: 'Compression level 0-100 for jpeg/webp output only.',
          },
          moderation: {
            type: 'string',
            enum: MODERATION_ENUM as unknown as string[],
            description: 'auto (default, standard filtering) or low (less restrictive).',
          },
          n: {
            type: 'number',
            minimum: 1,
            maximum: 4,
            description: 'Number of images to generate, 1-4. Default 1.',
          },
          partial_images: {
            type: 'number',
            minimum: 0,
            maximum: 3,
            description:
              'Stream 1-3 low-resolution previews while generating (single image only) so progress stays visible on slow, high-quality requests. Costs a little extra. Default 0 (off).',
          },
          model: {
            type: 'string',
            description:
              'Image model id, e.g. "gpt-image-2.5-sunburst" (editing precision, default), "gpt-image-2.5-flare" (fast everyday), "gpt-image-2". Shorthands "sunburst" / "flare" also work. Omit to use the configured default.',
          },
          output_name: {
            type: 'string',
            description: 'Optional short file name prefix for the saved image(s), e.g. "poster". Letters, digits, - and _ only.',
          },
          base_url: {
            type: 'string',
            description: `One-off override of the API base URL for this call only (e.g. a proxy/relay endpoint), without changing the saved default. Must include the protocol, e.g. "https://your-proxy.example.com/v1". Omit to use the endpoint configured via the Composer's Image Gen settings button (default "${DEFAULT_BASE_URL}").`,
          },
          safety_identifier: {
            type: 'string',
            description:
              'Optional stable, privacy-preserving id for the end user on whose behalf this runs (hash a username or email, never send the raw value; ≤128 chars). Helps OpenAI abuse detection.',
          },
        },
        required: ['prompt'],
      },
      risk: 'medium',
      timeoutMs: 300000,
      progressMode: 'indeterminate',
      async execute(rawInput: Record<string, unknown>, exec: finch.ToolExecutionContext) {
        const input = rawInput as unknown as CreateImageInput;
        const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
        if (!prompt) {
          return { content: [{ type: 'text', text: 'prompt is required and cannot be empty.' }], isError: true };
        }

        const apiKey = (await exec.secrets.get('OPENAI_API_KEY')) || (await exec.storage.get<string>(API_KEY_STORAGE_KEY));
        if (!apiKey) {
          return {
            content: [
              {
                type: 'text',
                text: t('error.noKey'),
              },
            ],
            isError: true,
          };
        }

        const storedModel = await ctx.storage.get<string>(MODEL_STORAGE_KEY);
        const model = resolveModel(input.model, storedModel && storedModel.trim() ? storedModel.trim() : DEFAULT_MODEL);
        const storedQuality = await ctx.storage.get<string>(QUALITY_STORAGE_KEY);
        const quality = pickEnum(
          input.quality,
          QUALITY_ENUM,
          storedQuality && QUALITY_ENUM.includes(storedQuality as QualityOption)
            ? (storedQuality as QualityOption)
            : (DEFAULT_QUALITY as QualityOption),
        );

        const sizeCheck = checkSize(input.size);
        if (!sizeCheck.ok) {
          return { content: [{ type: 'text', text: sizeCheck.error }], isError: true };
        }
        const size = sizeCheck.size;

        const refPaths = Array.isArray(input.reference_image_paths)
          ? input.reference_image_paths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
          : [];
        const maskPath = typeof input.mask_path === 'string' && input.mask_path.trim() ? input.mask_path.trim() : undefined;
        if (maskPath && !refPaths.length) {
          return {
            content: [{ type: 'text', text: 'mask_path needs reference_image_paths — a mask only applies to an image edit.' }],
            isError: true,
          };
        }

        const n = clampInt(input.n, 1, 4, 1);
        const partialImages = clampInt(input.partial_images, 0, 3, 0);
        const background = pickEnum(input.background, BACKGROUND_ENUM, 'auto' as BackgroundOption);
        let format = pickEnum(input.output_format, FORMAT_ENUM, 'png' as FormatOption);
        if (background === 'transparent' && format === 'jpeg') format = 'png';
        const compression = clampInt(input.output_compression, 0, 100, -1);
        const moderation = pickEnum(input.moderation, MODERATION_ENUM, 'auto');
        const safetyIdentifier =
          typeof input.safety_identifier === 'string' ? input.safety_identifier.trim().slice(0, 128) : '';
        const namePrefix = sanitizeName(input.output_name || 'image-gen') || 'image-gen';

        let baseUrl = DEFAULT_BASE_URL;
        if (typeof input.base_url === 'string' && input.base_url.trim()) {
          if (!isValidHttpUrl(input.base_url)) {
            return { content: [{ type: 'text', text: `base_url is not a valid http(s) URL: ${input.base_url}` }], isError: true };
          }
          baseUrl = normalizeBaseUrl(input.base_url);
        } else {
          const configured = await ctx.storage.get<string>(BASE_URL_STORAGE_KEY);
          if (configured && configured.trim()) baseUrl = normalizeBaseUrl(configured);
        }

        // Only forward optional knobs the caller actually asked for: relays and
        // older models reject parameters they do not implement.
        const optional: Record<string, unknown> = {};
        if (input.background !== undefined && background !== 'auto') optional.background = background;
        if (input.output_format !== undefined) optional.output_format = format;
        if (compression >= 0 && (format === 'jpeg' || format === 'webp')) optional.output_compression = compression;
        if (input.moderation !== undefined && moderation !== 'auto') optional.moderation = moderation;
        if (safetyIdentifier) optional.safety_identifier = safetyIdentifier;

        try {
          for (const refPath of refPaths) await fs.access(refPath);
          if (maskPath) await fs.access(maskPath);

          const stage = refPaths.length ? 'editing' : 'generating';
          const baseMessage = refPaths.length ? t('progress.editing') : t('progress.generating');
          const outDir = path.join(ctx.storagePath, 'images');
          const previewDir = path.join(outDir, '.preview');
          const stream = partialImages > 0 && n === 1 && !refPaths.length;

          const result = await withHeartbeat(
            refPaths.length
              ? callEdit(
                  baseUrl,
                  apiKey,
                  { model, prompt, size, quality, n: String(n), ...optional },
                  refPaths,
                  maskPath,
                  exec.signal,
                )
              : stream
                ? callGenerateStreaming(
                    baseUrl,
                    apiKey,
                    { model, prompt, size, quality, n, partial_images: partialImages, ...optional },
                    exec.signal,
                    async (index, buf) => {
                      const previewPath = path.join(previewDir, `${namePrefix}-preview-${index}.png`);
                      await fs.mkdir(previewDir, { recursive: true });
                      await fs.writeFile(previewPath, buf);
                      exec.progress.report({
                        stage,
                        message: t('progress.preview', { index: String(index), total: String(partialImages) }),
                      });
                    },
                  )
                : callGenerate(baseUrl, apiKey, { model, prompt, size, quality, n, ...optional }, exec.signal),
            exec.progress,
            stage,
            baseMessage,
          );

          const items = result.data ?? [];
          if (!items.length) {
            return { content: [{ type: 'text', text: t('error.noImage') }], isError: true };
          }

          exec.progress.report({ stage: 'saving', message: t('progress.saving') });
          const savedPaths = await saveImages(items, outDir, namePrefix, EXT_BY_FORMAT[format]);
          if (stream) await fs.rm(previewDir, { recursive: true, force: true });

          const notes = [
            `model: ${model}`,
            `size: ${size}`,
            `quality: ${quality}`,
            `format: ${format}`,
            ...(background !== 'auto' ? [`background: ${background}`] : []),
            ...(moderation !== 'auto' ? [`moderation: ${moderation}`] : []),
            ...(refPaths.length ? [`references: ${refPaths.length}`] : []),
            ...(maskPath ? ['masked: yes'] : []),
          ];
          const lines = [
            `${t('result.generated', { count: String(savedPaths.length) })} via ${baseUrl}.`,
            `> ${notes.join(' · ')}`,
            ...(result.fromPartial ? [`! ${t('result.fromPartial')}`] : []),
            ...savedPaths,
          ];
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.logger.error(`image_gen_create failed: ${message}`);
          return { content: [{ type: 'text', text: `${t('error.failed')}\n${message}` }], isError: true };
        }
      },
    }),
  );

  ctx.subscriptions.push(
    ctx.composerActions.register('image-gen-settings', {
      async getMenu() {
        const storedBaseUrl = await ctx.storage.get<string>(BASE_URL_STORAGE_KEY);
        const effectiveBaseUrl = storedBaseUrl && storedBaseUrl.trim() ? normalizeBaseUrl(storedBaseUrl) : DEFAULT_BASE_URL;
        const hasKeychainKey = !!(await ctx.secrets.get('OPENAI_API_KEY'));
        const hasStoredKey = !!(await ctx.storage.get<string>(API_KEY_STORAGE_KEY));
        const keyStatus = hasKeychainKey || hasStoredKey ? t('status.configured') : t('status.notSet');
        const storedModel = await ctx.storage.get<string>(MODEL_STORAGE_KEY);
        const effectiveModel = storedModel && storedModel.trim() ? storedModel.trim() : DEFAULT_MODEL;
        const storedQuality = await ctx.storage.get<string>(QUALITY_STORAGE_KEY);
        const effectiveQuality = storedQuality && storedQuality.trim() ? storedQuality.trim() : DEFAULT_QUALITY;
        return [
          {
            id: 'set-api-key',
            label: t('menu.apiKey'),
            iconName: 'settings',
            description: keyStatus,
            hoverText: `${t('menu.apiKey.hint')} ${t('menu.current', { value: keyStatus })}`,
          },
          {
            id: 'set-model',
            label: t('menu.model'),
            iconName: 'image',
            description: effectiveModel,
            hoverText: t('menu.current', { value: effectiveModel }),
          },
          {
            id: 'set-quality',
            label: t('menu.quality'),
            iconName: 'sparkles',
            description: effectiveQuality,
            hoverText: t('menu.current', { value: effectiveQuality }),
          },
          {
            id: 'set-base-url',
            label: t('menu.baseUrl'),
            iconName: 'globe',
            description: effectiveBaseUrl,
            hoverText: `${t('menu.baseUrl.hint')} ${t('menu.current', { value: effectiveBaseUrl })}`,
          },
        ];
      },
      async execute(_actionCtx, itemId) {
        if (itemId === 'set-api-key') {
          const result = await ctx.ui.showModalDialog({
            title: t('menu.apiKey'),
            description: t('dialog.apiKey.desc'),
            fields: [
              {
                key: 'apiKey',
                label: t('menu.apiKey'),
                type: 'password',
                secret: true,
                placeholder: 'sk-...',
              },
            ],
            actions: [
              { id: 'cancel', label: t('dialog.cancel') },
              { id: 'save', label: t('dialog.save'), variant: 'primary' },
            ],
          });
          if (result.action !== 'save') return;
          const value = String(result.values?.apiKey ?? '').trim();
          if (!value) {
            await ctx.storage.delete(API_KEY_STORAGE_KEY);
            return;
          }
          await ctx.storage.set(API_KEY_STORAGE_KEY, value);
          return;
        }

        if (itemId === 'set-model') {
          const stored = await ctx.storage.get<string>(MODEL_STORAGE_KEY);
          const current = stored && stored.trim() ? stored.trim() : DEFAULT_MODEL;
          const result = await ctx.ui.showModalDialog({
            title: t('menu.model'),
            description: t('dialog.model.desc'),
            fields: [
              {
                key: 'model',
                label: t('menu.model'),
                type: 'select',
                default: current,
                options: MODEL_CHOICES.map((choice) => ({ value: choice.id, label: choice.label })),
              },
            ],
            actions: [
              { id: 'cancel', label: t('dialog.cancel') },
              { id: 'save', label: t('dialog.save'), variant: 'primary' },
            ],
          });
          if (result.action !== 'save') return;
          const value = String(result.values?.model ?? '').trim();
          if (!value) {
            await ctx.storage.delete(MODEL_STORAGE_KEY);
            return;
          }
          await ctx.storage.set(MODEL_STORAGE_KEY, value);
          return;
        }

        if (itemId === 'set-quality') {
          const stored = await ctx.storage.get<string>(QUALITY_STORAGE_KEY);
          const current = stored && stored.trim() ? stored.trim() : DEFAULT_QUALITY;
          const result = await ctx.ui.showModalDialog({
            title: t('menu.quality'),
            description: t('dialog.quality.desc'),
            fields: [
              {
                key: 'quality',
                label: t('menu.quality'),
                type: 'select',
                default: current,
                options: QUALITY_ENUM.map((value) => ({ value, label: value })),
              },
            ],
            actions: [
              { id: 'cancel', label: t('dialog.cancel') },
              { id: 'save', label: t('dialog.save'), variant: 'primary' },
            ],
          });
          if (result.action !== 'save') return;
          const value = String(result.values?.quality ?? '').trim();
          if (!value || value === DEFAULT_QUALITY) {
            await ctx.storage.delete(QUALITY_STORAGE_KEY);
            return;
          }
          await ctx.storage.set(QUALITY_STORAGE_KEY, value);
          return;
        }

        if (itemId === 'set-base-url') {
          const stored = await ctx.storage.get<string>(BASE_URL_STORAGE_KEY);
          const result = await ctx.ui.showModalDialog({
            title: t('menu.baseUrl'),
            description: t('dialog.baseUrl.desc', { default: DEFAULT_BASE_URL }),
            fields: [
              {
                key: 'baseUrl',
                label: t('menu.baseUrl'),
                type: 'text',
                placeholder: DEFAULT_BASE_URL,
                default: stored ?? '',
              },
            ],
            actions: [
              { id: 'cancel', label: t('dialog.cancel') },
              { id: 'save', label: t('dialog.save'), variant: 'primary' },
            ],
          });
          if (result.action !== 'save') return;
          const value = String(result.values?.baseUrl ?? '').trim();
          if (!value) {
            await ctx.storage.delete(BASE_URL_STORAGE_KEY);
            return;
          }
          if (!isValidHttpUrl(value)) {
            await ctx.ui.showModalDialog({
              title: t('dialog.invalidUrl.title'),
              message: t('dialog.invalidUrl.message', { value }),
              actions: [{ id: 'ok', label: t('dialog.ok'), variant: 'primary' }],
            });
            return;
          }
          await ctx.storage.set(BASE_URL_STORAGE_KEY, normalizeBaseUrl(value));
        }
      },
    }),
  );

  ctx.logger.info('image-gen activated');
}

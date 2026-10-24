import type * as finch from 'finch';
import { createHash } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAnnotations, type GalleryAnnotations } from './gallery-model';

/**
 * The pack id shared by the manifest declaration, the registration below and
 * every `ext:` reference. Declaring the pack in the manifest only reserves the
 * namespace: the SVGs themselves have to be registered at runtime, otherwise
 * every reference silently resolves to nothing and no icon renders.
 */
const ICON_PACK_ID = 'image-gen-icons';
const ICON_FILES = [
  'book-image', 'image', 'cpu-ai', 'paintbrush', 'image-upscale', 'settings', 'key-round', 'link',
  'square', 'rectangle-vertical', 'rectangle-horizontal',
] as const;

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
/**
 * Defaults are the cheapest combination, on purpose: Flare is the fast/cheap
 * everyday model, `low` + 1024x1024 is the draft tier. Anything better costs
 * real money and time, so it has to be asked for — the system prompt says the
 * same thing so the agent does not "helpfully" render at max quality.
 */
const DEFAULT_MODEL = 'gpt-image-2.5-flare';
const DEFAULT_QUALITY = 'low';
const DEFAULT_SIZE = '1024x1024';

const BASE_URL_STORAGE_KEY = 'baseUrl';
const API_KEY_STORAGE_KEY = 'openaiApiKey';
const MODEL_STORAGE_KEY = 'defaultModel';
const QUALITY_STORAGE_KEY = 'defaultQuality';
const SIZE_STORAGE_KEY = 'defaultSize';

/**
 * Aspect-ratio entries for the Composer size submenu. Every one has to pass the
 * same local validation a caller-supplied size passes — the smoke suite checks
 * each — so what is offered can never drift from what the API accepts.
 */
const SIZE_CHOICES = [
  { size: '1024x1024', ratio: '1:1', icon: 'square', label: 'size.square' },
  { size: '768x1024', ratio: '3:4', icon: 'rectangle-vertical', label: 'size.portrait' },
  { size: '720x1280', ratio: '9:16', icon: 'rectangle-vertical', label: 'size.story' },
  { size: '1024x768', ratio: '4:3', icon: 'rectangle-horizontal', label: 'size.landscape' },
  { size: '1280x720', ratio: '16:9', icon: 'rectangle-horizontal', label: 'size.wide' },
] as const;

/**
 * Model ids offered in the settings menu. Anything else is forwarded verbatim so
 * relay/proxy endpoints can expose their own ids — only the shorthands below are
 * expanded, never guessed at.
 *
 * The row stays short (the variant name, with its family as the small trailing
 * text) because the full names made the menu unreadable, and rows carry no
 * hover text: a tooltip on hover would cover the neighbouring rows.
 */
const MODEL_CHOICES: Array<{ id: string; labelKey: string; family: string }> = [
  { id: 'gpt-image-2.5-flare', labelKey: 'model.flare', family: 'Image 2.5' },
  { id: 'gpt-image-2.5-sunburst', labelKey: 'model.sunburst', family: 'Image 2.5' },
  { id: 'gpt-image-2', labelKey: 'model.previous', family: 'Image 2' },
  { id: 'gpt-image-1.5', labelKey: 'model.legacy', family: 'Image 1.5' },
];

const MODEL_ALIASES: Record<string, string> = {
  sunburst: 'gpt-image-2.5-sunburst',
  'gpt-image-sunburst': 'gpt-image-2.5-sunburst',
  flare: 'gpt-image-2.5-flare',
  'gpt-image-flare': 'gpt-image-2.5-flare',
  'gpt-image-2.5-sun': 'gpt-image-2.5-sunburst',
  'gpt-image-2.5-fl': 'gpt-image-2.5-flare',
};

/** Resolve a user/AI-supplied model name to a concrete model id. */
export function resolveModel(raw: unknown, fallback: string = DEFAULT_MODEL): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) return fallback;
  // "gpt-image-2.5" on its own does not name a variant — honour whatever the
  // user configured rather than silently picking one of the two.
  if (value === 'gpt-image-2.5') return fallback;
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
/**
 * The edit endpoint documents this ceiling for the GPT image models
 * ("you can provide up to 16 images"), so extra references are refused locally
 * rather than sent to come back as an opaque 400.
 */
const MAX_REFERENCE_IMAGES = 16;

export type SizeCheck = { ok: true; size: string } | { ok: false; error: string };

/**
 * GPT Image 2.x accepts arbitrary `WIDTHxHEIGHT` dimensions within a set of
 * constraints; validate locally so the caller gets an actionable message
 * instead of an opaque 400 from the API.
 */
export function checkSize(raw: unknown, fallback = DEFAULT_SIZE): SizeCheck {
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
  signal: AbortSignal | undefined,
  started: () => void,
): Promise<OpenAiImageResponse> {
  started();
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
  signal: AbortSignal | undefined,
  started: () => void,
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
  // Announced here, not at the top: reading (and about to upload) the
  // reference images is preparation, not generation.
  started();
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
  started: () => void,
): Promise<OpenAiImageResponse> {
  started();
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

export interface SavedImage {
  filePath: string;
  width: number;
  height: number;
  bytes: number;
}

async function saveImages(
  items: OpenAiImageItem[],
  outDir: string,
  namePrefix: string,
  extension: string,
): Promise<SavedImage[]> {
  await fs.mkdir(outDir, { recursive: true });
  const saved: SavedImage[] = [];
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
    const { width, height } = readImageSize(buf, extension);
    saved.push({ filePath, width, height, bytes: buf.length });
  }
  return saved;
}

/**
 * Keep reporting progress on a fixed interval while `work` is in flight, so the
 * UI still shows a live "N s elapsed" status if the user leaves and returns to
 * the session mid-generation, instead of freezing on the first message.
 *
 * Nothing is reported until the work calls `started()`: reading and uploading
 * local inputs is not generation, and claiming it with the image component
 * would show a picture being drawn before the request even went out. `started()`
 * fires exactly when the generation call goes on the wire, and every report
 * after it uses `kind: 'image'` — Finch's dedicated image-generation animation
 * (with the requested pixel size as a badge), the one component that says "a
 * picture is being drawn" rather than "some tool is working".
 */
async function withHeartbeat<T>(
  work: (started: () => void) => Promise<T>,
  progress: finch.ToolProgress,
  stage: string,
  baseMessage: string,
  options: { resolution?: [number, number]; intervalMs?: number } = {},
): Promise<T> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  const report = (message: string): void => {
    progress.report({
      stage,
      message,
      kind: 'image',
      ...(options.resolution ? { image: { resolution: options.resolution } } : {}),
    });
  };
  const started = (): void => {
    if (timer) return;
    report(baseMessage);
    timer = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      report(`${baseMessage} (${elapsed}s elapsed)`);
    }, options.intervalMs ?? 4000);
  };
  try {
    return await work(started);
  } finally {
    if (timer) clearInterval(timer);
  }
}

/** `auto` leaves the size to the model, so only an explicit size has a badge. */
function sizeResolution(size: string): [number, number] | undefined {
  const match = /^(\d{1,4})x(\d{1,4})$/.exec(size.trim());
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

// ── gallery ──────────────────────────────────────────────────────────────────

const GALLERY_FILE = 'gallery.json';
const GALLERY_LIMIT = 2000;
/** Above this we refuse to ship bytes across the panel bridge. */
const MAX_EMBED_BYTES = 12 * 1024 * 1024;
/**
 * The grid never needs a 4K original: the page renders each card from a small
 * thumbnail it produced itself (it is the only side with an image decoder) and
 * asks us to keep it, so a gallery that has been looked at once opens instantly.
 */
const THUMB_DIR = 'thumbs';
const MAX_THUMB_BYTES = 400 * 1024;
/**
 * The marked preview is drawn in the page, so it has no file until the page
 * hands us the bytes. Keeping one file per record lets a Composer reference
 * point at a path, which is what keeps the marked picture to a single image.
 */
const ANNOTATED_DIR = 'annotated';
const MAX_ANNOTATED_BYTES = 12 * 1024 * 1024;
const currentThumbs = new Map<string, string>();

/** Thumbnails live beside the gallery index, keyed by the original path. */
function thumbFile(ctx: finch.MiniToolContext, filePath: string): string {
  const key = createHash('sha1').update(filePath).digest('hex').slice(0, 20);
  return path.join(ctx.storagePath, THUMB_DIR, `${key}.webp`);
}

export interface GalleryRecord {
  id: string;
  filePath: string;
  name: string;
  prompt: string;
  model: string;
  /** What was requested (`auto` or `WxH`); `width`/`height` are what came back. */
  size: string;
  quality: string;
  format: string;
  width: number;
  height: number;
  bytes: number;
  createdAt: number;
  sessionId: string;
  spaceId: string;
  references: string[];
  masked: boolean;
  /** Free-form user note, edited from the gallery page. */
  note: string;
  annotations?: GalleryAnnotations;
  /**
   * Session created for "send to a new chat" from the App View, which has no
   * Composer to attach into. Reused across sends for the same image.
   */
  annotationSessionId?: string;
}

async function loadGallery(ctx: finch.MiniToolContext): Promise<GalleryRecord[]> {
  try {
    const raw = await fs.readFile(path.join(ctx.storagePath, GALLERY_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as GalleryRecord[]) : [];
  } catch {
    return [];
  }
}

async function saveGallery(ctx: finch.MiniToolContext, records: GalleryRecord[]): Promise<void> {
  const file = path.join(ctx.storagePath, GALLERY_FILE);
  const tmp = `${file}.tmp`;
  await fs.mkdir(ctx.storagePath, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(records), 'utf8');
  await fs.rename(tmp, file);
}

/** Serialize read-modify-write transactions, not just the final rename: an
 * autosave and a generation must never overwrite each other's gallery data. */
const galleryWrites = new WeakMap<finch.MiniToolContext, Promise<void>>();
function mutateGallery(ctx: finch.MiniToolContext, mutate: (records: GalleryRecord[]) => GalleryRecord[]): Promise<void> {
  const next = (galleryWrites.get(ctx) ?? Promise.resolve()).catch(() => {}).then(async () => {
    await saveGallery(ctx, mutate(await loadGallery(ctx)));
  });
  galleryWrites.set(ctx, next);
  return next;
}

/** Newest first, capped — a lost record never loses the image file itself. */
async function addToGallery(ctx: finch.MiniToolContext, records: GalleryRecord[]): Promise<void> {
  await mutateGallery(ctx, (existing) => [...records, ...existing].slice(0, GALLERY_LIMIT));
}

/**
 * Read real pixel dimensions straight out of the file header. The gallery lays
 * out a masonry column from the aspect ratio, so it needs the numbers before
 * the picture has loaded — and `size: auto` means the request never told us.
 */
export function readImageSize(buf: Buffer, format: string): { width: number; height: number } {
  try {
    if (format === 'png' && buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (format === 'jpeg' && buf.length > 16 && buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) {
          off += 1;
          continue;
        }
        const marker = buf[off + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: buf.readUInt16BE(off + 7), height: buf.readUInt16BE(off + 5) };
        }
        off += 2 + buf.readUInt16BE(off + 2);
      }
    }
    if (format === 'webp' && buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF') {
      const tag = buf.toString('ascii', 8, 12);
      if (tag === 'VP8X') {
        return {
          width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
          height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
        };
      }
      if (tag === 'VP8 ') {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      if (tag === 'VP8L') {
        const bits = buf.readUInt32LE(17);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
  } catch {
    // fall through — an unknown size just means the card sizes itself on load
  }
  return { width: 0, height: 0 };
}

const livePanels = new Set<finch.AppPanel>();
let composerMenu: (finch.Disposable & { notifyUpdate(): void }) | undefined;

/** Sessions are only reachable when the host exposes them and the permission is granted. */
function sessionsSupported(ctx: finch.MiniToolContext): boolean {
  try {
    return ctx.api.supports('sessions.create') && ctx.api.supports('sessions.send');
  } catch {
    return false;
  }
}

/** Writes the Composer menu's default size: the one place that stores it. */
async function storeDefaultSize(ctx: finch.MiniToolContext, size: string): Promise<string | null> {
  const check = checkSize(size);
  if (!check.ok) return null;
  if (check.size === DEFAULT_SIZE) await ctx.storage.delete(SIZE_STORAGE_KEY);
  else await ctx.storage.set(SIZE_STORAGE_KEY, check.size);
  return check.size;
}

/**
 * The App View owns no Composer draft, so an edited image cannot be `addContexts`-ed
 * there. Instead the composed preview is sent into a Session this mini tool owns.
 * Reusing one Session per image keeps repeated edits in the same conversation.
 */
async function resolveAnnotationSession(ctx: finch.MiniToolContext, record: GalleryRecord): Promise<string> {
  if (record.annotationSessionId) {
    const existing = await ctx.sessions.get(record.annotationSessionId).catch(() => undefined);
    if (existing) return existing.sessionId;
    record.annotationSessionId = undefined;
  }
  const created = await ctx.sessions.create({});
  const sessionId = created.sessionId;
  record.annotationSessionId = sessionId;
  await mutateGallery(ctx, (records) => {
    const target = records.find((item) => item.id === record.id);
    if (target) target.annotationSessionId = sessionId;
    return records;
  });
  return sessionId;
}

async function buildPanelEnv(ctx: finch.MiniToolContext, panel: finch.AppPanel): Promise<Record<string, unknown>> {
  return {
    view: panel.view ?? '',
    sessionId: panel.sessionId ?? '',
    // Fallback for older hosts; the page prefers repeatable finch:env signals.
    locale: ctx.i18n.locale,
    canSend: sessionsSupported(ctx),
  };
}

async function sendGallery(ctx: finch.MiniToolContext, panel: finch.AppPanel): Promise<void> {
  await panel.postMessage({
    type: 'gallery',
    data: await loadGallery(ctx),
    env: await buildPanelEnv(ctx, panel),
  });
}

async function broadcastGallery(ctx: finch.MiniToolContext): Promise<void> {
  if (!livePanels.size) return;
  const data = await loadGallery(ctx);
  for (const panel of livePanels) {
    try {
      await panel.postMessage({ type: 'gallery', data });
    } catch {
      // Navigation is transient. Only onDidDispose removes a panel handle.
    }
  }
}

/** Per-message attachment budget, mirrored from the host's documented limits. */
const MAX_ATTACHMENTS = 10;
const MAX_ATTACH_TOTAL_BYTES = 20 * 1024 * 1024;

/**
 * Sends the marked preview plus the untouched original into a Session, so an
 * App View edit can actually reach the model. The original is read from disk
 * here — the page already shipped the preview bytes and should not resend a
 * second copy of a possibly large file. The original is dropped, not the send
 * itself, when the two would exceed the host's attachment budget.
 */
async function sendAnnotationsToSession(
  ctx: finch.MiniToolContext,
  record: GalleryRecord,
  evidence: string,
  text: string,
  idempotencyKey: string,
): Promise<{ sessionId?: string; error?: string; attached: number; includedOriginal: boolean }> {
  const attachments: finch.SessionMessageAttachment[] = [];
  let total = 0;
  const attach = (name: string, mimeType: string, data: string): boolean => {
    const bytes = Math.floor((data.length * 3) / 4);
    if (attachments.length >= MAX_ATTACHMENTS || total + bytes > MAX_ATTACH_TOTAL_BYTES) return false;
    attachments.push({ name, mimeType, data, kind: 'image' });
    total += bytes;
    return true;
  };

  let includedOriginal = false;
  // Original first: it is the image to edit, the preview is only the markup.
  const rawOriginal = await fs.readFile(record.filePath).catch(() => null);
  if (rawOriginal) includedOriginal = attach(record.name, imageMime(record.filePath), rawOriginal.toString('base64'));
  const evidenceName = `${record.name.replace(/\.[^.]+$/, '')}-annotated.png`;
  if (evidence && !attach(evidenceName, 'image/png', evidence)) {
    return { error: 'too-large', attached: attachments.length, includedOriginal };
  }
  if (!attachments.length) return { error: 'empty', attached: 0, includedOriginal };

  const sessionId = await resolveAnnotationSession(ctx, record);
  const receipt = await ctx.sessions.send(sessionId, { text, attachments, idempotencyKey });
  // A replayed receipt means the host already queued this exact message; do not
  // pretend a new turn started.
  if (receipt.state !== 'accepted') return { sessionId, error: 'duplicate', attached: attachments.length, includedOriginal };
  return { sessionId, attached: attachments.length, includedOriginal };
}

function imageMime(filePath: string): string {
  return mimeForPath(filePath);
}

async function handlePanelMessage(
  ctx: finch.MiniToolContext,
  panel: finch.AppPanel,
  msg: Record<string, unknown>,
): Promise<void> {
  const type = String(msg?.type ?? '');

  if (type === 'requestGallery') {
    await sendGallery(ctx, panel);
    return;
  }

  if (type === 'requestImage') {
    const filePath = typeof msg.filePath === 'string' ? msg.filePath : '';
    const wantThumb = msg.variant === 'thumb';
    if (!filePath) return;
    try {
      const records = await loadGallery(ctx);
      if (!records.some((record) => record.filePath === filePath)) {
        await panel.postMessage({ type: 'imageData', filePath, error: 'unreadable' });
        return;
      }
      if (wantThumb) {
        // A grid-sized copy, when one has been made. Otherwise the page gets the
        // original, renders it, and sends back a thumbnail for next time.
        const thumb = await fs.readFile(thumbFile(ctx, filePath)).catch(() => null);
        if (thumb && thumb.length > 64 && thumb.length <= MAX_THUMB_BYTES) {
          await panel.postMessage({
            type: 'imageData',
            filePath,
            variant: 'thumb',
            dataUrl: `data:image/webp;base64,${thumb.toString('base64')}`,
          });
          return;
        }
      }
      const info = await fs.stat(filePath);
      if (info.size > MAX_EMBED_BYTES) {
        await panel.postMessage({ type: 'imageData', filePath, error: 'too-large' });
        return;
      }
      const buf = await fs.readFile(filePath);
      await panel.postMessage({
        type: 'imageData',
        filePath,
        variant: 'full',
        dataUrl: `data:${imageMime(filePath)};base64,${buf.toString('base64')}`,
      });
    } catch {
      await panel.postMessage({ type: 'imageData', filePath, error: 'unreadable' });
    }
    return;
  }

  if (type === 'saveThumb') {
    // The page is the only side that can resize, so it hands us the result. Only
    // a picture this gallery actually knows is accepted, and only small ones.
    const filePath = typeof msg.filePath === 'string' ? msg.filePath : '';
    const dataUrl = typeof msg.dataUrl === 'string' ? msg.dataUrl : '';
    const encoded = /^data:image\/webp;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!filePath || !encoded) return;
    const records = await loadGallery(ctx);
    if (!records.some((record) => record.filePath === filePath)) return;
    const buf = Buffer.from(encoded[1], 'base64');
    if (buf.length < 64 || buf.length > MAX_THUMB_BYTES) return;
    const target = thumbFile(ctx, filePath);
    const cached = currentThumbs.get(target);
    if (cached === encoded[1]) return;
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, target);
    currentThumbs.set(target, encoded[1]);
    return;
  }

  if (type === 'saveAnnotated') {
    const id = typeof msg.id === 'string' ? msg.id : '';
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (!id || !/^[A-Za-z0-9+/=]+$/.test(content)) return;
    const records = await loadGallery(ctx);
    if (!records.some((record) => record.id === id)) return;
    const buf = Buffer.from(content, 'base64');
    if (buf.length < 64 || buf.length > MAX_ANNOTATED_BYTES) {
      await panel.postMessage({ type: 'annotatedSaved', id, error: 'too-large' });
      return;
    }
    const dir = path.join(ctx.storagePath, ANNOTATED_DIR);
    await fs.mkdir(dir, { recursive: true });
    // One file per record: the newest preview always wins, and nothing piles up.
    const target = path.join(dir, `${createHash('sha1').update(id).digest('hex').slice(0, 20)}.png`);
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, target);
    await panel.postMessage({ type: 'annotatedSaved', id, path: target });
    return;
  }

  if (type === 'openPreview') {
    const filePath = typeof msg.filePath === 'string' ? msg.filePath : '';
    if (!filePath) return;
    try {
      await ctx.ui.openFilePreview(filePath);
    } catch (err) {
      ctx.logger.warn(`openFilePreview failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  if (type === 'saveNote') {
    const id = String(msg.id ?? '');
    const note = typeof msg.note === 'string' ? msg.note : '';
    await mutateGallery(ctx, (records) => {
      const record = records.find((item) => item.id === id);
      if (record) record.note = note.slice(0, 8000);
      return records;
    });
    await panel.postMessage({ type: 'noteSaved', id });
    return;
  }

  if (type === 'saveAnnotations') {
    const id = String(msg.id ?? '');
    const annotations = parseAnnotations(msg.annotations);
    if (!annotations) {
      await panel.postMessage({ type: 'panelError', id, requestId: msg.requestId, error: 'invalid-annotations' });
      return;
    }
    let found = false;
    await mutateGallery(ctx, (records) => {
      const record = records.find((item) => item.id === id);
      if (record) {
        found = true;
        record.annotations = annotations;
        record.note = typeof msg.note === 'string' ? msg.note.slice(0, 8000) : record.note;
      }
      return records;
    });
    await panel.postMessage({ type: found ? 'annotationsSaved' : 'panelError', id, requestId: msg.requestId, ...(!found ? { error: 'not-found' } : {}) });
    return;
  }

  if (type === 'sendToSession') {
    const id = String(msg.id ?? '');
    const requestId = String(msg.requestId ?? '');
    const records = await loadGallery(ctx);
    const record = records.find((item) => item.id === id);
    const reply = (payload: Record<string, unknown>) =>
      panel.postMessage({ type: 'annotationSendResult', id, requestId, ...payload });
    if (!record) {
      await reply({ error: 'not-found' });
      return;
    }
    if (!sessionsSupported(ctx)) {
      await reply({ error: 'unsupported' });
      return;
    }
    const evidence = typeof msg.evidence === 'string' ? msg.evidence : '';
    const text = typeof msg.text === 'string' ? msg.text.slice(0, 8000) : '';
    // A fresh key per attempt: a replayed idempotency key would suppress the turn.
    const idempotencyKey =
      typeof msg.idempotencyKey === 'string' && msg.idempotencyKey
        ? msg.idempotencyKey.slice(0, 200)
        : `${record.id}-${Date.now()}`;
    const result = await sendAnnotationsToSession(ctx, record, evidence, text, idempotencyKey).catch((error: unknown) => {
      ctx.logger.warn(`sendToSession failed: ${error instanceof Error ? error.message : String(error)}`);
      return { sessionId: undefined, error: 'send-failed', attached: 0, includedOriginal: false };
    });
    // 'duplicate' still means the host queued this exact message, so it is worth
    // opening the Session; the other errors never delivered anything.
    if (result.sessionId && (result.error === undefined || result.error === 'duplicate')) {
      try {
        await ctx.navigation.openSession(result.sessionId);
      } catch (err) {
        ctx.logger.warn(`openSession failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await reply(result);
    return;
  }

  if (type === 'adjustImage') {
    const id = String(msg.id ?? '');
    const records = await loadGallery(ctx);
    const record = records.find((item) => item.id === id);
    if (!record) {
      await panel.postMessage({ type: 'adjustResult', id, error: 'not-found' });
      return;
    }
    if (!record.sessionId) {
      await panel.postMessage({ type: 'adjustResult', id, error: 'no-session' });
      return;
    }
    try {
      await ctx.navigation.openSession(record.sessionId);
    } catch (err) {
      ctx.logger.warn(`openSession failed: ${err instanceof Error ? err.message : String(err)}`);
      await panel.postMessage({ type: 'adjustResult', id, error: 'open-failed' });
      return;
    }
    // The image is edited where it can be delivered: a gallery panel already
    // open in that Session is revealed and dropped straight into the editor.
    for (const target of livePanels) {
      if (target === panel || target.view !== 'session' || target.sessionId !== record.sessionId) continue;
      try {
        await target.reveal();
        await target.postMessage({ type: 'editImage', id });
      } catch (err) {
        ctx.logger.warn(`editImage push failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await panel.postMessage({ type: 'adjustResult', id, sessionId: record.sessionId });
    return;
  }

  if (type === 'deleteRecord') {
    const id = String(msg.id ?? '');
    const deleteFile = msg.deleteFile === true;
    let target: GalleryRecord | undefined;
    await mutateGallery(ctx, (records) => {
      target = records.find((item) => item.id === id);
      return records.filter((item) => item.id !== id);
    });
    if (!target) return;
    let fileDeleteError = '';
    if (deleteFile) {
      await fs.rm(target.filePath, { force: true }).catch((err: unknown) => {
        fileDeleteError = err instanceof Error ? err.message : String(err);
      });
    }
    // The record is gone for good, so its cached thumbnail is dead weight.
    const thumb = thumbFile(ctx, target.filePath);
    await fs.rm(thumb, { force: true }).catch(() => {});
    currentThumbs.delete(thumb);
    await panel.postMessage({ type: 'deleteResult', id, deleteFile, fileDeleteError });
    await broadcastGallery(ctx);
    return;
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

/**
 * Register every shipped SVG under the pack the manifest reserves. The bundle
 * lives in `dist/`, so the assets sit one level up — the same layout the
 * package ships. A missing file costs one icon, never the whole activation.
 */
export function registerIcons(ctx: finch.MiniToolContext): number {
  const directory = fileURLToPath(new URL('../icons/', import.meta.url));
  const entries: Record<string, { svg: string }> = {};
  for (const name of ICON_FILES) {
    try {
      entries[name] = { svg: readFileSync(path.join(directory, `${name}.svg`), 'utf8') };
    } catch (err) {
      ctx.logger.warn(`icon "${name}" could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const count = Object.keys(entries).length;
  if (count) ctx.subscriptions.push(ctx.icons.register(ICON_PACK_ID, entries));
  return count;
}

export function activate(ctx: finch.MiniToolContext): void {
  const t = (key: string, values?: Record<string, string | number>) => ctx.i18n.t(key, values);

  registerIcons(ctx);

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
              'Local absolute file paths of reference image(s) for image-to-image / reference-guided editing or compositing. Omit for plain text-to-image. The API accepts up to 16 reference images.',
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

        // A stored default size is only trusted if it still passes the same
        // local rules a caller-supplied size has to pass.
        const storedSize = await ctx.storage.get<string>(SIZE_STORAGE_KEY);
        const sizeFallback = storedSize && checkSize(storedSize).ok ? storedSize.trim() : DEFAULT_SIZE;
        const sizeCheck = checkSize(input.size, sizeFallback);
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
        // The endpoint documents a hard ceiling for GPT image models; refusing
        // here beats a request that only comes back as an opaque 400.
        if (refPaths.length > MAX_REFERENCE_IMAGES) {
          return {
            content: [{ type: 'text', text: t('error.tooManyReferences', { max: String(MAX_REFERENCE_IMAGES) }) }],
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
          const resolution = sizeResolution(size);
          const outDir = path.join(ctx.storagePath, 'images');
          const previewDir = path.join(outDir, '.preview');
          const stream = partialImages > 0 && n === 1 && !refPaths.length;

          const result = await withHeartbeat(
            (started) =>
              refPaths.length
                ? callEdit(
                    baseUrl,
                    apiKey,
                    { model, prompt, size, quality, n: String(n), ...optional },
                    refPaths,
                    maskPath,
                    exec.signal,
                    started,
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
                          kind: 'image',
                          ...(resolution ? { image: { resolution } } : {}),
                        });
                      },
                      started,
                    )
                  : callGenerate(baseUrl, apiKey, { model, prompt, size, quality, n, ...optional }, exec.signal, started),
            exec.progress,
            stage,
            baseMessage,
            { resolution },
          );

          const items = result.data ?? [];
          if (!items.length) {
            return { content: [{ type: 'text', text: t('error.noImage') }], isError: true };
          }

          exec.progress.report({ stage: 'saving', message: t('progress.saving') });
          const saved = await saveImages(items, outDir, namePrefix, EXT_BY_FORMAT[format]);
          const savedPaths = saved.map((item) => item.filePath);
          if (stream) await fs.rm(previewDir, { recursive: true, force: true });

          // Everything the gallery badge and a later "edit this again" need has
          // to be captured here — the file alone cannot tell you what produced it.
          const createdAt = Date.now();
          await addToGallery(
            ctx,
            saved.map((item, index) => ({
              id: `${createdAt}-${index + 1}`,
              filePath: item.filePath,
              name: path.basename(item.filePath),
              prompt,
              model,
              size,
              quality,
              format,
              width: item.width,
              height: item.height,
              bytes: item.bytes,
              createdAt,
              sessionId: exec.sessionId ?? '',
              spaceId: exec.spaceId ?? '',
              references: refPaths,
              masked: !!maskPath,
              note: '',
            })),
          );
          await broadcastGallery(ctx);

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

  // Everyday generation defaults, plus the endpoint's own settings menu.
  composerMenu = ctx.composerActions.register('image-gen-settings', {
      async getMenu(actionCtx: finch.ComposerActionContext) {
        const storedModel = await ctx.storage.get<string>(MODEL_STORAGE_KEY);
        const effectiveModel = storedModel && storedModel.trim() ? storedModel.trim() : DEFAULT_MODEL;
        const storedQuality = await ctx.storage.get<string>(QUALITY_STORAGE_KEY);
        const effectiveQuality = storedQuality && storedQuality.trim() ? storedQuality.trim() : DEFAULT_QUALITY;
        const storedSize = await ctx.storage.get<string>(SIZE_STORAGE_KEY);
        const effectiveSize = storedSize && checkSize(storedSize).ok ? storedSize.trim() : DEFAULT_SIZE;
        const knownModel = MODEL_CHOICES.find((choice) => choice.id === effectiveModel);
        return [
          {
            id: 'set-model',
            label: t('menu.model'),
            iconName: 'ext:image-gen-icons/cpu-ai',
            // A relay's own model id has no short name, so it stays as-is.
            description: knownModel ? t(knownModel.labelKey) : effectiveModel,
            children: MODEL_CHOICES.map((choice) => ({
              id: `model:${choice.id}`,
              label: t(choice.labelKey),
              description: choice.family,
              current: choice.id === effectiveModel,
            })),
          },
          {
            id: 'set-quality',
            label: t('menu.quality'),
            iconName: 'ext:image-gen-icons/paintbrush',
            description: effectiveQuality,
            children: QUALITY_ENUM.map((value) => ({
              id: `quality:${value}`,
              label: value,
              current: value === effectiveQuality,
            })),
          },
          {
            id: 'set-size',
            label: t('menu.size'),
            iconName: 'ext:image-gen-icons/image-upscale',
            description: effectiveSize,
            // Aspect-ratio presets, each resolved to a valid pixel size.
            children: [
              ...SIZE_CHOICES.map((preset) => ({
                id: `size:${preset.size}`,
                label: t(preset.label),
                iconName: `ext:image-gen-icons/${preset.icon}`,
                description: preset.ratio,
                current: preset.size === effectiveSize,
              })),
              {
                id: 'size:auto',
                label: t('size.auto'),
                description: 'auto',
                current: effectiveSize === 'auto',
              },
            ],
          },
        ];
      },
      async execute(actionCtx, itemId, actions) {
        // Submenu rows save straight away — no dialog to confirm a single choice.
        const [kind, ...rest] = itemId.split(':');
        const chosen = rest.join(':');
        if (kind === 'model' && chosen) {
          if (chosen === DEFAULT_MODEL) await ctx.storage.delete(MODEL_STORAGE_KEY);
          else await ctx.storage.set(MODEL_STORAGE_KEY, chosen);
          composerMenu?.notifyUpdate();
          return;
        }
        if (kind === 'quality' && QUALITY_ENUM.includes(chosen as QualityOption)) {
          if (chosen === DEFAULT_QUALITY) await ctx.storage.delete(QUALITY_STORAGE_KEY);
          else await ctx.storage.set(QUALITY_STORAGE_KEY, chosen);
          composerMenu?.notifyUpdate();
          return;
        }
        if (kind === 'size') {
          const stored = await storeDefaultSize(ctx, chosen);
          if (stored === null) return;
          composerMenu?.notifyUpdate();
          return;
        }
      },
    });

  ctx.subscriptions.push(composerMenu);

  // The endpoint is setup, not a knob you flip between generations, so the key
  // and the base URL live in the Toolcase / container settings menu.
  ctx.subscriptions.push(
    ctx.settingsMenu.register({
      async getMenu() {
        const storedBaseUrl = await ctx.storage.get<string>(BASE_URL_STORAGE_KEY);
        const effectiveBaseUrl = storedBaseUrl && storedBaseUrl.trim() ? normalizeBaseUrl(storedBaseUrl) : DEFAULT_BASE_URL;
        const hasKeychainKey = !!(await ctx.secrets.get('OPENAI_API_KEY'));
        const hasStoredKey = !!(await ctx.storage.get<string>(API_KEY_STORAGE_KEY));
        const keyStatus = hasKeychainKey || hasStoredKey ? t('status.configured') : t('status.notSet');
        return [
          {
            id: 'set-api-key',
            label: t('menu.apiKey'),
            iconName: 'ext:image-gen-icons/key-round',
            description: keyStatus,
          },
          {
            id: 'set-base-url',
            label: t('menu.baseUrl'),
            iconName: 'ext:image-gen-icons/link',
            description: effectiveBaseUrl,
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

  // One listener covers both surfaces: the right-side Panel App and the
  // application-level App View page (which never calls createPanel itself, so
  // this is the only place its AppPanel handle is reachable).
  ctx.subscriptions.push(
    ctx.ui.onDidOpenPanel((panel) => {
      livePanels.add(panel);
      ctx.subscriptions.push(
        panel.onDidReceiveMessage((message) => {
          const msg = (message ?? {}) as Record<string, unknown>;
          void handlePanelMessage(ctx, panel, msg).catch((error: unknown) => {
            ctx.logger.warn(`gallery message failed: ${error instanceof Error ? error.message : String(error)}`);
            void panel.postMessage({ type: 'panelError', id: msg.id, requestId: msg.requestId }).catch(() => {});
          });
        }),
      );
      ctx.subscriptions.push(
        panel.onDidDispose(() => {
          livePanels.delete(panel);
        }),
      );
      void sendGallery(ctx, panel).catch((err: unknown) => {
        ctx.logger.warn(`panel gallery push failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }),
  );

  ctx.logger.info('image-gen activated');
}

import type * as finch from 'finch';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-image-1.5';
const BASE_URL_STORAGE_KEY = 'baseUrl';
const API_KEY_STORAGE_KEY = 'openaiApiKey';

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

const SIZE_ENUM = ['auto', '1024x1024', '1024x1536', '1536x1024'] as const;
const QUALITY_ENUM = ['auto', 'low', 'medium', 'high'] as const;

type SizeOption = (typeof SIZE_ENUM)[number];
type QualityOption = (typeof QUALITY_ENUM)[number];

interface CreateImageInput {
  prompt: string;
  reference_image_paths?: string[];
  size?: SizeOption;
  quality?: QualityOption;
  n?: number;
  model?: string;
  output_name?: string;
  base_url?: string;
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'image/png';
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9-_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function clampN(n: unknown): number {
  const num = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 1;
  return Math.min(4, Math.max(1, num));
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    if (body?.error?.message) return body.error.message;
  } catch {
    // ignore parse failure, fall through to status text
  }
  return `${response.status} ${response.statusText}`;
}

interface OpenAiImageItem {
  b64_json?: string;
  url?: string;
}

interface OpenAiImageResponse {
  data?: OpenAiImageItem[];
}

async function callGenerate(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<OpenAiImageResponse> {
  const response = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as OpenAiImageResponse;
}

async function callEdit(
  baseUrl: string,
  apiKey: string,
  fields: Record<string, string>,
  referenceImagePaths: string[],
  signal?: AbortSignal,
): Promise<OpenAiImageResponse> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  for (const refPath of referenceImagePaths) {
    const buf = await fs.readFile(refPath);
    const blob = new Blob([buf], { type: mimeForPath(refPath) });
    form.append('image[]', blob, path.basename(refPath));
  }
  const response = await fetch(`${baseUrl}/images/edits`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
    signal,
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as OpenAiImageResponse;
}

async function saveImages(
  items: OpenAiImageItem[],
  outDir: string,
  namePrefix: string,
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
    const fileName = `${namePrefix}-${stamp}-${i + 1}.png`;
    const filePath = path.join(outDir, fileName);
    await fs.writeFile(filePath, buf);
    saved.push(filePath);
  }
  return saved;
}

export function activate(ctx: finch.MiniToolContext): void {
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'image_gen_create',
      title: 'Generate Image (OpenAI)',
      description: `Generate an image with OpenAI's image API, or edit/remix one using reference images.
- Text-to-image: pass only "prompt".
- Image-to-image (reference-guided generation/editing): also pass "reference_image_paths" with one or more local absolute image file paths; the model uses them as visual reference while following "prompt".
Generated images are saved to local files; the tool result returns their absolute paths. Use wechat_send or Session attach afterward to show/share the images — do not try to re-download or re-encode them yourself.
size controls aspect ratio/resolution: 1024x1024 (square), 1024x1536 (portrait), 1536x1024 (landscape), or auto (let the model choose).
Requests go to the OpenAI-compatible endpoint configured via the Image Gen settings button in the Composer toolbar (default api.openai.com); pass base_url to override it for a single call only.`,
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'What to generate or how to edit the reference image(s). Be specific about subject, style, composition and mood.',
          },
          reference_image_paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Local absolute file paths of reference image(s) for image-to-image / reference-guided editing. Omit for plain text-to-image.',
          },
          size: {
            type: 'string',
            enum: SIZE_ENUM as unknown as string[],
            description: 'Output size/aspect ratio. Default "auto".',
          },
          quality: {
            type: 'string',
            enum: QUALITY_ENUM as unknown as string[],
            description: 'Rendering quality/cost tradeoff. Default "auto".',
          },
          n: {
            type: 'number',
            minimum: 1,
            maximum: 4,
            description: 'Number of images to generate, 1-4. Default 1.',
          },
          model: {
            type: 'string',
            description: `OpenAI image model id. Default "${DEFAULT_MODEL}".`,
          },
          output_name: {
            type: 'string',
            description: 'Optional short file name prefix for the saved image(s), e.g. "poster". Letters, digits, - and _ only.',
          },
          base_url: {
            type: 'string',
            description: `One-off override of the API base URL for this call only (e.g. a proxy/relay endpoint), without changing the saved default. Must include the protocol, e.g. "https://your-proxy.example.com/v1". Omit to use the endpoint configured via the Composer's Image Gen settings button (default "${DEFAULT_BASE_URL}").`,
          },
        },
        required: ['prompt'],
      },
      risk: 'medium',
      timeoutMs: 240000,
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
                text: 'OpenAI API key is not configured. Ask the user to click the Image Gen settings button (gear icon) in the Composer toolbar → "OpenAI API Key" to enter it, then retry.',
              },
            ],
            isError: true,
          };
        }

        const model = (typeof input.model === 'string' && input.model.trim()) || DEFAULT_MODEL;
        const size = SIZE_ENUM.includes(input.size as SizeOption) ? (input.size as SizeOption) : 'auto';
        const quality = QUALITY_ENUM.includes(input.quality as QualityOption) ? (input.quality as QualityOption) : 'auto';
        const n = clampN(input.n);
        const refPaths = Array.isArray(input.reference_image_paths)
          ? input.reference_image_paths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
          : [];
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

        try {
          for (const refPath of refPaths) {
            await fs.access(refPath);
          }

          const stage = refPaths.length ? 'editing' : 'generating';
          const baseMessage = refPaths.length ? 'Generating image from reference…' : 'Generating image…';
          const result = await withHeartbeat(
            refPaths.length
              ? callEdit(baseUrl, apiKey, { model, prompt, size, quality, n: String(n) }, refPaths, exec.signal)
              : callGenerate(baseUrl, apiKey, { model, prompt, size, quality, n }, exec.signal),
            exec.progress,
            stage,
            baseMessage,
          );

          const items = result.data ?? [];
          if (!items.length) {
            return { content: [{ type: 'text', text: 'OpenAI returned no image data.' }], isError: true };
          }

          exec.progress.report({ stage: 'saving', message: 'Saving image(s) locally…' });
          const outDir = path.join(ctx.storagePath, 'images');
          const savedPaths = await saveImages(items, outDir, namePrefix);

          const lines = [
            `Generated ${savedPaths.length} image(s) with model "${model}" (size: ${size}, quality: ${quality})${refPaths.length ? ` from ${refPaths.length} reference image(s)` : ''} via ${baseUrl}.`,
            ...savedPaths,
          ];
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.logger.error(`image_gen_create failed: ${message}`);
          return { content: [{ type: 'text', text: `Image generation failed: ${message}` }], isError: true };
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
        const keyStatus = hasKeychainKey || hasStoredKey ? 'Configured' : 'Not set';
        return [
          {
            id: 'set-api-key',
            label: 'OpenAI API Key',
            iconName: 'settings',
            description: keyStatus,
            hoverText: `Set the OpenAI API key used by Image Gen. Currently: ${keyStatus}.`,
          },
          {
            id: 'set-base-url',
            label: 'API Base URL',
            iconName: 'globe',
            description: effectiveBaseUrl,
            hoverText: `Change the OpenAI-compatible API endpoint used by Image Gen (e.g. a proxy/relay). Currently: ${effectiveBaseUrl}${storedBaseUrl ? '' : ' (default)'}`,
          },
        ];
      },
      async execute(_actionCtx, itemId) {
        if (itemId === 'set-api-key') {
          const result = await ctx.ui.showModalDialog({
            title: 'OpenAI API Key',
            description: 'Paste your OpenAI API key. It is stored locally and only sent to the API endpoint used by Image Gen — never shown in chat.',
            fields: [
              {
                key: 'apiKey',
                label: 'API Key',
                type: 'password',
                secret: true,
                placeholder: 'sk-...',
              },
            ],
            actions: [
              { id: 'cancel', label: 'Cancel' },
              { id: 'save', label: 'Save', variant: 'primary' },
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
            title: 'Image Gen API Base URL',
            description: `OpenAI-compatible base URL, e.g. a proxy/relay endpoint. Leave empty to use the official ${DEFAULT_BASE_URL}.`,
            fields: [
              {
                key: 'baseUrl',
                label: 'API Base URL',
                type: 'text',
                placeholder: DEFAULT_BASE_URL,
                default: stored ?? '',
              },
            ],
            actions: [
              { id: 'cancel', label: 'Cancel' },
              { id: 'save', label: 'Save', variant: 'primary' },
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
              title: 'Invalid URL',
              message: `"${value}" is not a valid http(s) URL. The base URL was not changed.`,
              actions: [{ id: 'ok', label: 'OK', variant: 'primary' }],
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

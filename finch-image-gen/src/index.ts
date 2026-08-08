import type * as finch from 'finch';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const OPENAI_API_BASE = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-image-2';

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
  apiKey: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<OpenAiImageResponse> {
  const response = await fetch(`${OPENAI_API_BASE}/images/generations`, {
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
  const response = await fetch(`${OPENAI_API_BASE}/images/edits`, {
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
size controls aspect ratio/resolution: 1024x1024 (square), 1024x1536 (portrait), 1536x1024 (landscape), or auto (let the model choose).`,
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

        const apiKey = await exec.secrets.get('OPENAI_API_KEY');
        if (!apiKey) {
          return {
            content: [
              {
                type: 'text',
                text: 'OpenAI API key is not configured. Ask the user to open this mini tool\'s settings in Finch (Toolcase → Image Gen (OpenAI)) and fill in OPENAI_API_KEY, then retry.',
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

        exec.progress.report({
          stage: refPaths.length ? 'editing' : 'generating',
          message: refPaths.length ? 'Generating image from reference…' : 'Generating image…',
        });

        try {
          for (const refPath of refPaths) {
            await fs.access(refPath);
          }

          const result = refPaths.length
            ? await callEdit(
                apiKey,
                { model, prompt, size, quality, n: String(n) },
                refPaths,
                exec.signal,
              )
            : await callGenerate(apiKey, { model, prompt, size, quality, n }, exec.signal);

          const items = result.data ?? [];
          if (!items.length) {
            return { content: [{ type: 'text', text: 'OpenAI returned no image data.' }], isError: true };
          }

          exec.progress.report({ stage: 'saving', message: 'Saving image(s) locally…' });
          const outDir = path.join(ctx.storagePath, 'images');
          const savedPaths = await saveImages(items, outDir, namePrefix);

          const lines = [
            `Generated ${savedPaths.length} image(s) with model "${model}" (size: ${size}, quality: ${quality})${refPaths.length ? ` from ${refPaths.length} reference image(s)` : ''}.`,
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

  ctx.logger.info('image-gen activated');
}

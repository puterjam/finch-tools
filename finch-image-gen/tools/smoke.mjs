/**
 * Host-free smoke test for finch-image-gen.
 *
 * `activate()` only needs `ctx`, and every request goes through global `fetch`,
 * so a fake host plus a stubbed fetch can drive the real `image_gen_create`
 * `execute()` and assert the parts that are painful to check by hand:
 *
 *   1. which parameters actually reach the API (and which stay omitted so relays
 *      and older models keep working),
 *   2. local size validation, so a bad WxH fails with an actionable message
 *      instead of an opaque 400,
 *   3. model alias / stored-default resolution,
 *   4. the moderation and auth error hints the model is supposed to act on,
 *   5. the streaming path, including the "only previews arrived" fallback.
 *
 * Run with: npm run smoke   (builds first, then runs this)
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activate, checkSize, formatApiError, resolveModel } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
}

// ── fake host ────────────────────────────────────────────────────────────────

const locale = JSON.parse(readFileSync(join(root, 'i18n/zh-CN.json'), 'utf8'));
const fallback = JSON.parse(readFileSync(join(root, 'i18n/en-US.json'), 'utf8'));

/** Mirrors how Finch resolves i18n: a flat dotted key first, then a nested walk. */
function lookup(store, key) {
  if (typeof store[key] === 'string') return store[key];
  return key.split('.').reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), store);
}

function makeCtx(storagePath) {
  const store = new Map();
  const registered = {};
  const composer = {};
  const ctx = {
    storagePath,
    subscriptions: { push() {} },
    storage: {
      async get(key) {
        return store.has(key) ? store.get(key) : null;
      },
      async set(key, value) {
        store.set(key, value);
      },
      async delete(key) {
        store.delete(key);
      },
    },
    secrets: { async get() { return null; } },
    logger: { info() {}, warn() {}, error() {} },
    i18n: {
      locale: 'en-US',
      has(key) {
        return lookup(locale, key) !== undefined || lookup(fallback, key) !== undefined;
      },
      t(key, values) {
        let text = lookup(locale, key) ?? lookup(fallback, key) ?? key;
        if (typeof text !== 'string') text = key;
        return text.replace(/\{(\w+)\}/g, (_, name) => String(values?.[name] ?? `{${name}}`));
      },
    },
    tools: {
      register(definition) {
        registered[definition.name] = definition;
      },
    },
    composerActions: {
      register(id, handlers) {
        composer[id] = handlers;
      },
    },
    ui: { async showModalDialog() { return { action: 'dismissed' }; } },
  };
  return { ctx, registered, composer, store };
}

function makeExec() {
  const reports = [];
  return {
    reports,
    exec: {
      signal: undefined,
      storage: {
        async get() { return null; },
        async set() {},
      },
      secrets: { async get() { return 'test-key'; } },
      progress: { report(event) { reports.push(event); } },
    },
  };
}

// ── fetch stub ───────────────────────────────────────────────────────────────

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let calls = [];
let nextResponse = null;

function jsonReply(body, init = {}) {
  return {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    async json() { return body; },
  };
}

function sseReply(chunks) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true };
            return { done: false, value: encoder.encode(chunks[index++]) };
          },
        };
      },
    },
  };
}

globalThis.fetch = async (url, init) => {
  const record = { url: String(url), init: init ?? {} };
  if (record.init.body && typeof record.init.body === 'string') {
    record.json = JSON.parse(record.init.body);
  }
  if (record.init.body && typeof record.init.body !== 'string' && typeof record.init.body.get === 'function') {
    record.form = Object.fromEntries(record.init.body.entries());
    record.formKeys = record.init.body.getAll ? record.init.body.getAll('image[]').length : 0;
  }
  calls.push(record);
  return nextResponse;
};

// ── run ──────────────────────────────────────────────────────────────────────

const storagePath = mkdtempSync(join(tmpdir(), 'image-gen-smoke-'));
const { ctx, registered, store } = makeCtx(storagePath);
activate(ctx);

const tool = registered.image_gen_create;
check('tool image_gen_create is registered', !!tool);

async function run(input, reply) {
  calls = [];
  nextResponse = reply ?? jsonReply({ data: [{ b64_json: PNG_1PX.toString('base64') }] });
  const { exec, reports } = makeExec();
  const result = await tool.execute(input, exec);
  return { result, text: result.content[0]?.text ?? '', call: calls[0], reports };
}

const base = { prompt: 'a red square' };

// 1 — defaults: only the broadly supported knobs are sent.
{
  const { call, text } = await run(base);
  check('default model is gpt-image-2.5-sunburst', call.json.model === 'gpt-image-2.5-sunburst', call.json.model);
  check('default size/quality are auto', call.json.size === 'auto' && call.json.quality === 'auto');
  check('optional knobs stay omitted', call.json.background === undefined && call.json.output_format === undefined && call.json.moderation === undefined);
  check('hits /images/generations', call.url.endsWith('/v1/images/generations'), call.url);
  check('result lists a saved file', text.includes('.png') && text.includes('model: gpt-image-2.5-sunburst'), text.slice(0, 120));
}

// 2 — stored defaults from the settings menu win over the built-in default.
{
  await store.set('defaultModel', 'gpt-image-2.5-flare');
  await store.set('defaultQuality', 'high');
  const { call } = await run(base);
  check('stored default model is used', call.json.model === 'gpt-image-2.5-flare', call.json.model);
  check('stored default quality is used', call.json.quality === 'high', call.json.quality);
  const alias = await run({ prompt: 'x', model: 'sunburst' });
  check('model shorthand sunburst resolves', alias.call.json.model === 'gpt-image-2.5-sunburst', alias.call.json.model);
  const relay = await run({ prompt: 'x', model: 'my-relay-model' });
  check('unknown model ids pass through untouched', relay.call.json.model === 'my-relay-model');
  await store.delete('defaultModel');
  await store.delete('defaultQuality');
}

// 3 — size validation happens locally.
{
  check('1024x1024 accepted', checkSize('1024x1024').ok === true);
  check('2560x1440 accepted', checkSize('2560x1440').ok === true);
  check('3840x2160 accepted (pixel ceiling)', checkSize('3840x2160').ok === true);
  check('1000x1000 rejected (not /16)', checkSize('1000x1000').ok === false);
  check('4096x4096 rejected (edge + pixels)', checkSize('4096x4096').ok === false);
  check('1024x4096 rejected (ratio)', checkSize('1024x4096').ok === false);
  check('garbage rejected', checkSize('square').ok === false);
  const { result, text } = await run({ ...base, size: '1000x1000' });
  check('bad size fails before any request', result.isError === true && calls.length === 0 && text.includes('multiples of 16'), text);
}

// 4 — quality, background and format interplay.
{
  const { call } = await run({ ...base, quality: 'xhigh', background: 'transparent', output_format: 'jpeg' });
  check('xhigh quality is forwarded', call.json.quality === 'xhigh');
  check('transparent forces png over jpeg', call.json.output_format === 'png' && call.json.background === 'transparent');
  const webp = await run({ ...base, output_format: 'webp', output_compression: 50 });
  check('webp keeps compression', webp.call.json.output_format === 'webp' && webp.call.json.output_compression === 50);
  check('webp file extension follows format', webp.text.includes('.webp'), webp.text);
  const png = await run({ ...base, output_compression: 50 });
  check('compression dropped for png', png.call.json.output_compression === undefined);
}

// 5 — edits, masks and n.
{
  const refPath = join(storagePath, 'ref.png');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(refPath, PNG_1PX);
  const { call } = await run({ ...base, reference_image_paths: [refPath], mask_path: refPath, n: 9 });
  check('edits go to /images/edits', call.url.endsWith('/v1/images/edits'), call.url);
  check('reference image is attached', call.formKeys === 1, String(call.formKeys));
  check('mask is attached', call.form.mask !== undefined && call.form.mask.name === 'ref.png', JSON.stringify(call.form.mask));
  check('n is clamped to 4', call.form.n === '4', call.form.n);
  const noRef = await run({ ...base, mask_path: refPath });
  check('mask without references is rejected', noRef.result.isError === true && calls.length === 0, noRef.text);
  const missing = await run({ ...base, reference_image_paths: [join(storagePath, 'nope.png')] });
  check('missing reference file is reported', missing.result.isError === true && calls.length === 0);
}

// 6 — error mapping the model has to act on.
{
  check(
    'moderation input block explains the fix',
    formatApiError(
      { message: 'No.', code: 'moderation_blocked', moderation_details: { moderation_stage: 'input', categories: ['harassment'] } },
      '400 Bad Request',
    ).includes('reword the prompt'),
  );
  check(
    'moderation output block says regenerate',
    formatApiError({ message: 'No.', code: 'moderation_blocked', moderation_details: { moderation_stage: 'output' } }, '400 Bad Request').includes('generate again'),
  );
  check('401 points at the settings button', formatApiError({ message: 'no' }, '401 Unauthorized').includes('API key'));
  check('403 mentions organization verification', formatApiError({ message: 'no' }, '403 Forbidden').includes('organization verification'));
  check('429 mentions rate limit', formatApiError({ message: 'no' }, '429 Too Many Requests').includes('Rate limit'));

  const blocked = await run(
    { ...base },
    jsonReply(
      { error: { message: 'Blocked', code: 'moderation_blocked', moderation_details: { moderation_stage: 'input', categories: ['violence'] } } },
      { status: 400, statusText: 'Bad Request' },
    ),
  );
  check('blocked request surfaces code and hint', blocked.result.isError && blocked.text.includes('moderation_blocked') && blocked.text.includes('violence'), blocked.text);
}

// 7 — streaming previews.
{
  const b64 = PNG_1PX.toString('base64');
  const stream = await run(
    { ...base, partial_images: 2 },
    sseReply([
      `data: ${JSON.stringify({ type: 'image_generation.partial_image', partial_image_index: 0, b64_json: b64 })}\n\n`,
      `data: ${JSON.stringify({ type: 'image_generation.partial_image', partial_image_index: 1, b64_json: b64 })}\n\n`,
      `data: ${JSON.stringify({ type: 'image_generation.completed', data: [{ b64_json: b64 }] })}\n\n`,
      'data: [DONE]\n\n',
    ]),
  );
  check('stream sends stream:true and partial_images', stream.call.json.stream === true && stream.call.json.partial_images === 2);
  check('stream reports preview progress', stream.reports.some((r) => String(r.message).includes('1/2')), JSON.stringify(stream.reports));
  check('stream saves the final image', stream.result.isError !== true && stream.text.includes('.png'), stream.text);
  check('preview scratch dir is cleaned up', !readdirSync(join(storagePath, 'images')).includes('.preview'));

  const partialOnly = await run(
    { ...base, partial_images: 1 },
    sseReply([`data: ${JSON.stringify({ type: 'image_generation.partial_image', partial_image_index: 0, b64_json: b64 })}\n\n`]),
  );
  check('preview-only stream still returns an image', partialOnly.result.isError !== true && partialOnly.text.includes('.png'), partialOnly.text);
  check('preview-only stream warns about it', partialOnly.text.split('\n').some((line) => line.startsWith('!')), partialOnly.text);

  const streamed = await run({ ...base, partial_images: 2, n: 2 });
  check('previews are skipped when n > 1', streamed.call.json.stream === undefined && streamed.call.json.partial_images === undefined);
}

// 8 — misc plumbing.
{
  const relay = await run({ ...base, base_url: 'https://relay.example.com/v1/' });
  check('base_url override is applied and trimmed', relay.call.url === 'https://relay.example.com/v1/images/generations', relay.call.url);
  const badUrl = await run({ ...base, base_url: 'not-a-url' });
  check('invalid base_url is rejected', badUrl.result.isError === true && calls.length === 0);
  const safety = await run({ ...base, safety_identifier: 'x'.repeat(200) });
  check('safety_identifier is capped at 128 chars', safety.call.json.safety_identifier.length === 128);
  const named = await run({ ...base, output_name: '咖啡 海报!' });
  check('non-ascii output_name falls back to the default prefix', named.text.split('\n').pop().includes('/image-gen-'), named.text.split('\n').pop());
  const named2 = await run({ ...base, output_name: 'coffee poster v2' });
  check('output_name is sanitized to a safe prefix', named2.text.split('\n').pop().includes('/coffee-poster-v2-'), named2.text.split('\n').pop());
  check('resolveModel keeps unknown ids verbatim', resolveModel('gpt-image-2') === 'gpt-image-2' && resolveModel('') === 'gpt-image-2.5-sunburst');
}

rmSync(storagePath, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);

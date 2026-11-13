/**
 * Host-free smoke test for finch-image-gen.
 *
 * `activate()` only needs `ctx`, and every request goes through the pack's own
 * transport, so a fake host plus a stubbed transport can drive the real `image_gen_create`
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
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activate, checkSize, formatApiError, readImageSize, registerIcons, resolveModel, setTransport, resolveProxy, needsImage26, image26Sibling } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let failures = 0;
/** Replies the fake App View panel received, readable across test blocks. */
let panelSent = [];
/** Panel message helper, wired up once the fake panel is attached below. */
let ask;
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
  const panelHandlers = [];
  const previews = [];
  const menus = { composer: {}, settings: null, notifyUpdates: 0 };
  // App View cannot attach to a Composer, so it sends into a Session instead.
  const sessions = { created: 0, sent: [], opened: [] };
  // Icons only render when the pack is registered at runtime, not merely declared.
  const icons = { packs: {} };
  let sessionCount = 0;
  const ctx = {
    storagePath,
    subscriptions: { push() {} },
    api: { supports: (path) => path.startsWith('sessions.') },
    navigation: {
      async openSession(sessionId) { sessions.opened.push(sessionId); },
    },
    sessions: {
      async create() {
        sessionCount += 1;
        sessions.created += 1;
        return { sessionId: `sess-${sessionCount}`, owner: { type: 'minitool', minitoolId: 'image-gen' }, placement: { type: 'chat' }, activity: 'interactive' };
      },
      async get(sessionId) {
        return sessions.opened.includes(sessionId) || sessions.sent.some((item) => item.sessionId === sessionId)
          ? { sessionId }
          : undefined;
      },
      async send(sessionId, message) {
        if (sessions.failSend) throw new Error('send refused');
        if (sessions.sent.some((item) => item.message.idempotencyKey === message.idempotencyKey)) {
          return { sessionId, turnId: 't0', clientMessageId: 'c0', state: 'duplicate', queued: false, pendingCount: 0 };
        }
        sessions.sent.push({ sessionId, message });
        return { sessionId, turnId: `turn-${sessions.sent.length}`, clientMessageId: `client-${sessions.sent.length}`, state: 'accepted', queued: false, pendingCount: 1 };
      },
    },
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
        menus.composer[id] = handlers;
        return { dispose() {}, notifyUpdate() { menus.notifyUpdates += 1; } };
      },
    },
    settingsMenu: {
      register(handlers) {
        menus.settings = handlers;
      },
    },
    icons: {
      register(packId, entries) {
        icons.packs[packId] = entries;
        return { dispose() {} };
      },
    },
    ui: {
      async showModalDialog() { return { action: 'dismissed' }; },
      onDidOpenPanel(handler) {
        panelHandlers.push(handler);
      },
      async openFilePreview(filePath) {
        previews.push(filePath);
      },
    },
  };
  return { ctx, registered, menus, store, panelHandlers, previews, sessions, icons };
}

function makeExec() {
  const reports = [];
  activeReports = reports;
  return {
    reports,
    exec: {
      signal: undefined,
      sessionId: 'sess-1',
      spaceId: '',
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

/** 2×2 GIF: header + logical screen descriptor, enough to read a size from. */
const GIF_2X2 = Buffer.concat([
  Buffer.from('GIF89a', 'ascii'),
  Buffer.from([0x02, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x3b]),
]);

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let calls = [];
let nextResponse = null;
/** Progress reports of the run in flight, so the stub can time them. */
let activeReports = [];

function jsonReply(body, init = {}) {
  return {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    async json() { return body; },
  };
}

/**
 * The host's global fetch is not used any more (it cannot take a proxy
 * dispatcher), so the suite drives the pack's exported transport hook instead.
 * `nextThrows` simulates a request that dies before any response arrives.
 */
let nextThrows = null;

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

setTransport(async (url, init) => {
  const record = { url: String(url), init: init ?? {} };
  record.dispatcher = init?.dispatcher;
  if (record.init.body && typeof record.init.body === 'string') {
    record.json = JSON.parse(record.init.body);
  }
  if (record.init.body && typeof record.init.body !== 'string' && typeof record.init.body.get === 'function') {
    record.form = Object.fromEntries(record.init.body.entries());
    // fromEntries collapses repeated keys, so keep the pairs too.
    record.formEntries = [...record.init.body.entries()];
    record.formKeys = record.init.body.getAll ? record.init.body.getAll('image[]').length : 0;
  }
  // How many progress reports existed when the request went out: preparation
  // must not have claimed to be drawing anything yet.
  record.reportsBeforeSend = activeReports.length;
  calls.push(record);
  if (nextThrows) {
    const error = nextThrows;
    nextThrows = null;
    throw error;
  }
  return nextResponse;
});

// ── run ──────────────────────────────────────────────────────────────────────

const storagePath = mkdtempSync(join(tmpdir(), 'image-gen-smoke-'));
const { ctx, registered, menus, store, panelHandlers, previews, sessions, icons } = makeCtx(storagePath);
activate(ctx);

const tool = registered.image_gen_create;
check('tool image_gen_create is registered', !!tool);
check('no initial progress component before image generation starts', tool.progressMode === undefined);

/** Stand in for a gallery webview so the panel bridge can be driven end to end. */
function makePanel(view = 'appView', sessionId = '') {
  const sent = [];
  const handlers = [];
  const panel = {
    view,
    sessionId,
    revealed: 0,
    async reveal() { panel.revealed += 1; },
    async postMessage(message) { sent.push(message); },
    onDidReceiveMessage(handler) { handlers.push(handler); return { dispose() {} }; },
    onDidDispose() { return { dispose() {} }; },
  };
  return { panel, sent, handlers };
}

/** Panel messages are handled fire-and-forget, so wait for the reply instead. */
async function until(predicate) {
  for (let i = 0; i < 300 && !predicate(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

async function run(input, reply) {
  calls = [];
  nextThrows = null;
  nextResponse = reply ?? jsonReply({ data: [{ b64_json: PNG_1PX.toString('base64') }] });
  const { exec, reports } = makeExec();
  const result = await tool.execute(input, exec);
  return { result, text: result.content[0]?.text ?? '', call: calls[0], reports };
}

const base = { prompt: 'a red square' };

// 1 — defaults: the cheapest combination, and only the broadly supported knobs.
{
  const { call, text, reports } = await run(base);
  check('default model is the cheap gpt-image-2.6-flare', call.json.model === 'gpt-image-2.6-flare', call.json.model);
  check('default size/quality are the cheap 1024x1024 / low', call.json.size === '1024x1024' && call.json.quality === 'low', `${call.json.size} ${call.json.quality}`);
  check('optional knobs stay omitted', call.json.background === undefined && call.json.output_format === undefined && call.json.moderation === undefined);
  check('hits /images/generations', call.url.endsWith('/v1/images/generations'), call.url);
  check('result lists a saved file', text.includes('.png') && text.includes('model: gpt-image-2.6-flare'), text.slice(0, 120));
  // Finch draws its dedicated image-generation animation for this kind, sized
  // from the requested pixels — a plain progress bar reads as generic work.
  check('progress asks for the image component', reports[0]?.kind === 'image' && reports[0]?.stage === 'generating', JSON.stringify(reports[0]));
  check('the image component carries the pixel size', JSON.stringify(reports[0]?.image?.resolution) === '[1024,1024]', JSON.stringify(reports[0]?.image));
  // The first report goes out *with* the request: while the tool is still
  // reading and uploading local inputs nothing is being drawn, so no image
  // component is claimed (a report at the top of the call would make this 2).
  check('drawing is only claimed once the request is on the wire', call.reportsBeforeSend === 1, String(call.reportsBeforeSend));
}

// 1b — an auto size has no pixels to badge yet, but it is still generation.
{
  const { reports } = await run({ ...base, size: 'auto' });
  check('an auto size still shows the image component', reports[0]?.kind === 'image', JSON.stringify(reports[0]));
  check('an auto size has no resolution badge', reports[0]?.image === undefined, JSON.stringify(reports[0]?.image));
}

// 1c — an edit is generation too, and it carries the same badge.
{
  const ref = join(storagePath, 'reference.png');
  writeFileSync(ref, PNG_1PX);
  const { reports } = await run({ ...base, reference_image_paths: [ref], size: '768x1024' });
  check('editing reports the image component', reports[0]?.kind === 'image' && reports[0]?.stage === 'editing', JSON.stringify(reports[0]));
  check('editing badges the requested size', JSON.stringify(reports[0]?.image?.resolution) === '[768,1024]', JSON.stringify(reports[0]?.image));
}

// 2 — stored defaults from the settings menu win over the built-in default.
{
  await store.set('defaultModel', 'gpt-image-2.5-flare');
  await store.set('defaultQuality', 'high');
  const { call } = await run(base);
  check('stored default model is used', call.json.model === 'gpt-image-2.5-flare', call.json.model);
  check('stored default quality is used', call.json.quality === 'high', call.json.quality);
  const alias = await run({ prompt: 'x', model: 'sunburst' });
  check('model shorthand sunburst resolves to the current generation', alias.call.json.model === 'gpt-image-2.6-sunburst', alias.call.json.model);
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

// 4b — transparency and file type: the pair the caller is expected to choose.
{
  const webp = await run({ ...base, background: 'transparent', output_format: 'webp' });
  check('transparent keeps webp', webp.call.json.background === 'transparent' && webp.call.json.output_format === 'webp', JSON.stringify(webp.call.json));

  const jpeg = await run({ ...base, background: 'transparent', output_format: 'jpeg' });
  check('transparent refuses jpeg and falls back to png', jpeg.call.json.output_format === 'png' && jpeg.call.json.background === 'transparent', JSON.stringify(jpeg.call.json));
  check('the jpeg fallback is reported, not hidden', jpeg.text.split('\n').some((line) => line.startsWith('!')), jpeg.text);

  const opaque = await run({ ...base, background: 'opaque' });
  check('an explicit opaque background is forwarded', opaque.call.json.background === 'opaque', JSON.stringify(opaque.call.json));
  check('opaque does not force a format', opaque.call.json.output_format === undefined, JSON.stringify(opaque.call.json));

  const auto = await run({ ...base, background: 'auto' });
  check('auto is the endpoint default and stays unsent', auto.call.json.background === undefined, JSON.stringify(auto.call.json));

  // jpeg is a first-class photo format: compression goes with it, transparency never does.
  const photo = await run({ ...base, output_format: 'jpeg', output_compression: 70 });
  check('jpeg carries its compression level', photo.call.json.output_format === 'jpeg' && photo.call.json.output_compression === 70, JSON.stringify(photo.call.json));
  check('jpeg saves a .jpg file', photo.text.includes('.jpg'), photo.text);
  check('jpeg never asks for transparent', photo.call.json.background === undefined, JSON.stringify(photo.call.json));

  const compressedPng = await run({ ...base, output_compression: 70 });
  check('png ignores compression', compressedPng.call.json.output_compression === undefined, JSON.stringify(compressedPng.call.json));

  // The same rules hold on an edit, where the input image is the reference.
  const refPath = join(storagePath, 'ref.png');
  writeFileSync(refPath, PNG_1PX);
  const editJpeg = await run({ ...base, reference_image_paths: [refPath], background: 'transparent', output_format: 'jpeg' });
  check('an edit follows the same transparency rule', editJpeg.call.form.output_format === 'png' && editJpeg.call.form.background === 'transparent', JSON.stringify(editJpeg.call.form));
  const editWebp = await run({ ...base, reference_image_paths: [refPath], output_format: 'webp', output_compression: 55 });
  check('an edit keeps webp and its compression', editWebp.call.form.output_format === 'webp' && editWebp.call.form.output_compression === '55', JSON.stringify(editWebp.call.form));
}

// 5 — edits, masks and n.
{
  const refPath = join(storagePath, 'ref.png');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(refPath, PNG_1PX);
  const { call } = await run({ ...base, reference_image_paths: [refPath], mask_path: refPath, n: 9 });
  check('edits go to /images/edits', call.url.endsWith('/v1/images/edits'), call.url);
  check('an edit reads its reference image before claiming to draw', call.reportsBeforeSend === 1, String(call.reportsBeforeSend));
  check('reference image is attached', call.formKeys === 1, String(call.formKeys));
  check('mask is attached', call.form.mask !== undefined && call.form.mask.name === 'ref.png', JSON.stringify(call.form.mask));
  check('n passes through up to 10', call.form.n === '9', call.form.n);
  const lots = await run({ ...base, reference_image_paths: [refPath], n: 99 });
  check('n is clamped to 10', lots.call.form.n === '10', lots.call.form.n);
  const noRef = await run({ ...base, mask_path: refPath });
  check('mask without references is rejected', noRef.result.isError === true && calls.length === 0, noRef.text);
  const missing = await run({ ...base, reference_image_paths: [join(storagePath, 'nope.png')] });
  check('missing reference file is reported', missing.result.isError === true && calls.length === 0);

  // Several references travel as repeated `image[]` parts, in the order given.
  const secondPath = join(storagePath, 'ref-2.png');
  await writeFile(secondPath, PNG_1PX);
  const multi = await run({ ...base, reference_image_paths: [refPath, secondPath] });
  check('every reference image is attached', multi.call.formKeys === 2, String(multi.call.formKeys));
  check('references keep their order and names', JSON.stringify(multi.call.formEntries.filter(([key]) => key === 'image[]').map(([, file]) => file.name)) === '["ref.png","ref-2.png"]', JSON.stringify(multi.call.formEntries.map(([key]) => key)));
  const many = Array.from({ length: 17 }, () => refPath);
  const tooMany = await run({ ...base, reference_image_paths: many });
  check('more than 16 references is refused before any request', tooMany.result.isError === true && tooMany.text.includes('16') && calls.length === 0, tooMany.text);

  // Markup: a transparent overlay that guides the edit of the first image.
  const markupPath = join(storagePath, 'markup.png');
  await writeFile(markupPath, PNG_1PX);
  const markup = await run({ ...base, reference_image_paths: [refPath], markup_path: markupPath });
  check('markup travels as its own form part', markup.call.form.markup !== undefined && markup.call.form.markup.name === 'markup.png', JSON.stringify(markup.call.form.markup));
  check('markup is reported back in the result', markup.text.includes('markup: yes'), markup.text);
  const markupNoRef = await run({ ...base, markup_path: markupPath });
  check('markup without a reference image is rejected', markupNoRef.result.isError === true && calls.length === 0, markupNoRef.text);
  const bothGuides = await run({ ...base, reference_image_paths: [refPath], markup_path: markupPath, mask_path: refPath });
  check('markup and mask cannot be combined', bothGuides.result.isError === true && calls.length === 0, bothGuides.text);
  const ghostMarkup = await run({ ...base, reference_image_paths: [refPath], markup_path: join(storagePath, 'nope-markup.png') });
  check('a missing markup file is reported', ghostMarkup.result.isError === true && calls.length === 0);

  // Planning effort is a separate knob: forwarded only when asked for.
  const planned = await run({ ...base, complexity: 'high' });
  check('complexity is forwarded when asked for', planned.call.json.complexity === 'high', JSON.stringify(planned.call.json.complexity));
  const unplanned = await run(base);
  check('complexity stays out of the request by default', unplanned.call.json.complexity === undefined, JSON.stringify(unplanned.call.json.complexity));
  const bogus = await run({ ...base, complexity: 'extreme' });
  check('an unknown complexity is dropped rather than sent', bogus.call.json.complexity === undefined, JSON.stringify(bogus.call.json.complexity));
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
  check('a preview also shows the image component', stream.reports.filter((r) => String(r.message).includes('/2')).every((r) => r.kind === 'image' && JSON.stringify(r.image?.resolution) === '[1024,1024]'), JSON.stringify(stream.reports));
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
  check('resolveModel keeps unknown ids verbatim', resolveModel('gpt-image-2') === 'gpt-image-2' && resolveModel('') === 'gpt-image-2.6-flare');
  check('a bare family name maps to the fallback model', resolveModel('gpt-image-2.6') === 'gpt-image-2.6-flare' && resolveModel('gpt-image-2.5') === 'gpt-image-2.6-flare', resolveModel('gpt-image-2.6'));
}

// 9 — the gallery: what gets recorded, and the panel bridge.
{
  const galleryFile = join(storagePath, 'gallery.json');
  const fresh = await run({ prompt: 'a blue circle', quality: 'medium', size: '1536x1024' });
  const filePath = fresh.text.split('\n').pop().trim();
  const gallery = JSON.parse(readFileSync(galleryFile, 'utf8'));
  const record = gallery.find((item) => item.filePath === filePath);
  check('generation is recorded in gallery.json', !!record, galleryFile);
  check('record carries the badge data', record.model === 'gpt-image-2.6-flare' && record.quality === 'medium' && record.size === '1536x1024', JSON.stringify(record).slice(0, 160));
  check('record carries the real pixel size', record.width === 1 && record.height === 1, `${record.width}x${record.height}`);
  check('record carries the session it came from', record.sessionId === 'sess-1' && record.prompt === 'a blue circle');
  check('newest record is first', gallery[0].filePath === filePath);
  check('readImageSize reads the PNG header', readImageSize(PNG_1PX, 'png').width === 1);
  check('readImageSize shrugs at unknown formats', readImageSize(Buffer.from('nope'), 'png').width === 0);

  const { panel, sent, handlers } = makePanel('appView', '');
panelSent = sent;
  panelHandlers[0](panel);
  // The push reads gallery.json, so wait for the message instead of one tick.
  for (let i = 0; i < 200 && !sent.some((m) => m.type === 'gallery'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const pushed = sent.find((message) => message.type === 'gallery');
  check('opening a panel pushes the gallery', !!pushed && Array.isArray(pushed.data) && pushed.data.length === gallery.length, JSON.stringify(sent.map((m) => m.type)));
  check('the push carries the view env', pushed.env.view === 'appView' && pushed.env.locale === 'en-US', JSON.stringify(pushed.env));

  // The host fires the panel message handler without awaiting it, so the smoke
  // test has to wait for the reply it produces rather than for the call itself.
  ask = async (message, expect) => {
    const before = sent.length;
    await handlers[0](message);
    for (let i = 0; i < 200; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (!expect || sent.slice(before).some((item) => item.type === expect)) return;
    }
  };

  await ask({ type: 'requestImage', filePath }, 'imageData');
  const imageMessage = sent.find((message) => message.type === 'imageData');
  check('image bytes cross the bridge as a data URL', imageMessage?.dataUrl?.startsWith('data:image/png;base64,'), JSON.stringify(imageMessage).slice(0, 80));
  check('the reply says it is the original', imageMessage?.variant === 'full', String(imageMessage?.variant));
  await ask({ type: 'requestImage', filePath: join(storagePath, 'ghost.png') }, 'imageData');
  check('unreadable image is reported, not thrown', sent.some((m) => m.type === 'imageData' && m.error === 'unreadable'));

  // Thumbnails: the grid asks for one and gets the original until it exists.
  const beforeThumb = sent.length;
  await ask({ type: 'requestImage', filePath, variant: 'thumb' }, 'imageData');
  const noThumbYet = sent.slice(beforeThumb).find((m) => m.type === 'imageData');
  check('without a thumbnail the original is sent instead', noThumbYet?.variant === 'full' && noThumbYet?.dataUrl.startsWith('data:image/png;base64,'), JSON.stringify(noThumbYet).slice(0, 60));

  const tinyWebp = `data:image/webp;base64,${Buffer.from('RIFF____WEBPVP8 '.repeat(8)).toString('base64')}`;
  /** The thumbnail folder only exists once something has been kept; a write in
   * flight may still be a `.tmp` file, which is not a kept thumbnail yet. */
  const thumbFiles = () => { try { return readdirSync(join(storagePath, 'thumbs')).filter((name) => name.endsWith('.webp')); } catch { return []; } };
  await handlers[0]({ type: 'saveThumb', filePath, dataUrl: tinyWebp });
  await until(() => thumbFiles().length > 0);
  const thumbs = thumbFiles();
  check('a kept thumbnail is written next to the index', thumbs.length === 1 && thumbs[0].endsWith('.webp'), thumbs.join(','));

  const beforeKept = sent.length;
  await ask({ type: 'requestImage', filePath, variant: 'thumb' }, 'imageData');
  const keptReply = sent.slice(beforeKept).find((m) => m.type === 'imageData');
  check('the kept thumbnail is what the grid gets', keptReply?.variant === 'thumb' && keptReply?.dataUrl === tinyWebp, JSON.stringify(keptReply).slice(0, 60));

  await handlers[0]({ type: 'saveThumb', filePath, dataUrl: 'data:image/png;base64,AAAA' });
  check('only a webp thumbnail is kept', thumbFiles().length === 1);
  await handlers[0]({ type: 'saveThumb', filePath: join(storagePath, 'ghost.png'), dataUrl: tinyWebp });
  check('a thumbnail for an unknown image is ignored', thumbFiles().length === 1);
  await handlers[0]({ type: 'saveThumb', filePath, dataUrl: `data:image/webp;base64,${Buffer.alloc(600 * 1024).toString('base64')}` });
  check('an oversized thumbnail is refused', thumbFiles().length === 1);

  // The marked preview: the page draws it, so it hands us the bytes and a quote
  // can point at one file instead of a second image riding as an attachment.
  const annotatedFiles = () => { try { return readdirSync(join(storagePath, 'annotated')); } catch { return []; } };
  const marked = Buffer.alloc(200, 7).toString('base64');
  const beforeMarked = sent.length;
  await handlers[0]({ type: 'saveAnnotated', id: record.id, content: marked });
  await until(() => annotatedFiles().length > 0);
  const markedFiles = annotatedFiles();
  const markedReply = sent.slice(beforeMarked).find((m) => m.type === 'annotatedSaved');
  check('the marked preview is written as one png', markedFiles.length === 1 && markedFiles[0].endsWith('.png'), markedFiles.join(','));
  check('the saved preview path comes back to the page', typeof markedReply?.path === 'string' && markedReply.path.endsWith(markedFiles[0]), JSON.stringify(markedReply).slice(0, 60));
  check('the marked preview is readable where it landed', readFileSync(markedReply.path).length === 200);
  await handlers[0]({ type: 'saveAnnotated', id: record.id, content: marked });
  check('the same bytes reuse the same snapshot', annotatedFiles().length === 1);
  // The editor clears its marks after a successful insert, which produces a new
  // (clean) preview. That must land in its own snapshot, or the reference already
  // sitting in the input box would lose the marks it was inserted with.
  await handlers[0]({ type: 'saveAnnotated', id: record.id, content: Buffer.alloc(300, 9).toString('base64') });
  await until(() => annotatedFiles().length === 2);
  check('a later edit writes its own snapshot', annotatedFiles().length === 2, annotatedFiles().join(','));
  check('the inserted preview keeps its marks', readFileSync(markedReply.path).length === 200);
  const beforeUnknown = annotatedFiles().length;
  await handlers[0]({ type: 'saveAnnotated', id: 'no-such-record', content: marked });
  check('a preview for an unknown image is ignored', annotatedFiles().length === beforeUnknown);
  await handlers[0]({ type: 'saveAnnotated', id: record.id, content: Buffer.alloc(13 * 1024 * 1024, 1).toString('base64') });
  check('an oversized preview is refused', annotatedFiles().length === beforeUnknown && readFileSync(markedReply.path).length === 200);
  for (let size = 400; size < 406; size++) await handlers[0]({ type: 'saveAnnotated', id: record.id, content: Buffer.alloc(size, 3).toString('base64') });
  await until(() => annotatedFiles().length === 3);
  check('old snapshots are pruned so disk use stays flat', annotatedFiles().length === 3, annotatedFiles().join(','));

  await ask({ type: 'openPreview', filePath });
  check('preview falls back to the host API', previews.includes(filePath), JSON.stringify(previews));

  await ask({ type: 'saveNote', id: record.id, note: 'warmer light please' }, 'noteSaved');
  const afterNote = JSON.parse(readFileSync(galleryFile, 'utf8')).find((item) => item.id === record.id);
  check('a note is persisted', afterNote?.note === 'warmer light please', afterNote?.note);
  check('note save is acknowledged', sent.some((m) => m.type === 'noteSaved' && m.id === record.id));

  const annotations = {
    version: 1,
    strokes: [{ id: 'stroke-1', width: .004, points: [{ x: .1, y: .2 }, { x: .6, y: .7 }] }],
    comments: [{ id: 'comment-1', x: .25, y: .4, text: 'warmer light' }, { id: 'comment-2', x: .8, y: .6, text: 'keep this shape' }],
  };
  await ask({ type: 'saveAnnotations', id: record.id, requestId: 'save-1', annotations, note: 'keep composition' }, 'annotationsSaved');
  const savedAnnotations = JSON.parse(readFileSync(galleryFile, 'utf8')).find((item) => item.id === record.id);
  check('freehand and multiple comments are persisted with normalized geometry', JSON.stringify(savedAnnotations.annotations) === JSON.stringify(annotations));
  check('annotation save acknowledgements correlate to the draft', sent.some((m) => m.type === 'annotationsSaved' && m.requestId === 'save-1'));
  const invalid = structuredClone(annotations);
  invalid.comments[0].x = 500;
  await ask({ type: 'saveAnnotations', id: record.id, annotations: invalid }, 'panelError');
  check('pixel coordinates are rejected rather than persisted', JSON.parse(readFileSync(galleryFile, 'utf8')).find((item) => item.id === record.id).annotations.comments[0].x === .25);
  await Promise.all([
    ask({ type: 'saveAnnotations', id: record.id, annotations, note: 'concurrent save' }, 'annotationsSaved'),
    run({ prompt: 'generated during annotation autosave' }),
  ]);
  const concurrent = JSON.parse(readFileSync(galleryFile, 'utf8'));
  check('autosave and generation cannot overwrite each other', concurrent.some((item) => item.prompt === 'generated during annotation autosave') && concurrent.find((item) => item.id === record.id).note === 'concurrent save');

  await ask({ type: 'deleteRecord', id: record.id, deleteFile: false }, 'deleteResult');
  check('delete keeps the file when not asked to', JSON.parse(readFileSync(galleryFile, 'utf8')).every((item) => item.id !== record.id) && readFileSync(filePath).length > 0);

  const doomed = await run({ prompt: 'doomed' });
  const doomedPath = doomed.text.split('\n').pop().trim();
  const doomedId = JSON.parse(readFileSync(galleryFile, 'utf8')).find((item) => item.filePath === doomedPath)?.id;
  check('the next generation is recorded again', !!doomedId, doomedPath);
  await ask({ type: 'deleteRecord', id: doomedId, deleteFile: true }, 'deleteResult');
  let fileGone = false;
  try { readFileSync(doomedPath); } catch { fileGone = true; }
  check('delete removes the file when asked', fileGone);

  // A live panel must hear about new generations without asking.
  const before = sent.length;
  await run({ prompt: 'pushed automatically' });
  check('a new generation broadcasts to open panels', sent.slice(before).some((m) => m.type === 'gallery'));
}

// 10 — which menu owns which setting, and do the icons actually exist.
{
  const composerMenu = await menus.composer['image-gen-settings'].getMenu({});
  const composerIds = composerMenu.map((item) => item.id);
  const settingsItems = await menus.settings.getMenu({ surface: 'toolcase', minitoolId: 'image-gen' });
  const settingsIds = settingsItems.map((item) => item.id);
  check('Composer menu holds the generation defaults', composerIds.join(',') === 'set-model,set-quality,set-size', composerIds.join(','));
  check('Composer menu no longer offers the endpoint', !composerIds.includes('set-api-key') && !composerIds.includes('set-base-url'));
  check('Toolcase settings menu holds the endpoint', settingsIds.join(',') === 'set-api-key,set-base-url,set-proxy,test-connection', settingsIds.join(','));
  check('key status is reported in the settings menu', settingsItems[0].description === locale['status.notSet'], settingsItems[0].description);
  check('the proxy row says when nothing is configured', settingsItems[2].description === locale['proxy.direct'], settingsItems[2].description);
  check('the test row explains itself before the first run', settingsItems[3].description === locale['menu.test.desc'], settingsItems[3].description);

  // Submenus instead of a dialog: one hover, one click, no confirm step.
  const modelRow = composerMenu.find((item) => item.id === 'set-model');
  const qualityRow = composerMenu.find((item) => item.id === 'set-quality');
  const sizeRow = composerMenu.find((item) => item.id === 'set-size');
  check('model, quality and size are submenus', [modelRow, qualityRow, sizeRow].every((row) => Array.isArray(row.children) && row.children.length > 1));
  check('every submenu row carries its own id', [modelRow, qualityRow, sizeRow].every((row) => row.children.every((child) => typeof child.id === 'string' && child.id.includes(':'))));
  check('no submenu row is left unlabelled', [modelRow, qualityRow, sizeRow].every((row) => row.children.every((child) => typeof child.label === 'string' && child.label.length > 0)));
  check('the current value is marked in each submenu', [modelRow, qualityRow, sizeRow].every((row) => row.children.filter((child) => child.current).length === 1));
  check('size offers the aspect-ratio presets', sizeRow.children.map((child) => child.description).join(',') === '1:1,3:4,9:16,4:3,16:9,auto', sizeRow.children.map((child) => child.description).join(','));
  // Offering a size the tool would reject would be a trap.
  const offered = sizeRow.children.map((child) => child.id.replace(/^size:/, ''));
  check('every offered size passes local validation', offered.every((value) => checkSize(value).ok), offered.filter((value) => !checkSize(value).ok).join(','));
  // Long model names made the menu unreadable: the row is the variant name with
  // its family as the trailing text, and the explanation moved to hover.
  const expectedModels = [
    `${locale['model.flare']}|Image 2.6`,
    `${locale['model.sunburst']}|Image 2.6`,
    `${locale['model.flare']}|Image 2.5`,
    `${locale['model.sunburst']}|Image 2.5`,
    `${locale['model.previous']}|Image 2`,
    `${locale['model.legacy']}|Image 1.5`,
  ].join(',');
  const modelRows = modelRow.children.map((child) => `${child.label}|${child.description}`).join(',');
  check('model rows are the variant plus its family', modelRows === expectedModels, modelRows);
  check('the model row still names the current model inline', modelRow.description.length > 0);
  // Menus stay quiet: rows explain themselves inline, never with a tooltip that
  // covers the neighbouring rows.
  const everyRow = [...composerMenu, ...composerMenu.flatMap((item) => item.children ?? []), ...settingsItems]
    .concat(settingsItems.flatMap((item) => item.children ?? []));
  check('no menu row carries a hover tooltip', everyRow.every((item) => item.hoverText === undefined), everyRow.filter((item) => item.hoverText !== undefined).map((item) => item.id).join(','));
  check('the model row shows the short name', modelRow.description === locale['model.flare'], modelRow.description);
  await store.set('defaultModel', 'my-relay-model');
  const relayMenu = await menus.composer['image-gen-settings'].getMenu({});
  check('a relay model id has no short name and keeps its own', relayMenu.find((item) => item.id === 'set-model').description === 'my-relay-model', relayMenu.find((item) => item.id === 'set-model').description);
  await store.delete('defaultModel');

  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).finch.contributes;
  const declared = Object.keys(manifest.icons ?? {});
  const used = [...composerMenu, ...composerMenu.flatMap((item) => item.children ?? []), ...settingsItems]
    .map((item) => item.iconName)
    .filter(Boolean)
    .concat([manifest.appPanel.icon, manifest.appView.icon, manifest.settingsMenu.icon, manifest.composerActions[0].icon]);
  // `ext:id` and `ext:<packId>/id` both have to land on a declared icon.
  const bareIconId = (ref) => String(ref).replace(/^ext:/, '').split('/').pop();
  const unresolved = used.filter((ref) => !String(ref).startsWith('ext:')).concat(
    used.map(bareIconId).filter((id) => !declared.includes(id)),
  );
  check('every icon reference is an ext: id declared in the manifest', unresolved.length === 0, unresolved.join(', '));
  const missingFiles = declared.filter((id) => !existsSync(join(root, manifest.icons[id].svg)));
  check('every declared icon ships a real SVG', missingFiles.length === 0, missingFiles.join(', '));

  // Declaring the pack only reserves the namespace: without a runtime
  // registration every reference and every shared side render nothing at all.
  const registeredIcons = icons.packs[manifest.iconPacks[0].id] ?? {};
  const registeredIds = Object.keys(registeredIcons);
  check('the icon pack is registered at runtime', registeredIds.length === Object.keys(manifest.icons).length, `${registeredIds.length}/${Object.keys(manifest.icons).length}`);
  check('every referenced icon id is registered', used.map(bareIconId).every((id) => registeredIds.includes(id)), used.filter((ref) => !registeredIds.includes(bareIconId(ref))).join(', '));
  check('registered icons carry real SVG markup', registeredIds.every((id) => registeredIcons[id].svg.includes('<svg') && /<(path|rect|circle|line|polyline)\b/.test(registeredIcons[id].svg)), registeredIds.filter((id) => !/<(path|rect|circle|line|polyline)\b/.test(registeredIcons[id].svg)).join(', '));
  check('registration does not depend on the manifest file map', registerIcons(ctx) === registeredIds.length, String(registerIcons(ctx)));
}

// 11 — the stored default size behaves like the other defaults.
{
  await store.set('defaultSize', '1536x1024');
  const stored = await run(base);
  check('stored default size is used', stored.call.json.size === '1536x1024', stored.call.json.size);
  const explicit = await run({ ...base, size: '1024x1536' });
  check('an explicit size still wins over the default', explicit.call.json.size === '1024x1536', explicit.call.json.size);
  await store.set('defaultSize', 'nonsense');
  const broken = await run(base);
  check('a broken stored default falls back instead of failing the call', broken.call.json.size === '1024x1024', broken.call.json.size);
  await store.delete('defaultSize');
}

// 12 — an App View edit has no Composer, so it is sent into a Session instead.
{
  const galleryFile = join(storagePath, 'gallery.json');
  const replies = () => panelSent.filter((message) => message.type === 'annotationSendResult');
  const fresh = await run({ prompt: 'send target' });
  const targetPath = fresh.text.split('\n').pop().trim();
  const targetId = JSON.parse(readFileSync(galleryFile, 'utf8')).find((item) => item.filePath === targetPath).id;
  const targetName = basename(targetPath);
  const evidence = PNG_1PX.toString('base64');
  const sendsBefore = sessions.sent.length;

  await ask({ type: 'sendToSession', id: targetId, requestId: 'send-1', evidence, text: 'warm light please', idempotencyKey: 'attempt-1' }, 'annotationSendResult');
  const sent = sessions.sent.at(-1);
  check('an App View edit is sent into a session this mini tool owns', sessions.sent.length === sendsBefore + 1 && !!sent?.sessionId, JSON.stringify(replies()));
  check('the user is taken to that session', sessions.opened.at(-1) === sent.sessionId, JSON.stringify(sessions.opened));
  check('the send is acknowledged with the session id', replies().at(-1)?.sessionId === sent.sessionId && !replies().at(-1)?.error, JSON.stringify(replies().at(-1)));
  check('the original and the marked preview are both attached', sent.message.attachments.length === 2, JSON.stringify(sent.message.attachments.map((item) => item.name)));
  check('the image to edit is attached first', sent.message.attachments[0].name === targetName && sent.message.attachments[0].kind === 'image');
  check('the marked preview is attached second as a PNG', sent.message.attachments[1].name === `${targetName.replace(/\.png$/, '')}-annotated.png` && sent.message.attachments[1].mimeType === 'image/png');
  check('the marked preview travels as raw base64', sent.message.attachments[1].data === evidence);
  check('the page-authored text is sent verbatim', sent.message.text === 'warm light please', sent.message.text);
  const persisted = JSON.parse(readFileSync(galleryFile, 'utf8')).find((item) => item.id === targetId);
  check('the session is remembered for that image', persisted.annotationSessionId === sent.sessionId, persisted.annotationSessionId);

  await ask({ type: 'sendToSession', id: targetId, evidence, text: 'more contrast', idempotencyKey: 'attempt-2' }, 'annotationSendResult');
  check('a later edit reuses the same session', sessions.sent.at(-1).sessionId === sent.sessionId && sessions.created === 1, `${sessions.sent.at(-1).sessionId} / created ${sessions.created}`);
  check('each attempt carries its own idempotency key', sessions.sent.at(-1).message.idempotencyKey === 'attempt-2');
  await ask({ type: 'sendToSession', id: targetId, evidence, text: 'again', idempotencyKey: 'attempt-2' }, 'annotationSendResult');
  check('a replayed idempotency key is reported instead of faking a new turn', replies().at(-1)?.error === 'duplicate', JSON.stringify(replies().at(-1)));

  await ask({ type: 'sendToSession', id: 'ghost', evidence, text: 'x' }, 'annotationSendResult');
  check('an unknown image is refused', replies().at(-1)?.error === 'not-found');

  sessions.failSend = true;
  await ask({ type: 'sendToSession', id: targetId, evidence, text: 'boom', idempotencyKey: 'attempt-3' }, 'annotationSendResult');
  check('a failed send is reported and keeps the draft retryable', replies().at(-1)?.error === 'send-failed');
  sessions.failSend = false;

  const supports = ctx.api.supports;
  ctx.api.supports = () => false;
  await ask({ type: 'sendToSession', id: targetId, evidence, text: 'x' }, 'annotationSendResult');
  check('hosts without session support say so', replies().at(-1)?.error === 'unsupported');
  ctx.api.supports = supports;
}

// 13 — picking a submenu row saves it directly, with no dialog in the way.
{
  const composerMenu = menus.composer['image-gen-settings'];
  const scoped = { sessionId: 'sess-1', spaceId: '', surface: 'session', cwd: '/tmp' };
  const dialogs = [];
  const dialog = ctx.ui.showModalDialog;
  ctx.ui.showModalDialog = async (spec) => { dialogs.push(spec.title); return { action: 'dismissed' }; };

  await composerMenu.execute(scoped, 'size:1280x720', { composer: {}, navigation: {} });
  check('choosing a size preset stores it directly', (await store.get('defaultSize')) === '1280x720', String(await store.get('defaultSize')));
  await composerMenu.execute(scoped, 'quality:high', { composer: {}, navigation: {} });
  check('choosing a quality stores it directly', (await store.get('defaultQuality')) === 'high', String(await store.get('defaultQuality')));
  await composerMenu.execute(scoped, 'model:gpt-image-2.6-sunburst', { composer: {}, navigation: {} });
  check('choosing a model stores it directly', (await store.get('defaultModel')) === 'gpt-image-2.6-sunburst', String(await store.get('defaultModel')));
  check('no dialog interrupts a submenu pick', dialogs.length === 0, dialogs.join(','));
  const rows = await composerMenu.getMenu(scoped);
  check('the submenu marks what was just chosen', rows.find((item) => item.id === 'set-size').children.find((child) => child.current)?.id === 'size:1280x720');
  check('the parent row shows the chosen value', rows.find((item) => item.id === 'set-size').description === '1280x720', rows.find((item) => item.id === 'set-size').description);

  // A default value is stored as "no override" so the built-in default can change.
  await composerMenu.execute(scoped, 'size:1024x1024', { composer: {}, navigation: {} });
  await composerMenu.execute(scoped, 'quality:low', { composer: {}, navigation: {} });
  await composerMenu.execute(scoped, 'model:gpt-image-2.6-flare', { composer: {}, navigation: {} });
  check('choosing a built-in default clears the override', (await store.get('defaultSize')) === undefined && (await store.get('defaultQuality')) === undefined && (await store.get('defaultModel')) === undefined);

  // Garbage ids must not reach storage.
  await composerMenu.execute(scoped, 'size:1000x1000', { composer: {}, navigation: {} });
  await composerMenu.execute(scoped, 'quality:nonsense', { composer: {}, navigation: {} });
  check('an invalid submenu id is ignored', (await store.get('defaultSize')) === undefined && (await store.get('defaultQuality')) === undefined);

  ctx.ui.showModalDialog = dialog;
}

// 14 — the gallery no longer writes the default size: the editor's size picker
// turns into a line in that edit's instructions instead (covered by ui-smoke).
{
  const sessionPanel = makePanel('session', 'sess-1');
  panelHandlers[0](sessionPanel.panel);
  await until(() => sessionPanel.sent.some((m) => m.type === 'gallery'));
  const env = sessionPanel.sent.find((m) => m.type === 'gallery')?.env ?? {};
  check('the panel env carries no default size', env.defaultSize === undefined, JSON.stringify(env.defaultSize));

  const before = sessionPanel.sent.length;
  await sessionPanel.handlers[0]({ type: 'setDefaultSize', size: '720x1280' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('a stale setDefaultSize from a page is ignored', (await store.get('defaultSize')) === undefined && sessionPanel.sent.length === before, String(await store.get('defaultSize')));
}

// 15 — the App View hands the image over to the Session it came from.
{
  const appView = makePanel('appView', '');
  panelHandlers[0](appView.panel);
  const sessionPanel = makePanel('session', 'sess-1');
  panelHandlers[0](sessionPanel.panel);
  const records = JSON.parse(readFileSync(join(storagePath, 'gallery.json'), 'utf8'));
  const record = records[0];
  // The panel's own gallery push can land between these replies, so match on
  // the message type rather than on what happened to arrive last.
  const adjustment = (from) => appView.sent.slice(from).find((m) => m.type === 'adjustResult');

  const unknown = appView.sent.length;
  await appView.handlers[0]({ type: 'adjustImage', id: 'no-such-image' });
  await until(() => adjustment(unknown));
  check('an unknown image cannot be adjusted', adjustment(unknown)?.error === 'not-found', JSON.stringify(adjustment(unknown)));

  const before = appView.sent.length;
  const opened = sessions.opened.length;
  await appView.handlers[0]({ type: 'adjustImage', id: record.id });
  await until(() => adjustment(before));
  check('adjusting opens the Session that produced the image', sessions.opened.slice(opened).join(',') === 'sess-1', sessions.opened.join(','));
  check('that Session’s gallery panel is revealed', sessionPanel.panel.revealed === 1, String(sessionPanel.panel.revealed));
  check('the panel is asked to open the editor', sessionPanel.sent.some((m) => m.type === 'editImage' && m.id === record.id), JSON.stringify(sessionPanel.sent.map((m) => m.type)));
  check('the App View is told where the image went', adjustment(before)?.sessionId === 'sess-1' && !adjustment(before)?.error, JSON.stringify(adjustment(before)));

  // An image with no Session behind it has nowhere to go.
  const galleryFile = join(storagePath, 'gallery.json');
  const patched = JSON.parse(readFileSync(galleryFile, 'utf8'));
  const original = patched[0].sessionId;
  patched[0].sessionId = '';
  writeFileSync(galleryFile, JSON.stringify(patched), 'utf8');
  const orphan = appView.sent.length;
  const openedBefore = sessions.opened.length;
  await appView.handlers[0]({ type: 'adjustImage', id: record.id });
  await until(() => adjustment(orphan));
  check('an image without a Session reports it', adjustment(orphan)?.error === 'no-session', JSON.stringify(adjustment(orphan)));
  check('nothing is opened for an image without a Session', sessions.opened.length === openedBefore);
  patched[0].sessionId = original;
  writeFileSync(galleryFile, JSON.stringify(patched), 'utf8');

  // A host that refuses to navigate must not leave the click silent.
  const failing = ctx.navigation.openSession;
  ctx.navigation.openSession = async () => { throw new Error('nope'); };
  const failed = appView.sent.length;
  await appView.handlers[0]({ type: 'adjustImage', id: record.id });
  await until(() => adjustment(failed));
  check('a refused navigation is reported back', adjustment(failed)?.error === 'open-failed', JSON.stringify(adjustment(failed)));
  ctx.navigation.openSession = failing;
}

// 16 — the gallery's inline icons are generated, never hand-drawn geometry.
{
  const { collectIcons, usedNames, ICONS_FILE } = await import('./build-icons.mjs');
  const committed = JSON.parse(readFileSync(ICONS_FILE, 'utf8'));
  const fresh = collectIcons();
  const normal = (svg) => String(svg).replace(/\s+/g, '');
  const changed = usedNames().filter((name) => normal(committed[name]) !== normal(fresh[name]));
  check('every gallery icon is the real lucide-static shape', changed.length === 0, `${changed.join(', ')} — run npm run icons`);
  // A name the generator never saw, or one it keeps after the last use, means
  // something renders the generic fallback picture instead of its own icon.
  const drifted = [...usedNames()].filter((name) => !(name in committed)).concat(Object.keys(committed).filter((name) => !usedNames().includes(name)));
  check('the icon set matches exactly what the page uses', drifted.length === 0, drifted.join(', '));
}

// 17 — the proxy: resolved, never leaked, and actually handed to the request.
{
  // Stored setting wins, then the environment, then direct.
  const env = { HTTPS_PROXY: 'http://env-proxy:8080' };
  check('a stored proxy wins over the environment', resolveProxy('127.0.0.1:7890', env) === 'http://127.0.0.1:7890', resolveProxy('127.0.0.1:7890', env));
  check('a scheme is added when the user omits it', resolveProxy('127.0.0.1:7890', {}) === 'http://127.0.0.1:7890');
  check('an explicit scheme is kept', resolveProxy('socks5://127.0.0.1:1080', {}) === 'socks5://127.0.0.1:1080');
  check('the environment is used when nothing is stored', resolveProxy('  ', env) === 'http://env-proxy:8080', resolveProxy('', env));
  check('lowercase proxy variables are understood too', resolveProxy(undefined, { https_proxy: 'http://lower:1' }) === 'http://lower:1');
  check('no proxy anywhere means a direct connection', resolveProxy(undefined, {}) === '', resolveProxy(undefined, {}));

  // The stored proxy reaches the request as a proxy dispatcher, not just as text.
  await store.set('proxyUrl', 'http://user:secret@127.0.0.1:7890');
  const proxied = await run(base);
  check('a stored proxy is used for the request', String(proxied.call.dispatcher?.constructor?.name).startsWith('ProxyAgent'), String(proxied.call.dispatcher?.constructor?.name));
  check('a proxy with credentials still gets a dispatcher', !!proxied.call.dispatcher);

  // …and the credentials are masked wherever a human can see them.
  const proxiedMenu = await menus.settings.getMenu({ surface: 'toolcase' });
  const proxyRow = proxiedMenu.find((item) => item.id === 'set-proxy');
  check('the settings row masks proxy credentials', proxyRow.description.includes('***') && !proxyRow.description.includes('secret'), proxyRow.description);

  await store.delete('proxyUrl');
  const direct = await run(base);
  const directName = String(direct.call.dispatcher?.constructor?.name);
  check('a direct request uses the plain agent', !!directName && !directName.startsWith('ProxyAgent'), directName);
  const directMenu = await menus.settings.getMenu({ surface: 'toolcase' });
  check('a cleared proxy reports the fallback plainly', typeof directMenu.find((item) => item.id === 'set-proxy').description === 'string');
}

// 18 — a failure says where it broke, instead of only "fetch failed".
{
  const refused = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7890'), {
      code: 'ECONNREFUSED',
      syscall: 'connect',
      hostname: '127.0.0.1',
    }),
  });
  await store.set('proxyUrl', 'http://127.0.0.1:7890');
  const { result, text, call, reports } = await (async () => {
    calls = [];
    nextThrows = refused;
    nextResponse = null;
    const { exec, reports: r2 } = makeExec();
    const r = await tool.execute({ ...base }, exec);
    return { result: r, text: r.content[0]?.text ?? '', call: calls[0], reports: r2 };
  })();
  check('a dead proxy is an error, not a silent success', result.isError === true);
  check('the failing stage is named', text.includes('connect'), text);
  check('the cause chain is shown instead of "fetch failed" alone', text.includes('ECONNREFUSED') && text.includes('fetch failed'), text);
  check('the hint says the proxy refused the connection', text.includes(locale['diag.hint.refused'].slice(0, 12)), text);
  check('the proxy in use is reported', text.includes('127.0.0.1:7890'), text);
  check('the diagnostic never leaks the request body or key', !text.includes('test-key') && !text.includes('a red square'), text);
  // One "starting" report is the boundary marker; a dead connection must not
  // then keep ticking elapsed heartbeats for a request nobody is serving.
  check('a request that dies immediately reports once and stops', reports.length === 1, JSON.stringify(reports));
  check('the request still had a dispatcher', !!call?.dispatcher);

  // A timeout on a direct connection is the other shape of the same bug.
  nextThrows = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
  });
  await store.delete('proxyUrl');
  const timedOut = await tool.execute({ ...base }, makeExec().exec);
  const timeoutText = timedOut.content[0]?.text ?? '';
  check('a timeout is explained as a timeout', timeoutText.includes(locale['diag.hint.timeout'].slice(0, 8)), timeoutText);
  check('a direct timeout says no proxy was used', timeoutText.includes(locale['diag.direct'].slice(0, 4)), timeoutText);

  // DNS failures point at the domain, and TLS interception is called out.
  for (const [code, key] of [['ENOTFOUND', 'diag.hint.dns'], ['SELF_SIGNED_CERT_IN_CHAIN', 'diag.hint.tls']]) {
    nextThrows = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`boom ${code}`), { code }) });
    const failed = await tool.execute({ ...base }, makeExec().exec);
    check(`${key} is offered for ${code}`, (failed.content[0]?.text ?? '').includes(locale[key].slice(0, 8)), failed.content[0]?.text);
  }
  nextThrows = null;
}

// 19 — the connection test costs nothing and reports what it proved.
{
  const dialogs = [];
  const originalDialog = ctx.ui.showModalDialog;
  ctx.ui.showModalDialog = async (spec) => { dialogs.push(spec); return { action: 'ok' }; };

  // A key is present, so the probe actually goes out — to /models, not /images.
  ctx.secrets.get = async () => 'probe-key';
  calls = [];
  nextResponse = jsonReply({ data: [] });
  await menus.settings.execute({}, 'test-connection');
  check('the probe asks for the model list, not an image', calls[0]?.url.endsWith('/models') && calls[0]?.init?.method === 'GET', calls[0]?.url);
  check('the probe sends the key as a bearer token', calls[0]?.init?.headers?.Authorization === 'Bearer probe-key');
  check('a successful probe reports the latency', String(dialogs.at(-1)?.message ?? '').includes('ms'), String(dialogs.at(-1)?.message));
  const okRow = (await menus.settings.getMenu({ surface: 'toolcase' })).find((item) => item.id === 'test-connection');
  check('the settings row remembers the probe result', okRow.description === locale['probe.ok'].replace('{ms}', okRow.description.match(/\d+/)?.[0] ?? ''), okRow.description);

  // 401: the transport worked and the key did not — say exactly that.
  nextResponse = jsonReply({ error: { message: 'bad key' } }, { status: 401, statusText: 'Unauthorized' });
  await menus.settings.execute({}, 'test-connection');
  check('a rejected key is not reported as a network failure', String(dialogs.at(-1)?.message ?? '').includes('401') && String(dialogs.at(-1)?.message).includes('TLS'), String(dialogs.at(-1)?.message));

  // No key at all: fail before sending anything.
  ctx.secrets.get = async () => null;
  calls = [];
  await menus.settings.execute({}, 'test-connection');
  check('the probe refuses to run without a key', calls.length === 0 && String(dialogs.at(-1)?.message ?? '').includes('API'), String(dialogs.at(-1)?.message));

  // The row that opens the proxy dialog stays a dialog (it is setup, not a toggle).
  ctx.secrets.get = async () => 'probe-key';
  ctx.ui.showModalDialog = async (spec) => {
    dialogs.push(spec);
    return spec.title === locale['menu.proxy'] ? { action: 'save', values: { proxy: '127.0.0.1:7891' } } : { action: 'dismissed' };
  };
  await menus.settings.execute({}, 'set-proxy');
  const saved = (await menus.settings.getMenu({ surface: 'toolcase' })).find((item) => item.id === 'set-proxy');
  check('the proxy dialog saves a normalized address', saved.description === 'http://127.0.0.1:7891/', saved.description);

  ctx.ui.showModalDialog = originalDialog;
  await store.delete('proxyUrl');
}

// 20 — Image 2.6's GIF and SVG output.
{
  const refPath = join(storagePath, 'ref.png');
  writeFileSync(refPath, PNG_1PX);

  // GIF: frames only mean something with gif, and only get sent when asked for.
  const gif = await run({ ...base, output_format: 'gif' });
  check('gif is sent as output_format', gif.call.json.output_format === 'gif', JSON.stringify(gif.call.json));
  check('gif saves a .gif file', gif.text.includes('.gif'), gif.text);
  check('gif leaves the frame knobs to the endpoint', gif.call.json.frame_count === undefined && gif.call.json.frame_duration_ms === undefined);

  const animated = await run({ ...base, output_format: 'gif', frame_count: 6, frame_duration_ms: 125 });
  check('gif frames are forwarded', animated.call.json.frame_count === 6, JSON.stringify(animated.call.json));
  check('frame delay is rounded to the nearest 10 ms', animated.call.json.frame_duration_ms === 130, String(animated.call.json.frame_duration_ms));
  check('the result reports the animation', animated.text.includes('6 × 130ms'), animated.text);

  const clamped = await run({ ...base, output_format: 'gif', frame_count: 99 });
  check('frame_count is clamped to 16', clamped.call.json.frame_count === 16, String(clamped.call.json.frame_count));
  check('the clamp is reported, not hidden', clamped.text.split('\n').some((line) => line.startsWith('!')), clamped.text);

  const framesOnPng = await run({ ...base, frame_count: 4 });
  check('frame knobs are dropped for still images', framesOnPng.call.json.frame_count === undefined, JSON.stringify(framesOnPng.call.json));

  const gifMask = await run({ ...base, output_format: 'gif', reference_image_paths: [refPath], mask_path: refPath });
  check('gif refuses masks before sending', gifMask.result.isError === true && gifMask.call === undefined, gifMask.text);

  const gifStream = await run({ ...base, output_format: 'gif', partial_images: 2 });
  check('gif does not stream', gifStream.call.json.stream === undefined, JSON.stringify(gifStream.call.json));
  check('the missing preview is reported', gifStream.text.split('\n').some((line) => line.startsWith('!')), gifStream.text);

  const gifCompressed = await run({ ...base, output_format: 'gif', output_compression: 40 });
  check('gif drops output_compression', gifCompressed.call.json.output_compression === undefined);

  // GIF edits do exist — only SVG is prompt-only.
  const gifEdit = await run({ ...base, output_format: 'gif', reference_image_paths: [refPath] });
  check('an edit can return a gif', gifEdit.result.isError !== true && gifEdit.call.url.endsWith('/images/edits'), gifEdit.text);

  // SVG: generate only, one file, no streaming, no compression.
  const svg = await run({ ...base, output_format: 'svg' });
  check('svg is sent as output_format', svg.call.json.output_format === 'svg', JSON.stringify(svg.call.json));
  check('svg saves a .svg file', svg.text.includes('.svg'), svg.text);
  check('svg omits the author object unless asked', svg.call.json.svg === undefined, JSON.stringify(svg.call.json));

  const authored = await run({ ...base, output_format: 'svg', svg_model: 'svg-author-x', svg_effort: 'high' });
  check(
    'the svg author and its effort are sent together',
    JSON.stringify(authored.call.json.svg) === JSON.stringify({ model: 'svg-author-x', reasoning: { effort: 'high' } }),
    JSON.stringify(authored.call.json.svg),
  );
  check('the result names the svg author', authored.text.includes('svg-author-x'), authored.text);

  const effortOnly = await run({ ...base, output_format: 'svg', svg_effort: 'low' });
  check('an effort without a model sends no svg object', effortOnly.call.json.svg === undefined, JSON.stringify(effortOnly.call.json));
  check('the ignored effort is reported', effortOnly.text.split('\n').some((line) => line.startsWith('!')), effortOnly.text);

  const svgEdit = await run({ ...base, output_format: 'svg', reference_image_paths: [refPath] });
  check('svg refuses to edit a reference image', svgEdit.result.isError === true && svgEdit.call === undefined, svgEdit.text);

  const svgMany = await run({ ...base, output_format: 'svg', n: 3 });
  check('svg insists on a single file', svgMany.result.isError === true && svgMany.call === undefined, svgMany.text);

  const svgStream = await run({ ...base, output_format: 'svg', partial_images: 1 });
  check('svg does not stream', svgStream.call.json.stream === undefined, JSON.stringify(svgStream.call.json));

  const svgWithModel = await run({ ...base, output_format: 'svg', svg_model: 'author-y' });
  const svgIgnored = await run({ ...base, svg_model: 'author-y' });
  check('svg_model is dropped for a png request', svgIgnored.call.json.svg === undefined && svgIgnored.text.split('\n').some((line) => line.startsWith('!')), svgIgnored.text);
  check('svg_model alone still sends the object', JSON.stringify(svgWithModel.call.json.svg) === JSON.stringify({ model: 'author-y' }));

  // Transparency stays a png/webp feature.
  const transparentGif = await run({ ...base, output_format: 'gif', background: 'transparent' });
  check('a transparent gif falls back to png', transparentGif.call.json.output_format === 'png', JSON.stringify(transparentGif.call.json));
  check('the transparent fallback is explained', transparentGif.text.split('\n').some((line) => line.startsWith('!')), transparentGif.text);

  // Generated gif/svg files cannot be fed back in as inputs.
  const gifPath = join(storagePath, 'input.gif');
  writeFileSync(gifPath, GIF_2X2);
  const badInput = await run({ ...base, reference_image_paths: [gifPath] });
  check('a gif is refused as a reference image', badInput.result.isError === true && badInput.call === undefined, badInput.text);
  check('the refusal names the file', badInput.text.includes('input.gif'), badInput.text);
}

// 21 — the new formats are measurable and saved like the old ones.
{
  // GIF: the logical screen descriptor, little endian.
  const gif = readImageSize(GIF_2X2, 'gif');
  check('readImageSize reads a GIF screen descriptor', gif.width === 2 && gif.height === 2, JSON.stringify(gif));
  // SVG: width/height first, then viewBox.
  const svgAttr = readImageSize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150"><rect/></svg>'), 'svg');
  check('readImageSize reads SVG width/height', svgAttr.width === 300 && svgAttr.height === 150, JSON.stringify(svgAttr));
  const svgBox = readImageSize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 96"><rect/></svg>'), 'svg');
  check('readImageSize falls back to the SVG viewBox', svgBox.width === 64 && svgBox.height === 96, JSON.stringify(svgBox));
  // The saved extension is "jpg", which used to miss the jpeg branch entirely.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x40, 0x00, 0x60, 0x03, 0, 0, 0, 0, 0, 0, 0]);
  check('readImageSize reads a JPEG by its saved extension', readImageSize(jpeg, 'jpg').width === 96 && readImageSize(jpeg, 'jpg').height === 64, JSON.stringify(readImageSize(jpeg, 'jpg')));
}

// 22 — gif and svg exist on Image 2.6 only, so an older model is moved up.
{
  check('2.5 is recognised as too old for gif', needsImage26('gpt-image-2.5-flare', 'gif') === true);
  check('2.5 sunburst is too old for svg', needsImage26('gpt-image-2.5-sunburst', 'svg') === true);
  check('a dated snapshot is too old as well', needsImage26('gpt-image-2-2026-04-21', 'gif') === true);
  check('2.6 needs no upgrade', needsImage26('gpt-image-2.6-flare', 'gif') === false);
  check('a png request never upgrades the model', needsImage26('gpt-image-2.5-flare', 'png') === false);
  check('an unknown relay model is left alone', needsImage26('my-relay-image-x', 'gif') === false);
  check('the sibling keeps the variant', image26Sibling('gpt-image-2.5-sunburst') === 'gpt-image-2.6-sunburst' && image26Sibling('gpt-image-2.5-flare') === 'gpt-image-2.6-flare');
  check('a base family upgrades to flare', image26Sibling('gpt-image-2') === 'gpt-image-2.6-flare');

  // End to end: a gif on a stored 2.5 default comes back from 2.6, and says so.
  await store.set('defaultModel', 'gpt-image-2.5-flare');
  const upgraded = await run({ ...base, output_format: 'gif' });
  check('a gif request on the 2.5 default is sent to 2.6', upgraded.call.json.model === 'gpt-image-2.6-flare', upgraded.call.json.model);
  check('the model change is explained, not silent', upgraded.text.includes('gpt-image-2.6-flare') && upgraded.text.split('\n').some((line) => line.startsWith('!')), upgraded.text);

  const stillOnPng = await run({ ...base });
  check('a png request keeps the configured 2.5', stillOnPng.call.json.model === 'gpt-image-2.5-flare', stillOnPng.call.json.model);

  const relay = await run({ ...base, model: 'my-relay-image-x', output_format: 'gif' });
  check('an unknown relay model is trusted with gif', relay.call.json.model === 'my-relay-image-x', relay.call.json.model);
  await store.delete('defaultModel');
}

// 23 — the AI-facing text must never name a concrete model as "the default".
// execute() only falls back to the stored toolbar default when the caller omits
// `model`, so a prompt that reads "the default is gpt-image-2.6-flare" makes the
// agent pass that id on every call and silently outrank whatever the user picked
// (that is exactly how a stored 2.5 default got bypassed in a real session).
{
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const en = JSON.parse(readFileSync(join(root, 'i18n/en-US.json'), 'utf8'));
  const zh = JSON.parse(readFileSync(join(root, 'i18n/zh-CN.json'), 'utf8'));
  const MODEL_ID = /gpt-image-[0-9][0-9.]*(?:[-.][a-z0-9]+)?/i;
  // Sentences split on a full stop even when CJK text has no space after it.
  const costPolicy = (text) =>
    text.split(/(?<=[.。])\s*/).find((sentence) => /COST POLICY|费用约定/.test(sentence)) ?? '';
  const saysOmit = /omit|leaves? [^.。]{0,60}out|configured default|不传|默认/i;

  for (const [where, text] of [
    ['manifest systemPrompt', manifest.finch.systemPrompt],
    ['en systemPrompt', en.systemPrompt],
    ['zh systemPrompt', zh.systemPrompt],
  ]) {
    const policy = costPolicy(text);
    check(`${where}: has a cost policy sentence`, policy.length > 0);
    check(`${where}: cost policy names no model id`, !MODEL_ID.test(policy), policy.slice(0, 180));
    check(`${where}: cost policy says omit to get the configured default`, saysOmit.test(policy), policy.slice(0, 180));
  }

  for (const [where, description] of [
    ['en tool.description', en['tool.description']],
    ['zh tool.description', zh['tool.description']],
  ]) {
    const bullet = description.split('\n').find((line) => line.trim().startsWith('- quality')) ?? '';
    check(`${where}: quality bullet names no model id`, !MODEL_ID.test(bullet), bullet.slice(0, 180));
    check(`${where}: quality bullet points at the configured default`, saysOmit.test(bullet), bullet.slice(0, 180));
  }

  const modelParam = tool.inputSchema.properties.model.description;
  check('model param says the default comes from the toolbar', /default the user configured/i.test(modelParam), modelParam);
  check('model param labels no id as the default', !/gpt-image-[a-z0-9.-]+\s*\([^)]*default/i.test(modelParam), modelParam);
}

rmSync(storagePath, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);

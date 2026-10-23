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
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activate, checkSize, formatApiError, readImageSize, registerIcons, resolveModel } from '../dist/index.js';

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
const { ctx, registered, menus, store, panelHandlers, previews, sessions, icons } = makeCtx(storagePath);
activate(ctx);

const tool = registered.image_gen_create;
check('tool image_gen_create is registered', !!tool);

/** Stand in for a gallery webview so the panel bridge can be driven end to end. */
function makePanel(view = 'appView', sessionId = '') {
  const sent = [];
  const handlers = [];
  const panel = {
    view,
    sessionId,
    async postMessage(message) { sent.push(message); },
    onDidReceiveMessage(handler) { handlers.push(handler); return { dispose() {} }; },
    onDidDispose() { return { dispose() {} }; },
  };
  return { panel, sent, handlers };
}

async function run(input, reply) {
  calls = [];
  nextResponse = reply ?? jsonReply({ data: [{ b64_json: PNG_1PX.toString('base64') }] });
  const { exec, reports } = makeExec();
  const result = await tool.execute(input, exec);
  return { result, text: result.content[0]?.text ?? '', call: calls[0], reports };
}

const base = { prompt: 'a red square' };

// 1 — defaults: the cheapest combination, and only the broadly supported knobs.
{
  const { call, text } = await run(base);
  check('default model is the cheap gpt-image-2.5-flare', call.json.model === 'gpt-image-2.5-flare', call.json.model);
  check('default size/quality are the cheap 1024x1024 / low', call.json.size === '1024x1024' && call.json.quality === 'low', `${call.json.size} ${call.json.quality}`);
  check('optional knobs stay omitted', call.json.background === undefined && call.json.output_format === undefined && call.json.moderation === undefined);
  check('hits /images/generations', call.url.endsWith('/v1/images/generations'), call.url);
  check('result lists a saved file', text.includes('.png') && text.includes('model: gpt-image-2.5-flare'), text.slice(0, 120));
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
  check('resolveModel keeps unknown ids verbatim', resolveModel('gpt-image-2') === 'gpt-image-2' && resolveModel('') === 'gpt-image-2.5-flare');
  check('bare gpt-image-.5 alias maps to the fallback model', resolveModel('gpt-image-2.5') === 'gpt-image-2.5-flare', resolveModel('gpt-image-2.5'));
}

// 9 — the gallery: what gets recorded, and the panel bridge.
{
  const galleryFile = join(storagePath, 'gallery.json');
  const fresh = await run({ prompt: 'a blue circle', quality: 'medium', size: '1536x1024' });
  const filePath = fresh.text.split('\n').pop().trim();
  const gallery = JSON.parse(readFileSync(galleryFile, 'utf8'));
  const record = gallery.find((item) => item.filePath === filePath);
  check('generation is recorded in gallery.json', !!record, galleryFile);
  check('record carries the badge data', record.model === 'gpt-image-2.5-flare' && record.quality === 'medium' && record.size === '1536x1024', JSON.stringify(record).slice(0, 160));
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
  await ask({ type: 'requestImage', filePath: join(storagePath, 'ghost.png') }, 'imageData');
  check('unreadable image is reported, not thrown', sent.some((m) => m.type === 'imageData' && m.error === 'unreadable'));

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
  check('Toolcase settings menu holds the endpoint', settingsIds.join(',') === 'set-api-key,set-base-url', settingsIds.join(','));
  check('key status is reported in the settings menu', settingsItems[0].description === locale['status.notSet'], settingsItems[0].description);

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

// 13 — the instructions reach the input box as an editable draft. A page can
// only attach contexts, so the text is parked for the Composer action to fill.
{
  const composerMenu = menus.composer['image-gen-settings'];
  const scoped = { sessionId: 'sess-1', spaceId: '', surface: 'session', cwd: '/tmp' };
  const sessionPanel = makePanel('session', 'sess-1');
  panelHandlers[0](sessionPanel.panel);
  for (let i = 0; i < 200 && !sessionPanel.sent.some((m) => m.type === 'gallery'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const stage = async (message) => {
    const before = sessionPanel.sent.length;
    await sessionPanel.handlers[0](message);
    for (let i = 0; i < 200; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (sessionPanel.sent.slice(before).some((item) => item.type === 'promptStaged')) return;
    }
  };

  const before = await composerMenu.getMenu(scoped);
  check('no fill row until an edit is staged', !before.some((item) => item.id === 'fill-prompt'), before.map((item) => item.id).join(','));
  check('no badge without a staged prompt', (await composerMenu.getBadge(scoped)) === undefined);

  await stage({ type: 'stagePrompt', id: 'x', name: 'picture.png', text: '把这里换成暖光\n原图：/gallery/picture-0.png' });
  const staged = await composerMenu.getMenu(scoped);
  check('a staged edit shows the fill row first', staged[0]?.id === 'fill-prompt', staged.map((item) => item.id).join(','));
  check('the fill row names the image', staged[0]?.description === 'picture.png', staged[0]?.description);
  check('a staged edit lights the badge', (await composerMenu.getBadge(scoped))?.text === '1' && (await composerMenu.getBadge(scoped))?.active === true);
  check('another session is unaffected', (await composerMenu.getBadge({ ...scoped, sessionId: 'other' })) === undefined);
  check('staging refreshes the toolbar', menus.notifyUpdates > 0);

  const fills = [];
  await composerMenu.execute(scoped, 'fill-prompt', { composer: { fill: async (text, options) => { fills.push({ text, options }); } } });
  check('the row fills the input box as an editable draft', fills.length === 1 && fills[0].text.includes('把这里换成暖光') && fills[0].text.includes('/gallery/picture-0.png'), JSON.stringify(fills));
  check('the text is appended, not overwriting the user’s draft', fills[0]?.options?.mode === 'append', JSON.stringify(fills[0]?.options));
  const after = await composerMenu.getMenu(scoped);
  check('the row clears once filled', !after.some((item) => item.id === 'fill-prompt') && (await composerMenu.getBadge(scoped)) === undefined, after.map((item) => item.id).join(','));
  await composerMenu.execute(scoped, 'fill-prompt', { composer: { fill: async () => { throw new Error('should not fill twice'); } } });
  check('a redundant fill is a no-op', fills.length === 1);

  // Home has no session id, so its draft is keyed by Space instead of being lost.
  await ask({ type: 'stagePrompt', id: 'y', name: 'home.png', text: 'home prompt' }, 'promptStaged');
  check('the Home draft is staged per-composer', (await composerMenu.getBadge({ sessionId: undefined, spaceId: '', surface: 'home', cwd: '/tmp' }))?.text === '1');
}

// 14 — picking a submenu row saves it directly, with no dialog in the way.
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
  await composerMenu.execute(scoped, 'model:gpt-image-2.5-sunburst', { composer: {}, navigation: {} });
  check('choosing a model stores it directly', (await store.get('defaultModel')) === 'gpt-image-2.5-sunburst', String(await store.get('defaultModel')));
  check('no dialog interrupts a submenu pick', dialogs.length === 0, dialogs.join(','));
  const rows = await composerMenu.getMenu(scoped);
  check('the submenu marks what was just chosen', rows.find((item) => item.id === 'set-size').children.find((child) => child.current)?.id === 'size:1280x720');
  check('the parent row shows the chosen value', rows.find((item) => item.id === 'set-size').description === '1280x720', rows.find((item) => item.id === 'set-size').description);

  // A default value is stored as "no override" so the built-in default can change.
  await composerMenu.execute(scoped, 'size:1024x1024', { composer: {}, navigation: {} });
  await composerMenu.execute(scoped, 'quality:low', { composer: {}, navigation: {} });
  await composerMenu.execute(scoped, 'model:gpt-image-2.5-flare', { composer: {}, navigation: {} });
  check('choosing a built-in default clears the override', (await store.get('defaultSize')) === undefined && (await store.get('defaultQuality')) === undefined && (await store.get('defaultModel')) === undefined);

  // Garbage ids must not reach storage.
  await composerMenu.execute(scoped, 'size:1000x1000', { composer: {}, navigation: {} });
  await composerMenu.execute(scoped, 'quality:nonsense', { composer: {}, navigation: {} });
  check('an invalid submenu id is ignored', (await store.get('defaultSize')) === undefined && (await store.get('defaultQuality')) === undefined);

  ctx.ui.showModalDialog = dialog;
}

// 15 — the editor toolbar writes the same size, so both surfaces agree.
{
  const sessionPanel = makePanel('session', 'sess-1');
  panelHandlers[0](sessionPanel.panel);
  for (let i = 0; i < 200 && !sessionPanel.sent.some((m) => m.type === 'gallery'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const env = sessionPanel.sent.find((m) => m.type === 'gallery')?.env ?? {};
  check('the panel env carries the current size', env.defaultSize === '1024x1024', JSON.stringify(env.defaultSize));

  const before = sessionPanel.sent.length;
  await sessionPanel.handlers[0]({ type: 'setDefaultSize', size: '720x1280' });
  for (let i = 0; i < 200 && !sessionPanel.sent.slice(before).some((m) => m.type === 'defaultSize'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  check('choosing a size in the gallery stores it', (await store.get('defaultSize')) === '720x1280', String(await store.get('defaultSize')));
  check('the choice is broadcast back to the panels', sessionPanel.sent.slice(before).some((m) => m.type === 'defaultSize' && m.size === '720x1280'), JSON.stringify(sessionPanel.sent.slice(before).map((m) => m.type)));
  check('the composer menu shows the same value', (await menus.composer['image-gen-settings'].getMenu({ sessionId: 'sess-1', spaceId: '' })).find((item) => item.id === 'set-size').description === '720x1280');

  const after = sessionPanel.sent.length;
  await sessionPanel.handlers[0]({ type: 'setDefaultSize', size: 'auto' });
  check('a rebuilt size can be cleared', (await store.get('defaultSize')) === 'auto', String(await store.get('defaultSize')));
  await sessionPanel.handlers[0]({ type: 'setDefaultSize', size: '1024x1024' });
  check('the built-in size clears the override again', (await store.get('defaultSize')) === undefined);
  await sessionPanel.handlers[0]({ type: 'setDefaultSize', size: '1234x99' });
  check('an invalid size from the gallery is refused', (await store.get('defaultSize')) === undefined, String(await store.get('defaultSize')));
  check('a refused size is not broadcast', !sessionPanel.sent.slice(after).some((m) => m.type === 'defaultSize' && m.size === '1234x99'));
}

rmSync(storagePath, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);

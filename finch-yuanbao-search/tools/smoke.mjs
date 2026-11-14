#!/usr/bin/env node
/**
 * Offline smoke test for finch-yuanbao-search.
 *
 * A fake host (hand-built ctx + in-memory secrets) plus a stubbed fetch drives
 * the real `execute()` from the built bundle. No Finch running, no network, no
 * tokens. Everything here is a rule that would otherwise only be observable in a
 * live session — signing shape, which parameters actually go on the wire, and
 * whether each Tencent error code turns into advice a human can act on.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push({ name, error });
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failures.push({ name, error });
  }
}

// ─────────────────────────────────────────────────────────── fake host ──────
function makeLocaleTable(locale) {
  return JSON.parse(readFileSync(path.join(ROOT, 'i18n', `${locale}.json`), 'utf8'));
}

function interpolate(text, values) {
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (all, key) => (key in values ? String(values[key]) : all));
}

function makeCtx({ locale = 'zh-CN', secrets = new Map(), dialogs = [], forms = [] } = {}) {
  const table = makeLocaleTable(locale);
  const enTable = makeLocaleTable('en-US');
  const registered = { tools: [], settingsMenu: [], icons: new Map() };
  const logged = [];
  const ctx = {
    subscriptions: [],
    storagePath: '/tmp/yuanbao-smoke-storage',
    logger: {
      info: (m) => logged.push(['info', String(m)]),
      warn: (m) => logged.push(['warn', String(m)]),
      error: (m) => logged.push(['error', String(m)]),
      debug: () => {},
    },
    app: { getInfo: () => ({ locale, version: '1.8.1', platform: 'darwin' }) },
    i18n: {
      locale,
      has: (key) => key in table || key in enTable,
      t: (key, values) => interpolate(table[key] ?? enTable[key] ?? key, values),
    },
    secrets: {
      get: async (k) => (secrets.has(k) ? secrets.get(k) : undefined),
      set: async (k, v) => { secrets.set(k, v); },
      delete: async (k) => { secrets.delete(k); },
    },
    storage: {
      _map: new Map(),
      async get(k) { return this._map.get(k); },
      async set(k, v) { this._map.set(k, v); },
    },
    icons: {
      register(packId, icons) {
        registered.icons.set(packId, icons);
        return { dispose() {} };
      },
    },
    tools: {
      register(def) {
        registered.tools.push(def);
        return { dispose() {} };
      },
    },
    settingsMenu: {
      register(provider) {
        registered.settingsMenu.push(provider);
        return { dispose() {}, notifyUpdate() {} };
      },
    },
    ui: {
      showModalDialog: async (spec) => {
        dialogs.push(spec);
        return { action: 'ok' };
      },
    },
  };
  return { ctx, registered, logged, dialogs, secrets };
}

function makeExec({ formResult = null, progress = [] } = {}) {
  const controller = new AbortController();
  return {
    toolCallId: 'call-1',
    sessionId: 'sess-1',
    spaceId: undefined,
    cwd: process.cwd(),
    signal: controller.signal,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    progress: { report: (p) => progress.push(p) },
    ui: {
      requestForm: async () => formResult,
    },
  };
}

// ────────────────────────────────────────────────────────── fetch stub ──────
function makeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, headers: Object.fromEntries(Object.entries(init.headers ?? {})) });
    const out = await handler(init);
    if (out instanceof Error) throw out;
    return {
      ok: out.status >= 200 && out.status < 300,
      status: out.status ?? 200,
      statusText: out.statusText ?? 'OK',
      text: async () => out.body,
    };
  };
  impl.calls = calls;
  return impl;
}

function apiBody(pages, extra = {}) {
  return JSON.stringify({
    Response: {
      Pages: pages,
      Query: 'q',
      Version: 'standard',
      RequestId: 'req-fixed-0001',
      ...extra,
    },
  });
}
function apiError(code, message) {
  return JSON.stringify({ Response: { Error: { Code: code, Message: message }, RequestId: 'req-err-0001' } });
}
function pageJson(fields) {
  return JSON.stringify(fields);
}

const text = (result) => result.content.map((c) => c.text ?? '').join('\n');

// ─────────────────────────────────────────────────── isolate + load bundle ──
// Point HOME at an empty dir before importing: `activate()` tries the key-file
// bootstrap, and the smoke test must never touch a real key file. Also drop any
// inherited Tencent env vars so the env fallback is deterministic.
process.env.HOME = '/tmp/yuanbao-smoke-home';
delete process.env.TENCENTCLOUD_SECRETID;
delete process.env.TENCENTCLOUD_SECRETKEY;
delete process.env.SECRETID;
delete process.env.SECRETKEY;

const { pathToFileURL } = await import('node:url');
const mod = await import(pathToFileURL(path.join(ROOT, 'dist/index.js')).href);

// The signing unit test needs `signRequest` on its own; bundle it separately so
// the production entry point does not have to export internals.
const { execFileSync } = await import('node:child_process');
const signBundle = '/tmp/yuanbao-smoke-sign.mjs';
execFileSync('npx', ['esbuild', 'src/sign.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${signBundle}`], { cwd: ROOT, stdio: 'pipe' });
const { signRequest } = await import(pathToFileURL(signBundle).href);

const GOLD = {
  secretId: 'AKIDgolden0000000000000000000000ab',
  secretKey: 'goldenSecretKey000000000000000000',
  timestamp: 1700000000,
  // Computed independently (Python) over the exact JSON.stringify body; the
  // live endpoint accepts this exact construction.
  signature: 'cd11342acdae50f9bfb380d17574f427a2b149b0e9f9235ec648667d87712b7e',
};

// ────────────────────────────────────────────────────────── 1. registration ─
const boot = makeCtx();
boot.secrets.set('tencentcloud.secretId', GOLD.secretId);
boot.secrets.set('tencentcloud.secretKey', GOLD.secretKey);
mod.activate(boot.ctx);

check('exactly one tool is registered', () => {
  assert.equal(boot.registered.tools.length, 1);
});

const tool = boot.registered.tools[0];

check('tool name is yuanbao_search, low risk, enabled by default', () => {
  assert.equal(tool.name, 'yuanbao_search');
  assert.equal(tool.risk, 'low');
  assert.equal(tool.defaultEnabled, true);
  assert.ok(tool.timeoutMs > 120_000, 'timeout must cover the credential form wait');
});

check('query is the only required parameter', () => {
  assert.deepEqual(tool.inputSchema.required, ['query']);
  assert.ok(tool.inputSchema.properties.count);
  assert.ok(tool.inputSchema.properties.timeRange);
});

check('tool description states the count and timeRange rules', () => {
  assert.match(tool.description, /10\/20\/30\/40\/50/);
  assert.match(tool.description, /d1-d30/);
});

check('icon pack is registered at runtime with real SVGs', () => {
  const pack = boot.registered.icons.get('yuanbao-search-icons');
  assert.ok(pack, 'pack must be registered, not only declared in the manifest');
  for (const id of ['search', 'key-round', 'plug']) {
    assert.ok(pack[id]?.svg?.includes('<svg'), `${id} must carry a real <svg>`);
  }
});

const iconRefs = await (async () => {
  const found = new Set();
  for (const rel of ['src/index.ts', 'package.json']) {
    const src = readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(/ext:(?:yuanbao-search-icons\/)?([a-z0-9]+(?:-[a-z0-9]+)*)(?=["'\s,)`])/g)) {
      found.add(m[1]);
    }
  }
  return found;
})();

check('every ext: reference resolves to a registered icon', () => {
  const pack = boot.registered.icons.get('yuanbao-search-icons') ?? {};
  for (const ref of iconRefs) {
    assert.ok(pack[ref], `${ref} is referenced but not registered — it would render as nothing`);
  }
});

// ─────────────────────────────────────────────────────────────────── 2. i18n ─
const zh = makeLocaleTable('zh-CN');
const en = makeLocaleTable('en-US');

function flatten(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...flatten(v, key));
    else out.push(key);
  }
  return out.sort();
}

check('zh-CN and en-US cover exactly the same keys', () => {
  assert.deepEqual(flatten(zh), flatten(en));
});

check('every literal t("key") in src/ exists in both locales', () => {
  const files = ['src/index.ts', 'src/errors.ts', 'src/format.ts'];
  const keys = new Set();
  for (const rel of files) {
    const src = readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9._]+)'/g)) keys.add(m[1]);
  }
  const missing = [...keys].filter((k) => !(k in zh) || !(k in en));
  assert.deepEqual(missing, [], `missing i18n keys: ${missing.join(', ')}`);
});

check('dynamically built i18n keys all exist', () => {
  const dynamic = [
    'menu.status.secrets', 'menu.status.env', 'menu.status.none',
    'err.auth.signature.title', 'err.auth.signature.hint',
    'err.auth.secretId.title', 'err.auth.secretId.hint',
    'err.auth.generic.title', 'err.auth.generic.hint',
    'warn.countRounded', 'warn.countInvalid', 'warn.modeIgnored',
    'warn.industryIgnored', 'warn.siteSingle', 'warn.siteTruncated', 'warn.pagesDropped',
  ];
  const missing = dynamic.filter((k) => !(k in zh) || !(k in en));
  assert.deepEqual(missing, [], `missing: ${missing.join(', ')}`);
});

check('manifest i18n overrides use nested objects, not dotted flat keys', () => {
  assert.equal(typeof zh.settingsMenu, 'object');
  assert.ok(zh.settingsMenu.tooltip);
  assert.ok(!('settingsMenu.tooltip' in zh), 'a flat "settingsMenu.tooltip" key silently does nothing');
  assert.ok(zh.name && zh.description && zh.systemPrompt);
});

// ─────────────────────────────────────────────────────────── 3. TC3 signing ─
check('signRequest matches the golden TC3 signature', () => {
  const signed = signRequest({
    secretId: GOLD.secretId,
    secretKey: GOLD.secretKey,
    service: 'wsa',
    action: 'SearchPro',
    version: '2025-05-08',
    endpoint: 'wsa.tencentcloudapi.com',
    payload: JSON.stringify({ Query: 'hello', Cnt: 10 }),
    timestamp: GOLD.timestamp,
  });
  assert.equal(signed.signature, GOLD.signature);
  assert.match(signed.headers.Authorization, new RegExp(GOLD.signature));
  assert.match(signed.headers.Authorization, new RegExp(`Credential=${GOLD.secretId}/2023-11-14/wsa/tc3_request`));
});

check('a different SecretKey produces a different signature', () => {
  const a = signRequest({ ...signArgs(), secretKey: GOLD.secretKey });
  const b = signRequest({ ...signArgs(), secretKey: `${GOLD.secretKey}x` });
  assert.notEqual(a.signature, b.signature);
});
function signArgs() {
  return {
    secretId: GOLD.secretId, secretKey: GOLD.secretKey, service: 'wsa', action: 'SearchPro',
    version: '2025-05-08', endpoint: 'wsa.tencentcloudapi.com',
    payload: '{"Query":"hello"}', timestamp: GOLD.timestamp,
  };
}

// ───────────────────────────────────────────────────────── 4. wire format ───
async function runTool(input, handler, opts = {}) {
  const box = makeCtx({ locale: opts.locale ?? 'zh-CN' });
  if (opts.creds !== false) {
    box.secrets.set('tencentcloud.secretId', GOLD.secretId);
    box.secrets.set('tencentcloud.secretKey', GOLD.secretKey);
  }
  mod.activate(box.ctx);
  const def = box.registered.tools[0];
  const fetchStub = makeFetch(handler);
  globalThis.fetch = fetchStub;
  const exec = makeExec({ formResult: opts.formResult ?? null, progress: [] });
  const result = await def.execute(input, exec);
  const call = fetchStub.calls[0];
  return {
    ...box,
    def,
    result,
    call,
    sent: call ? JSON.parse(call.init.body) : null,
    rendered: text(result),
    isError: result.isError === true,
  };
}
const ok = (pages, extra) => async () => ({ status: 200, body: apiBody(pages, extra) });

await checkAsync('request carries no X-TC-Region header', async () => {
  const r = await runTool({ query: 'hello' }, ok([pageJson({ title: 't', url: 'u' })]));
  assert.ok(r.call, 'a request must have been sent');
  assert.ok(!('X-TC-Region' in r.call.headers), 'wsa rejects every named region');
  assert.equal(r.call.headers['X-TC-Action'], 'SearchPro');
  assert.equal(r.call.headers['X-TC-Version'], '2025-05-08');
  assert.equal(r.call.url, 'https://wsa.tencentcloudapi.com/');
  assert.equal(r.call.init.method, 'POST');
});

await checkAsync('only Query is sent when nothing else is asked for', async () => {
  const r = await runTool({ query: 'hello' }, ok([]));
  assert.deepEqual(r.sent, { Query: 'hello' });
});

await checkAsync('optional parameters are forwarded verbatim', async () => {
  const r = await runTool(
    { query: 'q', count: 20, timeRange: 'd7', mode: 2, industry: 'news', site: 'zhihu.com', deeplinks: true },
    ok([]),
  );
  assert.deepEqual(r.sent, { Query: 'q', Cnt: 20, Freshness: 'd7', Mode: 2, Industry: 'news', Site: 'zhihu.com', Deeplinks: true });
});

// ───────────────────────────────────────────────────────────── 5. parameters ─
const paramCases = [
  ['count 15 rounds up to 20', { query: 'q', count: 15 }, (r) => { assert.equal(r.sent.Cnt, 20); assert.match(r.rendered, /count/); }],
  ['count 10 passes through', { query: 'q', count: 10 }, (r) => { assert.equal(r.sent.Cnt, 10); }],
  ['count 999 clamps to 50', { query: 'q', count: 999 }, (r) => assert.equal(r.sent.Cnt, 50)],
  ['count 7 rounds up to 10', { query: 'q', count: 7 }, (r) => assert.equal(r.sent.Cnt, 10)],
  ['timeRange 近一周 becomes d7', { query: 'q', timeRange: '近一周' }, (r) => assert.equal(r.sent.Freshness, 'd7')],
  ['timeRange week becomes d7', { query: 'q', timeRange: 'week' }, (r) => assert.equal(r.sent.Freshness, 'd7')],
  ['timeRange m3 passes through', { query: 'q', timeRange: 'm3' }, (r) => assert.equal(r.sent.Freshness, 'm3')],
  ['timeRange date range passes through', { query: 'q', timeRange: '2026-01-01,2026-02-01' }, (r) => assert.equal(r.sent.Freshness, '2026-01-01,2026-02-01')],
  ['industry is lower-cased', { query: 'q', industry: 'NEWS' }, (r) => assert.equal(r.sent.Industry, 'news')],
  ['bad industry is dropped with a note', { query: 'q', industry: 'sports' }, (r) => { assert.ok(!('Industry' in r.sent)); assert.match(r.rendered, /industry/); }],
  ['bad mode is dropped with a note', { query: 'q', mode: 5 }, (r) => { assert.ok(!('Mode' in r.sent)); assert.match(r.rendered, /mode/); }],
  ['multi-domain Site keeps the first', { query: 'q', site: 'a.com|b.com' }, (r) => { assert.equal(r.sent.Site, 'a.com'); assert.match(r.rendered, /Site/); }],
  ['exclude: with 6 domains truncates to 5', { query: 'q', site: 'exclude:a.com|b.com|c.com|d.com|e.com|f.com' }, (r) => assert.equal(r.sent.Site, 'exclude:a.com|b.com|c.com|d.com|e.com')],
];
for (const [name, input, assertFn] of paramCases) {
  await checkAsync(name, async () => {
    const r = await runTool(input, ok([pageJson({ title: 't', url: 'u' })]));
    assertFn(r);
  });
}

const rejectCases = [
  ['timeRange w is rejected', { query: 'q', timeRange: 'w' }, /timeRange/],
  ['timeRange d99 is rejected', { query: 'q', timeRange: 'd99' }, /timeRange/],
  ['empty query is rejected', { query: '   ' }, /query/],
];
for (const [name, input, pattern] of rejectCases) {
  await checkAsync(name, async () => {
    const r = await runTool(input, ok([]));
    assert.ok(r.isError, 'must be an error result');
    assert.ok(r.call === undefined, 'nothing may be sent for invalid input');
    assert.match(r.rendered, pattern);
  });
}

// ───────────────────────────────────────────────────────── 6. result parsing ─
await checkAsync('Pages JSON strings are parsed into readable results', async () => {
  const r = await runTool({ query: 'q' }, ok([
    pageJson({ title: '标题一', url: 'https://a.com', passage: '摘要一', site: '网站A', date: '2026-10-20 15:28:00', score: 0.85 }),
    pageJson({ title: '标题二', url: 'https://b.com', passage: '摘要二' }),
  ]));
  assert.match(r.rendered, /标题一/);
  assert.match(r.rendered, /https:\/\/a\.com/);
  assert.match(r.rendered, /网站A/);
  assert.match(r.rendered, /2026-10-20/, 'time is trimmed to the date');
  assert.match(r.rendered, /0\.85/);
  assert.match(r.rendered, /req-fixed-0001/);
});

await checkAsync('an unparsable page is skipped and reported', async () => {
  const r = await runTool({ query: 'q' }, ok(['not json', pageJson({ title: 'ok', url: 'u' })]));
  assert.match(r.rendered, /ok/);
  assert.match(r.rendered, /无法解析/);
});

await checkAsync('a page object (not a JSON string) still parses', async () => {
  const r = await runTool({ query: 'q' }, ok([{ title: 'obj', url: 'u' }]));
  assert.match(r.rendered, /obj/);
});

await checkAsync('empty result set says so instead of printing nothing', async () => {
  const r = await runTool({ query: 'q' }, ok([]));
  assert.match(r.rendered, /没有返回任何结果/);
});

await checkAsync('server Msg is surfaced', async () => {
  const r = await runTool({ query: 'q' }, ok([], { Msg: 'hit black query' }));
  assert.match(r.rendered, /hit black query/);
});

await checkAsync('snippets are truncated by default and the long body stays off', async () => {
  const long = 'x'.repeat(2000);
  const r = await runTool({ query: 'q' }, ok([pageJson({ title: 't', url: 'u', passage: long, content: long })]));
  assert.ok(!r.rendered.includes(`${long}`), 'full snippet must be clipped');
  assert.ok(!r.rendered.includes('正文'), 'content must stay out unless asked for');

  const r2 = await runTool(
    { query: 'q', includeContent: true, snippetChars: 50 },
    ok([pageJson({ title: 't', url: 'u', passage: 'short passage', content: long })]),
  );
  assert.match(r2.rendered, /正文/, 'a distinct content line appears when asked for');

  const r3 = await runTool(
    { query: 'q', includeContent: true },
    ok([pageJson({ title: 't', url: 'u', passage: long, content: long })]),
  );
  assert.ok(!r3.rendered.includes('正文'), 'content identical to the passage is not repeated');
});

await checkAsync('includeRaw appends the untouched JSON', async () => {
  const r = await runTool({ query: 'q', includeRaw: true }, ok([pageJson({ title: 't', url: 'u' })]));
  assert.match(r.rendered, /"Response"/);
});

// ────────────────────────────────────────────────────────── 7. error classes ─
const errorCases = [
  ['UnsupportedRegion points at console activation, not at a region setting',
    () => ({ status: 200, body: apiError('UnsupportedRegion', 'The action does not support this region.') }),
    [/元宝搜索服务当前不可用/, /控制台/, /wsa:SearchPro/]],
  ['UnauthorizedOperation points at the CAM policy',
    () => ({ status: 200, body: apiError('UnauthorizedOperation', 'unauthorized') }),
    [/权限不足/, /CAM/, /wsa:SearchPro/]],
  ['rate limiting is named as rate limiting',
    () => ({ status: 200, body: apiError('RequestLimitExceeded', 'too fast') }),
    [/限流/, /配额/]],
  ['a signature failure blames the SecretKey',
    () => ({ status: 200, body: apiError('AuthFailure.SignatureFailure', 'bad signature') }),
    [/SecretKey/]],
  ['an unknown SecretId blames the SecretId',
    () => ({ status: 200, body: apiError('AuthFailure.SecretIdNotFound', 'no such id') }),
    [/SecretId/]],
  ['InvalidParameter lists the accepted values',
    () => ({ status: 200, body: apiError('InvalidParameter', 'illegal Cnt') }),
    [/参数不合法/, /10\/20\/30\/40\/50/]],
  ['a server 500 is reported as a server error with the RequestId',
    () => ({ status: 500, body: apiError('InternalError', 'boom'), statusText: 'Server Error' }),
    [/服务端错误/, /req-err-0001/]],
  ['a non-JSON body is called out instead of crashing',
    () => ({ status: 200, body: '<html>proxy blocked</html>' }),
    [/不是 JSON/]],
];
for (const [name, handlerFactory, patterns] of errorCases) {
  await checkAsync(name, async () => {
    const r = await runTool({ query: 'q' }, () => handlerFactory());
    assert.ok(r.isError, 'must be an error result');
    for (const p of patterns) assert.match(r.rendered, p);
  });
}

const transportCases = [
  ['DNS failure', () => Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }), /DNS/],
  ['connection refused', () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), /无法连接/],
  ['TLS interception', () => Object.assign(new Error('self signed certificate'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }), /TLS/],
  ['a bare network throw', () => new TypeError('fetch failed'), /请求未能发出/],
];
for (const [name, makeError, pattern] of transportCases) {
  await checkAsync(name, async () => {
    const r = await runTool({ query: 'q' }, () => makeError());
    assert.ok(r.isError);
    assert.match(r.rendered, pattern);
  });
}

// ───────────────────────────────────────────────────────────── 8. credentials ─
await checkAsync('no credentials: clear setup instructions, no request sent', async () => {
  const r = await runTool({ query: 'q' }, ok([]), { creds: false, formResult: { submitted: false, reason: 'cancelled' } });
  assert.ok(r.isError);
  assert.match(r.rendered, /还没有配置腾讯云密钥/);
  assert.match(r.rendered, /工具箱/);
  assert.match(r.rendered, /TENCENTCLOUD_SECRETID/);
});

await checkAsync('the in-call form saves to secure storage and the search still succeeds', async () => {
  const r = await runTool({ query: 'q' }, ok([pageJson({ title: 'ok', url: 'u' })]), {
    creds: false,
    formResult: { submitted: true, values: { secretId: GOLD.secretId, secretKey: GOLD.secretKey } },
  });
  assert.equal(r.secrets.get('tencentcloud.secretId'), GOLD.secretId);
  assert.equal(r.secrets.get('tencentcloud.secretKey'), GOLD.secretKey);
  assert.ok(!r.isError, `expected success, got: ${r.rendered}`);
  assert.match(r.rendered, /ok/);
});

await checkAsync('no secret value ever reaches the model', async () => {
  const r = await runTool({ query: 'q' }, ok([pageJson({ title: 't', url: 'u' })]));
  assert.ok(!r.rendered.includes(GOLD.secretKey), 'SecretKey must never be rendered');
  assert.ok(!r.rendered.includes(GOLD.secretId), 'SecretId must never be rendered in full');
});

await checkAsync('environment variables are used when secure storage is empty', async () => {
  process.env.TENCENTCLOUD_SECRETID = GOLD.secretId;
  process.env.TENCENTCLOUD_SECRETKEY = GOLD.secretKey;
  try {
    const r = await runTool({ query: 'q' }, ok([pageJson({ title: 't', url: 'u' })]), { creds: false });
    assert.ok(!r.isError, 'env credentials must work');
    assert.equal(r.call.headers.Authorization.includes(GOLD.secretId), true);
  } finally {
    delete process.env.TENCENTCLOUD_SECRETID;
    delete process.env.TENCENTCLOUD_SECRETKEY;
  }
});

// ───────────────────────────────────────────────────────── 9. settings menu ─
await checkAsync('settings menu shows an unconfigured status row', async () => {
  const box = makeCtx();
  mod.activate(box.ctx);
  const items = await box.registered.settingsMenu[0].getMenu({ cwd: undefined, minitoolId: 'finch-yuanbao-search', surface: 'toolcase' });
  const status = items.find((i) => i.id === 'status');
  assert.equal(status.label, '未配置密钥');
  assert.equal(status.disabled, true, 'the status row is informational only');
  assert.ok(items.some((i) => i.id === 'configure'));
  assert.ok(items.some((i) => i.id === 'test'));
});

await checkAsync('settings menu masks the SecretId', async () => {
  const box = makeCtx();
  box.secrets.set('tencentcloud.secretId', GOLD.secretId);
  box.secrets.set('tencentcloud.secretKey', GOLD.secretKey);
  mod.activate(box.ctx);
  const items = await box.registered.settingsMenu[0].getMenu({ cwd: undefined, minitoolId: 'finch-yuanbao-search', surface: 'toolcase' });
  const status = items.find((i) => i.id === 'status');
  assert.ok(status.label.includes('AKID') && status.label.includes('…'), `expected a masked id, got ${status.label}`);
  assert.ok(!status.label.includes(GOLD.secretId), 'the full SecretId must not be shown');
  assert.match(status.description, /钥匙串/);
});

await checkAsync('a failed connection test is remembered on the menu row', async () => {
  const box = makeCtx();
  box.secrets.set('tencentcloud.secretId', GOLD.secretId);
  box.secrets.set('tencentcloud.secretKey', GOLD.secretKey);
  mod.activate(box.ctx);
  globalThis.fetch = makeFetch(() => ({ status: 200, body: apiError('UnauthorizedOperation', 'nope') }));
  const provider = box.registered.settingsMenu[0];
  await provider.execute({ cwd: undefined, minitoolId: 'finch-yuanbao-search', surface: 'toolcase' }, 'test');
  const items = await provider.getMenu({ cwd: undefined, minitoolId: 'finch-yuanbao-search', surface: 'toolcase' });
  assert.match(items.find((i) => i.id === 'test').description, /失败/);
  assert.ok(box.dialogs.length > 0, 'the user gets a dialog with the reason');
});

await checkAsync('a successful connection test reports the result count', async () => {
  const box = makeCtx();
  box.secrets.set('tencentcloud.secretId', GOLD.secretId);
  box.secrets.set('tencentcloud.secretKey', GOLD.secretKey);
  mod.activate(box.ctx);
  globalThis.fetch = makeFetch(() => ({ status: 200, body: apiBody([pageJson({ title: 't', url: 'u' })]) }));
  const provider = box.registered.settingsMenu[0];
  await provider.execute({ cwd: undefined, minitoolId: 'finch-yuanbao-search', surface: 'toolcase' }, 'test');
  const items = await provider.getMenu({ cwd: undefined, minitoolId: 'finch-yuanbao-search', surface: 'toolcase' });
  assert.match(items.find((i) => i.id === 'test').description, /1 条结果/);
});

await checkAsync('the English locale renders the whole tool', async () => {
  const r = await runTool({ query: 'q' }, ok([pageJson({ title: 't', url: 'u', passage: 'p' })]), { locale: 'en-US' });
  assert.match(r.rendered, /Yuanbao Search/);
  assert.match(r.rendered, /Snippet/);
});

// ─────────────────────────────────────────────────────────────────── report ──
console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) {
  console.error(`\n✗ ${f.name}\n  ${f.error?.message ?? f.error}`);
}
process.exit(failures.length > 0 ? 1 : 0);

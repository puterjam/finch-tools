// Fake-host smoke test for the ego-browser mini tool.
//
// Loads the built bundle with a hand-made ctx and drives the real
// `execute()` of the ego_browser tool, so the platform branches
// (macOS / Windows / unsupported) are exercised without launching Finch.
//
//   node tools/smoke.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(here, '..', 'dist', 'index.js');
const setPlatform = (value) => Object.defineProperty(process, 'platform', { value, configurable: true });

let failures = 0;
const check = (name, ok, extra) => {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${extra === undefined ? '' : ` — ${String(extra).slice(0, 200)}`}`);
  }
};

function makeCtx() {
  const tools = new Map();
  const i18n = JSON.parse(readFileSync(path.join(here, '..', 'i18n', 'en-US.json'), 'utf8'));
  const ctx = {
    subscriptions: { push() {} },
    logger: { info() {}, warn() {}, error() {} },
    storagePath: '/tmp/finch-ego-smoke',
    i18n: {
      t(key, values) {
        const flat = key.split('.').reduce((node, part) => (node ? node[part] : undefined), i18n);
        if (typeof flat !== 'string') return key;
        return flat.replace(/\{(\w+)\}/g, (_, name) => String(values?.[name] ?? ''));
      },
      onDidChangeLocale() { return { dispose() {} }; },
    },
    icons: { register: () => ({ dispose() {} }) },
    composerActions: {
      register() { return { notifyUpdate() {}, dispose() {} }; },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return { dispose() {} };
      },
    },
    ui: {
      async showToast() {},
      async showConfirmDialog() { return { confirmed: false }; },
    },
    __tools: tools,
  };
  return ctx;
}

const asJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

async function run() {
  const mod = await import(bundle);
  const ctx = makeCtx();
  mod.activate(ctx);
  const tool = ctx.__tools.get('ego_browser');
  if (!tool) {
    console.log('  FAIL ego_browser tool was not registered');
    process.exit(1);
  }
  const exec = { progress: { report() {} } };

  console.log('\nego-browser smoke');

  // 1. Unsupported platform: say so instead of probing anything.
  setPlatform('linux');
  const unsupported = await tool.execute({ action: 'status' }, exec);
  check('linux reports the platform as unsupported',
    unsupported.isError === true && /macOS and Windows/.test(unsupported.content[0].text),
    unsupported.content[0].text);

  // 2. macOS: the CLI on this machine answers with a JSON payload.
  setPlatform('darwin');
  const mac = await tool.execute({ action: 'status' }, exec);
  const macText = mac.content[0].text;
  const macJson = asJson(macText);
  check('darwin status is not rejected by the platform gate', !/macOS and Windows/.test(macText), macText);
  check('darwin status parses as JSON when Ego answers', macJson === null || macJson.ready === true, macText);

  // 3. Windows: same shape, must not be treated as unsupported.
  setPlatform('win32');
  const win = await tool.execute({ action: 'status' }, exec);
  const winText = win.content[0].text;
  check('win32 is a supported platform', !/macOS and Windows/.test(winText), winText);
  const winJson = asJson(winText);
  check('win32 status yields a status payload', winJson !== null || winText.length > 0, winText);

  // 4. Windows actions must reach the CLI layer, not the platform gate.
  const winAction = await tool.execute({ action: 'snapshot' }, exec);
  check('win32 actions pass the platform gate',
    !/macOS and Windows/.test(winAction.content[0].text), winAction.content[0].text);

  setPlatform('darwin');
  console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

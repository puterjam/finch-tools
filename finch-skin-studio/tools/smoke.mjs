/**
 * Host-free smoke test for finch-skin-studio.
 *
 * Two things are worth checking without launching Finch:
 *
 *   1. the built-in palette contract — presets must not hand-write the
 *      interaction axis (bgHover / bgActive are derived by the host from
 *      bgElevated), and bgElevated has to clear the host's "too flat" floor,
 *      otherwise Finch silently pushes the surface a full step and the skin
 *      looks nothing like the card;
 *   2. the read path — ctx.appearance.getTheme() is authoritative when the
 *      build has it (a skin can arrive from Appearance Settings or AppCall and
 *      never pass through this mini tool), and every caller must fall back to
 *      the locally recorded state when it does not.
 *
 * Run with: npm run smoke   (builds first, then runs this)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activate, BUILTIN_SKINS } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
}

// ── color helpers (mirroring the host's rules) ──────────────────────────────

function rgb(value) {
  const hex = value.trim().match(/^#([0-9a-f]{6})$/i)?.[1];
  if (!hex) throw new Error(`smoke only understands 6-digit hex, got ${value}`);
  return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
}
const channelDelta = (a, b) => {
  const A = rgb(a);
  const B = rgb(b);
  return Math.max(...A.map((c, i) => Math.abs(c - B[i])));
};
function luminance(value) {
  const s = rgb(value).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// ── fake host ────────────────────────────────────────────────────────────────

/** Every temp storage dir a fake host made, cleaned up at the end. */
const tempDirs = [];

/**
 * @param {{ theme?: { themePreference: string, customTheme?: object } | null }} opts
 *   theme: null leaves ctx.appearance without getTheme (an older Finch build).
 */
function makeHost({ theme = null } = {}) {
  const store = new Map();
  const tools = new Map();
  const panels = [];
  const appearance = {
    setThemeCalls: [],
    state: theme ? { ...theme } : null,
    async setTheme(options) {
      appearance.setThemeCalls.push(options);
      if (options.customTheme) {
        appearance.state = { themePreference: 'custom', customTheme: options.customTheme };
      } else if (options.theme) {
        appearance.state = { themePreference: options.theme };
      }
    },
    async setHomeBackground() {},
  };
  if (theme) {
    appearance.getTheme = async () => (appearance.state ? { ...appearance.state } : { themePreference: 'system' });
  }
  const ctx = {
    storagePath: (() => {
      const dir = mkdtempSync(join(tmpdir(), 'skin-studio-'));
      tempDirs.push(dir);
      return dir;
    })(),
    storage: {
      async get(key) { return store.get(key); },
      async set(key, value) { store.set(key, value); },
    },
    i18n: { locale: 'en-US', has: () => false, t: (key) => key },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    subscriptions: { push() {} },
    tools: {
      register(def) {
        tools.set(def.name, def);
        return { dispose() {} };
      },
    },
    composerActions: { register: () => ({ dispose() {} }) },
    ui: {
      panelListener: null,
      onDidOpenPanel(cb) {
        ctx.ui.panelListener = cb;
        return { dispose() {} };
      },
      createPanel() {
        const panel = makePanel();
        panels.push(panel);
        return panel;
      },
      async showModalDialog() {
        return { action: 'save', values: { name: 'Panel Extract' } };
      },
    },
    appearance,
  };
  function makePanel() {
    const panel = {
      id: `panel-${panels.length}`,
      sessionId: 's1',
      view: 'session',
      spaceId: '',
      spaceName: '',
      received: [],
      msgHandler: null,
      postMessage(msg) { panel.received.push(msg); },
      onDidDispose() { return { dispose() {} }; },
      onDidReceiveMessage(cb) { panel.msgHandler = cb; return { dispose() {} }; },
      /** What the real host does after the webview posts a message. */
      async send(msg) {
        await panel.msgHandler(msg);
        await flush();
      },
      async reveal() {},
    };
    return panel;
  }
  activate(ctx);
  const text = (result) => result.content.map((c) => c.text).join('\n');
  async function openPanel() {
    const panel = makePanel();
    panels.push(panel);
    await ctx.ui.panelListener(panel);
    // The listener fires buildStatePayload() without awaiting it.
    await flush();
    return panel;
  }
  const lastState = (panel) => panel.received.filter((m) => m.type === 'state').at(-1);
  return { ctx, tools, appearance, panels, text, openPanel, lastState };
}

/** Let the mini tool's floating promises (state push, panel handlers) settle. */
async function flush() {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const FOREIGN = {
  name: 'Foreign Plum',
  base: 'dark',
  colors: { bgMain: '#101014', bgElevated: '#1b1b22', accent: '#ff2d78', textPrimary: '#f5f2f4' },
};

// ── 1. palette contract ──────────────────────────────────────────────────────

console.log('\n# built-in presets');
check('6 presets, 3 light + 3 dark',
  BUILTIN_SKINS.length === 6
  && BUILTIN_SKINS.filter((s) => s.base === 'light').length === 3
  && BUILTIN_SKINS.filter((s) => s.base === 'dark').length === 3);
check('ids unique', new Set(BUILTIN_SKINS.map((s) => s.id)).size === BUILTIN_SKINS.length);

for (const skin of BUILTIN_SKINS) {
  const c = skin.colors;
  const flat = !c.bgHover && !c.bgActive;
  check(`${skin.id}: interaction axis left to the host`, flat, `bgHover/bgActive present: ${c.bgHover}/${c.bgActive}`);
  const delta = channelDelta(c.bgMain, c.bgElevated);
  // 8/255 is the host's MIN_ELEVATION_CHANNEL_DELTA; under it --bg-elevated is
  // overwritten and the preset no longer controls its own cards.
  check(`${skin.id}: elevated clears the flat floor (Δ=${delta})`, delta >= 8, `Δ ${delta} < 8`);
  check(`${skin.id}: body text stays readable on both surfaces`,
    contrast(c.textPrimary, c.bgMain) >= 4.5 && contrast(c.textPrimary, c.bgElevated) >= 4.5,
    `P/main ${contrast(c.textPrimary, c.bgMain).toFixed(2)} P/elev ${contrast(c.textPrimary, c.bgElevated).toFixed(2)}`);
  check(`${skin.id}: accent keeps white text legible`,
    contrast('#ffffff', c.accent) >= 3, `white on accent ${contrast('#ffffff', c.accent).toFixed(2)}`);
}

// ── 2. read path: getTheme is authoritative ──────────────────────────────────

console.log('\n# current / save with getTheme');
{
  const host = makeHost({ theme: { themePreference: 'system' } });
  const theme = host.tools.get('skin_studio_theme');

  const onSystem = host.text(await theme.execute({ action: 'current' }));
  check('current on the built-in theme says there is nothing to tweak',
    onSystem.includes('system') && onSystem.includes('no custom skin'), onSystem);

  await theme.execute({ action: 'apply', id: 'dark-teal' });
  check('apply records the live skin', host.appearance.setThemeCalls.length === 1);

  const onOwn = host.text(await theme.execute({ action: 'current' }));
  check('current recognises a skin this tool applied', onOwn.includes('dark-teal'), onOwn);

  // Something else changed the look — Appearance Settings, or AppCall's
  // setAppearance. Skin Studio never saw it happen.
  host.appearance.state = { themePreference: 'custom', customTheme: FOREIGN };

  const onForeign = host.text(await theme.execute({ action: 'current' }));
  check('current reports a foreign skin instead of the stale one',
    onForeign.includes('Foreign Plum') && onForeign.includes('#ff2d78') && onForeign.includes('not in the Skin Studio library'),
    onForeign);

  const saved = host.text(await theme.execute({ action: 'save', name: 'Kept Plum' }));
  const library = await host.ctx.storage.get('customSkins');
  check('save without colors extracts what is on screen',
    saved.startsWith('Saved custom skin') && library.length === 1
    && library[0].colors.accent === '#ff2d78' && library[0].base === 'dark',
    `${saved} / ${JSON.stringify(library?.map((s) => [s.name, s.colors.accent]))}`);

  const panel = await host.openPanel();
  let state = host.lastState(panel);
  check('panel highlights the live skin, not the last one applied here',
    state.activeMode?.mode === 'skin' && state.lastAppliedId === library[0].id,
    JSON.stringify({ mode: state.activeMode, id: state.lastAppliedId }));

  host.appearance.state = { themePreference: 'custom', customTheme: { name: 'Mint', base: 'light', colors: BUILTIN_SKINS[1].colors } };
  await panel.send({ type: 'requestState' });
  state = host.lastState(panel);
  check('panel matches a live preset by colors', state.lastAppliedId === 'light-mint', state.lastAppliedId);

  host.appearance.state = { themePreference: 'dark' };
  await panel.send({ type: 'requestState' });
  state = host.lastState(panel);
  check('panel shows the system theme when no skin is active',
    state.activeMode?.mode === 'system' && state.activeMode.systemTheme === 'dark' && !state.lastAppliedId,
    JSON.stringify({ mode: state.activeMode, id: state.lastAppliedId }));

  // The panel's own "save current skin" button follows the same read path.
  host.appearance.state = { themePreference: 'custom', customTheme: FOREIGN };
  await panel.send({ type: 'requestSaveCurrent' });
  const custom = await host.ctx.storage.get('customSkins');
  check('panel extract keeps the live skin',
    custom.length === 2 && custom.at(-1).name === 'Panel Extract' && custom.at(-1).colors.accent === '#ff2d78',
    JSON.stringify(custom.map((s) => [s.name, s.colors.accent])));
}

// ── 3. read path: older build without getTheme ──────────────────────────────

console.log('\n# fallback without getTheme');
{
  const host = makeHost(); // ctx.appearance exists but has no getTheme
  const theme = host.tools.get('skin_studio_theme');

  const empty = await theme.execute({ action: 'current' });
  check('current says so when nothing is known', empty.isError && empty.content[0].text.includes('getTheme'), empty.content[0].text);

  await theme.execute({ action: 'apply', id: 'light-peach' });
  const remembered = host.text(await theme.execute({ action: 'current' }));
  check('current falls back to the last skin applied here',
    remembered.includes('no ctx.appearance.getTheme') && remembered.includes('Peach Cream'), remembered);

  const saved = host.text(await theme.execute({ action: 'save', name: 'From Last Applied' }));
  const library = await host.ctx.storage.get('customSkins');
  check('save falls back to the last skin applied here',
    saved.startsWith('Saved custom skin') && library[0].colors.accent === '#e0527a',
    `${saved} / ${JSON.stringify(library?.map((s) => s.colors.accent))}`);

  const panel = await host.openPanel();
  const state = host.lastState(panel);
  check('panel keeps using stored state', state.activeMode?.mode === 'skin' && state.lastAppliedId === 'light-peach',
    JSON.stringify({ mode: state.activeMode, id: state.lastAppliedId }));
}

for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'smoke passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);

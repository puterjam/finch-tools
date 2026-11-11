import type * as finch from 'finch';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';

// ── Types ───────────────────────────────────────────────────────────────────

type SkinBase = 'light' | 'dark';

/** What `getTheme()` reports as the app-wide theme preference. */
type ThemePreference = 'light' | 'dark' | 'system' | 'custom';

/** Same shape as `finch.AppearanceThemeSnapshot` — the read half of the
 * appearance surface, so "tweak whatever is on screen" does not have to guess. */
interface ThemeSnapshot {
  themePreference: ThemePreference;
  /** The live custom skin; absent when Finch is on its own system theme. */
  customTheme?: { name: string; base: SkinBase; colors: SkinColors };
}

/**
 * `ctx.appearance` (setTheme / setHomeBackground / getTheme) is documented in
 * the mini tool authoring skill but not yet present in the published
 * `@finchtoys/minitool-api` type package this repo depends on. Declared here
 * as a local ambient type + safe runtime cast, the same pattern finch-delivery
 * uses for `ctx.ui.openFilePreview` — remove this shim once the published
 * types catch up.
 *
 * Member order mirrors the SDK contract (setTheme / setHomeBackground /
 * getTheme). `getTheme` arrived after the first appearance build, so it is
 * optional here and every caller must feature-detect it.
 */
interface AppearanceApi {
  setTheme(options: {
    theme?: 'light' | 'dark' | 'system' | 'custom';
    customTheme?: { name: string; base: SkinBase; colors: SkinColors };
    fontSize?: 'small' | 'medium' | 'large';
    uiFontFamily?: string;
    monoFontFamily?: string;
    showThinking?: boolean;
  }): Promise<void>;
  setHomeBackground(options: {
    imagePath?: string;
    placement?: 'fill' | 'tile';
    tone?: 'brightest' | 'bright' | 'balanced' | 'dark' | 'darkest';
    clear?: boolean;
  }): Promise<void>;
  getTheme?(): Promise<ThemeSnapshot>;
}

function getAppearance(ctx: finch.MiniToolContext): AppearanceApi {
  const appearance = (ctx as unknown as { appearance?: AppearanceApi }).appearance;
  if (!appearance) {
    throw new Error(
      'This Finch build does not expose ctx.appearance yet. Please update Finch to a version that supports the Appearance API.',
    );
  }
  return appearance;
}

/**
 * Reads what is actually on screen right now. Returns `undefined` when the host
 * build predates `getTheme()` or the call fails — callers then fall back to
 * what this mini tool recorded locally, which is exactly the old behaviour.
 * Never throws: a read-only nicety must not break apply/save.
 */
async function readLiveTheme(ctx: finch.MiniToolContext): Promise<ThemeSnapshot | undefined> {
  const appearance = (ctx as unknown as { appearance?: AppearanceApi }).appearance;
  if (!appearance || typeof appearance.getTheme !== 'function') return undefined;
  try {
    const snapshot = await appearance.getTheme();
    return snapshot && typeof snapshot.themePreference === 'string' ? snapshot : undefined;
  } catch (err) {
    ctx.logger.warn(`ctx.appearance.getTheme() failed, falling back to stored state: ${String(err)}`);
    return undefined;
  }
}

/** True when the snapshot is a custom skin we can hand back to setTheme(). */
function liveCustomTheme(snapshot: ThemeSnapshot | undefined): { name: string; base: SkinBase; colors: SkinColors } | undefined {
  const custom = snapshot?.customTheme;
  if (!custom || typeof custom.name !== 'string') return undefined;
  const colors = sanitizeColors(custom.colors);
  if (Object.keys(colors).length === 0) return undefined;
  return { name: custom.name, base: custom.base === 'dark' ? 'dark' : 'light', colors };
}

/** Same shape as finch.AppearanceCustomThemeColors — kept local so this file
 * has no hard runtime dependency on exact SDK type exports. */
interface SkinColors {
  bgRoot?: string;
  bgMain?: string;
  bgSidebar?: string;
  /** Card / popover / input / bubble surface. Must sit one clear step away
   * from bgMain (darker on light, lighter on dark) — closer than that and the
   * host pushes it a step itself so the hierarchy does not collapse. */
  bgElevated?: string;
  /** Hover veil. Recommended to leave out: omitted, the host derives a few
   * percent of ink over bgElevated, so the intensity follows the theme. */
  bgHover?: string;
  /** Pressed veil. Same rule as bgHover. */
  bgActive?: string;
  textPrimary?: string;
  textSecondary?: string;
  textTertiary?: string;
  accent?: string;
  accentDim?: string;
  border?: string;
}

interface BuiltinSkin {
  readonly id: string;
  /** English fallback name; localized via i18n key `skin.builtin.<id>`. */
  readonly name: string;
  readonly base: SkinBase;
  readonly colors: SkinColors;
}

interface CustomSkin {
  id: string;
  name: string;
  base: SkinBase;
  colors: SkinColors;
  createdAt: number;
}

type BackgroundPlacement = 'fill' | 'tile';
type BackgroundTone = 'brightest' | 'bright' | 'balanced' | 'dark' | 'darkest';

interface BackgroundConfig {
  imagePath?: string;
  placement: BackgroundPlacement;
  tone: BackgroundTone;
}

interface LastApplied {
  id?: string; // builtin or custom skin id, absent for one-off ad-hoc skins
  name: string;
  base: SkinBase;
  colors: SkinColors;
  appliedAt: number;
}

/** Tracks whether a custom color skin or Finch's own built-in system theme
 * is currently active, purely so the panel knows what to highlight. */
type ActiveMode = { mode: 'skin' } | { mode: 'system'; systemTheme: 'system' | 'light' | 'dark' };

// ── Storage keys ────────────────────────────────────────────────────────────

const KEY_CUSTOM_SKINS = 'customSkins';
const KEY_BACKGROUND = 'background';
const KEY_LAST_APPLIED = 'lastApplied';
const KEY_ACTIVE_MODE = 'activeMode';

// ── Built-in presets: 3 light + 3 dark ─────────────────────────────────────
//
// Each preset only sets the three axes the host cannot invent for it:
//   · surface axis  bgRoot → bgMain → bgSidebar → bgElevated, one visible step
//     apart. bgElevated keeps ≥ 12/255 from bgMain on purpose: below 8/255 the
//     host treats the pair as flat and pushes elevated a full step itself.
//   · interaction axis — deliberately absent. bgHover / bgActive are a sheer
//     veil over the current surface, not another surface, so they are left to
//     the host's derivation (light: 6% / 12% ink over elevated, dark: 8% / 15%
//     of white). Hand-written ones used to sit a hair above elevated and read
//     as "nothing happened" on hover.
//   · accent axis   accent + accentDim, plus border as an outline that is not
//     part of the hierarchy.

// Exported for tools/smoke.mjs, which asserts the palette contract below.
export const BUILTIN_SKINS: BuiltinSkin[] = [
  {
    id: 'light-snow',
    name: 'Snow White',
    base: 'light',
    colors: {
      bgRoot: '#ffffff',
      bgMain: '#ffffff',
      bgSidebar: '#f6f6f8',
      bgElevated: '#f0f1f3',
      textPrimary: '#1c1c1f',
      textSecondary: '#5b5d66',
      textTertiary: '#9a9ca6',
      accent: '#2f6fed',
      accentDim: '#e2ebfd',
      border: '#e3e4e9',
    },
  },
  {
    id: 'light-mint',
    name: 'Mint Morning',
    base: 'light',
    colors: {
      bgRoot: '#f3faf6',
      bgMain: '#f3faf6',
      bgSidebar: '#e9f4ee',
      bgElevated: '#ffffff',
      textPrimary: '#173226',
      textSecondary: '#4d6b5b',
      textTertiary: '#8aa79a',
      accent: '#0e9f6e',
      accentDim: '#d9f4e6',
      border: '#d5e8dc',
    },
  },
  {
    id: 'light-peach',
    name: 'Peach Cream',
    base: 'light',
    colors: {
      bgRoot: '#fff4f0',
      bgMain: '#fff4f0',
      bgSidebar: '#fbe8e3',
      bgElevated: '#ffffff',
      textPrimary: '#3a1f1d',
      textSecondary: '#7a4e49',
      textTertiary: '#b08a84',
      accent: '#e0527a',
      accentDim: '#fbdce6',
      border: '#f2d8d2',
    },
  },
  {
    id: 'dark-graphite',
    name: 'Graphite',
    base: 'dark',
    colors: {
      bgRoot: '#16171a',
      bgMain: '#1b1c20',
      bgSidebar: '#212227',
      bgElevated: '#26272c',
      textPrimary: '#f2f2f4',
      textSecondary: '#a7a8b2',
      textTertiary: '#7a7b86',
      accent: '#6366f1',
      accentDim: '#26264a',
      border: '#2f3037',
    },
  },
  {
    id: 'dark-berry',
    name: 'Midnight Berry',
    base: 'dark',
    colors: {
      bgRoot: '#170e14',
      bgMain: '#1d1219',
      bgSidebar: '#241722',
      bgElevated: '#2a1a26',
      textPrimary: '#f6eef2',
      textSecondary: '#c39cae',
      textTertiary: '#9a7285',
      accent: '#e02a8b',
      accentDim: '#3d1530',
      border: '#36202d',
    },
  },
  {
    id: 'dark-teal',
    name: 'Deep Teal',
    base: 'dark',
    colors: {
      bgRoot: '#0c1a1c',
      bgMain: '#0f2124',
      bgSidebar: '#14282b',
      bgElevated: '#1a3033',
      textPrimary: '#eaf5f4',
      textSecondary: '#9fc0bf',
      textTertiary: '#6f9391',
      accent: '#0d9488',
      accentDim: '#0f3a35',
      border: '#23393c',
    },
  },
];

const BUILTIN_BY_ID = new Map(BUILTIN_SKINS.map((s) => [s.id, s]));

// ── i18n helper (mirrors the pattern used by finch-delivery) ───────────────

function tr(ctx: finch.MiniToolContext, key: string, fallback: string, vars?: Record<string, string>): string {
  return ctx.i18n.has(key) ? ctx.i18n.t(key, vars) : fallback;
}

function builtinSkinName(ctx: finch.MiniToolContext, skin: BuiltinSkin): string {
  return tr(ctx, `skin.builtin.${skin.id}`, skin.name);
}

// ── Storage helpers ─────────────────────────────────────────────────────────

async function loadCustomSkins(ctx: finch.MiniToolContext): Promise<CustomSkin[]> {
  return (await ctx.storage.get<CustomSkin[]>(KEY_CUSTOM_SKINS)) ?? [];
}

async function saveCustomSkins(ctx: finch.MiniToolContext, skins: CustomSkin[]): Promise<void> {
  await ctx.storage.set(KEY_CUSTOM_SKINS, skins);
}

async function loadBackground(ctx: finch.MiniToolContext): Promise<BackgroundConfig> {
  return (
    (await ctx.storage.get<BackgroundConfig>(KEY_BACKGROUND)) ?? {
      placement: 'fill',
      tone: 'balanced',
    }
  );
}

async function saveBackground(ctx: finch.MiniToolContext, cfg: BackgroundConfig): Promise<void> {
  await ctx.storage.set(KEY_BACKGROUND, cfg);
}

// ── Uploaded background image storage ───────────────────────────────────────
// The panel offers no OS-native "open file" dialog through Finch's own APIs,
// so background images come in from a hidden `<input type=file>` (which does
// trigger the OS's real picker — that's a plain web platform feature, not a
// Finch API) or from a drag-and-drop. Either way the resulting File object in
// the Panel webview has no reliable absolute path (sandboxed renderer), so we
// receive its raw bytes instead and persist a copy under this mini tool's own
// storage directory. Anything we write here is "managed": safe to delete once
// superseded, so drops don't pile up on disk indefinitely.
const BACKGROUNDS_DIR_NAME = 'backgrounds';
const MAX_DROPPED_IMAGE_BYTES = 15 * 1024 * 1024; // 15 MB
const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

function backgroundsDir(ctx: finch.MiniToolContext): string {
  return join(ctx.storagePath, BACKGROUNDS_DIR_NAME);
}

function isManagedBackgroundPath(ctx: finch.MiniToolContext, imagePath: string | undefined): boolean {
  if (!imagePath) return false;
  const dir = backgroundsDir(ctx) + sep;
  return imagePath.startsWith(dir);
}

/** Best-effort delete of a previously-saved dropped-image copy. Never throws. */
async function cleanupManagedBackground(ctx: finch.MiniToolContext, imagePath: string | undefined): Promise<void> {
  if (!isManagedBackgroundPath(ctx, imagePath)) return;
  try {
    await unlink(imagePath as string);
  } catch {
    // Already gone or inaccessible — nothing to do.
  }
}

function sanitizeDroppedFileName(name: string | undefined): string {
  const base = (name ?? 'background').replace(/\.[^./\\]+$/, '');
  const cleaned = base.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, '-').slice(0, 60);
  return cleaned || 'background';
}

/** Decodes a `data:image/...;base64,...` URL into a saved file under this
 * mini tool's storage directory. Throws with a localized message on failure. */
async function saveDroppedImage(
  ctx: finch.MiniToolContext,
  dataUrl: string,
  originalName: string | undefined,
): Promise<string> {
  const match = /^data:([a-zA-Z0-9.+/-]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    throw new Error(tr(ctx, 'panel.error.dropInvalidType', 'Please drop an image file.'));
  }
  const mime = match[1].toLowerCase();
  const ext = IMAGE_MIME_EXTENSIONS[mime];
  if (!ext) {
    throw new Error(tr(ctx, 'panel.error.dropInvalidType', 'Please drop an image file.'));
  }
  const base64 = match[2];
  const approxBytes = (base64.length * 3) / 4;
  if (approxBytes > MAX_DROPPED_IMAGE_BYTES) {
    throw new Error(tr(ctx, 'panel.error.dropTooLarge', 'Image is too large (max 15MB).'));
  }
  const buffer = Buffer.from(base64, 'base64');
  const dir = backgroundsDir(ctx);
  await mkdir(dir, { recursive: true });
  const fileName = `${Date.now()}-${sanitizeDroppedFileName(originalName)}.${ext}`;
  const filePath = join(dir, fileName);
  await writeFile(filePath, buffer);
  return filePath;
}

async function loadLastApplied(ctx: finch.MiniToolContext): Promise<LastApplied | undefined> {
  return (await ctx.storage.get<LastApplied>(KEY_LAST_APPLIED)) ?? undefined;
}

async function saveLastApplied(ctx: finch.MiniToolContext, applied: LastApplied): Promise<void> {
  await ctx.storage.set(KEY_LAST_APPLIED, applied);
}

async function loadActiveMode(ctx: finch.MiniToolContext): Promise<ActiveMode | undefined> {
  return (await ctx.storage.get<ActiveMode>(KEY_ACTIVE_MODE)) ?? undefined;
}

async function saveActiveMode(ctx: finch.MiniToolContext, mode: ActiveMode): Promise<void> {
  await ctx.storage.set(KEY_ACTIVE_MODE, mode);
}

// ── Skin lookup & apply ─────────────────────────────────────────────────────

interface ResolvedSkin {
  id?: string;
  name: string;
  base: SkinBase;
  colors: SkinColors;
  isCustom: boolean;
}

async function resolveSkinById(ctx: finch.MiniToolContext, id: string): Promise<ResolvedSkin | undefined> {
  const builtin = BUILTIN_BY_ID.get(id);
  if (builtin) {
    return { id: builtin.id, name: builtinSkinName(ctx, builtin), base: builtin.base, colors: builtin.colors, isCustom: false };
  }
  const custom = (await loadCustomSkins(ctx)).find((s) => s.id === id);
  if (custom) {
    return { id: custom.id, name: custom.name, base: custom.base, colors: custom.colors, isCustom: true };
  }
  return undefined;
}

async function applySkin(
  ctx: finch.MiniToolContext,
  skin: { id?: string; name: string; base: SkinBase; colors: SkinColors },
): Promise<void> {
  await getAppearance(ctx).setTheme({
    customTheme: { name: skin.name, base: skin.base, colors: skin.colors },
  });
  await saveLastApplied(ctx, {
    id: skin.id,
    name: skin.name,
    base: skin.base,
    colors: skin.colors,
    appliedAt: Date.now(),
  });
  await saveActiveMode(ctx, { mode: 'skin' });
}

/** Switches back to Finch's own built-in light/dark/system theme, dropping
 * any custom color skin. */
async function applySystemTheme(ctx: finch.MiniToolContext, theme: 'system' | 'light' | 'dark'): Promise<void> {
  await getAppearance(ctx).setTheme({ theme });
  await saveActiveMode(ctx, { mode: 'system', systemTheme: theme });
}

function sanitizeColors(input: unknown): SkinColors {
  if (!input || typeof input !== 'object') return {};
  const allowedKeys: (keyof SkinColors)[] = [
    'bgRoot', 'bgMain', 'bgSidebar', 'bgElevated', 'bgHover', 'bgActive',
    'textPrimary', 'textSecondary', 'textTertiary', 'accent', 'accentDim', 'border',
  ];
  const out: SkinColors = {};
  const src = input as Record<string, unknown>;
  for (const key of allowedKeys) {
    const v = src[key];
    if (typeof v === 'string' && v.trim()) out[key] = v.trim();
  }
  return out;
}

/**
 * The skin "currently applied" that save / "extract current skin" keeps.
 * getTheme() first — the look on screen may have come from Appearance Settings
 * or AppCall's setAppearance and never passed through this mini tool — then the
 * locally recorded last-applied skin, which is all an older build can offer.
 */
async function extractCurrentSkin(
  ctx: finch.MiniToolContext,
): Promise<{ name: string; base: SkinBase; colors: SkinColors } | undefined> {
  const live = liveCustomTheme(await readLiveTheme(ctx));
  if (live) return live;
  const lastApplied = await loadLastApplied(ctx);
  return lastApplied
    ? { name: lastApplied.name, base: lastApplied.base, colors: lastApplied.colors }
    : undefined;
}

/** One skin's palette, spelled out — `current` hands this back to setTheme, so
 * every token has to stay visible. */
function formatSkinSnapshot(skin: { name: string; base: SkinBase; colors: SkinColors }, id?: string): string {
  const lines = [`Skin: "${skin.name}" (base: ${skin.base})${id ? ` [library id ${id}]` : ''}`];
  for (const [key, value] of Object.entries(skin.colors)) {
    if (value) lines.push(`  ${key}: ${value}`);
  }
  return lines.join('\n');
}

// ── What is actually on screen ──────────────────────────────────────────────

function sameColors(a: SkinColors, b: SkinColors): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as Array<keyof SkinColors>);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * Which library card the live skin corresponds to. Colors are compared rather
 * than the name, because two entries may share a name and because the host
 * keeps the exact tokens it was handed.
 */
function matchLibrarySkin(live: { base: SkinBase; colors: SkinColors }, customSkins: CustomSkin[]): string | undefined {
  const builtinHit = BUILTIN_SKINS.find((s) => s.base === live.base && sameColors(s.colors, live.colors));
  if (builtinHit) return builtinHit.id;
  return customSkins.find((s) => s.base === live.base && sameColors(s.colors, live.colors))?.id;
}

/**
 * What the panel should highlight. `getTheme()` wins when the host exposes it:
 * a skin can also arrive through Appearance Settings or AppCall's setAppearance,
 * and neither of those goes through `applySkin()`. Without it (older build) the
 * locally recorded state is the best available answer.
 */
async function resolveActiveState(
  ctx: finch.MiniToolContext,
  customSkins: CustomSkin[],
  lastApplied: LastApplied | undefined,
  storedMode: ActiveMode | undefined,
): Promise<{ activeSkinId?: string; activeMode: ActiveMode | null }> {
  const live = await readLiveTheme(ctx);
  if (!live) return { activeSkinId: lastApplied?.id, activeMode: storedMode ?? null };
  if (live.themePreference !== 'custom') {
    const systemTheme = live.themePreference === 'light' || live.themePreference === 'dark' ? live.themePreference : 'system';
    return { activeSkinId: undefined, activeMode: { mode: 'system', systemTheme } };
  }
  const custom = liveCustomTheme(live);
  return {
    activeSkinId: (custom ? matchLibrarySkin(custom, customSkins) : undefined) ?? lastApplied?.id,
    activeMode: { mode: 'skin' },
  };
}

// ── Panel state payload ─────────────────────────────────────────────────────

async function buildStatePayload(ctx: finch.MiniToolContext, panel: finch.AppPanel) {
  const [customSkins, background, lastApplied, storedMode] = await Promise.all([
    loadCustomSkins(ctx),
    loadBackground(ctx),
    loadLastApplied(ctx),
    loadActiveMode(ctx),
  ]);
  const { activeSkinId, activeMode } = await resolveActiveState(ctx, customSkins, lastApplied, storedMode);
  const builtin = BUILTIN_SKINS.map((s) => ({ id: s.id, name: builtinSkinName(ctx, s), base: s.base, colors: s.colors }));
  return {
    type: 'state',
    builtin,
    custom: customSkins,
    background,
    lastAppliedId: activeSkinId,
    activeMode,
    env: {
      sessionId: panel.sessionId ?? '',
      view: panel.view ?? '',
      spaceId: panel.spaceId ?? '',
      spaceName: panel.spaceName ?? '',
      locale: ctx.i18n.locale,
    },
  };
}

// ── Panel registry & broadcast ──────────────────────────────────────────────

const livePanels = new Set<finch.AppPanel>();
const boundPanels = new WeakSet<finch.AppPanel>();

async function broadcastState(ctx: finch.MiniToolContext): Promise<void> {
  for (const panel of livePanels) {
    try {
      await panel.postMessage(await buildStatePayload(ctx, panel));
    } catch (err) {
      ctx.logger.warn(`Failed to push state to panel ${panel.id}: ${String(err)}`);
    }
  }
}

interface PanelMessage {
  type: string;
  id?: string;
  name?: string;
  placement?: BackgroundPlacement;
  tone?: BackgroundTone;
  /** `data:image/...;base64,...` payload for a dropped/chosen background image. */
  dataUrl?: string;
  /** For setSystemTheme. */
  theme?: 'system' | 'light' | 'dark';
}

async function handlePanelMessage(ctx: finch.MiniToolContext, panel: finch.AppPanel, message: unknown): Promise<void> {
  const msg = message as PanelMessage;

  switch (msg.type) {
    case 'requestState': {
      await panel.postMessage(await buildStatePayload(ctx, panel));
      break;
    }

    case 'applySkin': {
      if (!msg.id) break;
      const resolved = await resolveSkinById(ctx, msg.id);
      if (!resolved) {
        await panel.postMessage({ type: 'error', message: tr(ctx, 'panel.error.skinNotFound', 'Skin not found.') });
        break;
      }
      try {
        await applySkin(ctx, resolved);
        await broadcastState(ctx);
      } catch (err) {
        await panel.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
      break;
    }

    case 'removeSkin': {
      if (!msg.id) break;
      const all = await loadCustomSkins(ctx);
      const filtered = all.filter((s) => s.id !== msg.id);
      if (filtered.length === all.length) break;
      await saveCustomSkins(ctx, filtered);
      await broadcastState(ctx);
      break;
    }

    case 'requestSaveCurrent': {
      const current = await extractCurrentSkin(ctx);
      if (!current) {
        await panel.postMessage({
          type: 'error',
          message: tr(
            ctx,
            'panel.error.noCurrentSkin',
            'No applied skin to save yet — apply a preset or an AI-designed skin first.',
          ),
        });
        break;
      }
      const result = await ctx.ui.showModalDialog({
        title: tr(ctx, 'modal.saveSkin.title', 'Save current skin'),
        description: tr(
          ctx,
          'modal.saveSkin.description',
          'Save the currently applied colors as a custom skin you can switch to later.',
        ),
        fields: [
          {
            key: 'name',
            label: tr(ctx, 'modal.saveSkin.nameLabel', 'Skin name'),
            type: 'text',
            required: true,
            default: current.name,
            placeholder: tr(ctx, 'modal.saveSkin.namePlaceholder', 'My Custom Skin'),
          },
        ],
        actions: [
          { id: 'cancel', label: tr(ctx, 'modal.cancel', 'Cancel') },
          { id: 'save', label: tr(ctx, 'modal.save', 'Save'), variant: 'primary' },
        ],
      });
      if (result.action !== 'save') break;
      const name = String(result.values?.name ?? '').trim() || current.name;
      const custom = await loadCustomSkins(ctx);
      const entry: CustomSkin = {
        id: randomUUID(),
        name,
        base: current.base,
        colors: current.colors,
        createdAt: Date.now(),
      };
      custom.push(entry);
      await saveCustomSkins(ctx, custom);
      await broadcastState(ctx);
      break;
    }

    case 'requestImportSkin': {
      // Panel opens a paste-JSON modal rather than a file dialog: the whole
      // point of export-as-copy is that the round trip never touches disk.
      const result = await ctx.ui.showModalDialog({
        title: tr(ctx, 'modal.importSkin.title', 'Import skin'),
        description: tr(
          ctx,
          'modal.importSkin.description',
          'Paste a skin exported from Skin Studio to add it to your library.',
        ),
        fields: [
          {
            key: 'json',
            label: tr(ctx, 'modal.importSkin.jsonLabel', 'Skin data'),
            type: 'textarea',
            required: true,
            placeholder: tr(ctx, 'modal.importSkin.jsonPlaceholder', 'Paste the copied skin JSON here…'),
          },
        ],
        actions: [
          { id: 'cancel', label: tr(ctx, 'modal.cancel', 'Cancel') },
          { id: 'import', label: tr(ctx, 'modal.import', 'Import'), variant: 'primary' },
        ],
      });
      if (result.action !== 'import') break;
      const raw = String(result.values?.json ?? '').trim();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        await panel.postMessage({
          type: 'error',
          message: tr(ctx, 'panel.error.importInvalid', 'This is not a valid skin export.'),
        });
        break;
      }
      const record = parsed as { name?: unknown; base?: unknown; colors?: unknown };
      const importedName = typeof record.name === 'string' ? record.name.trim() : '';
      const importedBase: SkinBase = record.base === 'dark' ? 'dark' : 'light';
      const importedColors = sanitizeColors(record.colors);
      if (!importedName || Object.keys(importedColors).length === 0) {
        await panel.postMessage({
          type: 'error',
          message: tr(ctx, 'panel.error.importInvalid', 'This is not a valid skin export.'),
        });
        break;
      }
      const custom = await loadCustomSkins(ctx);
      const entry: CustomSkin = {
        id: randomUUID(),
        name: importedName,
        base: importedBase,
        colors: importedColors,
        createdAt: Date.now(),
      };
      custom.push(entry);
      await saveCustomSkins(ctx, custom);
      await broadcastState(ctx);
      await panel.postMessage({ type: 'toast', message: tr(ctx, 'panel.skinImported', 'Skin imported') });
      break;
    }

    case 'setSystemTheme': {
      const theme = msg.theme === 'light' || msg.theme === 'dark' ? msg.theme : 'system';
      try {
        await applySystemTheme(ctx, theme);
        await broadcastState(ctx);
      } catch (err) {
        await panel.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
      break;
    }

    case 'uploadBackgroundImage': {
      // The panel triggers this both for a picked file (a hidden native
      // <input type=file>, giving the OS's real "open file" dialog — mini
      // tools have no other way to reach one) and for a drag-and-dropped
      // file. Either way the page hands us raw bytes (no reliable absolute
      // path exists for a sandboxed-renderer File), so we persist a managed
      // copy under this mini tool's own storage directory.
      const dataUrl = typeof msg.dataUrl === 'string' ? msg.dataUrl : '';
      const originalName = typeof msg.name === 'string' ? msg.name : undefined;
      const cfg = await loadBackground(ctx);
      try {
        const imagePath = await saveDroppedImage(ctx, dataUrl, originalName);
        const next: BackgroundConfig = { ...cfg, imagePath };
        await getAppearance(ctx).setHomeBackground({ imagePath, placement: next.placement, tone: next.tone });
        await cleanupManagedBackground(ctx, cfg.imagePath);
        await saveBackground(ctx, next);
        await broadcastState(ctx);
      } catch (err) {
        await panel.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
      break;
    }

    case 'setBackgroundOptions': {
      const cfg = await loadBackground(ctx);
      const next: BackgroundConfig = {
        imagePath: cfg.imagePath,
        placement: msg.placement ?? cfg.placement,
        tone: msg.tone ?? cfg.tone,
      };
      await saveBackground(ctx, next);
      if (next.imagePath) {
        try {
          await getAppearance(ctx).setHomeBackground({ imagePath: next.imagePath, placement: next.placement, tone: next.tone });
        } catch (err) {
          await panel.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
          break;
        }
      }
      await broadcastState(ctx);
      break;
    }

    case 'clearBackground': {
      try {
        await getAppearance(ctx).setHomeBackground({ clear: true });
      } catch (err) {
        await panel.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        break;
      }
      const cfg = await loadBackground(ctx);
      await cleanupManagedBackground(ctx, cfg.imagePath);
      await saveBackground(ctx, { placement: 'fill', tone: 'balanced' });
      await broadcastState(ctx);
      break;
    }
  }
}

// ── Agent tools ──────────────────────────────────────────────────────────────

function text(message: string, isError = false): finch.ToolResult {
  return { content: [{ type: 'text', text: message }], isError };
}

function formatSkinList(builtin: BuiltinSkin[], custom: CustomSkin[]): string {
  const lines: string[] = [];
  lines.push('Built-in presets:');
  for (const s of builtin) lines.push(`  - ${s.id} [${s.base}] ${s.name}`);
  lines.push(custom.length ? 'Custom skins:' : 'Custom skins: (none saved yet)');
  for (const s of custom) lines.push(`  - ${s.id} [${s.base}] ${s.name}`);
  return lines.join('\n');
}

function registerThemeTool(ctx: finch.MiniToolContext): finch.Disposable {
  return ctx.tools.register({
    name: 'skin_studio_theme',
    title: 'Skin Studio Theme',
    description:
      'Design, apply, save, and remove Finch color skins. Changes take effect immediately, same as editing Appearance Settings.\n' +
      'action:\n' +
      '  list    — list built-in presets (3 light + 3 dark) and the user\'s saved custom skins.\n' +
      '  current — read what is on screen right now: the theme preference and, when a custom skin is active, its name, base and colors. Call this before tweaking a skin you did not apply yourself instead of guessing a palette.\n' +
      '  apply   — apply a skin. Pass id to apply a built-in preset or a saved custom skin. To design and apply a new AI-generated skin in one step, omit id and pass name+base+colors instead; add save:true to also persist it as a custom skin in the same call. To switch back to Finch\'s own built-in theme instead of a custom color skin, pass systemTheme ("system"|"light"|"dark") and omit id/name/colors.\n' +
      '  save    — persist a skin into the custom library. Pass name+base+colors to save a specific palette (e.g. one just designed by AI), or omit colors to save the skin currently applied under a new name ("extract current skin").\n' +
      '  remove  — delete a custom skin by id (built-in presets cannot be removed).\n' +
      'Colors are a partial map — set only what you want, the rest inherits from base. Think in three axes, not one lightness ramp:\n' +
      '  · surface axis bgRoot → bgMain → bgSidebar → bgElevated. bgElevated (cards / popovers / inputs / bubbles) must sit one clear step away from bgMain — darker on light, lighter on dark; closer than that and Finch pushes it a step itself.\n' +
      '  · interaction axis bgHover / bgActive is a sheer veil over the current surface, not another surface. Recommended to leave both out: when omitted they are derived from bgElevated at a few percent intensity that follows the theme, which keeps every skin consistent.\n' +
      '  · accent axis accent (must stay dark/saturated enough for white text) + accentDim; border is an outline and takes no part in the hierarchy.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'current', 'apply', 'save', 'remove'] },
        id: { type: 'string', description: 'Built-in preset id or custom skin id. Required for remove; for apply, provide this, OR name+base+colors, OR systemTheme.' },
        systemTheme: {
          type: 'string',
          enum: ['system', 'light', 'dark'],
          description: 'For action=apply only: switch back to Finch\'s own built-in light/dark/system theme instead of a custom color skin. Takes priority over id/name+base+colors when present.',
        },
        name: { type: 'string', description: 'Skin display name. Required for save when colors is provided, and for an ad-hoc apply without id.' },
        base: { type: 'string', enum: ['light', 'dark'], description: 'Base preset unspecified colors inherit from. Required alongside colors.' },
        colors: {
          type: 'object',
          description:
            'Partial color map — only set what you want, rest inherit from base. Keys: bgRoot, bgMain, bgSidebar, bgElevated, textPrimary, textSecondary, textTertiary, accent (must stay dark/saturated enough for white text), accentDim, border. bgHover / bgActive exist but should normally be left out — omitted, they are derived from bgElevated as a thin veil that follows the theme.',
          properties: {
            bgRoot: { type: 'string' }, bgMain: { type: 'string' }, bgSidebar: { type: 'string' },
            bgElevated: { type: 'string' }, bgHover: { type: 'string' }, bgActive: { type: 'string' },
            textPrimary: { type: 'string' }, textSecondary: { type: 'string' }, textTertiary: { type: 'string' },
            accent: { type: 'string' }, accentDim: { type: 'string' }, border: { type: 'string' },
          },
        },
        save: { type: 'boolean', description: 'For action=apply with inline colors: also persist the applied skin into the custom library.' },
      },
      required: ['action'],
    },
    risk: 'medium',
    async execute(input): Promise<finch.ToolResult> {
      const action = String(input.action ?? '');

      switch (action) {
        case 'list': {
          const builtin = BUILTIN_SKINS.map((s) => ({ ...s, name: builtinSkinName(ctx, s) }));
          const custom = await loadCustomSkins(ctx);
          return text(formatSkinList(builtin, custom));
        }

        case 'current': {
          const live = await readLiveTheme(ctx);
          if (!live) {
            const lastApplied = await loadLastApplied(ctx);
            if (!lastApplied) {
              return text(
                'This Finch build has no ctx.appearance.getTheme(), and no skin has been applied through Skin Studio yet, so the current palette cannot be read. Update Finch, or apply a skin through Skin Studio first.',
                true,
              );
            }
            return text(
              'This Finch build has no ctx.appearance.getTheme(), so this is the last skin applied through Skin Studio, not necessarily what is on screen.\n' +
                formatSkinSnapshot({ name: lastApplied.name, base: lastApplied.base, colors: lastApplied.colors }, lastApplied.id),
            );
          }
          if (live.themePreference !== 'custom') {
            return text(
              `Theme preference: ${live.themePreference} — Finch's own built-in theme is active, there is no custom skin to tweak. `
              + 'Design one with action=apply (name+base+colors) if the user wants a custom look.',
            );
          }
          const custom = liveCustomTheme(live);
          if (!custom) return text('Theme preference: custom, but the host reported no usable custom skin colors.');
          const matched = matchLibrarySkin(custom, await loadCustomSkins(ctx));
          return text(
            `Theme preference: custom${matched ? ` (matches library id ${matched})` : ' (not in the Skin Studio library)'}.\n` +
              formatSkinSnapshot(custom),
          );
        }

        case 'apply': {
          const systemTheme =
            input.systemTheme === 'light' || input.systemTheme === 'dark' || input.systemTheme === 'system'
              ? input.systemTheme
              : undefined;
          if (systemTheme) {
            await applySystemTheme(ctx, systemTheme);
            await broadcastState(ctx);
            return text(`Switched to Finch's own built-in "${systemTheme}" theme.`);
          }
          const id = typeof input.id === 'string' ? input.id.trim() : '';
          if (id) {
            const resolved = await resolveSkinById(ctx, id);
            if (!resolved) return text(`No skin found with id "${id}". Use action=list to see available ids.`, true);
            await applySkin(ctx, resolved);
            await broadcastState(ctx);
            return text(`Applied skin "${resolved.name}" (${id}).`);
          }
          const name = typeof input.name === 'string' ? input.name.trim() : '';
          const base = input.base === 'dark' ? 'dark' : input.base === 'light' ? 'light' : undefined;
          if (!name || !base) return text('apply requires either "id", or "name"+"base"(+colors) for an ad-hoc skin.', true);
          const colors = sanitizeColors(input.colors);
          await applySkin(ctx, { name, base, colors });
          let savedNote = '';
          if (input.save === true) {
            const custom = await loadCustomSkins(ctx);
            const entry: CustomSkin = { id: randomUUID(), name, base, colors, createdAt: Date.now() };
            custom.push(entry);
            await saveCustomSkins(ctx, custom);
            savedNote = ` Saved to custom library as id ${entry.id}.`;
          }
          await broadcastState(ctx);
          return text(`Applied ad-hoc skin "${name}" (${base}).${savedNote}`);
        }

        case 'save': {
          const name = typeof input.name === 'string' ? input.name.trim() : '';
          if (!name) return text('save requires "name".', true);
          const hasColors = input.colors && typeof input.colors === 'object' && Object.keys(input.colors as object).length > 0;
          let base: SkinBase;
          let colors: SkinColors;
          if (hasColors) {
            const b = input.base === 'dark' ? 'dark' : input.base === 'light' ? 'light' : undefined;
            if (!b) return text('save with explicit colors also requires "base" ("light" or "dark").', true);
            base = b;
            colors = sanitizeColors(input.colors);
          } else {
            const current = await extractCurrentSkin(ctx);
            if (!current) {
              return text('No custom skin is applied right now (and this Finch build cannot read one), so there is nothing to extract. Pass base+colors explicitly, or apply a skin first.', true);
            }
            base = current.base;
            colors = current.colors;
          }
          const custom = await loadCustomSkins(ctx);
          const entry: CustomSkin = { id: randomUUID(), name, base, colors, createdAt: Date.now() };
          custom.push(entry);
          await saveCustomSkins(ctx, custom);
          await broadcastState(ctx);
          return text(`Saved custom skin "${name}" with id ${entry.id}.`);
        }

        case 'remove': {
          const id = typeof input.id === 'string' ? input.id.trim() : '';
          if (!id) return text('remove requires "id".', true);
          if (BUILTIN_BY_ID.has(id)) return text('Built-in presets cannot be removed.', true);
          const all = await loadCustomSkins(ctx);
          const found = all.find((s) => s.id === id);
          if (!found) return text(`No custom skin found with id: ${id}`, true);
          await saveCustomSkins(ctx, all.filter((s) => s.id !== id));
          await broadcastState(ctx);
          return text(`Removed custom skin "${found.name}" (${id}).`);
        }

        default:
          return text(`Unknown action: ${action}`, true);
      }
    },
  });
}

function registerBackgroundTool(ctx: finch.MiniToolContext): finch.Disposable {
  return ctx.tools.register({
    name: 'skin_studio_background',
    title: 'Skin Studio Background',
    description:
      "Set or clear Finch's Home background image. Changes take effect immediately, same as editing Appearance Settings.\n" +
      'action:\n' +
      '  set   — requires imagePath (absolute local path to a PNG/JPEG/WebP/GIF/AVIF file). Optional placement ("fill"|"tile", default "fill") and tone ("brightest"|"bright"|"balanced"|"dark"|"darkest", default "balanced").\n' +
      '  clear — remove the Home background and revert to the plain theme surface.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set', 'clear'] },
        imagePath: { type: 'string', description: 'Absolute local image path. Required for action=set.' },
        placement: { type: 'string', enum: ['fill', 'tile'], description: 'Default "fill".' },
        tone: { type: 'string', enum: ['brightest', 'bright', 'balanced', 'dark', 'darkest'], description: 'Default "balanced".' },
      },
      required: ['action'],
    },
    risk: 'medium',
    async execute(input): Promise<finch.ToolResult> {
      const action = String(input.action ?? '');
      if (action === 'set') {
        const imagePath = typeof input.imagePath === 'string' ? input.imagePath.trim() : '';
        if (!imagePath) return text('set requires "imagePath" (absolute local path).', true);
        const placement: BackgroundPlacement = input.placement === 'tile' ? 'tile' : 'fill';
        const tone: BackgroundTone =
          input.tone === 'brightest' || input.tone === 'bright' || input.tone === 'dark' || input.tone === 'darkest'
            ? input.tone
            : 'balanced';
        try {
          await getAppearance(ctx).setHomeBackground({ imagePath, placement, tone });
          await saveBackground(ctx, { imagePath, placement, tone });
          await broadcastState(ctx);
          return text(`Home background set (${placement}, ${tone}): ${imagePath}`);
        } catch (err) {
          return text(`Failed to set Home background: ${err instanceof Error ? err.message : String(err)}`, true);
        }
      }
      if (action === 'clear') {
        try {
          await getAppearance(ctx).setHomeBackground({ clear: true });
          await saveBackground(ctx, { placement: 'fill', tone: 'balanced' });
          await broadcastState(ctx);
          return text('Home background cleared.');
        } catch (err) {
          return text(`Failed to clear Home background: ${err instanceof Error ? err.message : String(err)}`, true);
        }
      }
      return text(`Unknown action: ${action}`, true);
    },
  });
}

// ── Activate ────────────────────────────────────────────────────────────────

export function activate(ctx: finch.MiniToolContext): void {
  ctx.subscriptions.push(registerThemeTool(ctx));
  ctx.subscriptions.push(registerBackgroundTool(ctx));

  ctx.subscriptions.push(
    ctx.ui.onDidOpenPanel((panel) => {
      livePanels.add(panel);
      if (!boundPanels.has(panel)) {
        boundPanels.add(panel);
        ctx.subscriptions.push(
          panel.onDidDispose(() => livePanels.delete(panel)),
          panel.onDidReceiveMessage((msg) => handlePanelMessage(ctx, panel, msg)),
        );
      }
      buildStatePayload(ctx, panel).then((payload) => panel.postMessage(payload));
    }),
  );

  ctx.subscriptions.push(
    ctx.composerActions.register('skin-studio-open', {
      async onClick() {
        const panel = ctx.ui.createPanel({ instanceMode: 'single' });
        await panel.reveal();
      },
    }),
  );

  ctx.logger.info('finch-skin-studio activated');
}

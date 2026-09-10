import type * as finch from 'finch';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';

// ── Types ───────────────────────────────────────────────────────────────────

type SkinBase = 'light' | 'dark';

/**
 * `ctx.appearance` (setTheme / setHomeBackground) is documented in the mini
 * tool authoring skill but not yet present in the published
 * `@finchtoys/minitool-api` type package this repo depends on. Declared here
 * as a local ambient type + safe runtime cast, the same pattern finch-delivery
 * uses for `ctx.ui.openFilePreview` — remove this shim once the published
 * types catch up.
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

/** Same shape as finch.AppearanceCustomThemeColors — kept local so this file
 * has no hard runtime dependency on exact SDK type exports. */
interface SkinColors {
  bgRoot?: string;
  bgMain?: string;
  bgSidebar?: string;
  bgElevated?: string;
  bgHover?: string;
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

const BUILTIN_SKINS: BuiltinSkin[] = [
  {
    id: 'light-snow',
    name: 'Snow White',
    base: 'light',
    colors: {
      bgRoot: '#ffffff',
      bgMain: '#ffffff',
      bgSidebar: '#f6f6f8',
      bgElevated: '#ffffff',
      bgHover: '#f0f1f3',
      bgActive: '#e6e8eb',
      textPrimary: '#1c1c1f',
      textSecondary: '#5b5d66',
      textTertiary: '#9a9ca6',
      accent: '#2f6fed',
      accentDim: '#e2ebfd',
      border: '#e6e7eb',
    },
  },
  {
    id: 'light-mint',
    name: 'Mint Morning',
    base: 'light',
    colors: {
      bgRoot: '#f6fbf8',
      bgMain: '#f6fbf8',
      bgSidebar: '#eef7f1',
      bgElevated: '#ffffff',
      bgHover: '#e6f3ea',
      bgActive: '#d8ecdf',
      textPrimary: '#173226',
      textSecondary: '#4d6b5b',
      textTertiary: '#93ab9d',
      accent: '#0e9f6e',
      accentDim: '#d9f4e6',
      border: '#dcece2',
    },
  },
  {
    id: 'light-peach',
    name: 'Peach Cream',
    base: 'light',
    colors: {
      bgRoot: '#fff8f6',
      bgMain: '#fff8f6',
      bgSidebar: '#fdeeec',
      bgElevated: '#ffffff',
      bgHover: '#fbe3e0',
      bgActive: '#f7d2ce',
      textPrimary: '#3a1f1d',
      textSecondary: '#7a4e49',
      textTertiary: '#b78d87',
      accent: '#e0527a',
      accentDim: '#fbdce6',
      border: '#f3ddd8',
    },
  },
  {
    id: 'dark-graphite',
    name: 'Graphite',
    base: 'dark',
    colors: {
      bgRoot: '#17181b',
      bgMain: '#1b1c20',
      bgSidebar: '#131417',
      bgElevated: '#222327',
      bgHover: '#28292e',
      bgActive: '#313239',
      textPrimary: '#f2f2f4',
      textSecondary: '#a7a8b2',
      textTertiary: '#6c6d78',
      accent: '#6366f1',
      accentDim: '#26264a',
      border: '#2b2c31',
    },
  },
  {
    id: 'dark-berry',
    name: 'Midnight Berry',
    base: 'dark',
    colors: {
      bgRoot: '#180f16',
      bgMain: '#1d1219',
      bgSidebar: '#140c12',
      bgElevated: '#25151f',
      bgHover: '#2c1a25',
      bgActive: '#38212e',
      textPrimary: '#f6eef2',
      textSecondary: '#c39cae',
      textTertiary: '#8a6577',
      accent: '#e02a8b',
      accentDim: '#3d1530',
      border: '#301c29',
    },
  },
  {
    id: 'dark-teal',
    name: 'Deep Teal',
    base: 'dark',
    colors: {
      bgRoot: '#0d1a1c',
      bgMain: '#0f2124',
      bgSidebar: '#0a1517',
      bgElevated: '#15292c',
      bgHover: '#1a3134',
      bgActive: '#20393c',
      textPrimary: '#eaf5f4',
      textSecondary: '#9fc0bf',
      textTertiary: '#5f8583',
      accent: '#0d9488',
      accentDim: '#0f3a35',
      border: '#1c3335',
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

// ── Panel state payload ─────────────────────────────────────────────────────

async function buildStatePayload(ctx: finch.MiniToolContext, panel: finch.AppPanel) {
  const [customSkins, background, lastApplied, activeMode] = await Promise.all([
    loadCustomSkins(ctx),
    loadBackground(ctx),
    loadLastApplied(ctx),
    loadActiveMode(ctx),
  ]);
  const builtin = BUILTIN_SKINS.map((s) => ({ id: s.id, name: builtinSkinName(ctx, s), base: s.base, colors: s.colors }));
  return {
    type: 'state',
    builtin,
    custom: customSkins,
    background,
    lastAppliedId: lastApplied?.id,
    activeMode: activeMode ?? null,
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
  /** For requestImportSkin. */
  base?: SkinBase;
  colors?: unknown;
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
      const lastApplied = await loadLastApplied(ctx);
      if (!lastApplied) {
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
            default: lastApplied.name,
            placeholder: tr(ctx, 'modal.saveSkin.namePlaceholder', 'My Custom Skin'),
          },
        ],
        actions: [
          { id: 'cancel', label: tr(ctx, 'modal.cancel', 'Cancel') },
          { id: 'save', label: tr(ctx, 'modal.save', 'Save'), variant: 'primary' },
        ],
      });
      if (result.action !== 'save') break;
      const name = String(result.values?.name ?? '').trim() || lastApplied.name;
      const custom = await loadCustomSkins(ctx);
      const entry: CustomSkin = {
        id: randomUUID(),
        name,
        base: lastApplied.base,
        colors: lastApplied.colors,
        createdAt: Date.now(),
      };
      custom.push(entry);
      await saveCustomSkins(ctx, custom);
      await broadcastState(ctx);
      break;
    }

    case 'requestImportSkin': {
      const importedName = typeof msg.name === 'string' ? msg.name.trim() : '';
      const importedBase: SkinBase = msg.base === 'dark' ? 'dark' : 'light';
      const importedColors = sanitizeColors(msg.colors);
      if (!importedName || Object.keys(importedColors).length === 0) {
        await panel.postMessage({
          type: 'error',
          message: tr(ctx, 'panel.error.importInvalid', 'This file is not a valid skin export.'),
        });
        break;
      }
      const result = await ctx.ui.showModalDialog({
        title: tr(ctx, 'modal.importSkin.title', 'Import skin'),
        description: tr(ctx, 'modal.importSkin.description', 'Save this imported skin to your custom library.'),
        fields: [
          {
            key: 'name',
            label: tr(ctx, 'modal.saveSkin.nameLabel', 'Skin name'),
            type: 'text',
            required: true,
            default: importedName,
            placeholder: tr(ctx, 'modal.saveSkin.namePlaceholder', 'My Custom Skin'),
          },
        ],
        actions: [
          { id: 'cancel', label: tr(ctx, 'modal.cancel', 'Cancel') },
          { id: 'save', label: tr(ctx, 'modal.save', 'Save'), variant: 'primary' },
        ],
      });
      if (result.action !== 'save') break;
      const finalName = String(result.values?.name ?? '').trim() || importedName;
      const custom = await loadCustomSkins(ctx);
      const entry: CustomSkin = {
        id: randomUUID(),
        name: finalName,
        base: importedBase,
        colors: importedColors,
        createdAt: Date.now(),
      };
      custom.push(entry);
      await saveCustomSkins(ctx, custom);
      await broadcastState(ctx);
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
      '  list   — list built-in presets (3 light + 3 dark) and the user\'s saved custom skins.\n' +
      '  apply  — apply a skin. Pass id to apply a built-in preset or a saved custom skin. To design and apply a new AI-generated skin in one step, omit id and pass name+base+colors instead; add save:true to also persist it as a custom skin in the same call. To switch back to Finch\'s own built-in theme instead of a custom color skin, pass systemTheme ("system"|"light"|"dark") and omit id/name/colors.\n' +
      '  save   — persist a skin into the custom library. Pass name+base+colors to save a specific palette (e.g. one just designed by AI), or omit colors to save the most recently applied skin under a new name ("extract current skin").\n' +
      '  remove — delete a custom skin by id (built-in presets cannot be removed).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'apply', 'save', 'remove'] },
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
            'Partial color map — only set what you want, rest inherit from base. Keys: bgRoot, bgMain, bgSidebar, bgElevated, bgHover, bgActive, textPrimary, textSecondary, textTertiary, accent (must stay dark/saturated enough for white text), accentDim, border.',
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
            const lastApplied = await loadLastApplied(ctx);
            if (!lastApplied) {
              return text('No skin has been applied through Skin Studio yet, so there is nothing to extract. Pass base+colors explicitly, or apply a skin first.', true);
            }
            base = lastApplied.base;
            colors = lastApplied.colors;
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

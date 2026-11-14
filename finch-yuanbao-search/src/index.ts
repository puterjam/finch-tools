import type * as finch from 'finch';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  searchPro,
  ALLOWED_COUNTS,
  type SearchProInput,
} from './client';
import { renderResult } from './format';
import {
  resolveCredentials,
  importKeyFileIfPresent,
  readKeyFile,
  maskSecretId,
  SECRET_ID_KEY,
  SECRET_KEY_KEY,
  DEFAULT_KEY_FILE,
} from './credentials';
import {
  ApiError,
  ParamError,
  explainApiError,
  explainLocalError,
  explainMissingCredentials,
  explainParamError,
  renderError,
  type ExplainedError,
} from './errors';

/**
 * Shared by the manifest `contributes.iconPacks` declaration, the registration
 * below, and every `ext:` reference. Declaring the pack only reserves the
 * namespace — the SVGs have to be registered at runtime or every reference
 * silently resolves to nothing and no icon renders at all.
 */
const ICON_PACK_ID = 'yuanbao-search-icons';
const ICON_FILES = ['search', 'key-round', 'plug'] as const;

/** Milliseconds a single SearchPro request is allowed to take. */
const REQUEST_TIMEOUT_MS = 30_000;
/** How long the in-call credential form waits before giving up. */
const FORM_TIMEOUT_MS = 120_000;

/**
 * Human ways of saying a time range, mapped onto the API's compact `Freshness`.
 *
 * The API only understands `d[N]` / `m[N]` / `y[N]` / dates, and `m` means
 * month — so a plain "1w"/"一周" has to be translated here rather than guessed
 * at by the model.
 */
const FRESHNESS_ALIASES: Record<string, string> = {
  today: 'd1',
  day: 'd1',
  '1d': 'd1',
  '1w': 'd7',
  week: 'd7',
  '1mo': 'm1',
  month: 'm1',
  '1y': 'y1',
  year: 'y1',
  '今天': 'd1',
  '当天': 'd1',
  '近1天': 'd1',
  '近一天': 'd1',
  '近1日': 'd1',
  '近一周': 'd7',
  '近1周': 'd7',
  '近7天': 'd7',
  '近一月': 'm1',
  '近1月': 'm1',
  '近一个月': 'm1',
  '近30天': 'd30',
  '近一年': 'y1',
  '近1年': 'y1',
};

export function normalizeFreshness(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  if (!text) return undefined;
  return FRESHNESS_ALIASES[text.toLowerCase()] ?? FRESHNESS_ALIASES[text] ?? text;
}

/**
 * Load the SVGs shipped in `icons/` (generated from lucide-static at build time)
 * and register them. A missing file is a warning, not a fatal error: losing one
 * glyph must not stop the whole mini tool from activating.
 */
function registerIcons(ctx: finch.MiniToolContext): void {
  const base = new URL('../icons/', import.meta.url);
  const icons: Record<string, { svg: string }> = {};
  for (const name of ICON_FILES) {
    try {
      icons[name] = { svg: readFileSync(new URL(`${name}.svg`, base), 'utf8') };
    } catch {
      ctx.logger.warn(`[yuanbao-search] missing icon ${name}.svg — that glyph will not render`);
    }
  }
  ctx.subscriptions.push(ctx.icons.register(ICON_PACK_ID, icons));
}

function errorResult(error: ExplainedError, t: (key: string, values?: Record<string, string | number>) => string): finch.ToolResult {
  return { content: [{ type: 'text', text: renderError(t, error) }], isError: true };
}

/**
 * Ask for the key pair inside the running tool call, so a first-time user can
 * finish what they asked for without leaving the chat. Values go straight into
 * secure storage and are never echoed back into the model context.
 */
async function promptForCredentials(
  ctx: finch.MiniToolContext,
  exec: finch.ToolExecutionContext,
  t: (key: string, values?: Record<string, string | number>) => string,
) {
  let result: finch.MiniToolFormResult;
  try {
    result = await exec.ui.requestForm({
      title: t('form.title'),
      description: t('form.desc'),
      submitLabel: t('form.submit'),
      timeoutMs: FORM_TIMEOUT_MS,
      fields: [
        { key: 'secretId', label: 'SecretId', type: 'text', required: true, width: 'full' },
        { key: 'secretKey', label: 'SecretKey', type: 'password', secret: true, required: true, width: 'full' },
      ],
    });
  } catch (error) {
    ctx.logger.warn(`[yuanbao-search] credential form failed: ${String(error)}`);
    return null;
  }
  if (!result.submitted) return null;
  const secretId = String(result.values?.secretId ?? '').trim();
  const secretKey = String(result.values?.secretKey ?? '').trim();
  if (!secretId || !secretKey) return null;
  await ctx.secrets.set(SECRET_ID_KEY, secretId);
  await ctx.secrets.set(SECRET_KEY_KEY, secretKey);
  return resolveCredentials(ctx);
}

export function activate(ctx: finch.MiniToolContext): void {
  const t = (key: string, values?: Record<string, string | number>): string => ctx.i18n.t(key, values);

  registerIcons(ctx);

  // One-time bootstrap: if secure storage is empty but the operator left the
  // key file on disk, move it into the keychain so the tool just works. The
  // file is left as-is and its contents are never logged.
  void importKeyFileIfPresent(ctx)
    .then((outcome) => {
      if (outcome === 'imported') {
        ctx.logger.info('[yuanbao-search] imported the key pair from the local key file into secure storage');
      }
    })
    .catch((error: unknown) => ctx.logger.warn(`[yuanbao-search] key-file bootstrap skipped: ${String(error)}`));

  ctx.subscriptions.push(ctx.tools.register({
    name: 'yuanbao_search',
    title: t('tool.title'),
    description: t('tool.description'),
    risk: 'low',
    defaultEnabled: true,
    // Covers the credential form wait plus the request itself.
    timeoutMs: FORM_TIMEOUT_MS + REQUEST_TIMEOUT_MS + 30_000,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: t('tool.p.query') },
        count: {
          type: 'number',
          description: t('tool.p.count', { allowed: ALLOWED_COUNTS.join('/') }),
        },
        timeRange: { type: 'string', description: t('tool.p.timeRange') },
        mode: { type: 'number', description: t('tool.p.mode') },
        industry: { type: 'string', description: t('tool.p.industry') },
        site: { type: 'string', description: t('tool.p.site') },
        deeplinks: { type: 'boolean', description: t('tool.p.deeplinks') },
        includeContent: { type: 'boolean', description: t('tool.p.includeContent') },
        snippetChars: { type: 'number', description: t('tool.p.snippetChars') },
        includeRaw: { type: 'boolean', description: t('tool.p.includeRaw') },
      },
      required: ['query'],
    },
    async execute(input, exec) {
      const query = String((input as { query?: unknown }).query ?? '').trim();
      if (!query) return errorResult(explainParamError(t, new ParamError('query')), t);

      let creds = await resolveCredentials(ctx);
      if (!creds) creds = await promptForCredentials(ctx, exec, t);
      if (!creds) return errorResult(explainMissingCredentials(t), t);

      exec.progress.report({ stage: 'searching', message: t('progress.searching', { query }) });

      const raw = input as Record<string, unknown>;
      const searchInput: SearchProInput = {
        query,
        count: typeof raw.count === 'number' ? raw.count : undefined,
        freshness: normalizeFreshness(raw.timeRange),
        mode: typeof raw.mode === 'number' ? raw.mode : undefined,
        industry: typeof raw.industry === 'string' ? raw.industry : undefined,
        site: typeof raw.site === 'string' ? raw.site : undefined,
        deeplinks: typeof raw.deeplinks === 'boolean' ? raw.deeplinks : undefined,
      };

      try {
        const result = await searchPro(creds, searchInput, {
          timeoutMs: REQUEST_TIMEOUT_MS,
          signal: exec.signal,
        });
        return {
          content: [{
            type: 'text',
            text: renderResult(t, result, {
              snippetChars: typeof raw.snippetChars === 'number' ? raw.snippetChars : undefined,
              includeContent: raw.includeContent === true,
              includeRaw: raw.includeRaw === true,
            }),
          }],
        };
      } catch (error) {
        if (error instanceof ApiError) return errorResult(explainApiError(t, error), t);
        if (error instanceof ParamError) return errorResult(explainParamError(t, error), t);
        ctx.logger.warn(`[yuanbao-search] request failed: ${String(error)}`);
        return errorResult(explainLocalError(t, error), t);
      }
    },
  }));

  registerSettingsMenu(ctx, t);
}

function registerSettingsMenu(
  ctx: finch.MiniToolContext,
  t: (key: string, values?: Record<string, string | number>) => string,
): void {
  // Kept in this closure rather than at module scope: a module-level variable
  // would survive a disable/enable cycle and keep showing a stale probe result.
  let lastProbe: string | undefined;

  ctx.subscriptions.push(ctx.settingsMenu.register({
    async getMenu() {
      const creds = await resolveCredentials(ctx);
      const items: finch.ComposerActionMenuItem[] = [];

      if (creds) {
        items.push({
          id: 'status',
          label: t('menu.status', { id: maskSecretId(creds.secretId) }),
          description: t(`menu.status.${creds.source}`),
          disabled: true,
          iconName: 'ext:yuanbao-search-icons/key-round',
        });
      } else {
        items.push({
          id: 'status',
          label: t('menu.status.none'),
          disabled: true,
          iconName: 'ext:yuanbao-search-icons/key-round',
        });
      }

      items.push({
        id: 'configure',
        label: t('menu.configure'),
        description: t('menu.configure.desc'),
        iconName: 'ext:yuanbao-search-icons/key-round',
      });

      if (!creds && (await readKeyFile())) {
        items.push({
          id: 'import',
          label: t('menu.import'),
          description: t('menu.import.desc', { path: DEFAULT_KEY_FILE }),
        });
      }

      items.push({ id: 'sep', label: '', separator: true });
      items.push({
        id: 'test',
        label: t('menu.test'),
        description: lastProbe ?? t('menu.test.desc'),
        iconName: 'ext:yuanbao-search-icons/plug',
      });

      return items;
    },

    async execute(_menuCtx, itemId) {
      if (itemId === 'configure') {
        const result = await ctx.ui.showModalDialog({
          title: t('dialog.title'),
          message: t('dialog.message'),
          actions: [
            { id: 'cancel', label: t('dialog.cancel') },
            { id: 'save', label: t('dialog.save'), variant: 'primary' },
          ],
          fields: [
            { key: 'secretId', label: 'SecretId', type: 'text', required: true, width: 'full' },
            { key: 'secretKey', label: 'SecretKey', type: 'password', secret: true, required: true, width: 'full' },
          ],
        });
        if (result.action !== 'save') return;
        const secretId = String(result.values?.secretId ?? '').trim();
        const secretKey = String(result.values?.secretKey ?? '').trim();
        if (!secretId || !secretKey) return;
        await ctx.secrets.set(SECRET_ID_KEY, secretId);
        await ctx.secrets.set(SECRET_KEY_KEY, secretKey);
        lastProbe = undefined;
        await ctx.ui.showModalDialog({
          title: t('dialog.saved.title'),
          message: t('dialog.saved.message', { id: maskSecretId(secretId) }),
          actions: [{ id: 'ok', label: t('dialog.ok'), variant: 'primary' }],
        });
        return;
      }

      if (itemId === 'import') {
        const outcome = await importKeyFileIfPresent(ctx);
        lastProbe = undefined;
        await ctx.ui.showModalDialog({
          title: t('dialog.import.title'),
          message: outcome === 'imported' ? t('dialog.import.ok') : t('dialog.import.none', { path: DEFAULT_KEY_FILE }),
          actions: [{ id: 'ok', label: t('dialog.ok'), variant: 'primary' }],
        });
        return;
      }

      if (itemId === 'test') {
        const creds = await resolveCredentials(ctx);
        if (!creds) {
          lastProbe = t('probe.noKey');
          return;
        }
        try {
          const result = await searchPro(creds, { query: '腾讯', count: 10 }, { timeoutMs: REQUEST_TIMEOUT_MS });
          lastProbe = t('probe.ok', { count: result.pages.length });
          await ctx.ui.showModalDialog({
            title: t('probe.ok.title'),
            message: t('probe.ok.message', { count: result.pages.length, version: result.version ?? '?', requestId: result.requestId }),
            actions: [{ id: 'ok', label: t('dialog.ok'), variant: 'primary' }],
          });
        } catch (error) {
          const explained = error instanceof ApiError
            ? explainApiError(t, error)
            : error instanceof ParamError
              ? explainParamError(t, error)
              : explainLocalError(t, error);
          lastProbe = t('probe.fail', { title: explained.title });
          await ctx.ui.showModalDialog({
            title: t('probe.fail.title'),
            message: renderError(t, explained),
            actions: [{ id: 'ok', label: t('dialog.ok'), variant: 'primary' }],
          });
        }
      }
    },
  }));
}

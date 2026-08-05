import type * as finch from 'finch';
import { randomBytes } from 'node:crypto';

// ── Tencent Docs MCP services ────────────────────────────────────────────────
// Four independent MCP endpoints share the same Authorization token.
// Tokens are minted through Tencent's own OAuth-style flow (auth code page →
// token/get endpoint), not standard MCP OAuth discovery, so we collect the
// token ourselves and register the servers with a static Authorization header.

interface TdocServer {
  name: string;
  url: string;
  kind: string;
}

const SERVERS: TdocServer[] = [
  { name: 'tencent-docs', url: 'https://docs.qq.com/openapi/mcp', kind: 'general' },
  { name: 'slide-mcp', url: 'https://docs.qq.com/api/v6/slide/mcp', kind: 'slide' },
  { name: 'doc-mcp', url: 'https://docs.qq.com/api/v6/doc/mcp', kind: 'doc' },
  { name: 'sheet-mcp', url: 'https://docs.qq.com/api/v6/sheet/mcp', kind: 'sheet' },
];

const AUTH_BASE = 'https://docs.qq.com';
const TOKEN_KEY = 'TENCENT_DOCS_TOKEN';
const PENDING_CODE_KEY = 'tdocs_pending_auth_code';
const TOKEN_POLL_INTERVAL_MS = 2_000;
const TOKEN_POLL_ATTEMPTS = 15; // ~30s after the user confirms

function authUrl(code: string): string {
  return `${AUTH_BASE}/scenario/open-claw.html?nlc=1&authType=1&code=${code}&mcp_source=desktop`;
}

function tokenEndpoint(code: string): string {
  return `${AUTH_BASE}/oauth/v2/mcp/token/get?code=${code}`;
}

interface McpClientCapability {
  registerServer(config: unknown): Promise<{ ok: boolean; error?: string }>;
  unregisterServer(name: string): Promise<{ ok: boolean }>;
  listTools(name: string): Promise<Array<{ name: string; description?: string }>>;
  callTool(name: string, tool: string, args: Record<string, unknown>): Promise<unknown>;
}

type Ctx = finch.MiniToolContext;

// ── Token storage ─────────────────────────────────────────────────────────────
// Prefer the platform Keychain via ctx.secrets.set when the runtime exposes it;
// fall back to the mini-tool KV storage otherwise.

async function readToken(ctx: Ctx): Promise<string | undefined> {
  const fromSecrets = await ctx.secrets.get(TOKEN_KEY).catch(() => undefined);
  if (fromSecrets) return fromSecrets;
  const stored = await ctx.storage.get<{ token?: string }>('tdocs');
  return stored?.token || undefined;
}

async function writeToken(ctx: Ctx, token: string): Promise<'keychain' | 'storage'> {
  const secrets = ctx.secrets as unknown as { set?: (k: string, v: string) => Promise<unknown> };
  if (typeof secrets.set === 'function') {
    try {
      await secrets.set(TOKEN_KEY, token);
      return 'keychain';
    } catch {
      // fall through to storage
    }
  }
  await ctx.storage.set('tdocs', { token });
  return 'storage';
}

async function clearToken(ctx: Ctx): Promise<void> {
  const secrets = ctx.secrets as unknown as { set?: (k: string, v: string) => Promise<unknown> };
  if (typeof secrets.set === 'function') {
    await secrets.set(TOKEN_KEY, '').catch(() => {});
  }
  await ctx.storage.delete('tdocs').catch(() => {});
}

// ── mcp.client readiness ──────────────────────────────────────────────────────
// MCP Client may activate after this extension; poll briefly before use.

async function waitForMcpClient(ctx: Ctx): Promise<McpClientCapability | undefined> {
  for (let i = 0; i < 60; i++) {
    if (ctx.capabilities.has('mcp.client')) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ctx.capabilities.has('mcp.client')) {
    ctx.logger.warn('mcp.client capability not available after waiting 30s — is the MCP Client mini tool enabled?');
    return undefined;
  }
  return ctx.capabilities.get<McpClientCapability>('mcp.client');
}

async function registerAll(ctx: Ctx, mcp: McpClientCapability, token: string): Promise<Array<{ name: string; ok: boolean; error?: string }>> {
  const results: Array<{ name: string; ok: boolean; error?: string }> = [];
  for (const server of SERVERS) {
    const result = await mcp.registerServer({
      name: server.name,
      url: server.url,
      headers: { Authorization: token },
      ownerExtensionId: ctx.extension.id,
      ownerExtensionName: ctx.extension.displayName,
    });
    results.push({ name: server.name, ok: result.ok, error: result.error });
    if (!result.ok) ctx.logger.warn(`registerServer ${server.name} failed`, result.error);
  }
  return results;
}

async function unregisterAll(ctx: Ctx, mcp: McpClientCapability): Promise<void> {
  for (const server of SERVERS) {
    await mcp.unregisterServer(server.name).catch(() => {});
  }
}

// ── Authorization flow ────────────────────────────────────────────────────────
// 1. Generate a client-side code, build the auth page URL.
// 2. User opens the URL, signs in with QQ/WeChat.
// 3. Poll GET /oauth/v2/mcp/token/get?code=… until a token appears.

interface TokenPollResult {
  token?: string;
  error?: string;
  kind?: 'not_authorized' | 'expired' | 'token_invalid' | 'vip_required' | 'network';
}

async function pollToken(code: string, signal?: AbortSignal, attempts = TOKEN_POLL_ATTEMPTS): Promise<TokenPollResult> {
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) return { error: 'aborted', kind: 'network' };
    try {
      const response = await fetch(tokenEndpoint(code), { signal });
      if (!response.ok) {
        await new Promise((resolve) => setTimeout(resolve, TOKEN_POLL_INTERVAL_MS));
        continue;
      }
      const body = (await response.json()) as Record<string, unknown>;
      const data = (body.data ?? {}) as Record<string, unknown>;
      const token = typeof data.token === 'string' && data.token ? data.token : undefined;
      if (token) return { token };
      if (data.expired === true || body.ret === 400006) return { error: 'expired', kind: 'expired' };
      if (body.ret === 400007) return { error: 'vip_required', kind: 'vip_required' };
      // ret 11510 (or anything else) → user has not finished authorizing yet
    } catch {
      // network hiccup — retry
    }
    await new Promise((resolve) => setTimeout(resolve, TOKEN_POLL_INTERVAL_MS));
  }
  return { error: 'not_authorized', kind: 'not_authorized' };
}

// ── Shared status snapshot ────────────────────────────────────────────────────

interface TdocStatus {
  configured: boolean;
  authSource?: 'keychain' | 'storage';
  servers: Array<{ name: string; kind: string; connected: boolean }>;
  mcpClient: boolean;
}

async function getStatus(ctx: Ctx): Promise<TdocStatus> {
  const token = await readToken(ctx);
  const stored = await ctx.storage.get<{ token?: string }>('tdocs');
  let authSource: 'keychain' | 'storage' | undefined;
  if (token) {
    authSource = stored?.token === token ? 'storage' : 'keychain';
  }
  const mcpClient = ctx.capabilities.has('mcp.client');
  const registeredNames = new Set<string>();
  if (mcpClient) {
    const mcp = ctx.capabilities.get<McpClientCapability>('mcp.client');
    for (const server of SERVERS) {
      try {
        await mcp.listTools(server.name);
        registeredNames.add(server.name);
      } catch {
        // not connected (no token, wrong token, or not registered)
      }
    }
  }
  return {
    configured: Boolean(token),
    authSource,
    servers: SERVERS.map((server) => ({
      name: server.name,
      kind: server.kind,
      connected: registeredNames.has(server.name),
    })),
    mcpClient,
  };
}

// ── Composer action icon ──────────────────────────────────────────────────────

function tdocsIconSvg(): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><path d="M9 13h6"/><path d="M9 17h6"/></svg>';
}
type Translate = (key: string, values?: Record<string, string | number | boolean | null | undefined>) => string;

export function activate(ctx: Ctx): void {
  const tr: Translate = (key, values) => ctx.i18n.t(key, values);

  // ── Icon pack ───────────────────────────────────────────────────────────────
  ctx.subscriptions.push(ctx.icons.register('tencent-docs-icons', {
    tdocs: { svg: tdocsIconSvg() },
  }));

  // ── Composer action: badge + menu ───────────────────────────────────────────
  let statusCache: TdocStatus | undefined;
  let statusInFlight: Promise<void> | undefined;
  const refreshStatus = (): Promise<void> => {
    if (statusInFlight) return statusInFlight;
    statusInFlight = getStatus(ctx)
      .then((status) => {
        statusCache = status;
        action.notifyUpdate();
      })
      .catch((error) => ctx.logger.warn('Tencent Docs status refresh failed', error))
      .finally(() => {
        statusInFlight = undefined;
      });
    return statusInFlight;
  };

  // Re-register servers whenever a token becomes available. Called at startup
  // and after every successful authorization.
  const registerWithCurrentToken = async (): Promise<void> => {
    try {
      const mcp = await waitForMcpClient(ctx);
      if (!mcp) {
        ctx.logger.warn('registerWithCurrentToken: mcp.client unavailable');
        return;
      }
      const token = await readToken(ctx);
      if (!token) {
        ctx.logger.info('registerWithCurrentToken: no token, skip registration');
        return;
      }
      const results = await registerAll(ctx, mcp, token);
      ctx.logger.info('Tencent Docs servers registered', { results });
      refreshStatus();
    } catch (error) {
      ctx.logger.error('registerWithCurrentToken failed', error);
    }
  };

  const action = ctx.composerActions.register('tencent-docs', {
    async getBadge() {
      const status = statusCache ?? (await getStatus(ctx));
      if (!status.mcpClient) return { text: '⚠', active: false };
      if (status.configured) return { text: '✓', active: true };
      return { text: '·', active: false };
    },

    async getMenu(): Promise<finch.ComposerActionMenuItem[]> {
      if (!statusCache) await refreshStatus();
      const status = statusCache ?? { configured: false, servers: [], mcpClient: false };

      const items: finch.ComposerActionMenuItem[] = [];
      if (!status.mcpClient) {
        items.push({
          id: '__mcp_missing__',
          label: tr('menu.mcpMissing.label'),
          description: tr('menu.mcpMissing.description'),
          iconName: 'bot-off',
          disabled: true,
        });
      } else if (status.configured) {
        items.push({
          id: '__connected__',
          label: tr('menu.connected.label'),
          description: tr('menu.connected.description'),
          iconName: 'check-circle-2',
          disabled: true,
        });
        for (const server of status.servers) {
          items.push({
            id: `__server_${server.name}__`,
            label: tr(`menu.server.${server.kind}`),
            description: server.connected ? tr('menu.server.ready') : tr('menu.server.pending'),
            iconName: server.connected ? 'circle-check' : 'loader',
            disabled: true,
          });
        }
        items.push({ id: '__divider_1__', label: '', separator: true });
        items.push({
          id: '__reauth__',
          label: tr('menu.reauth.label'),
          description: tr('menu.reauth.description'),
          iconName: 'refresh-cw',
        });
        items.push({
          id: '__clear__',
          label: tr('menu.clear.label'),
          description: tr('menu.clear.description'),
          iconName: 'log-out',
        });
      } else {
        items.push({
          id: '__signed_out__',
          label: tr('menu.signedOut.label'),
          description: tr('menu.signedOut.description'),
          iconName: 'user-x',
          disabled: true,
        });
        items.push({
          id: '__auth__',
          label: tr('menu.auth.label'),
          description: tr('menu.auth.description'),
          iconName: 'key-round',
        });
      }

      items.push({ id: '__divider_2__', label: '', separator: true });
      items.push({
        id: '__home__',
        label: tr('menu.home.label'),
        description: 'docs.qq.com',
        iconName: 'external-link',
      });
      return items;
    },

    async execute(_context, itemId) {
      try {
        switch (itemId) {
          case '__auth__':
          case '__reauth__':
            await runAuthDialog(ctx, tr);
            await registerWithCurrentToken();
            return;
          case '__clear__':
            await clearToken(ctx);
            const mcp = await waitForMcpClient(ctx);
            if (mcp) await unregisterAll(ctx, mcp);
            await ctx.ui.showToast({ title: tr('toast.signedOut'), variant: 'success', position: 'TC' });
            refreshStatus();
            return;
          case '__home__':
            await ctx.ui.showModalDialog({
              title: tr('dialog.home.title'),
              actions: [{ id: 'cancel', label: tr('dialog.close') }],
              fields: [{ key: 'home', label: tr('dialog.home.link'), type: 'link', href: 'https://docs.qq.com/home' }],
            });
            return;
          default:
            return;
        }
      } catch (error) {
        ctx.logger.error('Tencent Docs composer action failed', error);
        await ctx.ui.showToast({
          title: tr('toast.actionFailed'),
          description: error instanceof Error ? error.message : String(error),
          variant: 'error',
          position: 'TC',
        });
      }
    },
  });
  ctx.subscriptions.push(action);
  ctx.subscriptions.push(ctx.i18n.onDidChangeLocale(() => action.notifyUpdate()));

  // ── tdocs_status: connection overview ───────────────────────────────────────
  ctx.subscriptions.push(ctx.tools.register({
    name: 'tdocs_status',
    title: 'Tencent Docs Status',
    description: `Check the Tencent Docs connection state: whether the account token is
configured, and whether the four MCP services (tencent-docs / slide-mcp / doc-mcp /
sheet-mcp) are registered. Call this first when a tencent_docs or mcp__* tool fails
with an auth error, or when the user asks about the Tencent Docs connection.`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
    risk: 'low',
    defaultEnabled: true,
    async execute() {
      const status = await getStatus(ctx);
      const lines = [
        `configured: ${status.configured}`,
        `authSource: ${status.authSource ?? 'none'}`,
        `mcpClient: ${status.mcpClient}`,
        ...status.servers.map((server) => `- ${server.name} (${server.kind}): ${server.connected ? 'connected' : 'not connected'}`),
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  }));

  // ── tdocs_auth: login / token management ────────────────────────────────────
  ctx.subscriptions.push(ctx.tools.register({
    name: 'tdocs_auth',
    title: 'Tencent Docs Auth',
    description: `Manage the Tencent Docs account connection.
action:
  start     — start the authorization flow: show the auth link, wait for the user to
              finish signing in with QQ/WeChat, then fetch and store the token, and
              register the four MCP services. Use this for first-time setup and for
              re-authorization after a token expired.
  set_token — let the user paste a token manually (e.g. copied from
              https://docs.qq.com/scenario/open-claw.html), then register the services.
  clear     — sign out: remove the stored token and unregister the MCP services.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'set_token', 'clear'] },
      },
      required: ['action'],
    },
    risk: 'medium',
    defaultEnabled: true,
    async execute(input, exec) {
      const request = input as { action?: string };
      const actionName = request.action ?? 'start';

      if (actionName === 'clear') {
        await clearToken(ctx);
        const mcp = await waitForMcpClient(ctx);
        if (mcp) await unregisterAll(ctx, mcp);
        return { content: [{ type: 'text', text: tr('auth.signedOut') }] };
      }

      if (actionName === 'set_token') {
        const result = await exec.ui.requestForm({
          title: tr('auth.setToken.title'),
          description: tr('auth.setToken.description'),
          fields: [
            { key: 'token', label: tr('auth.setToken.tokenLabel'), type: 'password', secret: true, required: true },
            { key: 'getToken', label: tr('auth.setToken.linkLabel'), type: 'link', href: 'https://docs.qq.com/scenario/open-claw.html' },
          ],
        });
        if (!result.submitted) return { content: [{ type: 'text', text: tr('auth.cancelled') }] };
        const token = String(result.values.token ?? '').trim();
        if (!token) return { content: [{ type: 'text', text: tr('auth.cancelled') }], isError: true };
        const where = await writeToken(ctx, token);
        await registerWithCurrentToken();
        return { content: [{ type: 'text', text: tr('auth.tokenSaved', { where }) }] };
      }

      // action === 'start'
      const mcp = await waitForMcpClient(ctx);
      if (!mcp) {
        return {
          content: [{ type: 'text', text: tr('auth.mcpMissing') }],
          isError: true,
        };
      }

      // Reuse a pending auth code while it is still valid (5 min), so a retry
      // after a network hiccup does not force the user to sign in again.
      const pending = await ctx.storage.get<{ code?: string; at?: number }>(PENDING_CODE_KEY);
      const fresh = !pending?.code || !pending.at || Date.now() - pending.at > 5 * 60_000;
      const code = fresh || !pending?.code ? randomBytes(8).toString('hex') : pending.code;
      if (fresh) await ctx.storage.set(PENDING_CODE_KEY, { code, at: Date.now() });

      const url = authUrl(code);
      exec.progress.report({ stage: 'auth', message: tr('auth.waiting') });
      const form = await exec.ui.requestForm({
        title: tr('auth.start.title'),
        description: tr('auth.start.description'),
        fields: [
          { key: 'authLink', label: tr('auth.start.linkLabel'), type: 'link', href: url },
        ],
      });
      if (!form.submitted) {
        return { content: [{ type: 'text', text: tr('auth.cancelled') }] };
      }

      exec.progress.report({ stage: 'auth', message: tr('auth.exchanging') });
      const poll = await pollToken(code, exec.signal);
      if (poll.token) {
        const where = await writeToken(ctx, poll.token);
        await ctx.storage.delete(PENDING_CODE_KEY).catch(() => {});
        await registerWithCurrentToken();
        return { content: [{ type: 'text', text: tr('auth.success', { where }) }] };
      }
      if (poll.kind === 'vip_required') {
        return { content: [{ type: 'text', text: tr('auth.vipRequired') }], isError: true };
      }
      if (poll.kind === 'expired') {
        return { content: [{ type: 'text', text: tr('auth.expired') }], isError: true };
      }
      if (poll.kind === 'network') {
        return { content: [{ type: 'text', text: tr('auth.network') }], isError: true };
      }
      return {
        content: [{ type: 'text', text: tr('auth.notAuthorized', { url }) }],
        isError: true,
      };
    },
  }));

  // ── Startup: restore registered servers if a token exists ───────────────────
  void registerWithCurrentToken();
  const timer = setInterval(() => {
    refreshStatus();
  }, 30_000);
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) });

  ctx.logger.info('finch-tencent-docs mini tool activated');
}

async function runAuthDialog(ctx: Ctx, tr: Translate): Promise<void> {
  const pending = await ctx.storage.get<{ code?: string; at?: number }>(PENDING_CODE_KEY);
  const fresh = !pending?.code || !pending.at || Date.now() - pending.at > 5 * 60_000;
  const code = fresh || !pending?.code ? randomBytes(8).toString('hex') : pending.code;
  if (fresh) await ctx.storage.set(PENDING_CODE_KEY, { code, at: Date.now() });

  const url = authUrl(code);
  const result = await ctx.ui.showModalDialog({
    title: tr('dialog.auth.title'),
    description: tr('dialog.auth.description'),
    message: tr('dialog.auth.hint'),
    actions: [
      { id: 'cancel', label: tr('dialog.close') },
      { id: 'done', label: tr('dialog.auth.done'), variant: 'primary' },
    ],
    fields: [
      { key: 'authLink', label: tr('dialog.auth.link'), type: 'link', href: url },
    ],
  });
  if (result.action !== 'done') return;

  const poll = await pollToken(code);
  if (poll.token) {
    await writeToken(ctx, poll.token);
    await ctx.storage.delete(PENDING_CODE_KEY).catch(() => {});
  }
}

export function deactivate(): void {}

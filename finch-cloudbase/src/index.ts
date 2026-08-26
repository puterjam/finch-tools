import type * as finch from 'finch';

const SERVER_NAME = 'cloudbase';
const MCP_PACKAGE = '@cloudbase/cloudbase-mcp@latest';
const CONSOLE_URL = 'https://tcb.cloud.tencent.com/dev';

const SECRET_API_KEY = 'cloudbase.apiKey';
const SECRET_SECRET_ID = 'cloudbase.secretId';
const SECRET_SECRET_KEY = 'cloudbase.secretKey';
const STORAGE_ENV_ID = 'envId';

interface CloudbaseCredentials {
  envId?: string;
  apiKey?: string;
  secretId?: string;
  secretKey?: string;
}

// Shape of the CloudBase MCP `auth` tool's JSON tool-result payload (reverse-engineered from
// @cloudbase/cloudbase-mcp — see buildJsonToolResult / buildDeviceAuthChallengePayload).
interface DeviceAuthChallenge {
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
}

interface AuthToolPayload {
  ok?: boolean;
  code?: string;
  message?: string;
  auth_status?: 'READY' | 'PENDING' | 'REQUIRED' | string;
  auth_challenge?: DeviceAuthChallenge;
  [key: string]: unknown;
}

interface McpClientCapability {
  registerServer(config: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
  unregisterServer(name: string): Promise<{ ok: boolean }>;
  listTools?(name: string): Promise<Array<{ name: string; description?: string }>>;
  callTool?(name: string, tool: string, args: Record<string, unknown>): Promise<unknown>;
}

let activeCtx: finch.MiniToolContext | undefined;

export function activate(ctx: finch.MiniToolContext): void {
  activeCtx = ctx;

  // 'log-out' is not a Finch built-in icon id — register it as a small runtime SVG (Lucide).
  ctx.icons.register('cloudbase-icons', {
    'log-out': {
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
    },
  });

  // Best-effort auto re-register on every activation — runtime MCP servers are in-memory only,
  // so if the user already connected before, restore the mount without asking again.
  void readCredentials(ctx).then((creds) => {
    if (hasAnyCredential(creds)) void mountServer(ctx, creds);
  });

  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'cloudbase_setup',
      title: 'CloudBase Setup',
      description: `Connect Tencent CloudBase (腾讯云开发) and manage its MCP server mount.
action:
  connect    — open a form to configure credentials (API Key recommended, or SecretId/SecretKey, or leave blank) and mount the official CloudBase MCP server so mcp__cloudbase__* tools become available
  login      — one-click device-code login: mounts the MCP server if needed, calls its built-in auth tool to start a device authorization flow, shows the user a login link + code, and reports the resulting login status. Prefer this over action=connect when the user just wants to "log in" / "一键登录" without typing keys.
  status     — report whether CloudBase is connected, which credential mode is in use, and (when reachable) the live auth status from the MCP server itself
  disconnect — clear stored credentials and unmount the CloudBase MCP server
Call this before any CloudBase (database / cloud function / hosting / storage / auth) work, and call action=status first if mcp__cloudbase__* tools are missing or return auth errors.`,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['connect', 'login', 'status', 'disconnect'] },
        },
        required: ['action'],
      },
      timeoutMs: 120000,
      risk: 'medium',
      async execute(input, exec) {
        const action = String((input as { action?: string }).action ?? '');

        if (action === 'connect') {
          const result = await exec.ui.requestForm(connectFormSpec());
          if (!result.submitted) {
            return { content: [{ type: 'text', text: 'Cancelled — CloudBase was not connected.' }] };
          }
          const creds = extractCredentials(result.values as Record<string, unknown>);
          await saveCredentials(ctx, creds);
          const mounted = await mountServer(ctx, creds);
          return {
            content: [
              {
                type: 'text',
                text: mounted
                  ? `CloudBase connected (${describeMode(creds)}). The cloudbase MCP server is mounting; mcp__cloudbase__* tools will appear shortly.`
                  : 'Credentials saved, but the CloudBase MCP server could not be mounted yet (MCP Client not ready). It will retry automatically.',
              },
            ],
          };
        }

        if (action === 'login') {
          exec.progress.report({ message: '正在启动 CloudBase 设备码登录…' });
          const creds = await readCredentials(ctx);
          await mountServer(ctx, creds);

          let startResult: unknown;
          try {
            startResult = await callCloudbaseTool(ctx, 'auth', { action: 'start_auth', authMode: 'device' });
          } catch (err) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Could not start CloudBase device login yet — the MCP server may still be starting (first run downloads the package via npx, which can take a while). Wait a few seconds and call cloudbase_setup with action=login again. (${String(err)})`,
                },
              ],
              isError: true,
            };
          }

          const startPayload = parseAuthPayload(resultText(startResult));
          const challenge = startPayload?.auth_challenge;

          if (!challenge?.verification_uri) {
            // Already logged in, or an unexpected shape — surface the raw response for the model.
            return { content: [{ type: 'text', text: resultText(startResult) }] };
          }

          const link = challenge.verification_uri_complete ?? challenge.verification_uri;
          await ctx.ui.showModalDialog({
            title: 'CloudBase 一键登录',
            description: `请打开下方链接并核对验证码，在浏览器中完成授权（约 ${Math.round(
              (challenge.expires_in ?? 900) / 60,
            )} 分钟内有效）。\n\n验证码：${challenge.user_code ?? '(见链接页面)'}`,
            actions: [{ id: 'done', label: '我已在浏览器完成授权', variant: 'primary' }],
            fields: [{ key: 'open', label: '打开授权页面', type: 'link', href: link }],
          });

          exec.progress.report({ message: '正在确认登录状态…' });
          const finalStatus = await pollAuthReady(ctx, 5, 2000);

          return {
            content: [
              {
                type: 'text',
                text: `Device login started via the CloudBase MCP auth tool (user_code ${challenge.user_code ?? 'n/a'}).\n\nStatus after user confirmation:\n${finalStatus}\n\nIf this still shows PENDING/REQUIRED, ask the user to finish the browser step and call cloudbase_setup with action=status again in a bit — the CloudBase MCP process keeps polling in the background even after this call returns.`,
              },
            ],
          };
        }

        if (action === 'status') {
          const creds = await readCredentials(ctx);
          return { content: [{ type: 'text', text: await statusText(ctx, creds) }] };
        }

        if (action === 'disconnect') {
          await clearCredentials(ctx);
          const ok = await unmountServer(ctx);
          return {
            content: [
              {
                type: 'text',
                text: ok
                  ? 'CloudBase disconnected — credentials cleared and the MCP server was unmounted.'
                  : 'Credentials cleared. The MCP server may not have been mounted.',
              },
            ],
          };
        }

        return { content: [{ type: 'text', text: `Unknown action: ${action}` }], isError: true };
      },
    }),
  );

  ctx.subscriptions.push(
    ctx.settingsMenu.register({
      async getMenu() {
        const creds = await readCredentials(ctx);
        const connected = hasAnyCredential(creds);
        const items: finch.ComposerActionMenuItem[] = [
          {
            id: 'status',
            label: connected ? `已连接 · ${describeMode(creds)}` : '未连接',
            disabled: true,
            iconName: connected ? 'check' : undefined,
          },
          {
            id: 'login',
            label: '一键登录（设备码）',
            iconName: 'log-in',
          },
          {
            id: 'connect',
            label: connected ? '手动重新配置凭证' : '手动配置凭证（API Key / 密钥）',
            iconName: 'settings',
          },
        ];
        if (connected) {
          items.push({ id: 'console', label: '打开云开发控制台', iconName: 'globe' });
          items.push({ id: 'disconnect', label: '断开连接', iconName: 'ext:log-out' });
        }
        return items;
      },
      async execute(_menuCtx, itemId) {
        if (itemId === 'login') {
          await mountServer(ctx, await readCredentials(ctx));

          let startResult: unknown;
          try {
            startResult = await callCloudbaseTool(ctx, 'auth', { action: 'start_auth', authMode: 'device' });
          } catch {
            await ctx.ui.showToast({ title: 'CloudBase MCP 还未就绪，请稍后重试', variant: 'error' });
            return;
          }

          const startPayload = parseAuthPayload(resultText(startResult));
          const challenge = startPayload?.auth_challenge;

          if (!challenge?.verification_uri) {
            await ctx.ui.showToast({ title: 'CloudBase 可能已处于登录状态', description: '可点击「查看连接状态」确认', variant: 'success' });
            return;
          }

          const link = challenge.verification_uri_complete ?? challenge.verification_uri;
          const result = await ctx.ui.showModalDialog({
            title: 'CloudBase 一键登录',
            description: `请打开下方链接并核对验证码，在浏览器中完成授权（约 ${Math.round(
              (challenge.expires_in ?? 900) / 60,
            )} 分钟内有效）。\n\n验证码：${challenge.user_code ?? '(见链接页面)'}`,
            actions: [
              { id: 'cancel', label: '取消' },
              { id: 'done', label: '我已完成授权', variant: 'primary' },
            ],
            fields: [{ key: 'open', label: '打开授权页面', type: 'link', href: link }],
          });
          if (result.action !== 'done') return;

          const finalStatus = await pollAuthReady(ctx, 5, 2000);
          const ok = finalStatus.includes('"auth_status": "READY"');
          await ctx.ui.showToast({
            title: ok ? 'CloudBase 登录成功' : '还未检测到登录完成',
            description: ok ? '已连接，可以开始使用 CloudBase 工具' : '若已在浏览器完成授权，请稍等片刻后重新打开设置菜单查看状态',
            variant: ok ? 'success' : 'error',
          });
          return;
        }
        if (itemId === 'connect') {
          const result = await ctx.ui.showModalDialog({
            title: '连接腾讯云开发 CloudBase',
            description:
              '推荐填写 API Key（环境级长期凭证，只授权到单个环境，更安全）。也可以使用传统的腾讯云 SecretId/SecretKey（账号级权限）。全部留空同样可以连接，首次调用工具时会引导你在浏览器完成登录并选择环境。',
            actions: [
              { id: 'cancel', label: '取消' },
              { id: 'save', label: '保存并连接', variant: 'primary' },
            ],
            fields: connectFormSpec().fields,
          });
          if (result.action !== 'save') return;
          const creds = extractCredentials(result.values as Record<string, unknown>);
          await saveCredentials(ctx, creds);
          await mountServer(ctx, creds);
          await ctx.ui.showToast({ title: `CloudBase 已连接（${describeMode(creds)}）`, variant: 'success' });
          return;
        }
        if (itemId === 'console') {
          const creds = await readCredentials(ctx);
          const url = creds.envId ? `${CONSOLE_URL}?envId=${encodeURIComponent(creds.envId)}` : CONSOLE_URL;
          await ctx.ui.showModalDialog({
            title: '云开发控制台',
            actions: [{ id: 'close', label: '关闭' }],
            fields: [{ key: 'open', label: '点击打开控制台', type: 'link', href: url }],
          });
          return;
        }
        if (itemId === 'disconnect') {
          await clearCredentials(ctx);
          await unmountServer(ctx);
          await ctx.ui.showToast({ title: 'CloudBase 已断开连接', variant: 'success' });
        }
      },
    }),
  );
}

export function deactivate(): void {
  if (activeCtx?.capabilities.has('mcp.client')) {
    void activeCtx.capabilities.get<McpClientCapability>('mcp.client').unregisterServer(SERVER_NAME);
  }
}

// ────────────────────────────────────────────────────────────────────────────

function connectFormSpec(): finch.MiniToolFormSpec {
  return {
    title: '连接腾讯云开发 CloudBase',
    description:
      '推荐填写 API Key（环境级长期凭证，只授权到单个环境，更安全）。也可以使用传统的腾讯云 SecretId/SecretKey（账号级权限）。全部留空同样可以连接，首次调用工具时会引导你在浏览器完成登录并选择环境。',
    submitLabel: '保存并连接',
    fields: [
      {
        key: 'envId',
        label: '环境 ID（EnvId）',
        type: 'text',
        width: 'full',
        description: '可选。使用 API Key 时建议一起填写；留空也可以在登录后于浏览器中选择环境。',
      },
      { key: 'apiKey', label: 'API Key（推荐）', type: 'password', secret: true, width: '2/3' },
      { key: 'apiKeyLink', label: '去控制台创建 API Key', type: 'link', href: CONSOLE_URL, width: '1/3' },
      { key: 'secretId', label: 'SecretId（高级，可选）', type: 'text', width: '1/2' },
      { key: 'secretKey', label: 'SecretKey（高级，可选）', type: 'password', secret: true, width: '1/2' },
    ],
  };
}

function extractCredentials(values: Record<string, unknown>): CloudbaseCredentials {
  const pick = (key: string) => {
    const v = values?.[key];
    const s = typeof v === 'string' ? v.trim() : '';
    return s.length > 0 ? s : undefined;
  };
  return {
    envId: pick('envId'),
    apiKey: pick('apiKey'),
    secretId: pick('secretId'),
    secretKey: pick('secretKey'),
  };
}

function hasAnyCredential(creds: CloudbaseCredentials): boolean {
  return Boolean(creds.apiKey || (creds.secretId && creds.secretKey) || creds.envId);
}

function describeMode(creds: CloudbaseCredentials): string {
  if (creds.apiKey) return `API Key 模式${creds.envId ? ` · env ${creds.envId}` : ''}`;
  if (creds.secretId && creds.secretKey) return `SecretId/SecretKey 模式${creds.envId ? ` · env ${creds.envId}` : ''}`;
  if (creds.envId) return `env ${creds.envId}（登录态凭证）`;
  return '未配置，使用浏览器登录引导';
}

async function readCredentials(ctx: finch.MiniToolContext): Promise<CloudbaseCredentials> {
  const [apiKey, secretId, secretKey, envId] = await Promise.all([
    ctx.secrets.get(SECRET_API_KEY),
    ctx.secrets.get(SECRET_SECRET_ID),
    ctx.secrets.get(SECRET_SECRET_KEY),
    ctx.storage.get<string>(STORAGE_ENV_ID),
  ]);
  return { apiKey, secretId, secretKey, envId };
}

async function saveCredentials(ctx: finch.MiniToolContext, creds: CloudbaseCredentials): Promise<void> {
  if (creds.apiKey) await ctx.secrets.set(SECRET_API_KEY, creds.apiKey);
  else await ctx.secrets.delete(SECRET_API_KEY);

  if (creds.secretId) await ctx.secrets.set(SECRET_SECRET_ID, creds.secretId);
  else await ctx.secrets.delete(SECRET_SECRET_ID);

  if (creds.secretKey) await ctx.secrets.set(SECRET_SECRET_KEY, creds.secretKey);
  else await ctx.secrets.delete(SECRET_SECRET_KEY);

  if (creds.envId) await ctx.storage.set(STORAGE_ENV_ID, creds.envId);
  else await ctx.storage.delete(STORAGE_ENV_ID);
}

async function clearCredentials(ctx: finch.MiniToolContext): Promise<void> {
  await Promise.all([
    ctx.secrets.delete(SECRET_API_KEY),
    ctx.secrets.delete(SECRET_SECRET_ID),
    ctx.secrets.delete(SECRET_SECRET_KEY),
    ctx.storage.delete(STORAGE_ENV_ID),
  ]);
}

async function waitForMcpClient(ctx: finch.MiniToolContext): Promise<McpClientCapability | undefined> {
  for (let i = 0; i < 20; i++) {
    if (ctx.capabilities.has('mcp.client')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ctx.capabilities.has('mcp.client')) {
    ctx.logger.warn('mcp.client capability not available');
    return undefined;
  }
  return ctx.capabilities.get<McpClientCapability>('mcp.client');
}

async function mountServer(ctx: finch.MiniToolContext, creds: CloudbaseCredentials): Promise<boolean> {
  const mcp = await waitForMcpClient(ctx);
  if (!mcp) return false;

  const env: Record<string, string> = { INTEGRATION_IDE: 'Finch' };
  if (creds.apiKey) env.CLOUDBASE_API_KEY = creds.apiKey;
  if (creds.secretId) env.TENCENTCLOUD_SECRETID = creds.secretId;
  if (creds.secretKey) env.TENCENTCLOUD_SECRETKEY = creds.secretKey;
  if (creds.envId) env.CLOUDBASE_ENV_ID = creds.envId;

  const result = await mcp.registerServer({
    name: SERVER_NAME,
    command: 'npx',
    args: ['-y', MCP_PACKAGE],
    env,
    ownerExtensionId: ctx.minitool.id,
    ownerExtensionName: ctx.minitool.displayName,
  });
  if (!result.ok) ctx.logger.warn(`Failed to mount CloudBase MCP server: ${result.error ?? 'unknown error'}`);
  return result.ok;
}

async function unmountServer(ctx: finch.MiniToolContext): Promise<boolean> {
  if (!ctx.capabilities.has('mcp.client')) return false;
  const mcp = ctx.capabilities.get<McpClientCapability>('mcp.client');
  const result = await mcp.unregisterServer(SERVER_NAME);
  return result.ok;
}

async function statusText(ctx: finch.MiniToolContext, creds: CloudbaseCredentials): Promise<string> {
  const mode = describeMode(creds);
  const connected = hasAnyCredential(creds);
  const mcpReady = ctx.capabilities.has('mcp.client');
  const lines = [
    `Stored credential: ${connected ? mode : 'not configured (device-code login may still be active — see live status below)'}`,
    `MCP Client available: ${mcpReady ? 'yes' : 'no (enable the MCP Client mini tool)'}`,
  ];
  if (mcpReady) {
    let serverConnected = false;
    try {
      const mcp = ctx.capabilities.get<McpClientCapability>('mcp.client');
      const tools = await mcp.listTools?.(SERVER_NAME);
      if (tools) {
        lines.push(`cloudbase MCP tools discovered: ${tools.length}`);
        serverConnected = tools.length > 0;
      }
    } catch {
      lines.push('cloudbase MCP server not connected yet — call action=connect / action=login or wait a moment and retry.');
    }
    if (serverConnected) {
      try {
        const liveStatus = await callCloudbaseTool(ctx, 'auth', { action: 'status' }, 1);
        lines.push(`Live auth status from CloudBase MCP:\n${resultText(liveStatus)}`);
      } catch {
        // Best-effort only — the stored-credential summary above still stands.
      }
    }
  }
  return lines.join('\n');
}

async function callCloudbaseTool(
  ctx: finch.MiniToolContext,
  toolName: string,
  args: Record<string, unknown>,
  maxAttempts = 6,
): Promise<unknown> {
  const mcp = await waitForMcpClient(ctx);
  if (!mcp?.callTool) throw new Error('MCP Client callTool is not available');
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await mcp.callTool(SERVER_NAME, toolName, args);
    } catch (err) {
      lastErr = err;
      if (i < maxAttempts - 1) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function resultText(result: unknown): string {
  if (result && typeof result === 'object') {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const parts = content
        .map((c) =>
          c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string'
            ? (c as { text: string }).text
            : undefined,
        )
        .filter((t): t is string => Boolean(t));
      if (parts.length) return parts.join('\n');
    }
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function parseAuthPayload(text: string): AuthToolPayload | undefined {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as AuthToolPayload) : undefined;
  } catch {
    return undefined;
  }
}

// Poll auth(action=status) a few times — the CloudBase MCP process keeps completing the device
// flow in the background even after our start_auth call returns, so a single immediate check can
// easily land on "still pending" right after the user clicks "done".
async function pollAuthReady(ctx: finch.MiniToolContext, attempts: number, intervalMs: number): Promise<string> {
  let lastText = '';
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await callCloudbaseTool(ctx, 'auth', { action: 'status' }, 1);
      lastText = resultText(result);
      const payload = parseAuthPayload(lastText);
      if (payload?.auth_status === 'READY') return lastText;
    } catch (err) {
      lastText = `(status check failed: ${String(err)})`;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, intervalMs));
  }
  return lastText;
}

import type * as finch from 'finch';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const WEBSITE = 'https://lite.ego.app/';
const STATUS_MARKER = '__EGO_STATUS__';
let commandQueue: Promise<void> = Promise.resolve();

type Ownership = 'agent' | 'agentDelegatedToUser' | 'user' | string;

interface EgoTab {
  targetId: string;
  title: string;
  url: string;
  active: boolean;
  index: number;
}

interface EgoSpace {
  id: number;
  name: string;
  taskId: string;
  ownership: Ownership;
  recentTabTitles?: string[];
  tabs?: EgoTab[];
  tabsError?: string;
}

interface EgoStatus {
  supported: boolean;
  installed: boolean;
  running: boolean;
  version?: string;
  spaces: EgoSpace[];
  pageCount: number;
  error?: string;
}

function egoBinary(): string | undefined {
  const local = join(homedir(), '.local', 'bin', 'ego-browser');
  if (existsSync(local)) return local;
  return 'ego-browser';
}

async function processRunning(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    await execFileAsync('pgrep', ['-f', '/ego lite.app/Contents/MacOS/ego lite'], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

async function runCommand(file: string, args: string[], timeout = 20_000): Promise<string> {
  const execute = () => new Promise<string>((resolve, reject) => {
    const child = execFile(file, args, {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, PATH: `${join(homedir(), '.local', 'bin')}:${process.env.PATH ?? ''}` },
    }, (error, stdout, stderr) => {
      const output = [stdout, stderr].filter(Boolean).join('\n').trim();
      if (error) {
        reject(new Error(output || error.message));
        return;
      }
      resolve(output);
    });

    // ego-browser waits for stdin EOF even when a script is supplied with -e.
    child.stdin?.end();
  });

  const result = commandQueue.then(execute, execute);
  commandQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function installedVersion(binary: string): Promise<string | undefined> {
  try {
    const output = await runCommand(binary, ['--version'], 3000);
    return output.split('\n').find((line) => line.startsWith('ego-browser '))?.replace('ego-browser ', '').trim();
  } catch {
    return undefined;
  }
}

function statusScript(detailed: boolean): string {
  return `
const spaces = await listTaskSpaces();
let initialTab = null;
if (${detailed ? 'true' : 'false'} && spaces.some(space => space.ownership === 'agent')) {
  initialTab = await currentTab().catch(() => null);
}
let initialSpaceId = null;
const result = [];
for (const space of spaces) {
  const item = Object.assign({}, space);
  if (${detailed ? 'true' : 'false'} && space.ownership === 'agent') {
    try {
      await switchTaskSpace(space.id);
      item.tabs = await listTabs();
      if (initialTab && item.tabs.some(tab => tab.targetId === initialTab.targetId)) initialSpaceId = space.id;
    } catch (error) {
      item.tabsError = String(error && error.message ? error.message : error);
    }
  }
  result.push(item);
}
if (initialSpaceId !== null && initialTab) {
  try {
    await switchTaskSpace(initialSpaceId);
    await switchTab(initialTab.targetId);
  } catch (error) {}
}
cliLog('${STATUS_MARKER}' + JSON.stringify(result));
`;
}

function parseSpaces(output: string): EgoSpace[] {
  const markerIndex = output.lastIndexOf(STATUS_MARKER);
  if (markerIndex < 0) throw new Error(output || 'Ego Browser did not return status data');
  const json = output.slice(markerIndex + STATUS_MARKER.length).split('\n')[0];
  return JSON.parse(json) as EgoSpace[];
}

async function getStatus(detailed = false): Promise<EgoStatus> {
  if (process.platform !== 'darwin') {
    return { supported: false, installed: false, running: false, spaces: [], pageCount: 0 };
  }

  const binary = egoBinary();
  if (!binary) return { supported: true, installed: false, running: false, spaces: [], pageCount: 0 };

  const version = await installedVersion(binary);
  if (!version) return { supported: true, installed: false, running: false, spaces: [], pageCount: 0 };

  const running = await processRunning();
  if (!running) return { supported: true, installed: true, running: false, version, spaces: [], pageCount: 0 };

  try {
    const output = await runCommand(binary, ['nodejs', '-e', statusScript(detailed)], 10_000);
    const spaces = parseSpaces(output);
    const pageCount = spaces.reduce((sum, space) => {
      if (space.tabs) return sum + space.tabs.length;
      return sum + (space.recentTabTitles?.length ?? 0);
    }, 0);
    return { supported: true, installed: true, running: true, version, spaces, pageCount };
  } catch (error) {
    return {
      supported: true,
      installed: true,
      running: true,
      version,
      spaces: [],
      pageCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function launchEgo(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Ego Lite currently supports macOS only.');
  await execFileAsync('open', ['-a', 'ego lite'], { timeout: 5000 });
}

async function openWebsite(): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', WEBSITE] : [WEBSITE];
  await execFileAsync(command, args, { timeout: 5000 });
}

function key(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function unkey<T>(value: string): T {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
}

function compactTitle(title: string, fallback: string, maxLength = 32): string {
  const chars = Array.from(title.trim() || fallback);
  return chars.length > maxLength ? `${chars.slice(0, maxLength).join('')}…` : chars.join('');
}

function domainOf(url: string, fallback: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname.replace(/^www\./, '')}`;
  } catch {
    return fallback;
  }
}

type Translate = (key: string, values?: Record<string, string | number | boolean | null | undefined>) => string;

function ownershipText(ownership: Ownership, t: Translate): string {
  if (ownership === 'agent') return t('ownership.agent');
  if (ownership === 'agentDelegatedToUser') return t('ownership.delegated');
  return t('ownership.user');
}

function statusText(status: EgoStatus, t: Translate): string {
  if (!status.supported) return t('status.unsupported', { platform: process.platform });
  if (!status.installed) return t('status.notInstalled', { website: WEBSITE });
  if (!status.running) return t('status.notRunning', { version: status.version ?? 'unknown' });
  if (status.error) return t('status.error', { error: status.error });
  const spaces = status.spaces.map((space) => ({
    id: space.id,
    name: space.name,
    ownership: space.ownership,
    pages: space.tabs?.length ?? space.recentTabTitles?.length ?? 0,
    tabs: space.tabs?.map(({ targetId, title, url, active }) => ({ targetId, title, url, active })),
  }));
  return JSON.stringify({ ready: true, version: status.version, pageCount: status.pageCount, spaces }, null, 2);
}

export function activate(ctx: finch.ExtensionContext): void {
  const t: Translate = (key, values) => ctx.i18n.t(key, values);

  ctx.subscriptions.push(ctx.icons.register('ego-browser-icons', {
    ego: {
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"><path stroke-width=".77" d="M4.78 3.634c1.066 0 2.042.38 2.803 1.012-.421.91-.668 2.099-.668 3.384s.248 2.474.669 3.384a4.396 4.396 0 1 1-2.804-7.78Zm4.938 0c.446 0 .95.367 1.367 1.19.405.8.667 1.934.667 3.206s-.262 2.406-.667 3.206c-.416.823-.92 1.19-1.367 1.19-.38 0-.803-.266-1.179-.858A5.15 5.15 0 0 0 9.944 8.03c0-1.37-.535-2.616-1.405-3.54.376-.59.799-.856 1.179-.856Zm5.05.007c.024.015.076.06.152.184.12.196.24.505.348.921.212.826.348 1.987.348 3.284s-.136 2.459-.348 3.285c-.107.415-.229.724-.348.92a.6.6 0 0 1-.151.183.6.6 0 0 1-.15-.184c-.12-.195-.242-.504-.348-.92-.213-.825-.348-1.987-.348-3.284s.135-2.458.348-3.284c.106-.416.228-.725.347-.92a.6.6 0 0 1 .15-.185Z"/></svg>',
    },
    'bot-off': {
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13.67 8H18a2 2 0 0 1 2 2v4.33"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M22 22 2 2"/><path d="M8 8H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 1.414-.586"/><path d="M9 13v2"/><path d="M9.67 4H12v2.33"/></svg>',
    },
    compass: {
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"/></svg>',
    },
    bot: {
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>',
    },
    x: {
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    },
    play: {
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/></svg>',
    },
  }));

  let cachedStatus: EgoStatus | undefined;
  let refreshInFlight: Promise<void> | undefined;
  let pendingDetailedRefresh = false;
  let refreshStatus: (detailed?: boolean) => void = () => {};

  const action = ctx.composerActions.register('ego-browser', {
    async getBadge() {
      const online = cachedStatus?.installed === true
        && cachedStatus.running === true
        && !cachedStatus.error;
      if (cachedStatus?.supported === false) return { text: t('badge.unsupported'), active: false };
      return online
        ? { text: t('badge.online'), active: true }
        : { text: t('badge.offline'), active: false };
    },

    async getMenu(): Promise<finch.ComposerActionMenuItem[]> {
      refreshStatus(true);
      if (!cachedStatus) {
        return [{
          id: '__checking__',
          label: t('menu.checking.label'),
          description: t('menu.checking.description'),
          iconName: 'timer',
          disabled: true,
        }, {
          id: '__install__',
          label: t('menu.help.label'),
          description: 'lite.ego.app',
          iconName: 'lightbulb',
        }];
      }
      const status = cachedStatus;

      if (!status.supported) {
        return [{
          id: '__unsupported__',
          label: t('menu.unsupported.label'),
          description: t('menu.unsupported.description'),
          hoverText: t('menu.unsupported.hover', { platform: process.platform }),
          iconName: 'ext:ego-browser-icons/bot-off',
          disabled: true,
        }, {
          id: '__unsupported_divider__',
          label: '',
          separator: true,
        }, {
          id: '__install__',
          label: t('menu.learn.label'),
          description: 'lite.ego.app',
          iconName: 'lightbulb',
        }];
      }

      if (!status.installed) {
        return [{
          id: '__install__',
          label: t('menu.install.label'),
          description: t('menu.install.description'),
          hoverText: t('menu.install.hover'),
          iconName: 'rocket',
        }];
      }

      if (!status.running) {
        return [{
          id: '__install__',
          label: t('menu.help.label'),
          description: 'lite.ego.app',
          iconName: 'lightbulb',
        }, {
          id: '__launch_divider__',
          label: '',
          separator: true,
        }, {
          id: '__launch__',
          label: t('menu.launch.label'),
          description: status.version,
          iconName: 'ext:ego-browser-icons/play',
        }];
      }

      const items: finch.ComposerActionMenuItem[] = [{
        id: '__summary__',
        label: t('menu.summary.spaces', { count: status.spaces.length }),
        description: t('menu.summary.pages', { count: status.pageCount }),
        iconName: 'ext:ego-browser-icons/compass',
        disabled: true,
      }, {
        id: '__spaces_divider__',
        label: '',
        separator: true,
      }];

      for (const space of status.spaces) {
        const tabs = space.tabs ?? [];
        const children: finch.ComposerActionMenuItem[] = tabs.map((tab, index) => ({
          id: `tab:${key([space.id, tab.targetId])}`,
          label: compactTitle(tab.title, t('page.untitled')),
          hoverText: `${tab.title || t('page.untitled')}\n${domainOf(tab.url, t('site.unknown'))}`,
          current: tab.active,
          iconName: 'globe',
          group: `space-${space.id}`,
          groupLabel: index === 0 ? ownershipText(space.ownership, t) : undefined,
          groupMaxVisible: index === 0 ? 6 : undefined,
        }));

        if (space.ownership === 'agentDelegatedToUser') {
          children.push({
            id: `resume:${key(space.id)}`,
            label: t('menu.resume.label'),
            description: t('menu.resume.description'),
            iconName: 'message-circle',
          });
        }

        if (children.length === 0) {
          children.push({
            id: `space:${key(space.id)}`,
            label: ownershipText(space.ownership, t),
            description: t('menu.summary.pages', { count: space.recentTabTitles?.length ?? 0 }),
            iconName: space.ownership === 'agent' ? 'bot' : 'users',
            disabled: true,
          });
        }

        children.push({ id: `close-divider:${space.id}`, label: '', separator: true });
        children.push({
          id: `close:${key(space.id)}`,
          label: t('menu.close.label'),
          description: t('menu.close.description'),
          iconName: 'ext:ego-browser-icons/x',
        });

        items.push({
          id: `space-menu:${space.id}`,
          label: space.name || t('menu.space.fallback', { id: space.id }),
          description: ownershipText(space.ownership, t),
          iconName: space.ownership === 'agent'
            ? 'ext:ego-browser-icons/bot'
            : 'ext:ego-browser-icons/compass',
          children,
        });
      }

      if (status.spaces.length === 0) {
        items.push({
          id: '__empty__',
          label: t('menu.empty.label'),
          description: t('menu.empty.description'),
          hoverText: t('menu.empty.hover'),
          iconName: 'ext:ego-browser-icons/bot-off',
        });
      }

      return items;
    },

    async execute(_actionContext, itemId, actions) {
      try {
        if (itemId === '__install__') {
          await openWebsite();
          return;
        }
        if (itemId === '__empty__') {
          await actions.composer.fill(t('composer.startPrompt'));
          return;
        }
        if (itemId === '__launch__') {
          await launchEgo();
          await ctx.ui.showToast({ title: t('toast.launched'), variant: 'success', position: 'TC' });
          cachedStatus = undefined;
          action.notifyUpdate();
          refreshStatus(true);
          return;
        }
        if (itemId.startsWith('resume:')) {
          const spaceId = unkey<number>(itemId.slice('resume:'.length));
          await actions.composer.fill(t('composer.resumePrompt', { id: spaceId }));
          return;
        }
        if (itemId.startsWith('close:')) {
          const spaceId = unkey<number>(itemId.slice('close:'.length));
          const space = cachedStatus?.spaces.find((item) => item.id === spaceId);
          const result = await ctx.ui.showConfirmDialog({
            title: t('dialog.close.title'),
            description: space?.name || t('menu.space.fallback', { id: spaceId }),
            message: t('dialog.close.message', { count: space?.tabs?.length ?? space?.recentTabTitles?.length ?? 0 }),
            confirmLabel: t('dialog.close.confirm'),
            cancelLabel: t('dialog.close.cancel'),
            variant: 'danger',
          });
          if (!result.confirmed) return;

          const binary = egoBinary();
          if (!binary || !(await installedVersion(binary))) throw new Error(t('error.notInstalled')); 
          const script = `const result = await completeTaskSpace(${JSON.stringify(spaceId)}, { keep: false }); cliLog(JSON.stringify(result));`;
          await runCommand(binary, ['nodejs', '-e', script], 15_000);
          cachedStatus = undefined;
          action.notifyUpdate();
          refreshStatus(true);
          await ctx.ui.showToast({ title: t('toast.closed'), variant: 'success', position: 'TC' });
          return;
        }
        if (itemId.startsWith('tab:')) {
          const [spaceId, targetId] = unkey<[number, string]>(itemId.slice('tab:'.length));
          await launchEgo();
          const binary = egoBinary()!;
          const script = `await switchTaskSpace(${JSON.stringify(spaceId)}); await switchTab(${JSON.stringify(targetId)}); cliLog('ok');`;
          await runCommand(binary, ['nodejs', '-e', script], 10_000);
        }
      } catch (error) {
        ctx.logger.error('Ego Composer action failed', error);
        await ctx.ui.showToast({
          title: t('toast.actionFailed'),
          description: error instanceof Error ? error.message : String(error),
          variant: 'error',
          position: 'TC',
        });
      }
    },
  });
  ctx.subscriptions.push(action);
  ctx.subscriptions.push(ctx.i18n.onDidChangeLocale(() => action.notifyUpdate()));

  ctx.subscriptions.push(ctx.tools.register({
    name: 'ego_browser',
    title: 'Ego Browser',
    description: `Operate Ego Browser through its preloaded JavaScript helpers.
action:
  status — check installation, runtime, task-space ownership, and open pages
  run    — execute one coherent Ego Browser JavaScript program (requires script)
Use cliLog(...) for output. Reuse task spaces, respect user control, verify actions, and complete finished spaces.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'run'] },
        script: { type: 'string', description: 'JavaScript program for action=run. Ego Browser helpers are preloaded.' },
        timeout_seconds: { type: 'number', description: 'Execution timeout for action=run, from 1 to 300 seconds. Default 60.' },
      },
      required: ['action'],
    },
    risk: 'high',
    defaultEnabled: true,
    async execute(input, exec) {
      const request = input as { action?: string; script?: string; timeout_seconds?: number };
      if (request.action === 'status') {
        const status = await getStatus(true);
        cachedStatus = status;
        action.notifyUpdate();
        return { content: [{ type: 'text', text: statusText(status, t) }], isError: !status.supported || Boolean(status.error) };
      }

      if (request.action !== 'run' || typeof request.script !== 'string' || !request.script.trim()) {
        return { content: [{ type: 'text', text: 'action=run requires a non-empty script.' }], isError: true };
      }
      if (request.script.length > 100_000 || request.script.includes('\0')) {
        return { content: [{ type: 'text', text: 'The Ego Browser script is invalid or too large.' }], isError: true };
      }
      if (process.platform !== 'darwin') {
        return { content: [{ type: 'text', text: t('status.unsupported', { platform: process.platform }) }], isError: true };
      }

      const binary = egoBinary();
      const version = binary ? await installedVersion(binary) : undefined;
      if (!binary || !version) {
        return {
          content: [{ type: 'text', text: `Ego Lite is not installed. Install it from ${WEBSITE}, finish onboarding, then retry.` }],
          isError: true,
        };
      }

      if (!(await processRunning())) {
        exec.progress.report({ stage: 'launching', message: t('progress.launching') });
        await launchEgo();
        await new Promise((resolve) => setTimeout(resolve, 1800));
      }

      const timeout = Math.min(300, Math.max(1, request.timeout_seconds ?? 60)) * 1000;
      exec.progress.report({ stage: 'browsing', message: t('progress.browsing') });
      try {
        const output = await runCommand(binary, ['nodejs', '-e', request.script], timeout);
        cachedStatus = undefined;
        action.notifyUpdate();
        refreshStatus(false);
        return { content: [{ type: 'text', text: output || 'Ego Browser script completed.' }] };
      } catch (error) {
        cachedStatus = undefined;
        action.notifyUpdate();
        refreshStatus(false);
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: message }], isError: true };
      }
    },
  }));

  refreshStatus = (detailed = false) => {
    if (refreshInFlight) {
      pendingDetailedRefresh ||= detailed;
      return;
    }

    refreshInFlight = getStatus(detailed)
      .then((status) => {
        cachedStatus = status;
        action.notifyUpdate();
      })
      .catch((error) => ctx.logger.warn('Ego background status refresh failed', error))
      .finally(() => {
        refreshInFlight = undefined;
        if (pendingDetailedRefresh) {
          pendingDetailedRefresh = false;
          refreshStatus(true);
        }
      });
  };

  refreshStatus(true);
  const timer = setInterval(() => refreshStatus(true), 10_000);
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) });

  ctx.logger.info('ego-browser mini tool activated', { cached: Boolean(cachedStatus) });
}

export function deactivate(): void {}

import type * as finch from 'finch';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

interface DocumentState {
  path?: string;
  markdown: string;
  title: string;
}

interface PanelMessage {
  type: string;
  path?: string;
  markdown?: string;
  title?: string;
  markdownStyle?: string;
  customCss?: string;
  requestId?: number;
  itemId?: string;
  patch?: { label?: string; icon?: string; tooltip?: string; disabled?: boolean; checked?: boolean };
  toolbar?: finch.AppPanelToolbarItem[];
  message?: string;
}

function result(message: string, isError = false): finch.ToolResult {
  return { content: [{ type: 'text', text: message }], isError };
}

function documentTitle(markdown: string, filePath?: string): string {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || (filePath ? path.basename(filePath, path.extname(filePath)) : 'Untitled article');
}

function snapshotPath(ctx: finch.MiniToolContext, sourcePath: string): string {
  const digest = createHash('sha256').update(sourcePath).digest('hex').slice(0, 12);
  return path.join(ctx.storagePath, 'snapshots', `${digest}-before.md`);
}

// Remember the last successfully opened file, so the user doesn't have to
// re-open it by hand every time. The primary key is panel.id: each Panel scope
// gets its own stable instance, including different Space Home scopes, and a
// Home → Session relocation preserves the same id. Older session/global keys
// remain readable for migration.
interface LastPathState {
  /** Per-Panel last-opened path. A Panel id stays stable for its scope and also follows Home → Session relocation. */
  panels?: Record<string, string>;
  /** @deprecated Pre-0.8 per-Session state, retained as a read fallback. */
  sessions?: Record<string, string>;
  /** @deprecated Legacy pre-0.6 global value; still read as a fallback for the '__global__' bucket. */
  lastPath?: string;
}

function stateFile(ctx: finch.MiniToolContext): string {
  return path.join(ctx.storagePath, 'state.json');
}

function sessionBucketKey(panel: finch.AppPanel): string {
  return panel.sessionId || '__global__';
}

async function readLastPathState(ctx: finch.MiniToolContext): Promise<LastPathState> {
  try {
    const raw = await readFile(stateFile(ctx), 'utf8');
    return JSON.parse(raw) as LastPathState;
  } catch {
    return {};
  }
}

async function rememberLastPath(ctx: finch.MiniToolContext, panel: finch.AppPanel, sourcePath: string): Promise<void> {
  try {
    await mkdir(ctx.storagePath, { recursive: true });
    const state = await readLastPathState(ctx);
    state.panels = { ...state.panels, [panel.id]: sourcePath };
    // Keep the previous shape warm for downgrade compatibility, but always
    // prefer the Panel id on reads so Home scopes in different Spaces cannot
    // overwrite one shared '__global__' bucket.
    state.sessions = { ...state.sessions, [sessionBucketKey(panel)]: sourcePath };
    await writeFile(stateFile(ctx), JSON.stringify(state), 'utf8');
  } catch (error) {
    ctx.logger.warn(`Could not persist last-opened path: ${String(error)}`);
  }
}

async function readLastPath(ctx: finch.MiniToolContext, panel: finch.AppPanel): Promise<string | undefined> {
  const state = await readLastPathState(ctx);
  const perPanel = state.panels?.[panel.id];
  if (typeof perPanel === 'string') return perPanel;
  const key = sessionBucketKey(panel);
  const perSession = state.sessions?.[key];
  if (typeof perSession === 'string') return perSession;
  // Legacy fallback: pre-0.6 versions stored one global lastPath with no
  // per-session bucketing — only honor it for the global bucket so an old
  // value doesn't leak into an unrelated Session.
  if (key === '__global__' && typeof state.lastPath === 'string') return state.lastPath;
  return undefined;
}

async function sendDocument(panel: finch.AppPanel, state: DocumentState): Promise<void> {
  await panel.postMessage({ type: 'document', ...state });
}

function payloadPath(panel: finch.AppPanel): string | undefined {
  const payload = panel.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const value = (payload as { path?: unknown }).path;
  return typeof value === 'string' && path.isAbsolute(value) ? value : undefined;
}

/** Restore only after the guest has announced that its message listener is
 * installed. Prefer persisted per-Panel state; the retained opening payload
 * covers a tool's first-open race before persistence completes. */
async function restoreDocument(ctx: finch.MiniToolContext, panel: finch.AppPanel): Promise<boolean> {
  // Persisted state wins after the user opens a different file from inside an
  // existing single-instance panel; payload is the first-open race fallback.
  const sourcePath = await readLastPath(ctx, panel) ?? payloadPath(panel);
  if (!sourcePath) return false;
  try {
    const markdown = await readFile(sourcePath, 'utf8');
    watchSource(ctx, panel, sourcePath);
    await rememberLastPath(ctx, panel, sourcePath);
    await sendDocument(panel, { path: sourcePath, markdown, title: documentTitle(markdown, sourcePath) });
    return true;
  } catch (error) {
    ctx.logger.warn(`Could not restore ${sourcePath}: ${String(error)}`);
    return false;
  }
}

// Installing bmmd once into our own storage dir and invoking its script
// directly with `node` is much faster than `npx -y bmmd ...` on every
// render: npx re-resolves/re-verifies the package from its dlx cache on
// every single invocation, which dominates render latency once bmmd itself
// is already cached. A one-time local install avoids that overhead for
// every subsequent render.
let bmmdBinPromise: Promise<string> | undefined;

async function ensureBmmdBin(ctx: finch.MiniToolContext, onInstalling?: () => void): Promise<string> {
  if (!bmmdBinPromise) {
    bmmdBinPromise = (async () => {
      const installDir = path.join(ctx.storagePath, 'bmmd');
      const binPath = path.join(installDir, 'node_modules', 'bmmd', 'bin', 'bmmd.mjs');
      try {
        await stat(binPath);
        return binPath;
      } catch {
        // not installed yet, fall through to install below
      }
      onInstalling?.();
      await mkdir(installDir, { recursive: true });
      await new Promise<void>((resolve, reject) => {
        const child = spawn('npm', [
          'install', '--no-save', '--no-audit', '--no-fund', '--silent',
          '--prefix', installDir, 'bmmd@latest',
        ], { stdio: 'ignore' });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`npm install bmmd exited with code ${code}`))));
      });
      await stat(binPath);
      return binPath;
    })();
  }
  try {
    return await bmmdBinPromise;
  } catch (error) {
    bmmdBinPromise = undefined; // allow a retry on the next call
    throw error;
  }
}

async function runBmmd(ctx: finch.MiniToolContext, args: string[], input: string, onInstalling?: () => void): Promise<string> {
  const binPath = await ensureBmmdBin(ctx, onInstalling);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; });
    child.stderr.on('data', (chunk: string) => { errors += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(errors.trim() || `bmmd exited with code ${code}`));
    });
    child.stdin.end(input, 'utf8');
  });
}

async function renderWithBm(ctx: finch.MiniToolContext, markdown: string, markdownStyle: string, customCss: string | undefined, onInstalling?: () => void): Promise<string> {
  const args = ['render', '--platform', 'wechat', '--markdown-style', markdownStyle || 'kami'];
  if (customCss && customCss.trim()) args.push('--custom-css', customCss);
  return runBmmd(ctx, args, markdown, onInstalling);
}

const panelWatchers = new Map<string, FSWatcher>();
let lastPanel: finch.AppPanel | undefined;

function stopWatching(panelId: string): void {
  panelWatchers.get(panelId)?.close();
  panelWatchers.delete(panelId);
}

function watchSource(ctx: finch.MiniToolContext, panel: finch.AppPanel, sourcePath: string): void {
  stopWatching(panel.id);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const watcher = watch(sourcePath, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const markdown = await readFile(sourcePath, 'utf8');
          await sendDocument(panel, { path: sourcePath, markdown, title: documentTitle(markdown, sourcePath) });
        } catch (error) {
          ctx.logger.warn(`Source refresh failed: ${String(error)}`);
        }
      }, 150);
    });
    panelWatchers.set(panel.id, watcher);
  } catch (error) {
    ctx.logger.warn(`Could not watch ${sourcePath}: ${String(error)}`);
  }
}

async function sendReady(ctx: finch.MiniToolContext, panel: finch.AppPanel): Promise<void> {
  const pickFileSupported = ctx.api.supports('ui.pickFile');
  ctx.logger.info(`sending ready to panel; pickFileSupported = ${pickFileSupported}`);
  await panel.postMessage({ type: 'ready', locale: ctx.i18n.locale, pickFileSupported });
}

async function handleMessage(ctx: finch.MiniToolContext, panel: finch.AppPanel, raw: unknown): Promise<void> {
  const message = raw as PanelMessage;
  switch (message.type) {
    case 'clientLog': {
      // Temporary diagnostic bridge: surfaces panel.html-side events (e.g. a
      // toolbar click actually reaching the panel) in the mini tool console.
      ctx.logger.info(`[panel] ${String(message.message ?? '')}`);
      return;
    }
    case 'panelReady': {
      // Authoritative handshake: visibility/open events can precede guest
      // listener installation. Reply only after the page tells us it is ready,
      // then restore a complete current document snapshot on the same channel.
      await sendReady(ctx, panel);
      if (!await restoreDocument(ctx, panel)) {
        await panel.postMessage({ type: 'lastFileUnavailable' });
      }
      return;
    }
    case 'requestOpen': {
      // No client-side timeout here on purpose: a real native picker dialog can
      // legitimately stay open for minutes while the user browses the tree, and
      // racing it against a timer only means we might `close()` a dialog the
      // user is still actively using — plus every fallback path taken this way
      // permanently disables the native picker for the rest of the panel's
      // session (see `pickFileSupported` in panel.html), which is worse than
      // just waiting. The host itself already has its own multi-minute safety
      // net for a truly stuck dialog, so we simply await the result here.
      ctx.logger.info('requestOpen received; calling ctx.ui.pickFile()');
      try {
        const handle = ctx.ui.pickFile({
          title: 'Open article',
          filter: { extensions: ['.md', '.markdown'] },
        });
        ctx.logger.info('ctx.ui.pickFile() call returned a handle, awaiting resolution…');
        const picked = await handle;
        ctx.logger.info(`pickFile() resolved: action=${picked.action}, files=${picked.files.length}`);
        if (picked.action !== 'select' || picked.files.length === 0) {
          // The user cancelled — not an error, but the panel is still waiting
          // on *some* reply to clear its "a native request is pending" guard
          // (see `nativePickPending` in panel.html). Without this ack, the
          // very next click would wrongly think a request is still hanging
          // and jump straight to the (unreliable, no real user gesture)
          // browser fallback instead of opening the native picker again.
          await panel.postMessage({ type: 'pickCancelled' });
          return;
        }
        const sourcePath = picked.files[0].path;
        const markdown = await readFile(sourcePath, 'utf8');
        watchSource(ctx, panel, sourcePath);
        await rememberLastPath(ctx, panel, sourcePath);
        await sendDocument(panel, { path: sourcePath, markdown, title: documentTitle(markdown, sourcePath) });
      } catch (error) {
        ctx.logger.error(`pickFile() threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
        await panel.postMessage({
          type: 'error',
          fallback: true,
          message: `Native file picker failed, falling back to the browser dialog: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }
    case 'loadPath': {
      const sourcePath = String(message.path ?? '').trim();
      if (!path.isAbsolute(sourcePath)) {
        await panel.postMessage({ type: 'error', message: 'Please provide an absolute Markdown path.' });
        return;
      }
      try {
        const markdown = await readFile(sourcePath, 'utf8');
        watchSource(ctx, panel, sourcePath);
        await rememberLastPath(ctx, panel, sourcePath);
        await sendDocument(panel, { path: sourcePath, markdown, title: documentTitle(markdown, sourcePath) });
      } catch (error) {
        await panel.postMessage({ type: 'error', message: `Cannot read file: ${error instanceof Error ? error.message : String(error)}` });
      }
      return;
    }
    case 'watchPath': {
      const sourcePath = String(message.path ?? '').trim();
      if (!path.isAbsolute(sourcePath)) return;
      watchSource(ctx, panel, sourcePath);
      await rememberLastPath(ctx, panel, sourcePath);
      await panel.postMessage({ type: 'watchStarted', path: sourcePath });
      return;
    }
    case 'requestLastFile': {
      if (!await restoreDocument(ctx, panel)) {
        await panel.postMessage({ type: 'lastFileUnavailable' });
      }
      return;
    }
    case 'saveMarkdown': {
      const sourcePath = String(message.path ?? '').trim();
      if (!path.isAbsolute(sourcePath)) return;
      try {
        await writeFile(sourcePath, String(message.markdown ?? ''), 'utf8');
        await panel.postMessage({ type: 'savedMarkdown', path: sourcePath, requestId: message.requestId });
      } catch (error) {
        await panel.postMessage({ type: 'error', message: `Could not save Markdown: ${error instanceof Error ? error.message : String(error)}` });
      }
      return;
    }
    case 'renderBm': {
      try {
        const html = await renderWithBm(ctx, String(message.markdown ?? ''), String(message.markdownStyle ?? 'kami'), message.customCss, () => {
          panel.postMessage({ type: 'status', message: '首次渲染：正在本机安装 bmmd 渲染引擎（约几秒，仅一次）…' }).catch(() => {});
        });
        await panel.postMessage({ type: 'bmRendered', html, requestId: message.requestId });
      } catch (error) {
        await panel.postMessage({ type: 'error', message: `bm.md rendering failed: ${error instanceof Error ? error.message : String(error)}` });
      }
      return;
    }
    case 'updateToolbar': {
      const itemId = String(message.itemId ?? '').trim();
      if (!itemId || !message.patch) return;
      try {
        await panel.updateToolbarItem(itemId, message.patch as finch.AppPanelToolbarItemPatch);
      } catch (error) {
        ctx.logger.warn(`Could not update toolbar item ${itemId}: ${String(error)}`);
      }
      return;
    }
    case 'setToolbar': {
      if (!Array.isArray(message.toolbar)) return;
      try {
        await panel.setToolbar(message.toolbar);
      } catch (error) {
        ctx.logger.warn(`Could not replace toolbar: ${String(error)}`);
      }
      return;
    }
    case 'applyReplacement': {
      const sourcePath = String(message.path ?? '').trim();
      const markdown = String(message.markdown ?? '');
      if (!sourcePath || !path.isAbsolute(sourcePath)) {
        await panel.postMessage({ type: 'error', message: 'Pasted documents can be revised in the editor, but source-file apply needs an absolute path.' });
        return;
      }
      try {
        const before = await readFile(sourcePath, 'utf8');
        await mkdir(path.dirname(snapshotPath(ctx, sourcePath)), { recursive: true });
        const beforePath = snapshotPath(ctx, sourcePath);
        await writeFile(beforePath, before, 'utf8');
        await writeFile(sourcePath, markdown, 'utf8');
        await panel.postMessage({ type: 'applied', path: sourcePath, title: documentTitle(markdown, sourcePath) });
        await ctx.ui.openDiff({ type: 'files', leftPath: beforePath, rightPath: sourcePath, title: 'Markdown Editor revision' });
      } catch (error) {
        await panel.postMessage({ type: 'error', message: `Could not apply revision: ${error instanceof Error ? error.message : String(error)}` });
      }
      return;
    }
  }
}

export function activate(ctx: finch.MiniToolContext): void {
  ctx.subscriptions.push(ctx.icons.register('markdown-editor-icons', {
    'folder-open': {
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>',
    },
    save: {
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/></svg>',
    },
    'save-check': {
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h10.2a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4v4.35"/><path d="m16 19 2 2 4-4"/><path d="M17 15.13V14a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/></svg>',
    },
    'file-pen-line': {
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.364 13.634a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506l4.013-4.009a1 1 0 0 0-3.004-3.004z"/><path d="M14.487 7.858A1 1 0 0 1 14 7V2"/><path d="M20 19.645V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l2.516 2.516"/><path d="M8 18h1"/></svg>',
    },
  }));

  ctx.subscriptions.push(ctx.ui.onDidOpenPanel((panel) => {
    if (panel.visible) lastPanel = panel;
    ctx.subscriptions.push(panel.onDidReceiveMessage((message) => {
      // `handleMessage` is async and its rejections are not implicitly awaited
      // by whatever fires this event — an internal failure (e.g. `postMessage`
      // back to a panel that's mid-teardown/rebind across a Session switch)
      // would otherwise surface as a bare, unhelpful `unhandledRejection`
      // instead of a clean log line, and worse, could leave the panel-side
      // guard state (like `nativePickPending`) stuck forever since the reply
      // that would have cleared it never arrives. Always catch here.
      handleMessage(ctx, panel, message).catch((error) => {
        ctx.logger.warn(`handleMessage failed for '${(message as PanelMessage)?.type}': ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      });
    }));
    ctx.subscriptions.push(panel.onDidChangeVisibility((visible) => {
      if (visible) lastPanel = panel;
      else if (lastPanel === panel) lastPanel = undefined;
    }));
    ctx.subscriptions.push(panel.onDidDispose(() => {
      stopWatching(panel.id);
      if (lastPanel === panel) lastPanel = undefined;
    }));
    // Best-effort immediate push: page-originated `panelReady` is the
    // authoritative restore handshake and remains retryable after navigation.
    void sendReady(ctx, panel).catch((error) => ctx.logger.warn(String(error)));
  }));

  ctx.subscriptions.push(ctx.tools.register({
    name: 'markdown_editor_document',
    title: 'Markdown Editor Document',
    description: `Open, create, revise, or restyle a Markdown document in Markdown Editor.
action:
  open — read an absolute local Markdown path and open it as an editable WeChat article preview
  create — write brand-new Markdown content to an absolute path that does not exist yet, then open it in Markdown Editor. Use this whenever the user asks to create/draft a new Markdown file (Markdown Editor's own UI has no "new file" button on purpose — this tool action is the intended way to start a new document)
  apply — replace a source document with reviewed Markdown and open a native Diff (requires path and markdown)
  set_style — apply an AI-designed custom CSS layout to the currently open Markdown Editor preview (requires css). Write plain CSS scoped under #bm-md using tag/id selectors (no classes), use !important where needed to override the base style, and take inspiration from bm.md's built-in styles: kami (warm paper), bauhaus (geometric primary colors), blueprint (technical grid), botanical (soft green), newsprint (editorial serif), retro (nostalgic), sketch (hand-drawn), terminal (monospace dark).`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'create', 'apply', 'set_style'], description: 'Operation to perform.' },
        path: { type: 'string', description: 'Absolute path to the Markdown file. Required for open, create, and apply. For create, the file must not already exist.' },
        markdown: { type: 'string', description: 'Full Markdown content, required for create and apply.' },
        css: { type: 'string', description: 'Custom CSS to layer on top of the current base style, required for set_style.' },
        label: { type: 'string', description: 'Short label describing the custom style, optional for set_style.' },
      },
      required: ['action'],
    },
    risk: 'medium',
    async execute(input): Promise<finch.ToolResult> {
      const action = String(input.action ?? '');
      if (action === 'open' || action === 'create' || action === 'apply') {
        const sourcePath = String(input.path ?? '').trim();
        if (!path.isAbsolute(sourcePath)) return result('`path` must be an absolute local path.', true);
        if (action === 'open') {
          try {
            const markdown = await readFile(sourcePath, 'utf8');
            const panel = ctx.ui.createPanel({ instanceMode: 'single', payload: { path: sourcePath } });
            await panel.reveal();
            watchSource(ctx, panel, sourcePath);
            await rememberLastPath(ctx, panel, sourcePath);
            await sendDocument(panel, { path: sourcePath, markdown, title: documentTitle(markdown, sourcePath) });
            return result(`Opened Markdown Editor for ${path.basename(sourcePath)}.`);
          } catch (error) {
            return result(`Could not read ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`, true);
          }
        }
        if (action === 'create') {
          const markdown = String(input.markdown ?? '');
          try {
            const alreadyExists = await stat(sourcePath).then(() => true).catch(() => false);
            if (alreadyExists) return result(`${sourcePath} already exists. Use action 'open' to view it or 'apply' to revise it instead.`, true);
            await mkdir(path.dirname(sourcePath), { recursive: true });
            await writeFile(sourcePath, markdown, 'utf8');
            const panel = ctx.ui.createPanel({ instanceMode: 'single', payload: { path: sourcePath } });
            await panel.reveal();
            watchSource(ctx, panel, sourcePath);
            await rememberLastPath(ctx, panel, sourcePath);
            await sendDocument(panel, { path: sourcePath, markdown, title: documentTitle(markdown, sourcePath) });
            return result(`Created ${path.basename(sourcePath)} and opened it in Markdown Editor.`);
          } catch (error) {
            return result(`Could not create ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`, true);
          }
        }
        const markdown = String(input.markdown ?? '');
        if (!markdown) return result('`apply` requires non-empty `markdown`.', true);
        try {
          await mkdir(path.dirname(snapshotPath(ctx, sourcePath)), { recursive: true });
          const before = await readFile(sourcePath, 'utf8');
          const beforePath = snapshotPath(ctx, sourcePath);
          await writeFile(beforePath, before, 'utf8');
          await writeFile(sourcePath, markdown, 'utf8');
          await ctx.ui.openDiff({ type: 'files', leftPath: beforePath, rightPath: sourcePath, title: 'Markdown Editor revision' });
          return result(`Applied reviewed Markdown to ${path.basename(sourcePath)} and opened a Diff.`);
        } catch (error) {
          return result(`Could not apply revision: ${error instanceof Error ? error.message : String(error)}`, true);
        }
      }
      if (action === 'set_style') {
        const css = String(input.css ?? '').trim();
        if (!css) return result('`set_style` requires non-empty `css`.', true);
        if (!lastPanel) return result('No Markdown Editor panel is open. Ask the user to open a document first.', true);
        try {
          await lastPanel.postMessage({ type: 'customStyleSet', css, label: String(input.label ?? '') || 'AI style' });
          return result('Custom style applied to the open Markdown Editor panel.');
        } catch (error) {
          return result(`Could not apply custom style: ${error instanceof Error ? error.message : String(error)}`, true);
        }
      }
      return result(`Unknown action: ${action}`, true);
    },
  }));

  ctx.logger.info('finch-markdown-editor activated');
}

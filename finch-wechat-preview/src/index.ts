import type * as finch from 'finch';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
  patch?: { label?: string; icon?: string; tooltip?: string };
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

async function sendDocument(panel: finch.AppPanel, state: DocumentState): Promise<void> {
  await panel.postMessage({ type: 'document', ...state });
}

async function runBmmd(args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['-y', 'bmmd', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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

async function renderWithBm(markdown: string, markdownStyle: string, customCss?: string): Promise<string> {
  const args = ['render', '--platform', 'wechat', '--markdown-style', markdownStyle || 'kami'];
  if (customCss && customCss.trim()) args.push('--custom-css', customCss);
  return runBmmd(args, markdown);
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

function sendReady(ctx: finch.MiniToolContext, panel: finch.AppPanel): void {
  const pickFileSupported = ctx.api.supports('ui.pickFile');
  ctx.logger.info(`sending ready to panel; pickFileSupported = ${pickFileSupported}`);
  panel.postMessage({ type: 'ready', locale: ctx.i18n.locale, pickFileSupported }).catch((error) => ctx.logger.warn(String(error)));
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
      // Authoritative handshake: the host's own immediate `ready` push (fired
      // from `onDidOpenPanel`, see activate()) races against this guest page
      // loading and can be silently lost. The panel asks for it again once its
      // own message listener is guaranteed to be attached, so this reply can't
      // be lost the same way.
      sendReady(ctx, panel);
      return;
    }
    case 'requestOpen': {
      // Some Finch releases advertise `ctx.api.supports('ui.pickFile')` before the
      // dialog is actually wired up end-to-end (e.g. main-process/renderer version
      // skew during a rolling update), which would otherwise leave the awaited
      // `ctx.ui.pickFile()` Promise pending forever with no feedback for the user.
      // This is a generous *safety-valve* timeout only — a real dialog can
      // legitimately stay open for minutes while the user browses the tree, so we
      // must not cut that off. The actual "feels unresponsive" fix lives on the
      // panel side: it shows a status line right away, and a second click while a
      // request is still pending immediately switches to the in-page picker
      // instead of waiting for this timeout at all.
      const NATIVE_PICKER_TIMEOUT_MS = 60_000;
      let handle: finch.FilePickerHandle | undefined;
      ctx.logger.info('requestOpen received; calling ctx.ui.pickFile()');
      try {
        handle = ctx.ui.pickFile({
          title: 'Open article',
          filter: { extensions: ['.md', '.markdown'] },
        });
        ctx.logger.info('ctx.ui.pickFile() call returned a handle, awaiting resolution…');
        const timedOut = Symbol('timeout');
        const result = await Promise.race([
          handle,
          new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), NATIVE_PICKER_TIMEOUT_MS)),
        ]);
        if (result === timedOut) {
          ctx.logger.warn(`pickFile() did not resolve within ${NATIVE_PICKER_TIMEOUT_MS}ms; closing and falling back`);
          await handle.close();
          await panel.postMessage({
            type: 'error',
            fallback: true,
            message: 'Native file picker did not respond in time. Falling back to the browser file dialog — click "Open article" again.',
          });
          return;
        }
        const picked = result as finch.FilePickerResult;
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
      await panel.postMessage({ type: 'watchStarted', path: sourcePath });
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
        const html = await renderWithBm(String(message.markdown ?? ''), String(message.markdownStyle ?? 'kami'), message.customCss);
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
        await ctx.ui.openDiff({ type: 'files', leftPath: beforePath, rightPath: sourcePath, title: 'WeChat Preview revision' });
      } catch (error) {
        await panel.postMessage({ type: 'error', message: `Could not apply revision: ${error instanceof Error ? error.message : String(error)}` });
      }
      return;
    }
  }
}

export function activate(ctx: finch.MiniToolContext): void {
  ctx.subscriptions.push(ctx.ui.onDidOpenPanel((panel) => {
    lastPanel = panel;
    ctx.subscriptions.push(panel.onDidReceiveMessage((message) => handleMessage(ctx, panel, message)));
    ctx.subscriptions.push(panel.onDidDispose(() => {
      stopWatching(panel.id);
      if (lastPanel === panel) lastPanel = undefined;
    }));
    // Best-effort immediate push: usually fine, but the panel's own
    // `panelReady` handshake (handled above in handleMessage) is what actually
    // guarantees delivery — see the comment there for why this alone isn't
    // reliable.
    sendReady(ctx, panel);
  }));

  ctx.subscriptions.push(ctx.tools.register({
    name: 'wechat_preview_document',
    title: 'WeChat Preview Document',
    description: `Open, revise, or restyle a Markdown document in WeChat Preview.
action:
  open — read an absolute local Markdown path and open it as an editable WeChat article preview
  apply — replace a source document with reviewed Markdown and open a native Diff (requires path and markdown)
  set_style — apply an AI-designed custom CSS layout to the currently open WeChat Preview panel (requires css). Write plain CSS scoped under #bm-md using tag/id selectors (no classes), use !important where needed to override the base style, and take inspiration from bm.md's built-in styles: kami (warm paper), bauhaus (geometric primary colors), blueprint (technical grid), botanical (soft green), newsprint (editorial serif), retro (nostalgic), sketch (hand-drawn), terminal (monospace dark).`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'apply', 'set_style'], description: 'Operation to perform.' },
        path: { type: 'string', description: 'Absolute path to the Markdown source file. Required for open and apply.' },
        markdown: { type: 'string', description: 'Reviewed replacement Markdown, required for apply.' },
        css: { type: 'string', description: 'Custom CSS to layer on top of the current base style, required for set_style.' },
        label: { type: 'string', description: 'Short label describing the custom style, optional for set_style.' },
      },
      required: ['action'],
    },
    risk: 'medium',
    async execute(input): Promise<finch.ToolResult> {
      const action = String(input.action ?? '');
      if (action === 'open' || action === 'apply') {
        const sourcePath = String(input.path ?? '').trim();
        if (!path.isAbsolute(sourcePath)) return result('`path` must be an absolute local path.', true);
        if (action === 'open') {
          try {
            const markdown = await readFile(sourcePath, 'utf8');
            const panel = ctx.ui.createPanel({ instanceMode: 'single', payload: { path: sourcePath } });
            await panel.reveal();
            watchSource(ctx, panel, sourcePath);
            await sendDocument(panel, { path: sourcePath, markdown, title: documentTitle(markdown, sourcePath) });
            return result(`Opened WeChat Preview for ${path.basename(sourcePath)}.`);
          } catch (error) {
            return result(`Could not read ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`, true);
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
          await ctx.ui.openDiff({ type: 'files', leftPath: beforePath, rightPath: sourcePath, title: 'WeChat Preview revision' });
          return result(`Applied reviewed Markdown to ${path.basename(sourcePath)} and opened a Diff.`);
        } catch (error) {
          return result(`Could not apply revision: ${error instanceof Error ? error.message : String(error)}`, true);
        }
      }
      if (action === 'set_style') {
        const css = String(input.css ?? '').trim();
        if (!css) return result('`set_style` requires non-empty `css`.', true);
        if (!lastPanel) return result('No WeChat Preview panel is open. Ask the user to open an article first.', true);
        try {
          await lastPanel.postMessage({ type: 'customStyleSet', css, label: String(input.label ?? '') || 'AI style' });
          return result('Custom style applied to the open WeChat Preview panel.');
        } catch (error) {
          return result(`Could not apply custom style: ${error instanceof Error ? error.message : String(error)}`, true);
        }
      }
      return result(`Unknown action: ${action}`, true);
    },
  }));

  ctx.logger.info('finch-wechat-preview activated');
}

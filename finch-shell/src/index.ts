import { spawnSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type * as finch from 'finch';
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch';

interface NodePtyModule {
  spawn(file: string, args: string[] | string, options: {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string>;
  }): IPty;
}

interface TerminalBackend {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): finch.Disposable;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): finch.Disposable;
}

interface PanelMessage {
  type?: string;
  data?: unknown;
  cwd?: unknown;
  cols?: unknown;
  rows?: unknown;
}

interface TerminalSession {
  backend?: TerminalBackend;
  cwd: string;
  cols: number;
  rows: number;
  transcript: string;
  pendingOutput: string;
  ready: boolean;
  visible: boolean;
  generation: number;
}

const require = createRequire(import.meta.url);
let nodePtyModule: NodePtyModule | undefined;
const sessions = new Map<string, TerminalSession>();
const panels = new Map<string, finch.AppPanel>();
const MAX_TRANSCRIPT = 1_000_000;
const CWD_POLL_INTERVAL = 1000;

function loadNodePty(): NodePtyModule {
  if (nodePtyModule) return nodePtyModule;
  try {
    nodePtyModule = require('./node-pty/lib/index.js') as NodePtyModule;
  } catch (error) {
    // Surface the host runtime in the panel: native load failures are almost
    // always a platform, arch, or ABI mismatch in the bundled binaries.
    const reason = error instanceof Error ? error.message : String(error);
    const runtime = process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.versions.node}`;
    throw new Error(`${reason} (${process.platform}-${process.arch}, ${runtime}, abi ${process.versions.modules})`);
  }
  return nodePtyModule;
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe';
  return process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
}

class NodePtyBackend implements TerminalBackend {
  private readonly pty: IPty;

  constructor(cwd: string, cols: number, rows: number) {
    const shell = defaultShell();
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    this.pty = loadNodePty().spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
    });
  }

  write(data: string): void {
    this.pty.write(data);
  }

  get pid(): number {
    return this.pty.pid;
  }

  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows);
  }

  kill(): void {
    this.pty.kill();
  }

  onData(listener: (data: string) => void): finch.Disposable {
    return this.pty.onData(listener);
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): finch.Disposable {
    return this.pty.onExit(listener);
  }
}

function normalizeDimension(value: unknown, fallback: number, max: number): number {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) ? Math.max(2, Math.min(max, number)) : fallback;
}

function readProcessCwd(pid: number): string | undefined {
  if (!pid || pid <= 0) return undefined;
  try {
    if (process.platform === 'linux') {
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      return cwd || undefined;
    }
    if (['darwin', 'freebsd', 'openbsd', 'netbsd'].includes(process.platform)) {
      const result = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
        encoding: 'utf8',
        timeout: 1500,
      });
      if (result.status === 0 && result.stdout) {
        for (const line of result.stdout.split('\n')) {
          if (line.length > 1 && line.startsWith('n')) return line.slice(1);
        }
      }
    }
  } catch {
    // The shell process may have exited between the tick and the probe.
  }
  return undefined;
}

function resolveCwd(message: PanelMessage, panel: finch.AppPanel): string {
  const requested = String(message.cwd ?? '').trim();
  const payload = panel.payload;
  const payloadCwd = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? String((payload as Record<string, unknown>).cwd ?? '').trim()
    : '';
  const home = process.env.HOME || process.env.USERPROFILE || process.cwd();
  const candidate = payloadCwd || requested || home;
  return path.isAbsolute(candidate) ? candidate : home;
}

function appendTranscript(session: TerminalSession, data: string): void {
  session.transcript += data;
  if (session.transcript.length > MAX_TRANSCRIPT) {
    session.transcript = session.transcript.slice(-MAX_TRANSCRIPT);
  }
}

async function safePost(panel: finch.AppPanel, message: Record<string, unknown>): Promise<void> {
  try {
    await panel.postMessage(message);
  } catch {
    // Navigation and teardown can briefly invalidate a panel bridge.
  }
}

function stopBackend(session: TerminalSession): void {
  session.generation += 1;
  const backend = session.backend;
  session.backend = undefined;
  if (backend) {
    try {
      backend.kill();
    } catch {
      // The process may already have exited.
    }
  }
}

function startBackend(ctx: finch.MiniToolContext, panel: finch.AppPanel, session: TerminalSession): void {
  stopBackend(session);
  session.transcript = '';
  session.pendingOutput = '';
  const generation = session.generation;
  try {
    const backend = new NodePtyBackend(session.cwd, session.cols, session.rows);
    session.backend = backend;
    const dataDisposable = backend.onData((data) => {
      if (session.generation !== generation) return;
      appendTranscript(session, data);
      if (session.ready && session.visible) {
        void safePost(panel, { type: 'terminalData', data });
      } else {
        session.pendingOutput += data;
      }
    });
    const exitDisposable = backend.onExit((event) => {
      dataDisposable.dispose();
      exitDisposable.dispose();
      if (session.generation !== generation) return;
      session.backend = undefined;
      const marker = `\r\n[process exited with code ${event.exitCode}]\r\n`;
      appendTranscript(session, marker);
      if (session.ready && session.visible) void safePost(panel, { type: 'terminalData', data: marker });
      else session.pendingOutput += marker;
      void safePost(panel, { type: 'terminalExit', exitCode: event.exitCode });
    });
    void safePost(panel, { type: 'terminalStarted', cwd: session.cwd });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.error(`Could not start PTY: ${message}`);
    void safePost(panel, { type: 'terminalError', message });
  }
}

async function handleMessage(ctx: finch.MiniToolContext, panel: finch.AppPanel, raw: unknown): Promise<void> {
  const message = raw as PanelMessage;
  let session = sessions.get(panel.id);
  if (!session) {
    session = {
      cwd: resolveCwd(message, panel),
      cols: 80,
      rows: 24,
      transcript: '',
      pendingOutput: '',
      ready: false,
      visible: panel.visible,
      generation: 0,
    };
    sessions.set(panel.id, session);
  }

  switch (message.type) {
    case 'panelReady':
      session.ready = true;
      session.cwd = resolveCwd(message, panel);
      session.cols = normalizeDimension(message.cols, session.cols, 500);
      session.rows = normalizeDimension(message.rows, session.rows, 200);
      await safePost(panel, { type: 'terminalInit', data: session.transcript, cwd: session.cwd, running: Boolean(session.backend) });
      session.pendingOutput = '';
      if (!session.backend) startBackend(ctx, panel, session);
      return;
    case 'terminalInput':
      if (session.backend && typeof message.data === 'string') session.backend.write(message.data);
      return;
    case 'terminalResize':
      session.cols = normalizeDimension(message.cols, session.cols, 500);
      session.rows = normalizeDimension(message.rows, session.rows, 200);
      session.backend?.resize(session.cols, session.rows);
      return;
    case 'terminalRestart':
      startBackend(ctx, panel, session);
      return;
  }
}

export function activate(ctx: finch.MiniToolContext): void {
  ctx.subscriptions.push(ctx.icons.register('finch-shell-icons', {
    restart: {
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8.1 8.1 0 1 0 .5 4"/><path d="M20 4v7h-7"/></svg>',
    },
    trash: {
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>',
    },
  }));

  ctx.subscriptions.push(ctx.ui.onDidOpenPanel((panel) => {
    panels.set(panel.id, panel);
    const existing = sessions.get(panel.id);
    if (existing) existing.visible = panel.visible;

    ctx.subscriptions.push(panel.onDidReceiveMessage((message) => {
      void handleMessage(ctx, panel, message).catch((error) => {
        ctx.logger.error(`Terminal panel message failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }));

    ctx.subscriptions.push(panel.onDidChangeVisibility((visible) => {
      const session = sessions.get(panel.id);
      if (!session) return;
      session.visible = visible;
      if (visible && session.ready && session.pendingOutput) {
        const data = session.pendingOutput;
        session.pendingOutput = '';
        void safePost(panel, { type: 'terminalData', data });
      }
    }));

    ctx.subscriptions.push(panel.onDidDispose(() => {
      const session = sessions.get(panel.id);
      if (session) stopBackend(session);
      sessions.delete(panel.id);
      panels.delete(panel.id);
    }));
  }));

  // Track the real working directory of every live shell so tab titles follow
  // the user when they cd inside the terminal. Polling is shell-agnostic and
  // avoids injecting hooks into user rc files.
  const cwdPollTimer = setInterval(() => {
    for (const [id, session] of sessions) {
      const pid = session.backend?.pid;
      const panel = panels.get(id);
      if (!pid || !panel) continue;
      const cwd = readProcessCwd(pid);
      if (cwd && cwd !== session.cwd) {
        session.cwd = cwd;
        void safePost(panel, { type: 'terminalCwd', cwd });
      }
    }
  }, CWD_POLL_INTERVAL);
  ctx.subscriptions.push({ dispose: () => clearInterval(cwdPollTimer) });

  ctx.subscriptions.push(ctx.tools.register({
    name: 'finch_shell_open',
    title: 'Open terminal',
    description: 'Open an interactive shell terminal in a Finch panel. The terminal starts in the current workspace unless an absolute cwd is provided.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Optional absolute working directory for the terminal.' },
      },
    },
    risk: 'medium',
    async execute(input, execution): Promise<finch.ToolResult> {
      const requestedCwd = String(input.cwd ?? '').trim();
      if (requestedCwd && !path.isAbsolute(requestedCwd)) {
        return { content: [{ type: 'text', text: '`cwd` must be an absolute path.' }], isError: true };
      }
      const contextCwd = String(execution.cwd ?? '').trim();
      const cwd = requestedCwd || (path.isAbsolute(contextCwd) ? contextCwd : '');
      const panel = ctx.ui.createPanel({ instanceMode: 'multiple', payload: cwd ? { cwd } : undefined });
      await panel.reveal();
      return { content: [{ type: 'text', text: `Opened an interactive terminal${cwd ? ` in ${cwd}` : ''}.` }] };
    },
  }));
}

export function deactivate(): void {
  for (const session of sessions.values()) stopBackend(session);
  sessions.clear();
}

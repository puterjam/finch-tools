import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './panel.css';

declare global {
  interface Window {
    finch?: {
      postMessage(message: unknown): void;
      onMessage(listener: (message: unknown) => void): { dispose(): void };
      panel?: {
        setTitle(title: string): Promise<void>;
      };
    };
  }
}

interface HostMessage {
  type?: string;
  itemId?: string;
  data?: unknown;
  cwd?: unknown;
  message?: unknown;
  running?: unknown;
  locale?: unknown;
}

const bridge = window.finch;
const root = document.getElementById('terminal');
if (!root) throw new Error('Terminal panel markup is incomplete.');
const terminalRoot = root;

let isZh = /^zh/i.test(navigator.language || '');
const strings = {
  zh: {
    title: '终端',
    aria: '交互式终端',
    failedDetail: '无法启动 shell',
  },
  en: {
    title: 'Shell',
    aria: 'Interactive terminal',
    failedDetail: 'Could not start shell',
  },
};
const t = (key: keyof typeof strings.en): string => strings[isZh ? 'zh' : 'en'][key];
function applyLanguage(): void {
  document.documentElement.lang = isZh ? 'zh-CN' : 'en';
  document.title = t('title');
  terminalRoot.setAttribute('aria-label', t('aria'));
}
applyLanguage();

function color(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function themeColors(): NonNullable<ConstructorParameters<typeof Terminal>[0]>['theme'] {
  const style = getComputedStyle(document.documentElement);
  const declaredMode = style.getPropertyValue('--finch-theme-mode').trim();
  const dark = declaredMode === 'dark' || (!declaredMode && matchMedia('(prefers-color-scheme: dark)').matches);
  const background = color('--finch-bg-root', dark ? '#17171a' : '#ffffff');
  return {
    background,
    foreground: color('--finch-text-primary', dark ? '#eeeeee' : '#202124'),
    cursor: color('--finch-accent', dark ? '#70a889' : '#3f6b56'),
    cursorAccent: background,
    selectionBackground: color('--finch-accent-dim', dark ? 'rgba(112,168,137,.35)' : 'rgba(63,107,86,.25)'),
  };
}

const terminal = new Terminal({
  allowProposedApi: false,
  cursorBlink: true,
  cursorStyle: 'block',
  convertEol: false,
  fontFamily: color('--finch-font-mono', 'Menlo, Monaco, Consolas, monospace'),
  fontSize: 13,
  lineHeight: 1.15,
  scrollback: 10_000,
  theme: themeColors(),
});
const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
terminal.open(terminalRoot);

let initialized = false;
let resizeFrame = 0;
let themeSyncFrame = 0;
let appliedThemeSignature = '';
let cwd = '';

function syncTheme(): void {
  const theme = themeColors();
  const fontFamily = color('--finch-font-mono', 'Menlo, Monaco, Consolas, monospace');
  const signature = JSON.stringify({ theme, fontFamily });
  if (signature === appliedThemeSignature) return;
  appliedThemeSignature = signature;
  terminal.options.theme = theme;
  terminal.options.fontFamily = fontFamily;
}

function scheduleThemeSync(): void {
  cancelAnimationFrame(themeSyncFrame);
  themeSyncFrame = requestAnimationFrame(() => {
    // Finch updates its root marker before all injected CSS variables have
    // necessarily reached computed style. Read them on the following frame.
    themeSyncFrame = requestAnimationFrame(syncTheme);
  });
}

function compactCwd(value: string): string {
  const normalized = value.replace(/[\\/]+$/, '');
  const segments = normalized.split(/[\\/]+/).filter(Boolean);
  return segments.length ? `…/${segments[segments.length - 1]}` : t('title');
}

function updatePanelTitle(): void {
  if (!cwd || !bridge?.panel) return;
  void bridge.panel.setTitle(compactCwd(cwd)).catch(() => {});
}

function post(message: Record<string, unknown>): void {
  bridge?.postMessage(message);
}

function fitAndNotify(): void {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    try {
      fitAddon.fit();
      post({ type: 'terminalResize', cols: terminal.cols, rows: terminal.rows });
    } catch {
      // The panel can report a transient zero-sized layout while navigating.
    }
  });
}

terminal.onData((data) => post({ type: 'terminalInput', data }));
terminal.onResize(({ cols, rows }) => post({ type: 'terminalResize', cols, rows }));

bridge?.onMessage((raw) => {
  const message = raw as HostMessage;
  if (message.type === 'finch:env') {
    cwd = String(message.cwd ?? cwd);
    isZh = /^zh/i.test(String(message.locale ?? navigator.language ?? ''));
    applyLanguage();
    updatePanelTitle();
    scheduleThemeSync();
    return;
  }
  if (message.type === 'finch:menu') {
    if (message.itemId === 'new-session') {
      terminal.reset();
      post({ type: 'terminalRestart' });
    } else if (message.itemId === 'clear') {
      terminal.clear();
    }
    return;
  }
  if (message.type === 'terminalInit') {
    terminal.reset();
    if (typeof message.data === 'string' && message.data) terminal.write(message.data);
    cwd = String(message.cwd ?? cwd);
    updatePanelTitle();
    initialized = true;
    terminal.focus();
    fitAndNotify();
    return;
  }
  if (message.type === 'terminalStarted') {
    cwd = String(message.cwd ?? cwd);
    updatePanelTitle();
    terminal.focus();
    return;
  }
  if (message.type === 'terminalData' && typeof message.data === 'string') {
    terminal.write(message.data);
    return;
  }
  if (message.type === 'terminalExit') return;
  if (message.type === 'terminalError') {
    const detail = String(message.message ?? 'Unknown error');
    terminal.writeln(`\r\n\x1b[31m${t('failedDetail')}: ${detail}\x1b[0m`);
  }
});

new ResizeObserver(fitAndNotify).observe(terminalRoot);
new MutationObserver(scheduleThemeSync).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', scheduleThemeSync);
// Some host theme updates replace stylesheet contents without mutating the
// document root. A cheap signature check catches that path without repainting
// xterm when the computed palette is unchanged.
window.setInterval(syncTheme, 250);
syncTheme();
window.addEventListener('focus', () => terminal.focus());
document.addEventListener('click', () => terminal.focus());

requestAnimationFrame(() => {
  fitAddon.fit();
  post({ type: 'panelReady', cwd, cols: terminal.cols, rows: terminal.rows });
  window.setTimeout(() => {
    if (!initialized) post({ type: 'panelReady', cwd, cols: terminal.cols, rows: terminal.rows });
  }, 350);
});

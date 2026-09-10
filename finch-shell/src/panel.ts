import { Terminal } from '@xterm/xterm';
import type { IBufferRange, ILink } from '@xterm/xterm';
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
  fontFamily: 'SF Mono, Menlo, Monaco, Consolas, monospace',
  fontSize: 13,
  fontWeight: '400',
  fontWeightBold: '500',
  lineHeight: 1.15,
  overviewRuler: { width: 6 },
  scrollback: 10_000,
  theme: themeColors(),
});
const fitAddon = new FitAddon();
let scrollbarHideTimer = 0;
terminal.loadAddon(fitAddon);
terminal.open(terminalRoot);

function revealScrollbar(): void {
  terminalRoot.dataset.scrolling = '';
  window.clearTimeout(scrollbarHideTimer);
  scrollbarHideTimer = window.setTimeout(() => {
    delete terminalRoot.dataset.scrolling;
  }, 900);
}

terminal.onScroll(revealScrollbar);
const viewport = terminalRoot.querySelector<HTMLElement>('.xterm-viewport');
viewport?.addEventListener('scroll', revealScrollbar, { passive: true });

let initialized = false;
let resizeFrame = 0;
let themeSyncFrame = 0;
let appliedThemeSignature = '';
let cwd = '';
let panelReadySent = false;

function syncTheme(): void {
  const theme = themeColors();
  const fontFamily = 'SF Mono, Menlo, Monaco, Consolas, monospace';
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

function sendPanelReady(): void {
  if (panelReadySent) return;
  panelReadySent = true;
  fitAddon.fit();
  post({ type: 'panelReady', cwd, cols: terminal.cols, rows: terminal.rows });
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

function copySelection(): boolean {
  const selection = terminal.getSelection();
  if (!selection) return false;
  navigator.clipboard?.writeText(selection).catch(() => {
    // Clipboard access can be rejected while the panel is unfocused. xterm draws
    // its selection on a canvas, so fall back to a throwaway DOM node instead.
    const carrier = document.createElement('textarea');
    carrier.value = selection;
    carrier.setAttribute('aria-hidden', 'true');
    carrier.style.position = 'fixed';
    carrier.style.opacity = '0';
    document.body.appendChild(carrier);
    carrier.select();
    try {
      document.execCommand('copy');
    } finally {
      carrier.remove();
      terminal.focus();
    }
  });
  return true;
}

// Ctrl+Shift+C has no default browser action, so without this the shortcut does
// nothing on Linux and Windows. Paste already works through Chromium's built-in
// "paste as plain text", so leave Ctrl+Shift+V alone rather than risk breaking
// it behind a clipboard-read permission prompt. macOS keeps Cmd+C/Cmd+V.
terminal.attachCustomKeyEventHandler((event) => {
  if (event.type !== 'keydown') return true;
  if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return true;
  if (event.code !== 'KeyC' && event.key.toLowerCase() !== 'c') return true;
  // With no selection, fall through so the keypress keeps its normal meaning.
  if (!copySelection()) return true;
  event.preventDefault();
  return false;
});

// ── Ctrl/Cmd-click to open a URL ────────────────────────────────────────────
// Underlining every URL all the time would fight with the terminal's own
// colouring, so links stay invisible until the modifier is down, exactly like
// an editor. xterm tracks reassignment of `decorations`, so a hovered link
// restyles the moment the key state changes.
const isMac = /mac|iphone|ipad/i.test(navigator.userAgent);
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"'`\u0000-\u001f]{2,}/g;
const TRAILING_PUNCTUATION = /[.,;:!?'"]+$/;
const BRACKET_PAIRS: ReadonlyArray<readonly [string, string]> = [['(', ')'], ['[', ']'], ['{', '}']];

let modifierHeld = false;
const liveLinks = new Set<ILink>();

function hasModifier(event: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return isMac ? event.metaKey : event.ctrlKey;
}

function setModifier(held: boolean): void {
  if (held === modifierHeld) return;
  modifierHeld = held;
  for (const link of liveLinks) link.decorations = { pointerCursor: held, underline: held };
}

function occurrences(text: string, character: string): number {
  let count = 0;
  for (const char of text) if (char === character) count += 1;
  return count;
}

// Shells and log lines love to wrap or follow a URL with punctuation, and that
// trailing noise is almost never part of the address.
function tidyUrl(raw: string): string {
  let url = raw.replace(TRAILING_PUNCTUATION, '');
  let trimming = true;
  while (trimming) {
    trimming = false;
    for (const [open, close] of BRACKET_PAIRS) {
      if (url.endsWith(close) && occurrences(url, open) < occurrences(url, close)) {
        url = url.slice(0, -1).replace(TRAILING_PUNCTUATION, '');
        trimming = true;
      }
    }
  }
  return url;
}

interface CellRef {
  x: number;
  y: number;
}

// A long URL is split across several buffer lines, so scan the whole wrapped
// block and keep a per-character cell map: with wide glyphs on the line, a
// string index is not a column.
function collectWrappedBlock(lineIndex: number): { text: string; cells: CellRef[] } | undefined {
  const buffer = terminal.buffer.active;
  if (lineIndex < 0 || lineIndex >= buffer.length) return undefined;
  let start = lineIndex;
  while (start > 0 && buffer.getLine(start)?.isWrapped) start -= 1;
  let end = lineIndex;
  while (end + 1 < buffer.length && buffer.getLine(end + 1)?.isWrapped) end += 1;

  let text = '';
  const cells: CellRef[] = [];
  for (let y = start; y <= end; y += 1) {
    const line = buffer.getLine(y);
    if (!line) continue;
    for (let x = 0; x < line.length; x += 1) {
      const cell = line.getCell(x);
      if (!cell) continue;
      // Width 0 is the trailing half of a wide glyph and holds no character.
      if (cell.getWidth() === 0) continue;
      const chars = cell.getChars() || ' ';
      for (let index = 0; index < chars.length; index += 1) cells.push({ x, y });
      text += chars;
    }
  }
  return { text, cells };
}

function createLink(range: IBufferRange, url: string): ILink {
  const link: ILink = {
    range,
    text: url,
    decorations: { pointerCursor: modifierHeld, underline: modifierHeld },
    activate(event, text) {
      if (!hasModifier(event)) return;
      post({ type: 'openUrl', url: /^www\./i.test(text) ? `https://${text}` : text });
    },
    dispose() {
      liveLinks.delete(link);
    },
  };
  liveLinks.add(link);
  return link;
}

terminal.registerLinkProvider({
  provideLinks(bufferLineNumber, callback) {
    const block = collectWrappedBlock(bufferLineNumber - 1);
    if (!block) {
      callback(undefined);
      return;
    }
    const links: ILink[] = [];
    for (const match of block.text.matchAll(URL_PATTERN)) {
      if (typeof match.index !== 'number') continue;
      const url = tidyUrl(match[0]);
      if (url.length < 5) continue;
      const first = block.cells[match.index];
      const last = block.cells[match.index + url.length - 1];
      if (!first || !last) continue;
      links.push(createLink({
        start: { x: first.x + 1, y: first.y + 1 },
        end: { x: last.x + 1, y: last.y + 1 },
      }, url));
    }
    callback(links.length ? links : undefined);
  },
});

window.addEventListener('keydown', (event) => {
  if (hasModifier(event)) setModifier(true);
});
window.addEventListener('keyup', (event) => {
  if (!hasModifier(event)) setModifier(false);
});
window.addEventListener('blur', () => setModifier(false));

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
    sendPanelReady();
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
  if (message.type === 'terminalCwd') {
    cwd = String(message.cwd ?? cwd);
    updatePanelTitle();
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
});

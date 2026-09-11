import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// bmmd is LGPL-3.0-only as of 0.3.0, so its published CLI payload is
// bundled under dist/bmmd/bin at build time. Keeping its files intact (rather
// than rebundling) preserves the CLI's dynamic imports between chunk files.
const BMMD_BIN_PATH = fileURLToPath(new URL('./bmmd/bin/bmmd.mjs', import.meta.url));

async function runBmmd(args: string[], input: string): Promise<string> {
  const binPath = BMMD_BIN_PATH;
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

// bmmd sanitizes `img[src]` and deliberately removes both unknown protocols
// (including Finch's `finch-file:`) and data: URLs. Preserve the Markdown
// source URL unchanged, but temporarily turn each local image into a unique
// harmless HTTPS placeholder. HTTPS survives bmmd's sanitizer; after bmmd
// has finished its layout/inlining work we restore the original URL in the
// generated HTML. The panel webview can then resolve it through Finch's
// already-allowlisted `finch-file://local` protocol.
const FINCH_FILE_IMAGE_RE = /finch-file:\/\/local\?path=[^\s)"']+/g;
const FINCH_IMAGE_PLACEHOLDER_ORIGIN = 'https://finch-local.invalid/markdown-image/';
const MARKDOWN_IMAGE_ALT_RE = /!\[([^\]\n]*)\](?=\()/g;

interface ObsidianImageWidthMarker {
  token: string;
  width: number;
  emptyCaption: boolean;
}

// Obsidian stores image dimensions at the end of the image description:
// `![caption|320](url)` or `![caption|320x180](url)`. CommonMark treats that
// entire description as alt text, so replace the suffix with a private marker
// before bmmd renders. The marker associates the generated <img> with its
// width without relying on image order (raw HTML may contain other images).
function prepareObsidianImageWidths(markdown: string): { markdown: string; markers: ObsidianImageWidthMarker[] } {
  const markers: ObsidianImageWidthMarker[] = [];
  const prepared = markdown.replace(MARKDOWN_IMAGE_ALT_RE, (whole, rawAlt: string) => {
    const sized = /^(.*)\|(\d+)(?:x\d+)?$/.exec(rawAlt);
    const width = sized ? Number(sized[2]) : NaN;
    if (!sized || !Number.isFinite(width) || width <= 0) return whole;
    const normalizedWidth = Math.round(width);
    const token = `FINCHIMGSIZE${markers.length}X${normalizedWidth}X`;
    markers.push({ token, width: normalizedWidth, emptyCaption: !sized[1] });
    return `![${sized[1]}${token}]`;
  });
  return { markdown: prepared, markers };
}

function applyObsidianImageWidths(html: string, markers: ObsidianImageWidthMarker[]): string {
  let rendered = html;
  for (const marker of markers) {
    const widthStyle = `width: ${marker.width}px; max-width: 100%; height: auto;`;
    rendered = rendered.replace(/<img\b[^>]*>/gi, (tag) => {
      if (!tag.includes(marker.token)) return tag;
      const cleanTag = tag.split(marker.token).join('');
      if (/\sstyle="[^"]*"/i.test(cleanTag)) {
        return cleanTag.replace(/\sstyle="([^"]*)"/i, (_styleAttr, style: string) => ` style="${style} ${widthStyle}"`);
      }
      return cleanTag.replace(/>$/, ` style="${widthStyle}">`);
    });
    if (marker.emptyCaption) {
      rendered = rendered.replace(/<figcaption\b[^>]*>[\s\S]*?<\/figcaption>/gi, (caption) => (
        caption.includes(marker.token) ? '' : caption
      ));
    }
    rendered = rendered.split(marker.token).join('');
  }
  return rendered;
}

function substituteFinchFileImagesForBm(markdown: string): { markdown: string; urls: Map<string, string> } {
  const urls = new Map<string, string>();
  let sequence = 0;
  const substituted = markdown.replace(FINCH_FILE_IMAGE_RE, (originalUrl) => {
    // The random-ish digest plus monotonically increasing suffix makes a
    // collision within one render practically impossible, including when
    // the same source URL is deliberately pasted more than once.
    const placeholder = `${FINCH_IMAGE_PLACEHOLDER_ORIGIN}${createHash('sha256')
      .update(`${originalUrl}:${sequence++}`).digest('hex')}`;
    urls.set(placeholder, originalUrl);
    return placeholder;
  });
  return { markdown: substituted, urls };
}

// bmmd's `render` also accepts `--mermaid-theme`, but it is an entirely
// separate option from `--markdown-style` and defaults to bmmd's own
// generic "default" mermaid palette if left unset — so a Mermaid diagram in,
// say, the dark `terminal` layout style rendered with plain light/default
// node colors that didn't match the surrounding article at all. Map each
// built-in markdown style to whichever bundled mermaid theme reads closest
// in tone, so diagrams always look like part of the same article.
const MERMAID_THEME_BY_STYLE: Record<string, string> = {
  kami: 'solarized-light',
  bauhaus: 'github-light',
  blueprint: 'nord',
  botanical: 'catppuccin-latte',
  newsprint: 'github-light',
  retro: 'solarized-dark',
  sketch: 'github-light',
  terminal: 'one-dark',
};

// bmmd's own bundled mermaid renderer colors every node/text/arrow via
// `var(--fg)`, `var(--_node-fill)`, etc. (see the `<style>` block it emits
// inside each `figure.figure-mermaid > svg`), but the `render` CLI command
// never actually defines the base `--bg`/`--fg`/`--line`/`--accent`/`--muted`
// custom properties anywhere in its output — verified against 0.3.1, 0.3.2
// and 0.3.4, with and without `--mermaid-theme`, on both `wechat` and `html`
// platforms. Every color var is therefore unresolved and falls back to the
// browser default (`fill: black`), so diagrams render as solid black shapes
// with invisible black-on-black text — this is what the user is actually
// seeing, not a missing/wrong theme choice. This is an upstream gap we can't
// patch inside the bundled LGPL binary itself, so work around it here: values
// below are copied verbatim from bmmd's own internal theme table (dist-*.mjs)
// so the injected colors stay pixel-identical to what bmmd intends. Update
// this table if a future bmmd bump changes those hex values.
interface MermaidThemeColors { bg: string; fg: string; line?: string; accent?: string; muted?: string; }
const MERMAID_THEME_COLORS: Record<string, MermaidThemeColors> = {
  'zinc-dark': { bg: '#18181B', fg: '#FAFAFA' },
  'tokyo-night': { bg: '#1a1b26', fg: '#a9b1d6', line: '#3d59a1', accent: '#7aa2f7', muted: '#565f89' },
  'tokyo-night-storm': { bg: '#24283b', fg: '#a9b1d6', line: '#3d59a1', accent: '#7aa2f7', muted: '#565f89' },
  'tokyo-night-light': { bg: '#d5d6db', fg: '#343b58', line: '#34548a', accent: '#34548a', muted: '#9699a3' },
  'catppuccin-mocha': { bg: '#1e1e2e', fg: '#cdd6f4', line: '#585b70', accent: '#cba6f7', muted: '#6c7086' },
  'catppuccin-latte': { bg: '#eff1f5', fg: '#4c4f69', line: '#9ca0b0', accent: '#8839ef', muted: '#9ca0b0' },
  nord: { bg: '#2e3440', fg: '#d8dee9', line: '#4c566a', accent: '#88c0d0', muted: '#616e88' },
  'nord-light': { bg: '#eceff4', fg: '#2e3440', line: '#aab1c0', accent: '#5e81ac', muted: '#7b88a1' },
  dracula: { bg: '#282a36', fg: '#f8f8f2', line: '#6272a4', accent: '#bd93f9', muted: '#6272a4' },
  'github-light': { bg: '#ffffff', fg: '#1f2328', line: '#d1d9e0', accent: '#0969da', muted: '#59636e' },
  'github-dark': { bg: '#0d1117', fg: '#e6edf3', line: '#3d444d', accent: '#4493f8', muted: '#9198a1' },
  'solarized-light': { bg: '#fdf6e3', fg: '#657b83', line: '#93a1a1', accent: '#268bd2', muted: '#93a1a1' },
  'solarized-dark': { bg: '#002b36', fg: '#839496', line: '#586e75', accent: '#268bd2', muted: '#586e75' },
  'one-dark': { bg: '#282c34', fg: '#abb2bf', line: '#4b5263', accent: '#c678dd', muted: '#5c6370' },
};

const MERMAID_FIGURE_SVG_STYLE_RE = /(<figure class="figure-mermaid"[^>]*>\s*<svg\b[^>]*?\sstyle=")/g;

function applyMermaidThemeVars(html: string, themeId: string): string {
  const colors = MERMAID_THEME_COLORS[themeId];
  if (!colors) return html;
  const vars = [`--bg:${colors.bg};`, `--fg:${colors.fg};`,
    colors.line ? `--line:${colors.line};` : '', colors.accent ? `--accent:${colors.accent};` : '',
    colors.muted ? `--muted:${colors.muted};` : ''].filter(Boolean).join('');
  return html.replace(MERMAID_FIGURE_SVG_STYLE_RE, (_match, prefix: string) => `${prefix}${vars}`);
}

// bm.md inlines the article's own padding on the root <section id="bm-md">
// (e.g. `padding: 28px 24px` for kami, `1.5em 1em` for terminal). That inline
// style travels with the copied HTML, so pasting into the WeChat editor gave
// an inset article instead of a full-bleed one. Zero it on the root only —
// inner blocks (table cells, code blocks, blockquotes) keep their own padding
// — and let the preview pane supply the visual inset as the article's parent
// instead; see the iframe <style> in panel.ts.
const ROOT_SECTION_STYLE_RE = /(<section\b[^>]*\bid="bm-md"[^>]*\bstyle=")([^"]*)(")/;

function stripRootArticlePadding(html: string): string {
  return html.replace(ROOT_SECTION_STYLE_RE, (match: string, prefix: string, style: string, suffix: string) => {
    // Only `padding:` itself — `padding-top` and friends must stay untouched.
    const stripped = style.replace(/(^|;)\s*padding\s*:[^;]*/i, '$1 padding: 0');
    return stripped === style ? match : prefix + stripped + suffix;
  });
}

export async function renderWithBm(markdown: string, markdownStyle: string, customCss: string | undefined): Promise<string> {
  const style = markdownStyle || 'kami';
  // `--breaks` (bmmd 0.3.4+) is the whole line-break story, matching bmmd's own
  // demo: a single newline inside a paragraph becomes a <br/>, while a blank
  // line still starts a new <p>. Fenced code is untouched either way.
  const args = ['render', '--platform', 'wechat', '--markdown-style', style, '--breaks'];
  const mermaidTheme = MERMAID_THEME_BY_STYLE[style];
  if (mermaidTheme) args.push('--mermaid-theme', mermaidTheme);
  if (customCss && customCss.trim()) args.push('--custom-css', customCss);
  const sized = prepareObsidianImageWidths(markdown);
  const prepared = substituteFinchFileImagesForBm(sized.markdown);
  let html = await runBmmd(args, prepared.markdown);
  if (mermaidTheme) html = applyMermaidThemeVars(html, mermaidTheme);
  html = applyObsidianImageWidths(html, sized.markers);
  for (const [placeholder, originalUrl] of prepared.urls) html = html.split(placeholder).join(originalUrl);
  return stripRootArticlePadding(html);
}

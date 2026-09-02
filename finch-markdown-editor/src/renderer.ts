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

export async function renderWithBm(markdown: string, markdownStyle: string, customCss: string | undefined): Promise<string> {
  const args = ['render', '--platform', 'wechat', '--markdown-style', markdownStyle || 'kami'];
  if (customCss && customCss.trim()) args.push('--custom-css', customCss);
  const sized = prepareObsidianImageWidths(markdown);
  const prepared = substituteFinchFileImagesForBm(sized.markdown);
  let html = await runBmmd(args, prepared.markdown);
  html = applyObsidianImageWidths(html, sized.markers);
  for (const [placeholder, originalUrl] of prepared.urls) html = html.split(placeholder).join(originalUrl);
  return html;
}

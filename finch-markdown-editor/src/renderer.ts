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
  const prepared = substituteFinchFileImagesForBm(markdown);
  let html = await runBmmd(args, prepared.markdown);
  for (const [placeholder, originalUrl] of prepared.urls) html = html.split(placeholder).join(originalUrl);
  return html;
}

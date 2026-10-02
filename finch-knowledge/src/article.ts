/**
 * Turns a web page into Markdown for the library.
 *
 * Extraction is deliberately local and heuristic: no page content leaves the
 * machine, and the heuristics are tuned for article-shaped pages. When a page is
 * JavaScript-rendered, behind a login, or bot-blocked, the result is flagged as
 * suspect rather than silently indexed, so a caller can decide to clean it up
 * with a model instead.
 */

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_BYTES = 8 * 1024 * 1024;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) FinchKnowledge/1.0 Safari/537.36';

export interface ArticleDraft {
  url: string;
  title: string;
  markdown: string;
  /** Characters of extracted text — the practical size signal. */
  length: number;
  /** Set when the page looks like a shell rather than an article. */
  suspect: boolean;
  reason?: string;
}

export interface ArticleFetchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Thrown when the machine itself could not reach the host (DNS, proxy, TLS, timeout). */
export class ArticleUnreachableError extends Error {
  constructor(readonly url: string, readonly reason: string) {
    super(`Could not reach ${url}${reason ? `: ${reason}` : ''}.`);
    this.name = 'ArticleUnreachableError';
  }
}

/** Rejects anything that is not a plain http(s) URL we are willing to fetch. */
export function normalizeUrl(value: string): string {
  const raw = (value ?? '').trim();
  if (!raw) throw new Error('Enter a URL.');
  // Check the scheme before defaulting one, so "file://…" is refused rather than
  // silently reinterpreted as a host name under https.
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw)?.[1];
  if (scheme && !/^https?$/i.test(scheme)) throw new Error('Only http and https URLs are supported.');
  let url: URL;
  try { url = new URL(scheme ? raw : `https://${raw}`); } catch { throw new Error(`Not a valid URL: ${raw}`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https URLs are supported.');
  if (!url.hostname || !url.hostname.includes('.')) throw new Error(`Not a valid URL: ${raw}`);
  url.hash = '';
  return url.toString();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

const DROP_PAIRED =
  /<(script|style|noscript|template|svg|iframe|form|fieldset|nav|header|footer|aside|button|select|canvas|video|audio|picture|source)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const DROP_SELF = /<(script|style|link|meta|base|input|embed|object|source|track)\b[^>]*\/?>/gi;

/**
 * Removes containers whose class/id marks them as page chrome. Run a few times
 * because HTML nests, and a regex cannot match balanced nesting in one pass.
 */
const CHROME =
  /<(div|section|aside|ul|ol|nav|form|table|span)\b[^>]*(class|id)\s*=\s*(?:"[^"]*(?:nav|menu|sidebar|side-bar|breadcrumb|comment|share|social|related|recommend|footer|header|banner|promo|subscribe|cookie|advert|\bads?\b|widget|byline|copyright|pagination|toolbar|popup|modal|newsletter)[^"]*"|'[^']*(?:nav|menu|sidebar|side-bar|breadcrumb|comment|share|social|related|recommend|footer|header|banner|promo|subscribe|cookie|advert|\bads?\b|widget|byline|copyright|pagination|toolbar|popup|modal|newsletter)[^']*')[^>]*>[\s\S]*?<\/\1\s*>/gi;

function stripChrome(html: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, '');
  for (let pass = 0; pass < 3; pass++) {
    const before = out.length;
    out = out.replace(DROP_PAIRED, ' ').replace(CHROME, ' ');
    if (out.length === before) break;
  }
  return out.replace(DROP_SELF, ' ');
}

function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function absolute(href: string, base: string): string {
  try { return new URL(href, base).toString(); } catch { return href; }
}

function metaContent(html: string, property: string): string | undefined {
  const pattern = new RegExp(
    `<meta[^>]+(?:property|name)\\s*=\\s*["']${property}["'][^>]*content\\s*=\\s*["']([^"']*)["']`,
    'i',
  );
  const reversed = new RegExp(
    `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*(?:property|name)\\s*=\\s*["']${property}["']`,
    'i',
  );
  return pattern.exec(html)?.[1] ?? reversed.exec(html)?.[1];
}

function pickTitle(html: string): string {
  const candidate = metaContent(html, 'og:title') ?? metaContent(html, 'twitter:title');
  if (candidate) return decodeEntities(candidate).trim();
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html)?.[1];
  if (h1) {
    const text = textOf(h1);
    if (text) return text;
  }
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1];
  if (title) return textOf(title).replace(/\s*[|·—–-]\s*[^|·—–-]{0,40}$/, '').trim() || textOf(title);
  return '';
}

/** Prefers a real article container; falls back to <body> only when none is substantial. */
function pickRoot(html: string): { html: string; container: 'article' | 'main' | 'body' } {
  const candidates: Array<{ html: string; length: number; container: 'article' | 'main' }> = [];
  for (const tag of ['article', 'main'] as const) {
    const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi');
    for (const match of html.matchAll(pattern)) {
      const body = match[1] ?? '';
      candidates.push({ html: body, length: textOf(body).length, container: tag });
    }
    // An <article> wins as soon as one holds real content; only then is <main> considered.
    const substantial = candidates.filter((item) => item.length >= 400).sort((a, b) => b.length - a.length);
    if (substantial.length) return { html: substantial[0]!.html, container: substantial[0]!.container };
  }
  const body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html)?.[1];
  if (body) return { html: body, container: 'body' };
  const longest = candidates.sort((a, b) => b.length - a.length)[0];
  return longest ? { html: longest.html, container: longest.container } : { html, container: 'body' };
}

function inline(value: string, base: string): string {
  let out = value;
  out = out.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
    if (!src || /^data:/i.test(src)) return '';
    return `![${decodeEntities(alt).trim()}](${absolute(decodeEntities(src), base)})`;
  });
  out = out.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_, href: string, label: string) => {
    const text = textOf(label);
    if (!text) return '';
    const target = absolute(decodeEntities(href), base);
    return target.startsWith('http') ? `[${text}](${target})` : text;
  });
  out = out.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_, _tag: string, inner: string) => `**${textOf(inner)}**`);
  out = out.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_, _tag: string, inner: string) => `*${textOf(inner)}*`);
  out = out.replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_, inner: string) => `\`${decodeEntities(inner.replace(/<[^>]*>/g, '')).trim()}\``);
  out = out.replace(/<[^>]*>/g, '');
  return decodeEntities(out).replace(/\s+/g, ' ').trim();
}

/** Paragraph boundary marker. A control character so it can never occur in page text. */
const BREAK = '\u0001';
/** Placeholder for already-converted block content, protected from inline()'s whitespace collapse. */
const HOLD = '\u0000';

function toMarkdown(html: string, base: string): string {
  const held: string[] = [];
  // Holds are wrapped in breaks so two adjacent blocks never end up on one line.
  const hold = (markdown: string): string => {
    held.push(markdown);
    return `${BREAK}${HOLD}${held.length - 1}${HOLD}${BREAK}`;
  };

  let out = html;
  out = out.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_, inner: string) => {
    const text = decodeEntities(inner.replace(/<[^>]*>/g, '')).replace(/^\n+|\n+$/g, '');
    return text ? hold(`\`\`\`\n${text}\n\`\`\``) : '';
  });
  out = out.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, level: string, inner: string) => {
    const text = inline(inner, base);
    return text ? hold(`${'#'.repeat(Number(level))} ${text}`) : '';
  });
  // Lists are consumed as a unit so their items stay one block instead of separate paragraphs.
  out = out.replace(/<(ul|ol)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_, _tag: string, inner: string) => {
    const items: string[] = [];
    for (const match of inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)) {
      const item = inline(match[1] ?? '', base);
      if (item) items.push(`- ${item}`);
    }
    return items.length ? hold(items.join('\n')) : '';
  });
  out = out.replace(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi, (_, inner: string) => {
    const text = inline(inner, base);
    return text ? hold(`- ${text}`) : '';
  });
  out = out.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote\s*>/gi, (_, inner: string) => {
    const text = inline(inner, base);
    return text ? hold(text.split('\n').map((line) => `> ${line}`).join('\n')) : '';
  });
  out = out.replace(/<hr\b[^>]*\/?>/gi, () => hold('---'));
  // Every remaining block boundary becomes a paragraph break; <br> is treated the same way.
  out = out.replace(/<br\b[^>]*\/?>/gi, BREAK);
  out = out.replace(
    /<\/?(?:p|div|section|article|main|figure|figcaption|table|thead|tbody|tfoot|tr|td|th|dd|dt|dl)\b[^>]*>/gi,
    BREAK,
  );

  const text = out
    .split(BREAK)
    .map((piece) => inline(piece, base))
    .filter(Boolean)
    .join('\n\n');
  return text.replace(new RegExp(`${HOLD}(\\d+)${HOLD}`, 'g'), (_, index: string) => held[Number(index)] ?? '');
}

function tidy(markdown: string): string {
  // Fenced code keeps its own whitespace; only the prose around it is normalised.
  return markdown
    .split(/(```[\s\S]*?```)/)
    .map((part, index) => (index % 2 === 1
      ? part
      : part
        .split('\n')
        .map((line) => line.replace(/[ \t]+/g, ' ').trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Pure extraction step, so it can be tested without touching the network. */
export function extractArticle(html: string, url: string): Omit<ArticleDraft, 'url'> {
  const title = pickTitle(html);
  const { html: root, container } = pickRoot(stripChrome(html));
  const markdown = tidy(toMarkdown(root, url));
  const length = markdown.replace(/[#>*`\-[\]()!]/g, '').replace(/\s+/g, '').length;

  const lowered = html.toLowerCase();
  let reason: string | undefined;
  if (/enable javascript|javascript is (?:required|disabled)|please enable js/i.test(html)) {
    reason = 'The page says it needs JavaScript, so only a shell could be read.';
  } else if (length < 400) {
    reason = 'Very little text was found — this may be a list page, a login wall, or a client-rendered page.';
  } else if (container === 'body' && length < 1200) {
    reason = 'No article container was found, so page chrome may be mixed in.';
  }
  return { title, markdown, length, suspect: Boolean(reason), ...(reason ? { reason } : {}) };
}

/** Fetches a page and extracts it. Errors are thrown with a user-facing message. */
export async function fetchArticle(value: string, options: ArticleFetchOptions = {}): Promise<ArticleDraft> {
  const url = normalizeUrl(value);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timeout.unref?.();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
    });
    if (!response.ok) {
      throw new Error(`The page answered ${response.status}${response.status === 403 ? ' (it may block automated readers)' : ''}.`);
    }
    const type = response.headers.get('content-type') ?? '';
    if (!/text\/html|application\/xhtml|text\/plain/i.test(type)) {
      throw new Error(`That link is ${type.split(';')[0] || 'not a web page'}, not an article.`);
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_BYTES) throw new Error('That page is too large to fetch.');
    const html = (await response.text()).slice(0, MAX_BYTES);
    if (!html.trim()) throw new Error('The page returned no content.');
    return { url, ...extractArticle(html, url) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (controller.signal.aborted && !options.signal?.aborted) throw new Error('The page took too long to respond.');
    // Undici reports connection problems as a bare "fetch failed"; the reason lives in `cause`.
    const cause = (error as { cause?: unknown }).cause;
    const detail = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
    if (/fetch failed|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|certificate/i.test(message)) {
      throw new ArticleUnreachableError(url, detail || message);
    }
    throw new Error(message);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

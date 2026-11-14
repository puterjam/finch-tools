import { signRequest } from './sign';
import { ApiError, ParamError } from './errors';
import type { ResolvedCredentials } from './credentials';

/**
 * Tencent Yuanbao Search (`wsa`), action `SearchPro`.
 *
 * Verified against the live endpoint on 2026-11-14:
 *   endpoint  wsa.tencentcloudapi.com
 *   version   2025-05-08
 *   region    must be omitted — every named region returns UnsupportedRegion
 *   Pages     a list of JSON *strings*, each one a result object
 *
 * This module is transport + parsing only. It throws structured, prose-free
 * errors (`ApiError` / `ParamError`) and returns structured notes, so all
 * wording can live in `i18n/`.
 */

export const WSA_ENDPOINT = 'wsa.tencentcloudapi.com';
export const WSA_SERVICE = 'wsa';
export const WSA_ACTION = 'SearchPro';
export const WSA_VERSION = '2025-05-08';

/** The only values the server accepts for `Cnt`. Anything else → `illegal Cnt`. */
export const ALLOWED_COUNTS = [10, 20, 30, 40, 50] as const;
export const ALLOWED_MODES = [0, 1, 2] as const;
export const ALLOWED_INDUSTRIES = ['gov', 'news', 'acad', 'finance'] as const;

/** An input that had to be adjusted before sending. Rendered through i18n. */
export interface Note {
  key: 'countRounded' | 'countInvalid' | 'modeIgnored' | 'industryIgnored' | 'siteSingle' | 'siteTruncated' | 'pagesDropped';
  params?: Record<string, string | number>;
}

/** One search result after a `Pages[]` entry has been parsed. */
export interface SearchResultPage {
  title: string;
  url: string;
  /** Standard snippet. */
  passage: string;
  /** Longer dynamic summary. Not returned by the lite tier. */
  content?: string;
  /** Site name; empty for obscure sites. */
  site: string;
  /** Publish time as returned, e.g. `2026-10-20 15:28:00`. */
  date: string;
  /** Relevance 0..1. */
  score?: number;
  /** Authority 0..5. Flagship tier only. */
  authorityLevel?: number;
  favicon?: string;
  pics?: Array<{ caption?: string; origin_url?: string }>;
  deeplinks?: Array<{ title?: string; url?: string }>;
  /** The parsed object verbatim, so a future server field is never dropped. */
  raw: Record<string, unknown>;
}

export interface SearchProInput {
  query: string;
  /** Result count. Rounded up to the nearest allowed value. */
  count?: number;
  /** `d[N]` / `m[N]` / `y[N]` / `yyyy-mm-dd` / `yyyy-mm-dd,yyyy-mm-dd`. */
  freshness?: string;
  /** 0 natural results, 1 vertical (VR) cards, 2 mixed. */
  mode?: number;
  /** Vertical domain: gov / news / acad / finance. */
  industry?: string;
  /** `example.com` to restrict, or `exclude:a.com|b.com` to filter out. */
  site?: string;
  /** Sub-link info. Flagship tier only. */
  deeplinks?: boolean;
}

/** Body actually sent to the API. */
export interface SearchProRequestBody {
  Query: string;
  Cnt?: number;
  Freshness?: string;
  Mode?: number;
  Industry?: string;
  Site?: string;
  Deeplinks?: boolean;
}

export interface SearchProResult {
  query: string;
  /** lite / standard / flagship — whatever the account is entitled to. */
  version?: string;
  /** Server-side notice, e.g. `hit black query`. */
  msg?: string;
  requestId: string;
  pages: SearchResultPage[];
  notes: Note[];
  /** The untouched JSON body, for callers that want to keep it. */
  rawJson: string;
}

const FRESHNESS_COMPACT = /^([dmy])(\d{1,2})$/;
const FRESHNESS_DAY = /^\d{4}-\d{2}-\d{2}$/;

function freshDay(value: string): boolean {
  return FRESHNESS_DAY.test(value);
}

/**
 * Normalise user input into an API body, collecting notes for anything adjusted.
 *
 * Better to tell the caller "count 15 became 20" than to send a request the
 * server rejects with a bare `illegal Cnt`. Values with no sane rounding (a
 * malformed freshness) are raised instead of guessed at.
 */
export function normalizeInput(input: SearchProInput): { body: SearchProRequestBody; notes: Note[] } {
  const notes: Note[] = [];
  const body: SearchProRequestBody = { Query: input.query };

  if (input.count !== undefined && input.count !== null) {
    const wanted = Math.trunc(Number(input.count));
    if (!Number.isFinite(wanted) || wanted <= 0) {
      notes.push({ key: 'countInvalid', params: { value: String(input.count) } });
    } else if (!(ALLOWED_COUNTS as readonly number[]).includes(wanted)) {
      const next = ALLOWED_COUNTS.find((c) => c >= wanted) ?? ALLOWED_COUNTS[ALLOWED_COUNTS.length - 1];
      notes.push({ key: 'countRounded', params: { from: wanted, to: next, allowed: ALLOWED_COUNTS.join('/') } });
      body.Cnt = next;
    } else {
      body.Cnt = wanted;
    }
  }

  if (input.freshness !== undefined && input.freshness !== '') {
    const freshness = String(input.freshness).trim();
    const compact = FRESHNESS_COMPACT.exec(freshness);
    if (compact) {
      const n = Number(compact[2]);
      const max = compact[1] === 'd' ? 30 : compact[1] === 'm' ? 12 : 5;
      if (n < 1 || n > max) {
        throw new ParamError('freshness', { value: freshness });
      }
      body.Freshness = freshness;
    } else if (freshDay(freshness) || freshness.split(',').length === 2 && freshness.split(',').every(freshDay)) {
      body.Freshness = freshness;
    } else {
      throw new ParamError('freshness', { value: freshness });
    }
  }

  if (input.mode !== undefined && input.mode !== null) {
    const mode = Math.trunc(Number(input.mode));
    if ((ALLOWED_MODES as readonly number[]).includes(mode)) {
      body.Mode = mode;
    } else {
      notes.push({ key: 'modeIgnored', params: { value: String(input.mode) } });
    }
  }

  if (input.industry !== undefined && input.industry !== '') {
    const industry = String(input.industry).trim().toLowerCase();
    if ((ALLOWED_INDUSTRIES as readonly string[]).includes(industry)) {
      body.Industry = industry;
    } else {
      notes.push({ key: 'industryIgnored', params: { value: String(input.industry), allowed: ALLOWED_INDUSTRIES.join('/') } });
    }
  }

  if (input.site !== undefined && input.site !== '') {
    const site = String(input.site).trim();
    const domains = site.replace(/^exclude:/i, '').split('|').filter(Boolean);
    if (!site.startsWith('exclude:') && domains.length > 1) {
      notes.push({ key: 'siteSingle', params: { value: domains[0] ?? '' } });
      body.Site = domains[0];
    } else if (domains.length > 5) {
      notes.push({ key: 'siteTruncated' });
      body.Site = `exclude:${domains.slice(0, 5).join('|')}`;
    } else {
      body.Site = site;
    }
  }

  if (input.deeplinks !== undefined) body.Deeplinks = Boolean(input.deeplinks);

  return { body, notes };
}

/**
 * `Pages` is documented as a list of JSON strings, but a defensive read costs
 * nothing: an object element would otherwise disappear without any error.
 */
function parsePage(entry: unknown): SearchResultPage | null {
  let obj: unknown = entry;
  if (typeof entry === 'string') {
    try {
      obj = JSON.parse(entry);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
  return {
    title: str(rec.title),
    url: str(rec.url),
    passage: str(rec.passage),
    content: typeof rec.content === 'string' && rec.content ? rec.content : undefined,
    site: str(rec.site),
    date: str(rec.date),
    score: typeof rec.score === 'number' ? rec.score : undefined,
    authorityLevel: typeof rec.authority_level === 'number' ? rec.authority_level : undefined,
    favicon: typeof rec.favicon === 'string' && rec.favicon ? rec.favicon : undefined,
    pics: Array.isArray(rec.pics) ? (rec.pics as Array<{ caption?: string; origin_url?: string }>) : undefined,
    deeplinks: Array.isArray(rec.deeplinks) ? (rec.deeplinks as Array<{ title?: string; url?: string }>) : undefined,
    raw: rec,
  };
}

export interface SearchProOptions {
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  now?: () => number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Call SearchPro.
 *
 * Throws `ApiError` for an API-level error (including a non-2xx transport
 * status), `ParamError` for bad input, and lets raw transport errors bubble up.
 * `errors.ts` turns all three into localized text.
 */
export async function searchPro(
  creds: ResolvedCredentials,
  input: SearchProInput,
  options: SearchProOptions = {},
): Promise<SearchProResult> {
  const { body, notes } = normalizeInput(input);
  const payload = JSON.stringify(body);
  const doFetch = options.fetchImpl ?? fetch;
  const timestamp = Math.floor((options.now ? options.now() : Date.now()) / 1000);

  const { headers } = signRequest({
    secretId: creds.secretId,
    secretKey: creds.secretKey,
    token: creds.token,
    service: WSA_SERVICE,
    action: WSA_ACTION,
    version: WSA_VERSION,
    endpoint: WSA_ENDPOINT,
    payload,
    timestamp,
  });

  // No X-TC-Region on purpose. `wsa` is served from a global endpoint and every
  // named region (ap-guangzhou / ap-beijing / ap-shanghai / ap-singapore / …)
  // comes back as UnsupportedRegion. tccli always sends one, which is exactly
  // why a `tccli wsa SearchPro` probe of this product can never succeed.
  const timeoutSignal = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
  const signal = options.signal && timeoutSignal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : (options.signal ?? timeoutSignal);

  const response = await doFetch(`https://${WSA_ENDPOINT}/`, {
    method: 'POST',
    headers,
    body: payload,
    ...(signal ? { signal } : {}),
  });
  const text = await response.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError({
      code: 'BadResponse',
      serverMessage: text.slice(0, 300),
      httpStatus: response.status,
    });
  }

  const res = ((parsed as Record<string, unknown>)?.Response ?? parsed) as Record<string, unknown>;
  const requestId = typeof res.RequestId === 'string' ? res.RequestId : '';
  const apiError = res.Error as { Code?: string; Message?: string } | undefined;

  if (apiError?.Code || !response.ok) {
    throw new ApiError({
      code: apiError?.Code ?? `HTTP_${response.status}`,
      serverMessage: apiError?.Message ?? response.statusText,
      httpStatus: response.status,
      requestId,
    });
  }

  const rawPages = Array.isArray(res.Pages) ? (res.Pages as unknown[]) : [];
  const pages = rawPages.map(parsePage).filter((p): p is SearchResultPage => p !== null);
  if (rawPages.length > pages.length) {
    notes.push({ key: 'pagesDropped', params: { count: rawPages.length - pages.length } });
  }

  return {
    query: typeof res.Query === 'string' ? res.Query : input.query,
    version: typeof res.Version === 'string' ? res.Version : undefined,
    msg: typeof res.Msg === 'string' && res.Msg ? res.Msg : undefined,
    requestId,
    pages,
    notes,
    rawJson: text,
  };
}

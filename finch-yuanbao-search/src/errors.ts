/**
 * Error classification and presentation.
 *
 * `client.ts` only ever throws structured, prose-free errors. This module is the
 * single place that turns a code into a sentence, so every message can be
 * localized through `i18n/<locale>.json` instead of being baked into the logic.
 */

/** `ctx.i18n.t` shape — passed in so this module stays framework-free. */
export type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Raised by input validation. Carries the offending value, never prose. */
export class ParamError extends Error {
  readonly key: 'count' | 'freshness' | 'query';
  readonly params: Record<string, string | number>;

  constructor(key: ParamError['key'], params: Record<string, string | number> = {}) {
    super(`${key}: ${JSON.stringify(params)}`);
    this.name = 'ParamError';
    this.key = key;
    this.params = params;
  }
}

/** A Tencent Cloud API error, exactly as the server reported it. */
export class ApiError extends Error {
  readonly code: string;
  readonly serverMessage: string;
  readonly httpStatus: number;
  readonly requestId: string;

  constructor(fields: { code: string; serverMessage?: string; httpStatus?: number; requestId?: string }) {
    super(`${fields.code}: ${fields.serverMessage ?? ''}`);
    this.name = 'ApiError';
    this.code = fields.code;
    this.serverMessage = fields.serverMessage ?? '';
    this.httpStatus = fields.httpStatus ?? 200;
    this.requestId = fields.requestId ?? '';
  }
}

/** A localized, actionable failure ready to be shown to the user. */
export interface ExplainedError {
  code: string;
  title: string;
  hint: string;
  httpStatus?: number;
  requestId?: string;
  detail?: string;
}

const RATE_LIMIT_CODES = [
  'RequestLimitExceeded',
  'LimitExceeded',
  'InternalError.FlowLimitExceeded',
  'TooManyRequests',
];

/**
 * "Not entitled to this product". `UnsupportedRegion` belongs here for `wsa`:
 * the service is served from a global endpoint and rejects every named region,
 * so if we still get it after sending no region header, the product really is
 * not enabled on the account.
 */
const NOT_ACTIVATED_CODES = [
  'UnsupportedRegion',
  'ResourceUnavailable.Unactivated',
  'ResourceUnavailable.UnpaidService',
  'FailedOperation.OutOfBalance',
  'FailedOperation.ServiceNotActivated',
  'UnauthorizedOperation.NotActivated',
];

function matches(code: string, list: string[]): boolean {
  return list.some((entry) => code === entry || code.startsWith(`${entry}.`));
}

/** Turn a Tencent Cloud API error code into a title + actionable hint. */
export function explainApiError(
  t: Translate,
  error: ApiError,
): ExplainedError {
  const { code, serverMessage, httpStatus, requestId } = error;
  const base = { code, httpStatus, requestId, detail: serverMessage || undefined };

  if (matches(code, RATE_LIMIT_CODES)) {
    return { ...base, title: t('err.rateLimit.title'), hint: t('err.rateLimit.hint') };
  }
  if (matches(code, NOT_ACTIVATED_CODES)) {
    return { ...base, title: t('err.notActivated.title'), hint: t('err.notActivated.hint') };
  }
  if (code === 'UnauthorizedOperation' || code.startsWith('UnauthorizedOperation.')) {
    return { ...base, title: t('err.unauthorized.title'), hint: t('err.unauthorized.hint') };
  }
  if (code.startsWith('AuthFailure')) {
    const key = code.includes('Signature')
      ? 'err.auth.signature'
      : code.includes('SecretId')
        ? 'err.auth.secretId'
        : 'err.auth.generic';
    return { ...base, title: t(`${key}.title`), hint: t(`${key}.hint`) };
  }
  if (code === 'BadResponse') {
    return { ...base, title: t('err.badResponse.title'), hint: t('err.badResponse.hint') };
  }
  if (code === 'MissingParameter' || code.startsWith('InvalidParameter')) {
    return { ...base, title: t('err.invalidParam.title'), hint: t('err.invalidParam.hint') };
  }
  if (code === 'InvalidAction' || code === 'InvalidVersion' || code === 'UnsupportedOperation') {
    return { ...base, title: t('err.invalidAction.title'), hint: t('err.invalidAction.hint') };
  }
  if (code.startsWith('FailedOperation')) {
    return { ...base, title: t('err.failedOp.title'), hint: t('err.failedOp.hint') };
  }
  if (code.startsWith('InternalError') || httpStatus >= 500) {
    return { ...base, title: t('err.internal.title'), hint: t('err.internal.hint') };
  }
  return {
    ...base,
    title: t('err.generic.title', { code: code || 'UnknownError' }),
    hint: t('err.generic.hint'),
  };
}

/** Map a local validation error to a title + hint. */
export function explainParamError(t: Translate, error: ParamError): ExplainedError {
  if (error.key === 'count') {
    return {
      code: 'InvalidParameter',
      title: t('err.invalidParam.title'),
      hint: t('err.param.count', { value: String(error.params.value ?? '') }),
    };
  }
  if (error.key === 'freshness') {
    return {
      code: 'InvalidParameter',
      title: t('err.invalidParam.title'),
      hint: t('err.param.freshness', { value: String(error.params.value ?? '') }),
    };
  }
  return {
    code: 'MissingParameter',
    title: t('err.invalidParam.title'),
    hint: t('err.param.query'),
  };
}

/**
 * Map a transport-level failure (fetch threw, or the body was not JSON).
 * Node surfaces most network problems as `Error` with a `code`, so branch on
 * that rather than on the message text.
 */
export function explainLocalError(t: Translate, error: unknown): ExplainedError {
  const err = error as (Error & { code?: string; name?: string }) | undefined;
  const code = err?.code ?? err?.name ?? 'UnknownError';
  const detail = err?.message ?? String(error);

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { code, title: t('err.net.dns.title'), hint: t('err.net.dns.hint'), detail };
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT') {
    return { code, title: t('err.net.connect.title'), hint: t('err.net.connect.hint'), detail };
  }
  if (code.includes('CERT') || code.includes('SELF_SIGNED') || code.includes('UNABLE_TO_VERIFY')) {
    return { code, title: t('err.net.tls.title'), hint: t('err.net.tls.hint'), detail };
  }
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || code === 'ABORT_ERR') {
    return { code: 'Timeout', title: t('err.net.timeout.title'), hint: t('err.net.timeout.hint'), detail };
  }
  return { code, title: t('err.net.generic.title'), hint: t('err.net.generic.hint'), detail };
}

/** Nothing configured locally — the usual first-run state. */
export function explainMissingCredentials(t: Translate): ExplainedError {
  return { code: 'NoCredentials', title: t('err.noCreds.title'), hint: t('err.noCreds.hint') };
}

/** Render an explained error as the text body of a failed tool result. */
export function renderError(t: Translate, error: ExplainedError): string {
  const lines = [
    t('err.blocked', { title: error.title }),
    '',
    t('err.hintLine', { hint: error.hint }),
  ];
  const meta: string[] = [];
  if (error.code) meta.push(t('err.meta.code', { code: error.code }));
  if (error.httpStatus) meta.push(t('err.meta.http', { status: error.httpStatus }));
  if (error.requestId) meta.push(t('err.meta.requestId', { requestId: error.requestId }));
  if (meta.length > 0) lines.push(meta.join(' · '));
  if (error.detail) lines.push(t('err.meta.detail', { detail: error.detail }));
  return lines.join('\n');
}

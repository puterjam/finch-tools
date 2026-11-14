import { createHmac, createHash } from 'node:crypto';

/**
 * Tencent Cloud TC3-HMAC-SHA256 request signing.
 *
 * Implemented from scratch (no SDK dependency — mini tools ship zero runtime
 * dependencies) and verified against the live `wsa` endpoint.
 *
 * Note on `region`: the canonical request only signs `content-type` and `host`,
 * so `X-TC-Region` is a plain routing header. `wsa` rejects every named region
 * with `UnsupportedRegion`, so callers must be able to leave it off entirely —
 * see {@link buildHeaders}.
 */

export const SIGN_ALGORITHM = 'TC3-HMAC-SHA256';
export const CONTENT_TYPE = 'application/json; charset=utf-8';

export interface SignRequestInput {
  secretId: string;
  secretKey: string;
  /** Product code, e.g. `wsa`. Also the third credential-scope segment. */
  service: string;
  action: string;
  version: string;
  endpoint: string;
  /** Exact bytes that will be sent as the request body. */
  payload: string;
  /** Unix seconds. */
  timestamp: number;
  /** Optional session token for temporary credentials. */
  token?: string;
}

function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function hmac(key: Buffer | string, message: string): Buffer {
  return createHmac('sha256', key).update(message, 'utf8').digest();
}

/** `date` is the UTC `YYYY-MM-DD` derived from the same timestamp as the request. */
export function credentialScope(date: string, service: string): string {
  return `${date}/${service}/tc3_request`;
}

export interface SignedRequest {
  headers: Record<string, string>;
  /** Only useful for debugging; never log `authorization` in production paths. */
  signature: string;
  stringToSign: string;
}

export function signRequest(input: SignRequestInput): SignedRequest {
  const date = new Date(input.timestamp * 1000).toISOString().slice(0, 10);
  const scope = credentialScope(date, input.service);

  // Canonical headers must be lowercase, sorted by name, and each terminated
  // with \n. Only these two are signed, which is what lets us add X-TC-*
  // routing headers freely.
  const canonicalHeaders = `content-type:${CONTENT_TYPE}\nhost:${input.endpoint}\n`;
  const signedHeaders = 'content-type;host';

  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256Hex(input.payload),
  ].join('\n');

  const stringToSign = [
    SIGN_ALGORITHM,
    String(input.timestamp),
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const secretDate = hmac(`TC3${input.secretKey}`, date);
  const secretService = hmac(secretDate, input.service);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = createHmac('sha256', secretSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization =
    `${SIGN_ALGORITHM} Credential=${input.secretId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers: Record<string, string> = {
    'Content-Type': CONTENT_TYPE,
    Host: input.endpoint,
    'X-TC-Action': input.action,
    'X-TC-Version': input.version,
    'X-TC-Timestamp': String(input.timestamp),
    Authorization: authorization,
  };
  if (input.token) headers['X-TC-Token'] = input.token;

  return { headers, signature, stringToSign };
}

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type * as finch from 'finch';

/**
 * Credential resolution.
 *
 * Nothing here ever writes a key into `ctx.storage`, a log line, or a tool
 * result. `ctx.storage` is plaintext JSON; keys live in `ctx.secrets` (Keychain
 * on macOS) and are only ever read back to sign one request.
 *
 * Resolution order:
 *   1. `ctx.secrets` — written by the settings dialog, the in-call form, or the
 *      one-off key-file import below.
 *   2. `TENCENTCLOUD_SECRETID` / `TENCENTCLOUD_SECRETKEY` in the environment.
 */

export const SECRET_ID_KEY = 'tencentcloud.secretId';
export const SECRET_KEY_KEY = 'tencentcloud.secretKey';

/** Where a resolved key pair came from — shown to the user, never the value. */
export type CredentialSource = 'secrets' | 'env';

export interface ResolvedCredentials {
  secretId: string;
  secretKey: string;
  /** Only meaningful for temporary credentials from STS. */
  token?: string;
  source: CredentialSource;
}

/**
 * Default location of the bootstrap key file the operator drops on disk.
 * Two `KEY=VALUE` lines (comments allowed), chmod 600.
 */
export const DEFAULT_KEY_FILE = path.join(homedir(), '.finch', 'credentials', 'api-yuanbao.key');

/**
 * Parse an env-style key file. Tolerates `#` comments, blank lines, a leading
 * `export `, quotes, and `export FOO = bar` spacing.
 */
export function parseEnvKeyFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length > 1)
      || (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

/**
 * Read SecretId/SecretKey out of the bootstrap key file. Returns null when the
 * file is absent or incomplete — callers decide whether to surface an error.
 */
export async function readKeyFile(
  filePath: string = DEFAULT_KEY_FILE,
): Promise<{ secretId: string; secretKey: string } | null> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  const env = parseEnvKeyFile(text);
  const secretId = env.TENCENTCLOUD_SECRETID ?? env.SECRETID ?? '';
  const secretKey = env.TENCENTCLOUD_SECRETKEY ?? env.SECRETKEY ?? '';
  if (!secretId || !secretKey) return null;
  return { secretId, secretKey };
}

/**
 * Resolve the key pair, preferring secure storage over the environment.
 * Returns null when nothing usable is configured.
 */
export async function resolveCredentials(ctx: finch.MiniToolContext): Promise<ResolvedCredentials | null> {
  const [secretId, secretKey] = await Promise.all([
    ctx.secrets.get(SECRET_ID_KEY),
    ctx.secrets.get(SECRET_KEY_KEY),
  ]);
  if (secretId && secretKey) {
    return { secretId, secretKey, source: 'secrets' };
  }

  const envId = process.env.TENCENTCLOUD_SECRETID ?? process.env.SECRETID ?? '';
  const envKey = process.env.TENCENTCLOUD_SECRETKEY ?? process.env.SECRETKEY ?? '';
  if (envId && envKey) {
    return {
      secretId: envId,
      secretKey: envKey,
      token: process.env.TENCENTCLOUD_SESSIONTOKEN || undefined,
      source: 'env',
    };
  }

  return null;
}

/**
 * One-time bootstrap: if secure storage is still empty but the operator left a
 * key file on disk, move it into `ctx.secrets` so the tool works without the
 * user having to paste anything. The file itself is left untouched and its
 * contents are never logged.
 */
export async function importKeyFileIfPresent(
  ctx: finch.MiniToolContext,
  filePath: string = DEFAULT_KEY_FILE,
): Promise<'imported' | 'already-configured' | 'no-file'> {
  if (await resolveCredentials(ctx)) return 'already-configured';
  const pair = await readKeyFile(filePath);
  if (!pair) return 'no-file';
  await ctx.secrets.set(SECRET_ID_KEY, pair.secretId);
  await ctx.secrets.set(SECRET_KEY_KEY, pair.secretKey);
  return 'imported';
}

/** `AKIDabcd…wxyz` — safe to show in a menu row or a tool result. */
export function maskSecretId(secretId: string): string {
  if (secretId.length <= 8) return '••••';
  return `${secretId.slice(0, 4)}…${secretId.slice(-4)}`;
}

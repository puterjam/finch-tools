import * as crypto from 'node:crypto';
import type * as finch from 'finch';

/** One paired `finch` CLI client. Only the sha256 of its token is ever persisted. */
export interface PairedClient {
  readonly tokenId: string;
  readonly tokenHash: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly scopes: string[];
  readonly pairedAt: string;
  lastUsedAt: string;
}

const SECRET_KEY = 'cli.tokens';

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Persists paired CLI clients as hashed tokens inside `ctx.secrets` (system
 * secure storage). Raw tokens only ever exist in memory long enough to be
 * handed back to the CLI once, during pairing approval.
 */
export class TokenStore {
  constructor(private readonly secrets: finch.Secrets) {}

  private async load(): Promise<PairedClient[]> {
    const raw = await this.secrets.get(SECRET_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as PairedClient[]) : [];
    } catch {
      return [];
    }
  }

  private async save(list: PairedClient[]): Promise<void> {
    await this.secrets.set(SECRET_KEY, JSON.stringify(list));
  }

  async list(): Promise<PairedClient[]> {
    return this.load();
  }

  async issue(clientId: string, clientName: string, scopes: string[]): Promise<{ token: string; entry: PairedClient }> {
    const token = crypto.randomBytes(32).toString('hex');
    const now = new Date().toISOString();
    const entry: PairedClient = {
      tokenId: crypto.randomUUID(),
      tokenHash: hash(token),
      clientId,
      clientName,
      scopes,
      pairedAt: now,
      lastUsedAt: now,
    };
    const list = await this.load();
    list.push(entry);
    await this.save(list);
    return { token, entry };
  }

  /** Verifies a bearer token and bumps its last-used timestamp. */
  async verify(token: string): Promise<PairedClient | undefined> {
    const tokenHash = hash(token);
    const list = await this.load();
    const found = list.find((c) => c.tokenHash === tokenHash);
    if (!found) return undefined;
    found.lastUsedAt = new Date().toISOString();
    await this.save(list);
    return found;
  }

  async revokeById(tokenId: string): Promise<boolean> {
    const list = await this.load();
    const next = list.filter((c) => c.tokenId !== tokenId);
    if (next.length === list.length) return false;
    await this.save(next);
    return true;
  }

  async revokeByToken(token: string): Promise<boolean> {
    const tokenHash = hash(token);
    const list = await this.load();
    const next = list.filter((c) => c.tokenHash !== tokenHash);
    if (next.length === list.length) return false;
    await this.save(next);
    return true;
  }
}

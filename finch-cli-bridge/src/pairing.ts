import * as crypto from 'node:crypto';
import type * as finch from 'finch';
import { TokenStore } from './auth.js';

export type PairingState = 'pending' | 'approved' | 'denied' | 'expired';

export interface PairingRequest {
  readonly pairingId: string;
  readonly code: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly scopes: string[];
  state: PairingState;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** Raw token, present only between approval and the first status poll that consumes it. */
  token?: string;
  delivered: boolean;
}

const PAIRING_TTL_MS = 2 * 60 * 1000;
const GC_AFTER_MS = 5 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 5;
const WINDOW_MS = 60 * 1000;

/**
 * Runs the "CLI asks, human approves in Finch" device-flow pairing dance.
 * Each approved pairing mints one token via {@link TokenStore} and hands the
 * raw value back exactly once through `status()`.
 */
export class PairingManager {
  private readonly pending = new Map<string, PairingRequest>();
  private requestTimestamps: number[] = [];

  constructor(
    private readonly ctx: finch.MiniToolContext,
    private readonly tokens: TokenStore,
    private readonly onChange: () => void,
  ) {}

  private sweep(): void {
    const now = Date.now();
    for (const [id, req] of this.pending) {
      if (req.state === 'pending' && now > req.expiresAt) {
        req.state = 'expired';
      }
      if (req.state !== 'pending' && now - req.createdAt > GC_AFTER_MS) {
        this.pending.delete(id);
      }
    }
  }

  /** Basic flood protection so a rogue local process can't spam approval modals. */
  isRateLimited(): boolean {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter((t) => now - t < WINDOW_MS);
    if (this.requestTimestamps.length >= MAX_REQUESTS_PER_WINDOW) return true;
    this.requestTimestamps.push(now);
    return false;
  }

  request(clientId: string, clientName: string, scopes: string[]): PairingRequest {
    this.sweep();
    const pairingId = crypto.randomUUID();
    const digits = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const now = Date.now();
    const req: PairingRequest = {
      pairingId,
      code: `${digits.slice(0, 3)}-${digits.slice(3)}`,
      clientId: clientId.slice(0, 200),
      clientName: (clientName || 'unknown terminal').slice(0, 80),
      scopes,
      state: 'pending',
      createdAt: now,
      expiresAt: now + PAIRING_TTL_MS,
      delivered: false,
    };
    this.pending.set(pairingId, req);
    void this.promptUser(req);
    return req;
  }

  /** Returns the current state. Consumes (clears) the raw token on first read after approval. */
  consumeStatus(pairingId: string): PairingRequest | undefined {
    this.sweep();
    const req = this.pending.get(pairingId);
    if (!req) return undefined;
    if (req.state === 'approved' && !req.delivered) {
      req.delivered = true;
      const snapshot = { ...req };
      req.token = undefined; // never hand the raw value out twice
      return snapshot;
    }
    return { ...req, token: undefined };
  }

  private async promptUser(req: PairingRequest): Promise<void> {
    const result = await this.ctx.ui.showModalDialog({
      title: this.ctx.i18n.t('pairing.title'),
      message: this.ctx.i18n.t('pairing.message', { client: req.clientName, code: req.code }),
      actions: [
        { id: 'deny', label: this.ctx.i18n.t('pairing.deny') },
        { id: 'allow', label: this.ctx.i18n.t('pairing.allow'), variant: 'primary' },
      ],
    });

    const current = this.pending.get(req.pairingId);
    if (!current || current.state !== 'pending') return; // expired or GC'd while the dialog was open

    if (result.action === 'allow') {
      const { token } = await this.tokens.issue(current.clientId, current.clientName, current.scopes);
      current.state = 'approved';
      current.token = token;
    } else {
      current.state = 'denied';
    }
    this.onChange();
  }
}

import * as readline from 'node:readline';
import { Readable } from 'node:stream';

export class BridgeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

/** Thin HTTP + SSE client for the CLI Bridge mini tool's loopback protocol. */
export class BridgeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new BridgeError(
        'connection_failed',
        `Could not reach the CLI Bridge at ${this.baseUrl}. Is Finch running with the "CLI Bridge" mini tool enabled?`,
      );
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!res.ok) {
      const envelope = parsed as ErrorEnvelope | undefined;
      throw new BridgeError(envelope?.error?.code ?? 'unknown', envelope?.error?.message ?? `HTTP ${res.status}`, res.status);
    }
    return parsed as T;
  }

  /** Reads a `text/event-stream` endpoint and yields parsed `{event, data}` frames until the connection ends. */
  async *stream(path: string): AsyncGenerator<{ event: string; data: unknown }> {
    const res = await fetch(this.baseUrl + path, { headers: this.headers() });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new BridgeError('stream_failed', text || `HTTP ${res.status}`, res.status);
    }
    const rl = readline.createInterface({ input: Readable.fromWeb(res.body as never) });
    let currentEvent = 'message';
    let dataLines: string[] = [];
    for await (const line of rl) {
      if (line === '') {
        if (dataLines.length > 0) {
          const raw = dataLines.join('\n');
          dataLines = [];
          try {
            yield { event: currentEvent, data: JSON.parse(raw) };
          } catch {
            // ignore malformed frame
          }
        }
        currentEvent = 'message';
        continue;
      }
      if (line.startsWith(':')) continue; // comment / keepalive
      if (line.startsWith('event:')) {
        currentEvent = line.slice('event:'.length).trim();
        continue;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trim());
      }
    }
  }
}

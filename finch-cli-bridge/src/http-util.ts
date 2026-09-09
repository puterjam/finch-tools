import type { IncomingMessage, ServerResponse } from 'node:http';

export interface ApiError {
  code:
    | 'unauthorized'
    | 'forbidden'
    | 'not_found'
    | 'invalid_request'
    | 'rate_limited'
    | 'upstream_timeout'
    | 'internal_error';
  message: string;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB is plenty for a control-plane JSON body

export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

const STATUS_BY_CODE: Record<ApiError['code'], number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  rate_limited: 429,
  upstream_timeout: 504,
  internal_error: 500,
};

export function sendError(res: ServerResponse, error: ApiError): void {
  sendJson(res, STATUS_BY_CODE[error.code], { error });
}

/** Loopback-only guard: rejects any request whose Host header isn't 127.0.0.1/localhost on our own port. */
export function isLoopbackHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const [host, portStr] = hostHeader.split(':');
  if (portStr !== undefined && Number(portStr) !== port) return false;
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** Matches `/sessions/:id/turns/:turnId/cancel` style patterns against a real pathname. */
export function matchRoute(pattern: string, pathname: string): Record<string, string> | undefined {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i];
    const v = decodeURIComponent(pathParts[i]);
    if (p.startsWith(':')) {
      params[p.slice(1)] = v;
    } else if (p !== pathParts[i]) {
      return undefined;
    }
  }
  return params;
}

export function writeSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  // Establish the stream immediately so the client's fetch/EventSource resolves right away.
  res.write(': connected\n\n');
}

export function writeSseEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

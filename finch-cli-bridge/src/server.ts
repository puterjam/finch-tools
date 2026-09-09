import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type * as finch from 'finch';
import { TokenStore, type PairedClient } from './auth.js';
import { PairingManager } from './pairing.js';
import {
  isLoopbackHost,
  matchRoute,
  readJsonBody,
  sendError,
  sendJson,
  writeSseEvent,
  writeSseHeaders,
} from './http-util.js';

export const BRIDGE_VERSION = '0.1.0';
const PREFERRED_PORT = 47651;
const DEFAULT_SCOPES = ['sessions', 'status', 'notifications'];

interface RequestContext {
  client?: PairedClient;
}

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  rctx: RequestContext,
) => Promise<void>;

interface Route {
  method: string;
  pattern: string;
  auth: boolean;
  handler: Handler;
}

/**
 * The loopback-only HTTP+SSE control plane the `finch` CLI talks to.
 * See docs/finch-cli-design.md at the repo root for the full protocol spec.
 */
export class BridgeServer {
  private readonly server: http.Server;
  private port = 0;
  private readonly sessionStreams = new Map<string, Set<ServerResponse>>();
  private readonly globalEventStreams = new Set<ServerResponse>();
  private readonly notificationStreams = new Set<ServerResponse>();
  private readonly routes: Route[];
  private sessionEventSub?: finch.Disposable;
  private notificationSub?: finch.Disposable;

  constructor(
    private readonly ctx: finch.MiniToolContext,
    private readonly tokens: TokenStore,
    private readonly pairing: PairingManager,
  ) {
    this.routes = this.buildRoutes();
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.ctx.logger.error('[cli-bridge] unhandled request error', err);
        if (!res.headersSent) sendError(res, { code: 'internal_error', message: 'internal error' });
        else res.end();
      });
    });
  }

  async start(): Promise<void> {
    this.port = await this.listen();
    this.sessionEventSub = this.ctx.sessions.onDidReceiveEvent((event: finch.SessionBridgeEvent) => {
      const set = this.sessionStreams.get(event.sessionId);
      if (set && set.size > 0) {
        for (const res of set) writeSseEvent(res, event.type, event);
      }
      for (const res of this.globalEventStreams) writeSseEvent(res, event.type, event);
    });
    this.notificationSub = this.ctx.notifications.onDidPost((event: finch.FinchNotificationEvent) => {
      for (const res of this.notificationStreams) writeSseEvent(res, 'notification', event);
    });
    await this.writeEndpointFile();
    this.ctx.logger.info(`[cli-bridge] listening on 127.0.0.1:${this.port}`);
  }

  async stop(): Promise<void> {
    this.sessionEventSub?.dispose();
    this.notificationSub?.dispose();
    for (const set of this.sessionStreams.values()) for (const res of set) res.end();
    for (const res of this.globalEventStreams) res.end();
    for (const res of this.notificationStreams) res.end();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await fs.rm(this.endpointFilePath(), { force: true }).catch(() => undefined);
  }

  private endpointFilePath(): string {
    return path.join(this.ctx.storagePath, 'endpoint.json');
  }

  private async writeEndpointFile(): Promise<void> {
    const body = {
      port: this.port,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      bridgeVersion: BRIDGE_VERSION,
    };
    // ctx.storagePath is not guaranteed to exist yet on first activation.
    await fs.mkdir(this.ctx.storagePath, { recursive: true });
    await fs.writeFile(this.endpointFilePath(), JSON.stringify(body, null, 2), 'utf8');
  }

  private listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
          this.server.removeListener('error', onError);
          this.server.listen(0, '127.0.0.1');
        } else {
          reject(err);
        }
      };
      this.server.once('error', onError);
      this.server.once('listening', () => {
        this.server.removeListener('error', onError);
        const addr = this.server.address();
        if (addr && typeof addr === 'object') resolve(addr.port);
        else reject(new Error('bridge server has no address after listening'));
      });
      this.server.listen(PREFERRED_PORT, '127.0.0.1');
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLoopbackHost(req.headers.host, this.port)) {
      sendError(res, { code: 'forbidden', message: 'this bridge only accepts loopback requests' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://internal.invalid');
    const method = (req.method ?? 'GET').toUpperCase();

    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = matchRoute(route.pattern, url.pathname);
      if (!params) continue;

      const rctx: RequestContext = {};
      if (route.auth) {
        const client = await this.authenticate(req);
        if (!client) {
          sendError(res, { code: 'unauthorized', message: 'missing or invalid bearer token; run `finch login`' });
          return;
        }
        rctx.client = client;
      }
      (req as IncomingMessage & { finchQuery?: URLSearchParams }).finchQuery = url.searchParams;
      await route.handler(req, res, params, rctx);
      return;
    }
    sendError(res, { code: 'not_found', message: `no route for ${method} ${url.pathname}` });
  }

  private async authenticate(req: IncomingMessage): Promise<PairedClient | undefined> {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return undefined;
    const token = header.slice('Bearer '.length).trim();
    if (!token) return undefined;
    return this.tokens.verify(token);
  }

  private query(req: IncomingMessage): URLSearchParams {
    return (req as IncomingMessage & { finchQuery?: URLSearchParams }).finchQuery ?? new URLSearchParams();
  }

  // ── Route table ──────────────────────────────────────────────────────────

  private buildRoutes(): Route[] {
    return [
      { method: 'GET', pattern: '/healthz', auth: false, handler: this.getHealthz },
      { method: 'POST', pattern: '/pair/request', auth: false, handler: this.postPairRequest },
      { method: 'GET', pattern: '/pair/status/:pairingId', auth: false, handler: this.getPairStatus },
      { method: 'POST', pattern: '/pair/revoke', auth: true, handler: this.postPairRevoke },
      { method: 'GET', pattern: '/whoami', auth: true, handler: this.getWhoami },
      { method: 'GET', pattern: '/status', auth: true, handler: this.getStatus },
      { method: 'GET', pattern: '/spaces', auth: true, handler: this.getSpaces },
      { method: 'POST', pattern: '/sessions', auth: true, handler: this.postSessions },
      { method: 'GET', pattern: '/sessions', auth: true, handler: this.getSessions },
      { method: 'GET', pattern: '/sessions/:id', auth: true, handler: this.getSession },
      { method: 'POST', pattern: '/sessions/:id/messages', auth: true, handler: this.postSessionMessages },
      { method: 'POST', pattern: '/sessions/:id/turns/:turnId/wait', auth: true, handler: this.postTurnWait },
      { method: 'POST', pattern: '/sessions/:id/turns/:turnId/cancel', auth: true, handler: this.postTurnCancel },
      { method: 'GET', pattern: '/sessions/:id/events', auth: true, handler: this.getSessionEvents },
      { method: 'GET', pattern: '/events/watch', auth: true, handler: this.getAllEventsWatch },
      { method: 'GET', pattern: '/sessions/:id/waits', auth: true, handler: this.getSessionWaits },
      { method: 'GET', pattern: '/sessions/:id/waits/next', auth: true, handler: this.getSessionWaitsNext },
      { method: 'POST', pattern: '/sessions/:id/waits/:requestId/respond', auth: true, handler: this.postWaitRespond },
      { method: 'POST', pattern: '/navigation/open-session', auth: true, handler: this.postOpenSession },
      { method: 'GET', pattern: '/notifications/watch', auth: true, handler: this.getNotificationsWatch },
    ];
  }

  // ── Handlers ─────────────────────────────────────────────────────────────

  private getHealthz: Handler = async (_req, res) => {
    const info = await this.ctx.app.getInfo();
    sendJson(res, 200, { ok: true, bridgeVersion: BRIDGE_VERSION, appVersion: info.version, pid: process.pid });
  };

  private postPairRequest: Handler = async (req, res) => {
    if (this.pairing.isRateLimited()) {
      sendError(res, { code: 'rate_limited', message: 'too many pairing requests, try again shortly' });
      return;
    }
    const body = (await readJsonBody(req)) as { clientId?: string; clientName?: string; scopes?: string[] } | undefined;
    const clientId = typeof body?.clientId === 'string' && body.clientId ? body.clientId : crypto.randomUUID();
    const clientName = typeof body?.clientName === 'string' ? body.clientName : 'unknown terminal';
    const scopes = Array.isArray(body?.scopes) && body!.scopes!.length > 0 ? body!.scopes! : DEFAULT_SCOPES;
    const pairingReq = this.pairing.request(clientId, clientName, scopes);
    sendJson(res, 200, { pairingId: pairingReq.pairingId, code: pairingReq.code, expiresAt: new Date(pairingReq.expiresAt).toISOString() });
  };

  private getPairStatus: Handler = async (_req, res, params) => {
    const found = this.pairing.consumeStatus(params.pairingId);
    if (!found) {
      sendError(res, { code: 'not_found', message: 'unknown or expired pairingId' });
      return;
    }
    sendJson(res, 200, { state: found.state, token: found.token, scopes: found.scopes });
  };

  private postPairRevoke: Handler = async (req, res) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const ok = token ? await this.tokens.revokeByToken(token) : false;
    sendJson(res, 200, { ok });
  };

  private getWhoami: Handler = async (_req, res, _params, rctx) => {
    const c = rctx.client!;
    sendJson(res, 200, {
      clientId: c.clientId,
      clientName: c.clientName,
      scopes: c.scopes,
      pairedAt: c.pairedAt,
      lastUsedAt: c.lastUsedAt,
    });
  };

  private getStatus: Handler = async (_req, res) => {
    const [info, snapshot] = await Promise.all([this.ctx.app.getInfo(), this.ctx.status.get()]);
    sendJson(res, 200, {
      app: {
        version: info.version,
        versionDisplay: info.versionDisplay,
        platform: info.platform,
        locale: info.locale,
        assistantName: info.assistantName,
      },
      status: snapshot,
    });
  };

  private getSpaces: Handler = async (_req, res) => {
    const spaces = await this.ctx.spaces.list();
    sendJson(res, 200, { spaces });
  };

  private postSessions: Handler = async (req, res) => {
    const body = (await readJsonBody(req)) as
      | {
          containerId?: string;
          space?: { spaceId: string };
          title?: string;
          activity?: 'interactive' | 'background';
          permissionMode?: 'ask' | 'acceptCalls';
          initialMessage?: { text: string; idempotencyKey?: string };
        }
      | undefined;
    if (body?.containerId) {
      sendError(res, {
        code: 'invalid_request',
        message: 'this bridge declares no session containers; omit containerId or use space/plain chat placement',
      });
      return;
    }
    const initialMessage = body?.initialMessage
      ? { text: body.initialMessage.text, idempotencyKey: body.initialMessage.idempotencyKey || crypto.randomUUID() }
      : undefined;
    const session = await this.ctx.sessions.create({
      space: body?.space,
      title: body?.title,
      activity: body?.activity,
      permissionMode: body?.permissionMode,
      initialMessage,
    });
    sendJson(res, 201, { session });
  };

  private getSessions: Handler = async (req, res) => {
    const includeArchived = this.query(req).get('includeArchived') === '1';
    const sessions = await this.ctx.sessions.list({ includeArchived });
    sendJson(res, 200, { sessions });
  };

  private getSession: Handler = async (_req, res, params) => {
    const session = await this.ctx.sessions.get(params.id);
    if (!session) {
      sendError(res, { code: 'not_found', message: 'no such session' });
      return;
    }
    sendJson(res, 200, { session });
  };

  private postSessionMessages: Handler = async (req, res, params) => {
    const body = (await readJsonBody(req)) as
      | {
          text?: string;
          idempotencyKey?: string;
          attachments?: unknown;
          wait?: boolean;
          timeoutMs?: number;
        }
      | undefined;
    if (typeof body?.text !== 'string') {
      sendError(res, { code: 'invalid_request', message: 'text is required (may be empty when attachments are set)' });
      return;
    }
    const receipt = await this.ctx.sessions.send(params.id, {
      text: body.text,
      idempotencyKey: body.idempotencyKey || crypto.randomUUID(),
      attachments: body.attachments as never,
    });
    if (body.wait && receipt.state !== 'rejected') {
      const result = await this.ctx.sessions.waitForTurn(params.id, receipt.turnId, { timeoutMs: body.timeoutMs });
      sendJson(res, 200, { receipt, result });
      return;
    }
    sendJson(res, 200, { receipt });
  };

  private postTurnWait: Handler = async (req, res, params) => {
    const body = (await readJsonBody(req)) as { timeoutMs?: number } | undefined;
    const result = await this.ctx.sessions.waitForTurn(params.id, params.turnId, { timeoutMs: body?.timeoutMs });
    sendJson(res, 200, { result });
  };

  private postTurnCancel: Handler = async (_req, res, params) => {
    const accepted = await this.ctx.sessions.cancelTurn(params.id, params.turnId);
    sendJson(res, 200, { accepted });
  };

  private getSessionEvents: Handler = async (req, res, params) => {
    const q = this.query(req);
    if (q.get('stream') === '1') {
      writeSseHeaders(res);
      let set = this.sessionStreams.get(params.id);
      if (!set) {
        set = new Set();
        this.sessionStreams.set(params.id, set);
      }
      set.add(res);
      req.on('close', () => {
        set!.delete(res);
        if (set!.size === 0) this.sessionStreams.delete(params.id);
      });
      return;
    }
    const after = q.has('after') ? Number(q.get('after')) : undefined;
    const limit = q.has('limit') ? Number(q.get('limit')) : undefined;
    const page = await this.ctx.sessions.listEvents({ sessionId: params.id, after, limit });
    sendJson(res, 200, page);
  };

  /** Global agent-event stream across every Session this bridge owns (unlike /notifications/watch, which only carries coarse status notifications). */
  private getAllEventsWatch: Handler = async (req, res) => {
    writeSseHeaders(res);
    this.globalEventStreams.add(res);
    req.on('close', () => this.globalEventStreams.delete(res));
  };

  private getSessionWaits: Handler = async (_req, res, params) => {
    const waits = await this.ctx.sessions.listWaits(params.id);
    sendJson(res, 200, { waits });
  };

  private getSessionWaitsNext: Handler = async (req, res, params) => {
    const q = this.query(req);
    const timeoutMs = q.has('timeoutMs') ? Number(q.get('timeoutMs')) : undefined;
    const wait = await this.ctx.sessions.waitForWait(params.id, { timeoutMs });
    sendJson(res, 200, { wait: wait ?? null });
  };

  private postWaitRespond: Handler = async (req, res, params) => {
    const body = (await readJsonBody(req)) as finch.SessionWaitResponse | undefined;
    if (!body || !('kind' in body)) {
      sendError(res, { code: 'invalid_request', message: 'body must include kind: permission | question | form' });
      return;
    }
    const result = await this.ctx.sessions.respondToWait(params.id, params.requestId, body);
    sendJson(res, 200, { result });
  };

  private postOpenSession: Handler = async (req, res) => {
    const body = (await readJsonBody(req)) as { sessionId?: string } | undefined;
    if (!body?.sessionId) {
      sendError(res, { code: 'invalid_request', message: 'sessionId is required' });
      return;
    }
    await this.ctx.navigation.openSession(body.sessionId);
    sendJson(res, 200, { ok: true });
  };

  private getNotificationsWatch: Handler = async (req, res) => {
    writeSseHeaders(res);
    this.notificationStreams.add(res);
    req.on('close', () => this.notificationStreams.delete(res));
  };
}

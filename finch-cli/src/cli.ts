#!/usr/bin/env node
import * as crypto from 'node:crypto';
import { BridgeClient, BridgeError } from './client.js';
import {
  baseUrlFor,
  clearCredentials,
  defaultClientName,
  readCredentials,
  readEndpoint,
  writeCredentials,
} from './config.js';

type Flags = Record<string, string[] | true>;

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        const list = Array.isArray(flags[key]) ? (flags[key] as string[]) : [];
        list.push(next);
        flags[key] = list;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function flagStr(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return Array.isArray(v) ? v[v.length - 1] : undefined;
}

function flagAll(flags: Flags, key: string): string[] {
  const v = flags[key];
  return Array.isArray(v) ? v : [];
}

function flagBool(flags: Flags, key: string): boolean {
  return flags[key] !== undefined;
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requireEndpoint() {
  const endpoint = await readEndpoint();
  if (!endpoint) {
    fail(
      'CLI Bridge endpoint not found. Make sure Finch is running with the "CLI Bridge" mini tool installed and enabled.',
    );
  }
  return endpoint;
}

async function requireClient(): Promise<{ client: BridgeClient; baseUrl: string }> {
  const endpoint = await requireEndpoint();
  const creds = await readCredentials();
  if (!creds) fail('Not logged in. Run `finch login` first.');
  const baseUrl = baseUrlFor(endpoint);
  return { client: new BridgeClient(baseUrl, creds.token), baseUrl };
}

async function withErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BridgeError) {
      if (err.code === 'unauthorized') fail(`${err.message} (run \`finch login\`)`);
      fail(`${err.message} [${err.code}]`);
    }
    fail(err instanceof Error ? err.message : String(err));
  }
}

// ── Commands ─────────────────────────────────────────────────────────────

async function cmdLogin(): Promise<void> {
  const endpoint = await requireEndpoint();
  const baseUrl = baseUrlFor(endpoint);
  const existing = await readCredentials();
  const clientId = existing?.clientId ?? crypto.randomUUID();
  const clientName = existing?.clientName ?? defaultClientName();
  const anon = new BridgeClient(baseUrl);

  const { pairingId, code, expiresAt } = await withErrors(() =>
    anon.request<{ pairingId: string; code: string; expiresAt: string }>('POST', '/pair/request', {
      clientId,
      clientName,
    }),
  );

  console.log(`Open Finch and approve the pairing prompt for "${clientName}".`);
  console.log(`Confirmation code: ${code}  (expires ${expiresAt})`);
  console.log('Waiting for approval...');

  const deadline = Date.now() + 130_000;
  while (Date.now() < deadline) {
    const status = await withErrors(() =>
      anon.request<{ state: string; token?: string }>('GET', `/pair/status/${pairingId}`),
    );
    if (status.state === 'approved' && status.token) {
      await writeCredentials({ clientId, clientName, token: status.token, pairedAt: new Date().toISOString() });
      console.log(`Paired as "${clientName}". Try: finch status`);
      return;
    }
    if (status.state === 'denied') fail('Pairing was denied in Finch.');
    if (status.state === 'expired') fail('Pairing request expired. Run `finch login` again.');
    await sleep(1500);
  }
  fail('Timed out waiting for approval in Finch.');
}

async function cmdLogout(): Promise<void> {
  const endpoint = await readEndpoint();
  const creds = await readCredentials();
  if (!creds) {
    console.log('Not logged in.');
    return;
  }
  if (endpoint) {
    const client = new BridgeClient(baseUrlFor(endpoint), creds.token);
    await client.request('POST', '/pair/revoke').catch(() => undefined);
  }
  await clearCredentials();
  console.log('Logged out.');
}

async function cmdWhoami(): Promise<void> {
  const { client } = await requireClient();
  printJson(await withErrors(() => client.request('GET', '/whoami')));
}

async function cmdStatus(): Promise<void> {
  const { client } = await requireClient();
  printJson(await withErrors(() => client.request('GET', '/status')));
}

async function cmdSpaceList(): Promise<void> {
  const { client } = await requireClient();
  const { spaces } = await withErrors(() =>
    client.request<{ spaces: { id: string; name: string; alias?: string; directoryPath?: string }[] }>('GET', '/spaces'),
  );
  if (spaces.length === 0) {
    console.log('No Spaces.');
    return;
  }
  for (const s of spaces) {
    console.log(`${s.id}  ${s.name}${s.alias ? ` (${s.alias})` : ''}${s.directoryPath ? `  ${s.directoryPath}` : ''}`);
  }
}

interface SessionDescriptor {
  sessionId: string;
  placement: { type: string; spaceId?: string; containerId?: string };
  activity: string;
  topic?: string;
  state: { pinned: boolean; archived: boolean };
  updatedAt: string;
}

function describePlacement(p: SessionDescriptor['placement']): string {
  if (p.type === 'space') return `space:${p.spaceId}`;
  if (p.type === 'minitool') return `container:${p.containerId}`;
  return 'chat';
}

async function cmdSessionList(flags: Flags): Promise<void> {
  const { client } = await requireClient();
  const includeArchived = flagBool(flags, 'include-archived');
  const { sessions } = await withErrors(() =>
    client.request<{ sessions: SessionDescriptor[] }>('GET', `/sessions?includeArchived=${includeArchived ? '1' : '0'}`),
  );
  if (sessions.length === 0) {
    console.log('No sessions.');
    return;
  }
  for (const s of sessions) {
    const tags = [s.state.pinned ? 'pinned' : '', s.state.archived ? 'archived' : ''].filter(Boolean).join(',');
    console.log(`${s.sessionId}  ${describePlacement(s.placement)}  ${s.activity}${tags ? `  [${tags}]` : ''}${s.topic ? `  ${s.topic}` : ''}`);
  }
}

async function cmdSessionCreate(flags: Flags): Promise<void> {
  const { client } = await requireClient();
  const spaceId = flagStr(flags, 'space');
  const title = flagStr(flags, 'title');
  const message = flagStr(flags, 'message');
  const activity = flagStr(flags, 'background') !== undefined ? 'background' : undefined;
  const body = {
    space: spaceId ? { spaceId } : undefined,
    title,
    activity,
    initialMessage: message ? { text: message, idempotencyKey: crypto.randomUUID() } : undefined,
  };
  const result = await withErrors(() => client.request('POST', '/sessions', body));
  printJson(result);
}

async function cmdSessionGet(id: string): Promise<void> {
  const { client } = await requireClient();
  printJson(await withErrors(() => client.request('GET', `/sessions/${encodeURIComponent(id)}`)));
}

async function cmdSessionSend(id: string, flags: Flags): Promise<void> {
  const { client } = await requireClient();
  const text = flagStr(flags, 'message');
  if (text === undefined) fail('--message is required');
  const wait = flagBool(flags, 'wait');
  const timeout = flagStr(flags, 'timeout');
  const body = {
    text,
    idempotencyKey: flagStr(flags, 'idempotency-key') ?? crypto.randomUUID(),
    wait,
    timeoutMs: timeout ? Number(timeout) * 1000 : undefined,
  };
  printJson(await withErrors(() => client.request('POST', `/sessions/${encodeURIComponent(id)}/messages`, body)));
}

async function cmdSessionWait(id: string, turnId: string, flags: Flags): Promise<void> {
  const { client } = await requireClient();
  const timeout = flagStr(flags, 'timeout');
  printJson(
    await withErrors(() =>
      client.request('POST', `/sessions/${encodeURIComponent(id)}/turns/${encodeURIComponent(turnId)}/wait`, {
        timeoutMs: timeout ? Number(timeout) * 1000 : undefined,
      }),
    ),
  );
}

async function cmdSessionCancel(id: string, turnId: string): Promise<void> {
  const { client } = await requireClient();
  printJson(
    await withErrors(() =>
      client.request('POST', `/sessions/${encodeURIComponent(id)}/turns/${encodeURIComponent(turnId)}/cancel`),
    ),
  );
}

async function cmdSessionEvents(id: string, flags: Flags): Promise<void> {
  const { client } = await requireClient();
  const after = flagStr(flags, 'after');
  const limit = flagStr(flags, 'limit');
  const qs = new URLSearchParams();
  if (after) qs.set('after', after);
  if (limit) qs.set('limit', limit);
  printJson(await withErrors(() => client.request('GET', `/sessions/${encodeURIComponent(id)}/events?${qs}`)));
}

async function cmdSessionWatch(id: string): Promise<void> {
  const { client } = await requireClient();
  console.log(`Watching session ${id}. Press Ctrl+C to stop.`);
  try {
    for await (const frame of client.stream(`/sessions/${encodeURIComponent(id)}/events?stream=1`)) {
      console.log(`[${frame.event}] ${JSON.stringify(frame.data)}`);
    }
  } catch (err) {
    if (err instanceof BridgeError) fail(`${err.message} [${err.code}]`);
    throw err;
  }
}

async function cmdSessionWaits(id: string): Promise<void> {
  const { client } = await requireClient();
  printJson(await withErrors(() => client.request('GET', `/sessions/${encodeURIComponent(id)}/waits`)));
}

async function cmdSessionRespond(id: string, requestId: string, flags: Flags): Promise<void> {
  const { client } = await requireClient();
  let body: Record<string, unknown> | undefined;
  if (flagBool(flags, 'allow') || flagBool(flags, 'deny')) {
    body = { kind: 'permission', allow: flagBool(flags, 'allow') };
  } else if (flagAll(flags, 'answer').length > 0) {
    const answers: Record<string, string> = {};
    for (const pair of flagAll(flags, 'answer')) {
      const idx = pair.indexOf('=');
      if (idx === -1) fail(`--answer must be "header=value", got "${pair}"`);
      answers[pair.slice(0, idx)] = pair.slice(idx + 1);
    }
    body = { kind: 'question', answers };
  } else if (flagAll(flags, 'form').length > 0) {
    const values: Record<string, string> = {};
    for (const pair of flagAll(flags, 'form')) {
      const idx = pair.indexOf('=');
      if (idx === -1) fail(`--form must be "key=value", got "${pair}"`);
      values[pair.slice(0, idx)] = pair.slice(idx + 1);
    }
    body = { kind: 'form', submitted: true, values };
  } else {
    fail('Provide --allow, --deny, --answer "header=value", or --form key=value');
  }
  printJson(
    await withErrors(() =>
      client.request('POST', `/sessions/${encodeURIComponent(id)}/waits/${encodeURIComponent(requestId)}/respond`, body),
    ),
  );
}

async function cmdOpen(id: string): Promise<void> {
  const { client } = await requireClient();
  await withErrors(() => client.request('POST', '/navigation/open-session', { sessionId: id }));
  console.log(`Opened session ${id} in Finch.`);
}

async function cmdWatchNotifications(): Promise<void> {
  const { client } = await requireClient();
  console.log('Watching Finch notifications. Press Ctrl+C to stop.');
  try {
    for await (const frame of client.stream('/notifications/watch')) {
      console.log(`[${frame.event}] ${JSON.stringify(frame.data)}`);
    }
  } catch (err) {
    if (err instanceof BridgeError) fail(`${err.message} [${err.code}]`);
    throw err;
  }
}

function printHelp(): void {
  console.log(`finch — drive Finch Sessions from a terminal via the CLI Bridge mini tool

Usage:
  finch login                          Pair this terminal with a running Finch app
  finch logout                         Revoke this terminal's pairing
  finch whoami                         Show the current pairing identity
  finch status                         Finch app version/platform + status snapshot
  finch space list                     List your Spaces

  finch session list [--include-archived]
  finch session create [--space <id>] [--title <t>] [--message <text>] [--background]
  finch session get <sessionId>
  finch session send <sessionId> --message <text> [--wait] [--timeout <sec>] [--idempotency-key <key>]
  finch session wait <sessionId> <turnId> [--timeout <sec>]
  finch session cancel <sessionId> <turnId>
  finch session events <sessionId> [--after <n>] [--limit <n>]
  finch session watch <sessionId>      Stream live events (SSE)
  finch session waits <sessionId>      List pending permission/question/form cards
  finch session respond <sessionId> <requestId> --allow|--deny
  finch session respond <sessionId> <requestId> --answer "header=value" [--answer ...]
  finch session respond <sessionId> <requestId> --form key=value [--form ...]

  finch open <sessionId>               Bring Finch to the front on this Session
  finch watch                          Stream Finch's global notification feed

Sessions are created without a container (this bridge declares none); pass
--space <spaceId> to place a Session in a Space, or omit it for a plain chat.`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }

  switch (cmd) {
    case 'login':
      return cmdLogin();
    case 'logout':
      return cmdLogout();
    case 'whoami':
      return cmdWhoami();
    case 'status':
      return cmdStatus();
    case 'space': {
      const [sub] = rest;
      if (sub === 'list') return cmdSpaceList();
      fail(`Unknown \`finch space ${sub ?? ''}\`. Try \`finch space list\`.`);
      break;
    }
    case 'session': {
      const [sub, ...args] = rest;
      const { positional, flags } = parseArgs(args);
      switch (sub) {
        case 'list':
          return cmdSessionList(flags);
        case 'create':
          return cmdSessionCreate(flags);
        case 'get':
          return cmdSessionGet(requirePositional(positional, 0, 'sessionId'));
        case 'send':
          return cmdSessionSend(requirePositional(positional, 0, 'sessionId'), flags);
        case 'wait':
          return cmdSessionWait(requirePositional(positional, 0, 'sessionId'), requirePositional(positional, 1, 'turnId'), flags);
        case 'cancel':
          return cmdSessionCancel(requirePositional(positional, 0, 'sessionId'), requirePositional(positional, 1, 'turnId'));
        case 'events':
          return cmdSessionEvents(requirePositional(positional, 0, 'sessionId'), flags);
        case 'watch':
          return cmdSessionWatch(requirePositional(positional, 0, 'sessionId'));
        case 'waits':
          return cmdSessionWaits(requirePositional(positional, 0, 'sessionId'));
        case 'respond':
          return cmdSessionRespond(requirePositional(positional, 0, 'sessionId'), requirePositional(positional, 1, 'requestId'), flags);
        default:
          fail(`Unknown \`finch session ${sub ?? ''}\`. Run \`finch help\` for usage.`);
      }
      break;
    }
    case 'open':
      return cmdOpen(requirePositional(rest, 0, 'sessionId'));
    case 'watch':
      return cmdWatchNotifications();
    default:
      fail(`Unknown command \`${cmd}\`. Run \`finch help\` for usage.`);
  }
}

function requirePositional(positional: string[], index: number, name: string): string {
  const value = positional[index];
  if (!value) fail(`Missing required argument: ${name}`);
  return value;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

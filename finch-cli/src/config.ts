import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface Credentials {
  clientId: string;
  clientName: string;
  token: string;
  pairedAt: string;
}

export interface EndpointInfo {
  port: number;
  pid: number;
  startedAt: string;
  bridgeVersion: string;
}

const CONFIG_DIR = path.join(os.homedir(), '.finch-cli');
const CREDENTIALS_PATH = path.join(CONFIG_DIR, 'credentials.json');
// Matches the CLI Bridge mini tool's ctx.storagePath convention: `~/.finch/extension-data/<id>/`.
const ENDPOINT_PATH = path.join(os.homedir(), '.finch', 'extension-data', 'finch-cli-bridge', 'endpoint.json');

export function defaultClientName(): string {
  const user = os.userInfo().username || 'user';
  const host = os.hostname().split('.')[0] || 'host';
  return `${user}@${host}`;
}

export async function readCredentials(): Promise<Credentials | undefined> {
  try {
    const raw = await fs.readFile(CREDENTIALS_PATH, 'utf8');
    return JSON.parse(raw) as Credentials;
  } catch {
    return undefined;
  }
}

export async function writeCredentials(creds: Credentials): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export async function clearCredentials(): Promise<void> {
  await fs.rm(CREDENTIALS_PATH, { force: true });
}

export async function readEndpoint(): Promise<EndpointInfo | undefined> {
  try {
    const raw = await fs.readFile(ENDPOINT_PATH, 'utf8');
    return JSON.parse(raw) as EndpointInfo;
  } catch {
    return undefined;
  }
}

export function baseUrlFor(endpoint: EndpointInfo): string {
  return `http://127.0.0.1:${endpoint.port}`;
}

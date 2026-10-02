import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type * as lancedb from '@lancedb/lancedb';
import { downloadWithProgress, formatBytes } from './download.js';

const VERSION = '0.39.0';
const MAX_ARCHIVE = 200 * 1024 * 1024;
let pending: Promise<typeof lancedb> | undefined;

function binaryDestination(storagePath: string, target: string): string {
  return join(storagePath, 'lancedb-engine', VERSION, `lancedb.${target}.node`);
}

/** Presence check for environment reporting; installing is still done by loadLanceDB(). */
export function isEngineInstalled(storagePath: string): boolean {
  try {
    return existsSync(binaryDestination(storagePath, nativeTarget()));
  } catch {
    return false;
  }
}

export function engineVersion(): string {
  return VERSION;
}

export function nativeTarget(): string {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64';
  if (process.platform === 'win32' && process.arch === 'x64') return 'win32-x64-msvc';
  if (process.platform === 'win32' && process.arch === 'arm64') return 'win32-arm64-msvc';
  if (process.platform === 'linux') {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    const musl = !report?.header?.glibcVersionRuntime;
    if (process.arch === 'x64' || process.arch === 'arm64') {
      return `linux-${process.arch}-${musl ? 'musl' : 'gnu'}`;
    }
  }
  throw new Error(`LanceDB does not support ${process.platform}/${process.arch} here.`);
}

function extractBinary(tar: Buffer): Buffer {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const name = block.subarray(0, 100).toString('utf8').split('\0')[0] ?? '';
    const size = Number.parseInt(block.subarray(124, 136).toString('ascii').trim(), 8) || 0;
    const type = block[156];
    offset += 512;
    if (size > 0 && size < 400 * 1024 * 1024 && (type === 0 || type === 48) && name.endsWith('.node')) {
      return Buffer.from(tar.subarray(offset, offset + size));
    }
    offset += Math.ceil(size / 512) * 512;
  }
  throw new Error('The LanceDB archive has no native binding.');
}

async function install(target: string, destination: string, progress?: (message: string) => void): Promise<void> {
  const name = `@lancedb/lancedb-${target}`;
  progress?.('Locating the LanceDB native engine…');
  const metadata = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${VERSION}`);
  if (!metadata.ok) throw new Error(`LanceDB metadata download failed (${metadata.status}).`);
  const manifest = await metadata.json() as { dist?: { tarball?: string; integrity?: string; unpackedSize?: number } };
  if (!manifest.dist?.tarball || !manifest.dist.integrity) throw new Error('LanceDB archive has no integrity metadata.');
  const url = new URL(manifest.dist.tarball);
  if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org') throw new Error('Unexpected LanceDB archive host.');
  const expected = manifest.dist.unpackedSize ? ` (about ${formatBytes(manifest.dist.unpackedSize)} unpacked)` : '';
  progress?.(`Downloading the LanceDB native engine${expected}…`);
  const archive = await downloadWithProgress(url.toString(), {
    maxBytes: MAX_ARCHIVE,
    onProgress: (received, total) => {
      if (total <= 0) return;
      progress?.(`Downloading the LanceDB native engine — ${formatBytes(received)} / ${formatBytes(total)}`);
    },
  });
  const [algorithm, digest] = manifest.dist.integrity.split('-');
  if (algorithm !== 'sha512' || createHash('sha512').update(archive).digest('base64') !== digest) {
    throw new Error('LanceDB archive failed its integrity check.');
  }
  progress?.('Unpacking the LanceDB native engine…');
  const binary = extractBinary(gunzipSync(archive));
  mkdirSync(dirname(destination), { recursive: true });
  const staging = `${destination}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(staging, binary);
  renameSync(staging, destination);
}

/** Native files live in persistent extension data, not the replaceable install folder. */
export function loadLanceDB(storagePath: string, progress?: (message: string) => void): Promise<typeof lancedb> {
  if (pending) return pending;
  pending = (async () => {
    const target = nativeTarget();
    const binary = binaryDestination(storagePath, target);
    if (!existsSync(binary)) await install(target, binary, progress);
    // Native CommonJS loader is copied as native.cjs beside dist/index.js.
    // Preload it with the documented NAPI-RS override before the SDK imports it.
    const previous = process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
    try {
      process.env.NAPI_RS_NATIVE_LIBRARY_PATH = binary;
      createRequire(import.meta.url)('./native.cjs');
    } finally {
      if (previous === undefined) delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
      else process.env.NAPI_RS_NATIVE_LIBRARY_PATH = previous;
    }
    return import('@lancedb/lancedb');
  })().catch((error: unknown) => {
    pending = undefined;
    throw error;
  });
  return pending;
}

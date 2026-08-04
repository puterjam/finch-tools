/**
 * Resolves the native anydoc document engine.
 *
 * The engine is a platform specific native binary that is far too large to ship
 * inside this package. Instead it is fetched from the npm registry the first
 * time a document is read, verified against the registry integrity hash, and
 * cached inside the mini tool storage directory for every later call.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

/** Pinned upstream version. Bump deliberately, never resolve "latest" at runtime. */
export const ENGINE_VERSION = '0.1.2';

const REGISTRY = 'https://registry.npmjs.org';
const SCOPE = '@firecrawl';

/**
 * The Windows binary is a Rust MSVC build, so it imports VCRUNTIME140.dll from
 * the Visual C++ 2015-2022 redistributable. Every other DLL it needs ships with
 * Windows itself. The redistributable is present on most machines but is not
 * part of a clean install, so check for it instead of letting dlopen fail with
 * "the specified module could not be found".
 */
const VC_REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';

function missingVisualCppRuntime(): boolean {
  if (process.platform !== 'win32') return false;

  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  const candidates = [
    join(root, 'System32', 'vcruntime140.dll'),
    join(root, 'SysWOW64', 'vcruntime140.dll'),
  ];

  return !candidates.some((candidate) => existsSync(candidate));
}

const VC_REDIST_HINT =
  'AnyDoc needs the Microsoft Visual C++ 2015-2022 Redistributable (x64), which is missing on this machine. ' +
  `Install it from ${VC_REDIST_URL}, then restart Finch and try again.`;

/** Subset of the native binding this mini tool relies on. */
export interface DocumentEngine {
  toMarkdown(path: string): Promise<string>;
}

export type ProgressReporter = (message: string, percent?: number) => void;

/** Maps the current process to an upstream npm platform package suffix. */
export function detectTarget(): string | null {
  const { platform, arch } = process;

  if (platform === 'darwin') {
    if (arch === 'arm64') return 'darwin-arm64';
    if (arch === 'x64') return 'darwin-x64';
    return null;
  }

  if (platform === 'win32') {
    return arch === 'x64' ? 'win32-x64-msvc' : null;
  }

  if (platform === 'linux') {
    const libc = isMuslLibc() ? 'musl' : 'gnu';
    if (arch === 'x64') return `linux-x64-${libc}`;
    if (arch === 'arm64') return `linux-arm64-${libc}`;
    return null;
  }

  return null;
}

function isMuslLibc(): boolean {
  try {
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: string }; sharedObjects?: string[] }
      | undefined;

    if (typeof report?.header?.glibcVersionRuntime === 'string') return false;

    const objects = report?.sharedObjects ?? [];
    return objects.some((o) => o.includes('libc.musl-') || o.includes('ld-musl-'));
  } catch {
    // Assume the far more common glibc when the runtime refuses to tell us.
    return false;
  }
}

interface TarEntry {
  name: string;
  data: Buffer;
}

/**
 * Reads a single file out of an uncompressed tar archive.
 *
 * npm tarballs are plain ustar, so a ~40 line reader avoids pulling a tar
 * dependency into a mini tool that must bundle everything it uses.
 */
function readTarEntry(tar: Buffer, matches: (name: string) => boolean): TarEntry | null {
  const BLOCK = 512;
  let offset = 0;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);

    // Two consecutive zero blocks mark the end of the archive.
    if (header.every((byte) => byte === 0)) break;

    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(readString(header, 124, 12).trim() || '0', 8) || 0;
    const typeFlag = String.fromCharCode(header[156]!);

    offset += BLOCK;

    const isFile = typeFlag === '0' || typeFlag === '\0';
    if (isFile && matches(fullName)) {
      return { name: fullName, data: tar.subarray(offset, offset + size) };
    }

    offset += Math.ceil(size / BLOCK) * BLOCK;
  }

  return null;
}

function readString(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length).toString('utf8');
  const end = raw.indexOf('\0');
  return end === -1 ? raw : raw.slice(0, end);
}

function verifyIntegrity(data: Buffer, integrity: string | undefined, shasum: string | undefined): void {
  if (integrity) {
    const [algorithm, expected] = integrity.split('-');
    if (algorithm && expected) {
      const actual = createHash(algorithm).update(data).digest('base64');
      if (actual !== expected) {
        throw new Error('downloaded engine failed its integrity check');
      }
      return;
    }
  }

  if (shasum) {
    const actual = createHash('sha1').update(data).digest('hex');
    if (actual !== shasum) {
      throw new Error('downloaded engine failed its checksum check');
    }
    return;
  }

  throw new Error('registry did not provide a checksum for the engine');
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`registry request failed (${response.status})`);
  }
  return (await response.json()) as Record<string, unknown>;
}

/** Downloads, verifies and caches the native binary, returning its path. */
async function installEngine(
  target: string,
  destination: string,
  onProgress?: ProgressReporter,
): Promise<void> {
  const packageName = `${SCOPE}/anydoc-${target}`;

  onProgress?.('Locating document engine…', 5);
  const manifest = await fetchJson(`${REGISTRY}/${encodeURIComponent(packageName)}/${ENGINE_VERSION}`);
  const dist = manifest.dist as { tarball?: string; integrity?: string; shasum?: string } | undefined;
  const tarball = dist?.tarball;

  if (!tarball) {
    throw new Error(`registry has no download for ${packageName}@${ENGINE_VERSION}`);
  }

  onProgress?.('Downloading document engine (~7 MB)…', 20);
  const response = await fetch(tarball);
  if (!response.ok) {
    throw new Error(`engine download failed (${response.status})`);
  }
  const archive = Buffer.from(await response.arrayBuffer());

  onProgress?.('Verifying document engine…', 75);
  verifyIntegrity(archive, dist?.integrity, dist?.shasum);

  onProgress?.('Unpacking document engine…', 85);
  const entry = readTarEntry(gunzipSync(archive), (name) => name.endsWith('.node'));
  if (!entry) {
    throw new Error('engine archive did not contain a native binary');
  }

  mkdirSync(dirname(destination), { recursive: true });

  // Write to a unique temporary name first so a crashed or concurrent install
  // can never leave a half written binary behind for the next call to load.
  const staging = `${destination}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(staging, entry.data, { mode: 0o755 });
  renameSync(staging, destination);
}

let cached: DocumentEngine | null = null;
let pending: Promise<DocumentEngine> | null = null;

/**
 * Returns the document engine, installing it on first use.
 * Concurrent callers share a single install.
 */
export function loadEngine(storagePath: string, onProgress?: ProgressReporter): Promise<DocumentEngine> {
  if (cached) return Promise.resolve(cached);
  if (pending) return pending;

  pending = (async () => {
    const target = detectTarget();
    if (!target) {
      throw new Error(
        `AnyDoc has no document engine for ${process.platform}/${process.arch}. ` +
          'Supported: macOS (arm64/x64), Linux (x64/arm64, glibc/musl), Windows (x64). ' +
          'Windows on ARM is not supported because upstream publishes no build for it.',
      );
    }

    // Check before spending a 7 MB download on a binary that cannot be loaded.
    if (missingVisualCppRuntime()) {
      throw new Error(VC_REDIST_HINT);
    }

    const binaryPath = join(storagePath, 'engine', ENGINE_VERSION, `anydoc.${target}.node`);
    const load = createRequire(import.meta.url);

    const wasCached = existsSync(binaryPath);
    if (!wasCached) {
      await installEngine(target, binaryPath, onProgress);
    }

    let engine: DocumentEngine;
    try {
      engine = load(binaryPath) as DocumentEngine;
    } catch (error) {
      // A cached binary that will not load is almost always a truncated or
      // corrupted download from an earlier run. Heal it instead of asking the
      // user to go delete files, but only retry a copy we did not just fetch.
      if (!wasCached || isMissingSystemLibrary(error)) {
        throw new Error(describeLoadFailure(error, binaryPath));
      }

      rmSync(binaryPath, { force: true });
      await installEngine(target, binaryPath, onProgress);

      try {
        engine = load(binaryPath) as DocumentEngine;
      } catch (retryError) {
        throw new Error(describeLoadFailure(retryError, binaryPath));
      }
    }

    if (typeof engine.toMarkdown !== 'function') {
      throw new Error('document engine loaded but exposes no toMarkdown function');
    }

    cached = engine;
    return engine;
  })();

  pending = pending.finally(() => {
    pending = null;
  });

  return pending;
}

/**
 * Turns a native module load failure into something the user can act on.
 * The raw dlopen errors ("The specified module could not be found") name the
 * .node file rather than the missing system library, which sends people
 * looking in the wrong place.
 */
function describeLoadFailure(error: unknown, binaryPath: string): string {
  const message = error instanceof Error ? error.message : String(error);

  if (isMissingSystemLibrary(error)) {
    return `${VC_REDIST_HINT} (original error: ${message})`;
  }

  return (
    `AnyDoc could not load its document engine: ${message}. ` +
    `Delete ${binaryPath} and try again to force a fresh download.`
  );
}

/**
 * True when Windows refused the module because a dependent DLL is absent
 * rather than because our own file is broken. Re-downloading cannot fix that,
 * so these failures must not trigger the self-healing retry.
 */
function isMissingSystemLibrary(error: unknown): boolean {
  if (process.platform !== 'win32') return false;
  const message = error instanceof Error ? error.message : String(error);
  return /specified module could not be found|specified procedure could not be found|error code 126|127/i.test(
    message,
  );
}

/** Whether the engine is already installed locally, for status reporting. */
export function isEngineInstalled(storagePath: string): boolean {
  const target = detectTarget();
  if (!target) return false;
  return existsSync(join(storagePath, 'engine', ENGINE_VERSION, `anydoc.${target}.node`));
}

/**
 * Resolves the ppu-paddle-ocr standalone engine binary.
 *
 * ppu-paddle-ocr publishes self-contained per-platform executables as GitHub
 * Release assets (no Node/Bun, no `onnxruntime-node` npm peer dependency,
 * ~50-70 MB). That is a far better fit for a mini tool than the npm package,
 * whose `onnxruntime-node` peer alone ships ~258 MB of native binaries and
 * cannot be bundled at build time. So instead of `require()`-ing a native
 * addon, this mini tool downloads the matching "slim" binary on first use,
 * verifies it against the GitHub release's published sha256 digest, caches
 * it under the mini tool's storage directory, and later spawns it as a
 * plain child process.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync, inflateRawSync } from 'node:zlib';

const execFileAsync = promisify(execFile);

/** Pinned upstream release. Bump deliberately, never resolve "latest" at runtime. */
export const ENGINE_VERSION = '6.5.1';

const REPO = 'PT-Perkasa-Pilar-Utama/ppu-paddle-ocr';
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/tags/v${ENGINE_VERSION}`;

export type ProgressReporter = (message: string, percent?: number) => void;

export interface EngineTarget {
  /** Asset platform suffix used in the release filename, e.g. "darwin-arm64". */
  assetPlatform: string;
  /** Archive format for that asset. */
  archiveType: 'tar.gz' | 'zip';
  /** Executable name inside the archive. */
  binaryName: string;
}

/** Maps the current process to a published ppu-paddle-ocr release asset. */
export function detectTarget(): EngineTarget | null {
  const { platform, arch } = process;

  // No darwin-x64 (Intel Mac) build is published upstream as of ENGINE_VERSION.
  if (platform === 'darwin' && arch === 'arm64') {
    return { assetPlatform: 'darwin-arm64', archiveType: 'tar.gz', binaryName: 'ppu-paddle-ocr' };
  }

  if (platform === 'linux' && arch === 'x64') {
    return { assetPlatform: 'linux-x64', archiveType: 'tar.gz', binaryName: 'ppu-paddle-ocr' };
  }

  if (platform === 'linux' && arch === 'arm64') {
    return { assetPlatform: 'linux-arm64', archiveType: 'tar.gz', binaryName: 'ppu-paddle-ocr' };
  }

  if (platform === 'win32' && arch === 'x64') {
    return { assetPlatform: 'windows-x64', archiveType: 'zip', binaryName: 'ppu-paddle-ocr.exe' };
  }

  return null;
}

function assetFileName(target: EngineTarget): string {
  const ext = target.archiveType === 'zip' ? 'zip' : 'tar.gz';
  return `ppu-paddle-ocr-${target.assetPlatform}-slim.${ext}`;
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'finch-ocr' },
  });
  if (!response.ok) {
    throw new Error(`GitHub release lookup failed (${response.status})`);
  }
  return (await response.json()) as Record<string, unknown>;
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  digest?: string;
}

async function findAsset(target: EngineTarget): Promise<ReleaseAsset> {
  const release = await fetchJson(RELEASE_API);
  const assets = (release.assets as ReleaseAsset[] | undefined) ?? [];
  const name = assetFileName(target);
  const asset = assets.find((item) => item.name === name);
  if (!asset) {
    throw new Error(`ppu-paddle-ocr v${ENGINE_VERSION} has no published asset named ${name}`);
  }
  return asset;
}

function verifyDigest(data: Buffer, digest: string | undefined): void {
  if (!digest) return; // best effort: older releases may omit it
  const [algorithm, expected] = digest.split(':');
  if (!algorithm || !expected) return;
  const actual = createHash(algorithm).update(data).digest('hex');
  if (actual !== expected) {
    throw new Error('downloaded OCR engine failed its sha256 checksum check');
  }
}

// ---------------------------------------------------------------------------
// Minimal archive readers. A tar/zip dependency would defeat the point of a
// mini tool that must bundle everything it uses, so both formats are read
// with a couple dozen lines each, extracting only the one entry we need.
// ---------------------------------------------------------------------------

function readTarEntry(tar: Buffer): Buffer | null {
  const BLOCK = 512;
  let offset = 0;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;

    const size = Number.parseInt(readTarString(header, 124, 12).trim() || '0', 8) || 0;
    const typeFlag = String.fromCharCode(header[156] ?? 0);

    offset += BLOCK;

    // ppu-paddle-ocr release archives contain exactly one regular file, named
    // after the asset itself (e.g. "ppu-paddle-ocr-darwin-arm64-slim") rather
    // than a fixed binary name — take the first regular file we find.
    const isFile = typeFlag === '0' || typeFlag === '\0';
    if (isFile && size > 0) {
      return Buffer.from(tar.subarray(offset, offset + size));
    }

    offset += Math.ceil(size / BLOCK) * BLOCK;
  }

  return null;
}

function readTarString(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length).toString('utf8');
  const end = raw.indexOf('\0');
  return end === -1 ? raw : raw.slice(0, end);
}

/** Reads the first file entry out of a ZIP archive via its central directory
 * (store or deflate only). ppu-paddle-ocr's zip assets contain exactly one
 * file, named after the asset itself rather than a fixed binary name. */
function readZipEntry(zip: Buffer): Buffer | null {
  const EOCD_SIG = 0x06054b50;
  const CEN_SIG = 0x02014b50;
  const LOC_SIG = 0x04034b50;

  let eocdOffset = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('not a valid zip archive (no end-of-central-directory record)');

  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  const cenOffset = zip.readUInt32LE(eocdOffset + 16);

  let offset = cenOffset;
  for (let i = 0; i < entryCount; i++) {
    if (zip.readUInt32LE(offset) !== CEN_SIG) break;

    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const externalAttrs = zip.readUInt32LE(offset + 38);
    const localHeaderOffset = zip.readUInt32LE(offset + 42);

    offset += 46 + nameLength + extraLength + commentLength;

    // Skip directory entries (unix mode S_IFDIR bit in the high 16 bits).
    const unixMode = externalAttrs >>> 16;
    const isDirectory = unixMode !== 0 && (unixMode & 0o170000) === 0o40000;
    if (isDirectory) continue;

    if (zip.readUInt32LE(localHeaderOffset) !== LOC_SIG) {
      throw new Error('zip local file header mismatch');
    }
    const localNameLength = zip.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = zip.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const raw = zip.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) return Buffer.from(raw);
    if (method === 8) return inflateRawSync(raw);
    throw new Error(`unsupported zip compression method ${method}`);
  }

  return null;
}

function extractBinary(archive: Buffer, target: EngineTarget): Buffer {
  const data = target.archiveType === 'zip' ? readZipEntry(archive) : readTarEntry(gunzipSync(archive));

  if (!data) {
    throw new Error(`engine archive for ${target.assetPlatform} appears to be empty`);
  }
  return data;
}

/** Clears the macOS quarantine attribute so ad-hoc-signed binaries are not blocked by Gatekeeper. */
async function clearQuarantine(binaryPath: string): Promise<void> {
  if (process.platform !== 'darwin') return;
  try {
    await execFileAsync('xattr', ['-d', 'com.apple.quarantine', binaryPath]);
  } catch {
    // No quarantine attribute present, or xattr unavailable — not fatal either way.
  }
}

async function installEngine(
  target: EngineTarget,
  destination: string,
  onProgress?: ProgressReporter,
): Promise<void> {
  onProgress?.('Locating OCR engine…', 5);
  const asset = await findAsset(target);

  onProgress?.('Downloading OCR engine (tens of MB)…', 15);
  const response = await fetch(asset.browser_download_url);
  if (!response.ok) {
    throw new Error(`engine download failed (${response.status})`);
  }
  const archive = Buffer.from(await response.arrayBuffer());

  onProgress?.('Verifying OCR engine…', 75);
  verifyDigest(archive, asset.digest);

  onProgress?.('Unpacking OCR engine…', 85);
  const binary = extractBinary(archive, target);

  mkdirSync(dirname(destination), { recursive: true });

  // Write to a unique temp name first so a crashed/concurrent install never
  // leaves a half-written binary behind for the next call to spawn.
  const staging = `${destination}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(staging, binary, { mode: 0o755 });
  renameSync(staging, destination);
  chmodSync(destination, 0o755);

  onProgress?.('Clearing macOS quarantine flag…', 95);
  await clearQuarantine(destination);
}

let cachedPath: string | null = null;
let pending: Promise<string> | null = null;

function engineRoot(storagePath: string): string {
  return join(storagePath, 'engine');
}

function binaryDestination(storagePath: string, target: EngineTarget): string {
  return join(engineRoot(storagePath), ENGINE_VERSION, target.assetPlatform, target.binaryName);
}

/** Best-effort cleanup of engine binaries from versions other than the pinned one. */
function pruneOldEngines(storagePath: string): void {
  const root = engineRoot(storagePath);
  try {
    for (const entry of readdirSync(root)) {
      if (entry !== ENGINE_VERSION) {
        rmSync(join(root, entry), { recursive: true, force: true });
      }
    }
  } catch {
    // Ignore: pruning must never break a successful load.
  }
}

/** Returns the local engine binary path, downloading and caching it on first use. */
export function loadEngine(storagePath: string, onProgress?: ProgressReporter): Promise<string> {
  if (cachedPath && existsSync(cachedPath)) return Promise.resolve(cachedPath);
  if (pending) return pending;

  pending = (async () => {
    const target = detectTarget();
    if (!target) {
      throw new Error(
        `No ppu-paddle-ocr engine build is published for ${process.platform}/${process.arch}. ` +
          'Supported today: macOS Apple Silicon (darwin arm64), Linux x64/arm64, Windows x64. ' +
          'Intel-based macOS (darwin x64) has no upstream build yet.',
      );
    }

    const destination = binaryDestination(storagePath, target);
    const wasCached = existsSync(destination);

    if (!wasCached) {
      await installEngine(target, destination, onProgress);
    } else {
      // A previously installed binary may predate the quarantine fix or have
      // lost +x after being copied around; keep both idempotent.
      chmodSync(destination, 0o755);
      await clearQuarantine(destination);
    }

    cachedPath = destination;
    pruneOldEngines(storagePath);
    return destination;
  })();

  pending = pending.finally(() => {
    pending = null;
  });

  return pending;
}

export function isEngineInstalled(storagePath: string): boolean {
  const target = detectTarget();
  if (!target) return false;
  return existsSync(binaryDestination(storagePath, target));
}

export function engineBinaryPath(storagePath: string): string | null {
  const target = detectTarget();
  if (!target) return null;
  return binaryDestination(storagePath, target);
}

/** Removes the cached engine binary (all versions) so the next call re-downloads it. */
export function clearEngineCache(storagePath: string): void {
  cachedPath = null;
  rmSync(engineRoot(storagePath), { recursive: true, force: true });
}

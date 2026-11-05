import { copyFile, lstat, rm, symlink as nativeSymlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { closeFixtures } from './test-store.mjs';

export async function fixtureRm(path, options) {
  await closeFixtures(path);
  return rm(path, options);
}

export const nativeTarget = process.platform === 'darwin' ? `darwin-${process.arch}`
  : process.platform === 'win32' ? `win32-${process.arch}-msvc` : `${process.platform}-${process.arch}-gnu`;

// Load the packaged bridge against node_modules once. Windows locks loaded DLLs until process
// exit; loading a temporary fixture copy would make its cleanup fail despite correct behaviour.
const previous = process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
try {
  process.env.NAPI_RS_NATIVE_LIBRARY_PATH = resolve(`node_modules/@lancedb/lancedb-${nativeTarget}/lancedb.${nativeTarget}.node`);
  createRequire(import.meta.url)('../dist/native.cjs');
} finally {
  if (previous === undefined) delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
  else process.env.NAPI_RS_NATIVE_LIBRARY_PATH = previous;
}

/** Native fixtures use copies; security fixtures use unprivileged Windows directory junctions. */
export async function fixtureLink(source, target) {
  if (source.endsWith('.node')) return copyFile(source, target);
  if (process.platform !== 'win32') return nativeSymlink(source, target);
  const directory = (await lstat(source)).isDirectory() ? source : dirname(source);
  return nativeSymlink(directory, target, 'junction');
}

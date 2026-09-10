import { build } from 'esbuild';
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');
const linuxPtyRoot = path.join(root, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch');
const nodePtyRoot = path.join(root, 'node_modules', 'node-pty');
const isLinux = process.platform === 'linux';
const runtimeRoot = isLinux ? linuxPtyRoot : nodePtyRoot;

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: [path.join(root, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: path.join(dist, 'index.js'),
  external: ['./node-pty/lib/index.js'],
});

await build({
  entryPoints: [path.join(root, 'src/panel.ts')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome120',
  minify: true,
  outfile: path.join(dist, 'panel.js'),
});

await cp(path.join(root, 'src/panel.html'), path.join(dist, 'panel.html'));
const runtimeDir = path.join(dist, 'node-pty');
const runtimeLibDir = path.join(runtimeDir, 'lib');
await cp(path.join(runtimeRoot, 'lib'), runtimeLibDir, { recursive: true });
for (const entry of await readdir(runtimeLibDir, { recursive: true })) {
  if (entry.endsWith('.map') || entry.includes('.test.')) await rm(path.join(runtimeLibDir, entry));
}
await cp(path.join(runtimeRoot, 'LICENSE'), path.join(runtimeDir, 'LICENSE'));
await writeFile(path.join(runtimeDir, 'package.json'), JSON.stringify({
  name: 'node-pty-runtime',
  private: true,
  type: 'commonjs',
}, null, 2) + '\n');

if (isLinux) {
  // The bundled Linux binaries are Node-API addons, so any of them loads in
  // both Node and Electron hosts regardless of ABI number. Upstream instead
  // resolves one exact `<runtime>.abi<modules>.node` filename, which misses
  // whenever the host is Electron (its ABI differs from Node's and no
  // `electron.*` build is published) and then falls back to a non-existent
  // `build/Release/pty.node`. Resolve the file ourselves instead.
  await cp(path.join(linuxPtyRoot, 'prebuilds'), path.join(runtimeDir, 'prebuilds'), { recursive: true });
  await writeFile(path.join(runtimeLibDir, 'prebuild-file-path.js'), `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ptyPath = void 0;
var fs = require("fs");
var os = require("os");
var path = require("path");

function isMusl() {
  if (fs.existsSync('/etc/alpine-release')) return true;
  try {
    var report = process.report && typeof process.report.getReport === 'function' ? process.report.getReport() : null;
    if (report && report.header && !report.header.glibcVersionRuntime) return true;
  } catch (error) {
    // Fall through to the glibc assumption.
  }
  return false;
}

function abiOf(name) {
  var match = /^node\\.abi(\\d+)(\\.musl)?\\.node$/.exec(name);
  return match ? Number(match[1]) : null;
}

function resolvePtyPath() {
  var dir = path.resolve(__dirname, '../prebuilds/' + os.platform() + '-' + os.arch());
  var files;
  try {
    files = fs.readdirSync(dir);
  } catch (error) {
    return null;
  }
  var musl = isMusl();
  var runtimeAbi = Number(process.versions.modules);
  var matching = files.filter(function (name) {
    return abiOf(name) !== null && name.indexOf('.musl.node') !== -1 === musl;
  });
  // Prefer the host's own ABI, then the closest lower build, then anything.
  var candidates = files.indexOf('node.abi' + runtimeAbi + (musl ? '.musl' : '') + '.node') !== -1
    ? [dir + path.sep + 'node.abi' + runtimeAbi + (musl ? '.musl' : '') + '.node']
    : [];
  matching
    .sort(function (a, b) { return abiOf(b) - abiOf(a); })
    .forEach(function (name) { candidates.push(path.join(dir, name)); });
  for (var index = 0; index < candidates.length; index += 1) {
    if (fs.existsSync(candidates[index])) return candidates[index];
  }
  return null;
}

exports.ptyPath = resolvePtyPath();
//# sourceMappingURL=prebuild-file-path.js.map
`);
} else {
  const nativeRoot = path.join(dist, 'native');
  await mkdir(nativeRoot, { recursive: true });
  const supportedTargets = [];
  const prebuildRoot = path.join(nodePtyRoot, 'prebuilds');
  for (const entry of await readdir(prebuildRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const targetDir = path.join(nativeRoot, entry.name);
    await cp(path.join(prebuildRoot, entry.name), targetDir, { recursive: true });
    if (entry.name.startsWith('darwin-')) await chmod(path.join(targetDir, 'spawn-helper'), 0o755);
    supportedTargets.push(entry.name);
  }

  // Keep node-pty's JS loader beside the host bundle, but point native lookup
  // at the explicit runtime resource directory shipped in the Finch tarball.
  const utilsPath = path.join(runtimeLibDir, 'utils.js');
  const utilsSource = await readFile(utilsPath, 'utf8');
  const patchedUtils = utilsSource
    .replace("var dirs = ['build/Release', 'build/Debug', \"prebuilds/\" + process.platform + \"-\" + process.arch];", "var dirs = [\"../../native/\" + process.platform + \"-\" + process.arch];")
    .replace("var relative = ['..', '.'];", "var relative = ['.'];");
  if (patchedUtils === utilsSource) throw new Error('node-pty native loader patch did not match');
  await writeFile(utilsPath, patchedUtils);
  await writeFile(path.join(nativeRoot, 'platform.json'), JSON.stringify({
    supportedTargets: supportedTargets.sort(),
    nodePtyVersion: JSON.parse(await readFile(path.join(nodePtyRoot, 'package.json'), 'utf8')).version,
  }, null, 2) + '\n');
}

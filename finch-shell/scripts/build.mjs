import { build } from 'esbuild';
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');
// node-pty publishes macOS and Windows prebuilds but no Linux ones, so Linux
// uses the Homebridge fork. Both dependencies ship every platform's binaries in
// their own npm tarball, so a build on any host produces a package that runs on
// all of them — never gate this on the build machine's platform.
const nodePtyRoot = path.join(root, 'node_modules', 'node-pty');
const linuxPtyRoot = path.join(root, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: [path.join(root, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: path.join(dist, 'index.js'),
  external: ['./node-pty/lib/index.js', './node-pty-linux/lib/index.js'],
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

/** Copy one node-pty flavour's JS loader next to the host bundle. */
async function stageRuntime(sourceRoot, dirName) {
  const runtimeDir = path.join(dist, dirName);
  const libDir = path.join(runtimeDir, 'lib');
  await cp(path.join(sourceRoot, 'lib'), libDir, { recursive: true });
  for (const entry of await readdir(libDir, { recursive: true })) {
    if (entry.endsWith('.map') || entry.includes('.test.')) await rm(path.join(libDir, entry));
  }
  await cp(path.join(sourceRoot, 'LICENSE'), path.join(runtimeDir, 'LICENSE'));
  await writeFile(path.join(runtimeDir, 'package.json'), JSON.stringify({
    name: `${dirName}-runtime`,
    private: true,
    type: 'commonjs',
  }, null, 2) + '\n');
  return { runtimeDir, libDir };
}

// macOS and Windows: binaries are named `pty.node` with no ABI tag, so the
// loader only needs to look in the right platform-arch directory.
const desktop = await stageRuntime(nodePtyRoot, 'node-pty');
const nativeRoot = path.join(dist, 'native');
await mkdir(nativeRoot, { recursive: true });
const supportedTargets = [];
const prebuildRoot = path.join(nodePtyRoot, 'prebuilds');
for (const entry of await readdir(prebuildRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const targetDir = path.join(nativeRoot, entry.name);
  await cp(path.join(prebuildRoot, entry.name), targetDir, {
    recursive: true,
    filter: (source) => !source.endsWith('.pdb'),
  });
  if (entry.name.startsWith('darwin-')) await chmod(path.join(targetDir, 'spawn-helper'), 0o755);
  supportedTargets.push(entry.name);
}

// Keep node-pty's JS loader beside the host bundle, but point native lookup at
// the explicit runtime resource directory shipped in the Finch tarball.
const utilsPath = path.join(desktop.libDir, 'utils.js');
const utilsSource = await readFile(utilsPath, 'utf8');
const patchedUtils = utilsSource
  .replace("var dirs = ['build/Release', 'build/Debug', \"prebuilds/\" + process.platform + \"-\" + process.arch];", "var dirs = [\"../../native/\" + process.platform + \"-\" + process.arch];")
  .replace("var relative = ['..', '.'];", "var relative = ['.'];");
if (patchedUtils === utilsSource) throw new Error('node-pty native loader patch did not match');
await writeFile(utilsPath, patchedUtils);

// Linux: the fork ships one binary per architecture, libc flavour, and Node ABI.
// They are Node-API addons, so any of them loads in both Node and Electron hosts
// regardless of ABI number. Upstream instead resolves a single exact
// `<runtime>.abi<modules>.node` filename, which misses whenever the host is
// Electron (its ABI differs from Node's and no `electron.*` build is published)
// and then falls back to a non-existent `build/Release/pty.node`. Resolve it here.
const linux = await stageRuntime(linuxPtyRoot, 'node-pty-linux');
const linuxPrebuildRoot = path.join(linuxPtyRoot, 'prebuilds');
await cp(linuxPrebuildRoot, path.join(linux.runtimeDir, 'prebuilds'), { recursive: true });
for (const entry of await readdir(linuxPrebuildRoot, { withFileTypes: true })) {
  if (entry.isDirectory()) supportedTargets.push(entry.name);
}
await writeFile(path.join(linux.libDir, 'prebuild-file-path.js'), `"use strict";
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
  var suffix = musl ? '.musl.node' : '.node';
  var exact = 'node.abi' + Number(process.versions.modules) + suffix;
  var candidates = files
    .filter(function (name) {
      return abiOf(name) !== null && (name.indexOf('.musl.node') !== -1) === musl;
    })
    .sort(function (a, b) {
      // Prefer the host's own ABI, then the newest available build.
      if (a === exact) return -1;
      if (b === exact) return 1;
      return abiOf(b) - abiOf(a);
    });
  for (var index = 0; index < candidates.length; index += 1) {
    var candidate = path.join(dir, candidates[index]);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

exports.ptyPath = resolvePtyPath();
//# sourceMappingURL=prebuild-file-path.js.map
`);

await writeFile(path.join(nativeRoot, 'platform.json'), JSON.stringify({
  supportedTargets: [...new Set(supportedTargets)].sort(),
  nodePtyVersion: JSON.parse(await readFile(path.join(nodePtyRoot, 'package.json'), 'utf8')).version,
  linuxNodePtyVersion: JSON.parse(await readFile(path.join(linuxPtyRoot, 'package.json'), 'utf8')).version,
}, null, 2) + '\n');

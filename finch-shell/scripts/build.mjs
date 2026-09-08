import { build } from 'esbuild';
import { chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');
const nodePtyRoot = path.join(root, 'node_modules', 'node-pty');

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
await mkdir(path.join(dist, 'node-pty'), { recursive: true });
const runtimeLibDir = path.join(dist, 'node-pty', 'lib');
await cp(path.join(nodePtyRoot, 'lib'), runtimeLibDir, { recursive: true });
for (const entry of await readdir(runtimeLibDir, { recursive: true })) {
  if (entry.endsWith('.map') || entry.includes('.test.')) await rm(path.join(runtimeLibDir, entry));
}
await cp(path.join(nodePtyRoot, 'LICENSE'), path.join(dist, 'node-pty', 'LICENSE'));
await writeFile(path.join(dist, 'node-pty', 'package.json'), JSON.stringify({
  name: 'node-pty-runtime',
  private: true,
  type: 'commonjs',
}, null, 2) + '\n');

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

// Linux node-pty is compiled locally during npm install rather than shipped as
// an upstream prebuild. Preserve that result when this package is built on Linux.
const localTarget = `${process.platform}-${process.arch}`;
const localRelease = path.join(nodePtyRoot, 'build', 'Release');
try {
  if ((await stat(localRelease)).isDirectory()) {
    const targetDir = path.join(nativeRoot, localTarget);
    await cp(localRelease, targetDir, { recursive: true });
    if (process.platform !== 'win32') await chmod(path.join(targetDir, 'spawn-helper'), 0o755);
    if (!supportedTargets.includes(localTarget)) supportedTargets.push(localTarget);
  }
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}

// Keep node-pty's JS loader beside the host bundle, but point native lookup at
// the explicit runtime resource directory shipped in the Finch tarball.
const utilsPath = path.join(dist, 'node-pty', 'lib', 'utils.js');
const utilsSource = await readFile(utilsPath, 'utf8');
const patchedUtils = utilsSource
  .replace("var dirs = ['build/Release', 'build/Debug', \"prebuilds/\" + process.platform + \"-\" + process.arch];", "var dirs = [\"../../native/\" + process.platform + \"-\" + process.arch];")
  .replace("var relative = ['..', '.'];", "var relative = ['.'];");
if (patchedUtils === utilsSource) throw new Error('node-pty native loader patch did not match');
await writeFile(utilsPath, patchedUtils);
await writeFile(path.join(nativeRoot, 'platform.json'), JSON.stringify({
  builtOn: localTarget,
  supportedTargets: supportedTargets.sort(),
  nodePtyVersion: JSON.parse(await readFile(path.join(nodePtyRoot, 'package.json'), 'utf8')).version,
}, null, 2) + '\n');

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEngine, isEngineInstalled } from '../src/document-engine.js';

// Downloads a real engine archive into a throwaway cache to check that progress
// reports actual bytes against the real total, not a hard-coded guess.
const cache = await mkdtemp(join(tmpdir(), 'kb-download-drill-'));
console.log('cache:', cache);

const reports = [];
try {
  console.log('installed before:', isEngineInstalled(cache));
  const engine = await loadEngine(cache, (message, percent) => {
    reports.push({ message, percent });
    console.log(`  ${percent === undefined ? ' --' : String(percent).padStart(3)}%  ${message}`);
  });
  console.log('installed after :', isEngineInstalled(cache));
  console.log('engine exposes toMarkdown:', typeof engine.toMarkdown === 'function');
  const sized = await stat(join(cache, 'engine', '0.2.3', `anydoc.${process.platform === 'darwin' ? 'darwin-arm64' : `${process.platform}-${process.arch}-gnu`}.node`)).catch(() => null);
  console.log('binary on disk  :', sized ? `${(sized.size / 1024 / 1024).toFixed(1)} MB` : '(not found)');
  const withBytes = reports.filter((report) => /MB|KB|B\b/.test(report.message));
  console.log(`reports carrying real byte counts: ${withBytes.length} / ${reports.length}`);
  console.log('distinct percent values:', [...new Set(reports.map((report) => report.percent))].join(', '));
} finally {
  await rm(cache, { recursive: true, force: true });
}

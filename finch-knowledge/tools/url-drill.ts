import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fetchArticle } from '../src/article.js';
import { KnowledgeStore } from '../src/store.js';

// Fetches real pages, extracts them, indexes them into a throwaway library, then searches.
// Usage: node tools/drill-build.mjs tools/url-drill.ts && node /tmp/url-drill.mjs <url> [url…]
const cache = join(homedir(), '.finch', 'extension-data', 'finch-knowledge');
const library = await mkdtemp(join(tmpdir(), 'kb-url-drill-'));
const store = new KnowledgeStore(library, { cachePath: cache });

const targets = process.argv.slice(2);
if (!targets.length) {
  console.error('usage: node /tmp/url-drill.mjs <url> [url…]');
  process.exit(1);
}

try {
  for (const target of targets) {
    console.log(`\n=== ${target}`);
    try {
      const article = await fetchArticle(target);
      console.log(`  title    : ${article.title || '(none)'}`);
      console.log(`  length   : ${article.length} chars`);
      console.log(`  suspect  : ${article.suspect}${article.reason ? ` — ${article.reason}` : ''}`);
      for (const line of article.markdown.split('\n').filter(Boolean).slice(0, 4)) {
        console.log(`  | ${line.slice(0, 110)}`);
      }
      const name = `${(article.title || 'article').replace(/[/\\:]/g, ' ').slice(0, 80)}.md`;
      const target_path = await store.uploadTarget('default', name);
      await mkdir(dirname(target_path), { recursive: true });
      await writeFile(target_path, article.markdown, 'utf8');
      const indexed = await store.importFile(target_path, name, 'default');
      console.log(`  indexed  : ${indexed.document.chunks} chunks, id ${indexed.document.id}`);
      const query = article.title.split(/[\s|:—–-]+/).filter((word) => word.length > 4)[0] ?? 'the';
      const hits = await store.search(query, 2);
      console.log(`  search "${query}": ${hits.map((hit) => hit.name).join(', ') || '(none)'}`);
    } catch (error) {
      console.log(`  FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} finally {
  await store.close();
  await rm(library, { recursive: true, force: true });
}

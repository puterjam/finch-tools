/**
 * Lightweight local retrieval over the Finch documentation knowledge base.
 *
 * Zero-dependency BM25-style keyword search with a tiny CJK-aware tokenizer:
 * English words are split on non-alphanumeric runs, Chinese text is cut into
 * bigrams. The inverted index is built lazily on the first query and cached.
 *
 * Title and heading tokens are weighted higher than body tokens so that
 * section names ("Session 容器", "Memory") surface strong matches.
 */

export interface KbChunk {
  id: string;
  doc: string;
  lang: 'zh' | 'en';
  title: string;
  heading: string;
  text: string;
}

export interface KbData {
  source: string;
  generatedAt: string;
  chunkCount: number;
  chunks: KbChunk[];
}

export interface SearchResult {
  id: string;
  doc: string;
  lang: 'zh' | 'en';
  title: string;
  heading: string;
  text: string;
  score: number;
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const WORD_RE = /[a-z0-9]+/g;
const TITLE_WEIGHT = 2.0;
const K1 = 1.2;
const B = 0.75;

const STOPWORDS = new Set([
  // English
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'at',
  'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its',
  'this', 'that', 'these', 'those', 'do', 'does', 'did', 'can', 'could',
  'will', 'would', 'should', 'may', 'might', 'must', 'not', 'no', 'but',
  'if', 'then', 'than', 'so', 'too', 'very', 'just', 'about', 'into', 'over',
  'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how', 'all', 'any',
  'each', 'more', 'most', 'some', 'such', 'only', 'own', 'same', 'both',
  // Chinese single chars that carry little signal
  '的', '了', '在', '是', '我', '你', '他', '她', '它', '这', '那', '有', '和',
  '与', '就', '不', '也', '都', '而', '及', '等', '用', '把', '被', '让', '给',
  '对', '从', '到', '说', '问', '请', '么', '吧', '吗', '呢', '啊',
]);

const LANG_HINTS = new Map([
  ['en', new Set(['the', 'and', 'with', 'for', 'how', 'what', 'does', 'finch', 'minitool'])],
  ['zh', new Set(['的', '了', '是', '在', '和', '与', '用', '把', '被', '让', '给', '对', '从', '到'])],
]);

function isCjk(char: string): boolean {
  return CJK_RE.test(char);
}

/** Tokenize mixed English / Chinese text into index terms. */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  let i = 0;

  while (i < lower.length) {
    const ch = lower[i];
    if (isCjk(ch)) {
      const start = i;
      while (i < lower.length && isCjk(lower[i])) i++;
      const seg = lower.slice(start, i);
      if (seg.length === 1) {
        if (!STOPWORDS.has(seg)) tokens.push(seg);
      } else {
        for (let j = 0; j < seg.length - 1; j++) {
          const bigram = seg.slice(j, j + 2);
          if (!STOPWORDS.has(bigram)) tokens.push(bigram);
        }
      }
    } else if (WORD_RE.test(ch)) {
      WORD_RE.lastIndex = i;
      const m = WORD_RE.exec(lower);
      if (!m) break;
      const word = m[0];
      if (word.length > 1 && !STOPWORDS.has(word)) tokens.push(word);
      i = m.index + m[0].length;
    } else {
      i++;
    }
  }
  return tokens;
}

interface Posting {
  chunk: number;
  tf: number;
}

interface TermIndex {
  df: number;
  postings: Posting[];
}

interface BuiltIndex {
  terms: Map<string, TermIndex>;
  docLen: number[];
  avgdl: number;
}

let cached: { data: KbData; index: BuiltIndex } | null = null;

/** Build (or reuse) the in-memory inverted index over the knowledge base. */
export function getIndex(data: KbData): BuiltIndex {
  if (cached?.data === data) return cached.index;
  const index = buildIndex(data);
  cached = { data, index };
  return index;
}

function buildIndex(data: KbData): BuiltIndex {
  const terms = new Map<string, TermIndex>();
  const docLen: number[] = [];
  let total = 0;

  const bump = (term: string, chunk: number, weight: number) => {
    let entry = terms.get(term);
    if (!entry) {
      entry = { df: 0, postings: [] };
      terms.set(term, entry);
    }
    const last = entry.postings[entry.postings.length - 1];
    if (last?.chunk === chunk) {
      last.tf += weight;
    } else {
      entry.postings.push({ chunk, tf: weight });
      entry.df++;
    }
  };

  data.chunks.forEach((chunk, idx) => {
    const titleTokens = tokenize(`${chunk.title} ${chunk.heading}`);
    const bodyTokens = tokenize(chunk.text);
    for (const t of titleTokens) bump(t, idx, TITLE_WEIGHT);
    for (const t of bodyTokens) bump(t, idx, 1);
    const len = titleTokens.length * TITLE_WEIGHT + bodyTokens.length;
    docLen.push(len);
    total += len;
  });

  return { terms, docLen, avgdl: total / Math.max(1, docLen.length) };
}

/** BM25 score for a single term against one chunk. */
function termScore(term: TermIndex, tf: number, docLen: number, avgdl: number, n: number): number {
  const idf = Math.log(1 + (n - term.df + 0.5) / (term.df + 0.5));
  return idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * docLen) / avgdl)));
}

/** Guess the query language from its tokens (used to nudge result ordering). */
function guessLang(tokens: string[]): 'zh' | 'en' | undefined {
  let zh = 0;
  let en = 0;
  for (const t of tokens) {
    if (isCjk(t[0])) zh++;
    else if (LANG_HINTS.get('en')!.has(t)) en++;
    else if (LANG_HINTS.get('zh')!.has(t)) zh++;
  }
  if (zh === 0 && en === 0) return undefined;
  return zh >= en ? 'zh' : 'en';
}

/**
 * Search the knowledge base. Returns the top `limit` chunks ranked by BM25.
 * When the query is clearly in one language, matching chunks of that language
 * get a small boost so answers come from docs in the user's language.
 */
export function search(data: KbData, query: string, limit = 5): SearchResult[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const { terms, docLen, avgdl } = getIndex(data);
  const lang = guessLang(tokens);
  const n = data.chunks.length;
  const scores = new Map<number, number>();

  for (const token of tokens) {
    const term = terms.get(token);
    if (!term) continue;
    for (const posting of term.postings) {
      const base = termScore(term, posting.tf, docLen[posting.chunk], avgdl, n);
      const boost = lang ? (data.chunks[posting.chunk].lang === lang ? 1.15 : 0.9) : 1;
      scores.set(posting.chunk, (scores.get(posting.chunk) ?? 0) + base * boost);
    }
  }

  const results: SearchResult[] = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([idx, score]) => {
      const chunk = data.chunks[idx];
      return {
        id: chunk.id,
        doc: chunk.doc,
        lang: chunk.lang,
        title: chunk.title,
        heading: chunk.heading,
        text: chunk.text,
        score: Math.round(score * 100) / 100,
      };
    });

  return results;
}

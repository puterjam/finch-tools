#!/usr/bin/env node
/**
 * Builds src/kb.json — the Finch help knowledge base.
 *
 * Sources:
 *   1. The official Finch website docs, at
 *      ~/Workspace/aeolus/finch-website/pages
 *   2. The finch-mini-tool-creator skill docs, at
 *      ~/Workspace/aeolus/finch/skills/finch-mini-tool-creator
 *      (SKILL.md + reference/*.md) — supplements the website with API-level
 *      development details that the site does not cover.
 *
 * The script parses each Markdown file, strips the frontmatter, splits the
 * body into chunks at `##` headings, and writes a compact JSON array consumed
 * by src/search.ts at runtime.
 *
 * Usage:
 *   node scripts/build-kb.mjs [--source <dir>] [--skills <dir>] [--out <file>]
 *
 * The generated src/kb.json is committed to the repo so the package can be
 * built without the website checkout. Re-run this script whenever the docs
 * change, then rebuild and republish.
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_SOURCE = resolve(process.env.HOME ?? '', 'Workspace/aeolus/finch-website/pages');
const DEFAULT_SKILLS = resolve(
  process.env.HOME ?? '',
  'Workspace/aeolus/finch/skills/finch-mini-tool-creator',
);
const DEFAULT_OUT = join(ROOT, 'src', 'kb.json');

function parseArgs(argv) {
  const args = { source: DEFAULT_SOURCE, skills: DEFAULT_SKILLS, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--source') args.source = resolve(argv[++i]);
    else if (argv[i] === '--skills') args.skills = resolve(argv[++i]);
    else if (argv[i] === '--out') args.out = resolve(argv[++i]);
  }
  return args;
}

/** Collect Markdown files under `dir`, optionally limited to named subfolders. */
function collectFiles(dir, includeDirs) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.md')) {
        files.push(full);
      }
    }
  };
  for (const sub of includeDirs) {
    const dirPath = join(dir, sub);
    try {
      walk(dirPath);
    } catch {
      console.warn(`[kb] skipped missing directory: ${dirPath}`);
    }
  }
  return files.sort();
}

/**
 * Collect the finch-mini-tool-creator skill docs: SKILL.md plus every
 * reference/*.md except the index README and the raw finch.d.ts dump.
 */
function collectSkillFiles(dir) {
  const files = [];
  try {
    statSync(join(dir, 'SKILL.md'));
    files.push(join(dir, 'SKILL.md'));
  } catch {
    /* no SKILL.md */
  }
  try {
    for (const entry of readdirSync(join(dir, 'reference')).sort()) {
      if (entry.endsWith('.md') && entry !== 'README.md') {
        files.push(join(dir, 'reference', entry));
      }
    }
  } catch {
    /* no reference/ */
  }
  return files.sort();
}

/**
 * Parse a skill doc: strip the YAML frontmatter, take the first `# ` heading
 * as the title, then reuse the same `##`-section chunking as website pages.
 * Skill docs are English, so chunks get `lang: 'en'`.
 */
function parseSkillMarkdown(raw, fallbackTitle) {
  const fmMatch = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
  const body = fmMatch ? raw.slice(fmMatch[0].length) : raw;
  let title = fallbackTitle;
  const h1 = /^#\s+(.+)$/m.exec(body);
  if (h1) title = h1[1].trim().replace(/[`*_]/g, '');
  return splitChunks({ title, summary: '', label: '', body });
}

/** Extract frontmatter (title / summary / label) and the body text. */
function parseMarkdown(raw) {
  let title = basename(raw).replace(/\.(en\.)?md$/, '');
  let summary = '';
  let label = '';
  let body = raw;

  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (fmMatch) {
    body = raw.slice(fmMatch[0].length);
    for (const line of fmMatch[1].split(/\r?\n/)) {
      const m = /^(\w+):\s*(.*)$/.exec(line);
      if (!m) continue;
      const value = m[2].trim().replace(/^["']|["']$/g, '');
      if (m[1] === 'title') title = value;
      else if (m[1] === 'summary') summary = value;
      else if (m[1] === 'label') label = value;
    }
  }
  return { title, summary, label, body };
}

function detectLang(filePath) {
  return /\.en\.md$/.test(filePath) ? 'en' : 'zh';
}

/**
 * Split the body into chunks. The intro (text before the first `##`) becomes an
 * "overview" chunk; each `##` section becomes its own chunk. Chunk text keeps
 * the H1 title and heading so matches carry their own context.
 */
function splitChunks({ title, summary, label, body }) {
  const headingRe = /^#{2,4}\s+(.+)$/gm;
  const chunks = [];
  let lastIndex = 0;
  let heading = '';

  for (const m of body.matchAll(headingRe)) {
    const intro = body.slice(lastIndex, m.index).trim();
    if (intro) {
      chunks.push({ heading, text: intro });
    }
    heading = m[1].trim().replace(/[`*_]/g, '');
    lastIndex = m.index + m[0].length;
  }

  const tail = body.slice(lastIndex).trim();
  if (tail) {
    chunks.push({ heading, text: tail });
  }

  if (chunks.length === 0) {
    chunks.push({ heading: '', text: body.trim() });
  }

  const parts = [];
  for (const chunk of chunks) {
    const headingLine = chunk.heading ? `## ${chunk.heading}\n\n` : '';
    const summaryLine = summary ? `${summary}\n\n` : '';
    parts.push({
      title,
      heading: chunk.heading,
      text: `${headingLine}${summaryLine}${chunk.text}`,
    });
  }
  return { title, summary, label, parts };
}

function build(args) {
  const files = collectFiles(args.source, ['docs', 'Changelog']);
  const chunks = [];

  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const { title, summary, label, body } = parseMarkdown(raw);
    const { parts } = splitChunks({ title, summary, label, body });
    const rel = file.slice(args.source.length + 1).replace(/^\/+/, '');
    for (const part of parts) {
      chunks.push({
        id: `${rel}#${part.heading || 'overview'}`,
        doc: rel,
        lang: detectLang(file),
        title: part.title,
        heading: part.heading,
        text: part.text,
      });
    }
  }

  // Supplement with the finch-mini-tool-creator skill docs (API-level detail).
  let skillFiles = [];
  try {
    skillFiles = collectSkillFiles(args.skills);
  } catch {
    /* missing skills dir — website-only build */
  }
  for (const file of skillFiles) {
    const raw = readFileSync(file, 'utf8');
    const fallback = basename(file).replace(/\.md$/, '');
    const { parts } = parseSkillMarkdown(raw, fallback);
    const rel = file.slice(args.skills.length + 1).replace(/^\/+/, '');
    const doc = `minitool-creator/${rel}`;
    for (const part of parts) {
      chunks.push({
        id: `${doc}#${part.heading || 'overview'}`,
        doc,
        lang: 'en',
        title: part.title,
        heading: part.heading,
        text: part.text,
      });
    }
  }

  const data = {
    source: 'finch-website/pages + finch-mini-tool-creator skill docs',
    generatedAt: new Date().toISOString(),
    chunkCount: chunks.length,
    chunks,
  };

  mkdirSync(resolve(args.out, '..'), { recursive: true });
  writeFileSync(args.out, JSON.stringify(data));
  console.log(
    `[kb] wrote ${chunks.length} chunks (${files.length} website files, ${skillFiles.length} skill files) → ${args.out}`,
  );
}

build(parseArgs(process.argv.slice(2)));

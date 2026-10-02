import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractArticle, normalizeUrl } from '../dist/index.js';

const page = (body) => `<!doctype html><html><head>
<title>The Quiet Library | Some Site</title>
<meta property="og:title" content="The Quiet Library">
<meta name="description" content="ignored">
</head><body>
<nav class="site-nav"><a href="/">Home</a><a href="/about">About</a></nav>
<header id="page-header"><h1>Site Name</h1></header>
<article>
  <h1>The Quiet Library</h1>
  <p>A library that keeps every note <strong>on this machine</strong> and never phones home. It reads slowly, indexes once, and stays quiet afterwards.</p>
  <p>Second paragraph with a <a href="/relative/page">relative link</a>, an <a href="https://example.com/out">absolute link</a> and <em>emphasis</em>.</p>
  <ul><li>First point</li><li>Second point with <code>inline()</code></li></ul>
  <blockquote>Notes are only useful when you can find them again.</blockquote>
  <pre><code>const a = 1;
  const b = 2;</code></pre>
  <img src="/img/cover.png" alt="Cover art">
  <h2>A heading</h2>
  <p>Closing paragraph long enough to matter for the density heuristics used by the extractor.</p>
</article>
<div class="comments"><p>Great article! <a href="/x">reply</a></p></div>
<aside id="related-posts"><ul><li><a href="/other">Another post you may like</a></li></ul></aside>
<footer id="site-footer"><p>Copyright 2026</p></footer>
<script>window.tracker = function () { return "nav menu sidebar"; };</script>
</body></html>${body}`;

test('extracts the article and drops chrome, scripts and navigation', () => {
  const article = extractArticle(page(''), 'https://example.com/posts/quiet-library');
  assert.equal(article.title, 'The Quiet Library');
  assert.equal(article.suspect, false);
  assert.equal(article.reason, undefined);
  assert.match(article.markdown, /^# The Quiet Library/m);
  assert.match(article.markdown, /\*\*on this machine\*\*/);
  assert.match(article.markdown, /\[relative link\]\(https:\/\/example\.com\/relative\/page\)/);
  assert.match(article.markdown, /\[absolute link\]\(https:\/\/example\.com\/out\)/);
  assert.match(article.markdown, /- First point/);
  assert.match(article.markdown, /- Second point with `inline\(\)`/);
  assert.match(article.markdown, /^> Notes are only useful/m);
  assert.match(article.markdown, /```\nconst a = 1;\n {2}const b = 2;\n```/);
  assert.match(article.markdown, /!\[Cover art\]\(https:\/\/example\.com\/img\/cover\.png\)/);
  assert.match(article.markdown, /^## A heading/m);
  for (const gone of ['Home', 'About', 'Site Name', 'Great article', 'Another post', 'Copyright', 'tracker']) {
    assert.equal(article.markdown.includes(gone), false, `expected ${gone} to be removed`);
  }
});

test('a JavaScript shell is flagged instead of indexed as an empty page', () => {
  const shell = `<!doctype html><html><head><title>App</title></head><body>
  <div id="root"></div><noscript>Please enable JavaScript to continue.</noscript></body></html>`;
  const article = extractArticle(shell, 'https://app.example.com/');
  assert.equal(article.suspect, true);
  assert.match(article.reason, /JavaScript/);
  assert.ok(article.length < 400);
});

test('a page with no article container is flagged as possibly mixed with chrome', () => {
  const line = '<p>One flat paragraph of plain text, long enough to clear the short-page threshold.</p>';
  const flat = `<!doctype html><html><body>${line.repeat(14)}</body></html>`;
  const article = extractArticle(flat, 'https://example.com/flat');
  assert.equal(article.suspect, true);
  assert.match(article.reason, /chrome/);
  assert.ok(article.length >= 400 && article.length < 1200, `length was ${article.length}`);
  assert.match(article.markdown, /One flat paragraph/);
});

test('entities and title fallbacks are handled', () => {
  const html = `<!doctype html><html><head><title>Tips &amp; tricks &#8212; Blog</title></head>
  <body><main><h2>Body heading</h2><p>R&amp;D notes about &lt;tags&gt; and &quot;quotes&quot;.</p></main></body></html>`;
  const article = extractArticle(html, 'https://example.com/tips');
  assert.equal(article.title, 'Tips & tricks');
  assert.match(article.markdown, /R&D notes about <tags> and "quotes"\./);
});

test('urls are normalised and anything un-fetchable is refused', () => {
  assert.equal(normalizeUrl('example.com/a?b=1#frag'), 'https://example.com/a?b=1');
  assert.equal(normalizeUrl('  http://example.com/x  '), 'http://example.com/x');
  assert.throws(() => normalizeUrl(''), /Enter a URL/);
  assert.throws(() => normalizeUrl('file:///etc/passwd'), /Only http and https/);
  assert.throws(() => normalizeUrl('http://localhost'), /Not a valid URL/);
});

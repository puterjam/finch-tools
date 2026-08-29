import { basicSetup, EditorView } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { python } from '@codemirror/lang-python';
import { sql } from '@codemirror/lang-sql';
import { yaml } from '@codemirror/lang-yaml';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { HighlightStyle, LanguageDescription, LanguageSupport, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { RangeSetBuilder, StateField, type RangeSet, type Text } from '@codemirror/state';
import { indentLess, indentMore, indentWithTab } from '@codemirror/commands';
import {
  Decoration,
  type DecorationSet,
  GutterMarker,
  gutterLineClass,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';

interface EditorSelectionInfo {
  start: number;
  end: number;
  text: string;
  rect: { top: number; bottom: number; left: number; right: number };
}

interface MarkdownEditorHandle {
  getValue(): string;
  setValue(value: string): void;
  getSelection(): EditorSelectionInfo | null;
  hasFocus(): boolean;
  focus(): void;
  layout(): void;
  setFontSize(size: number): void;
  setFontFamily(family: string): void;
  scrollDOM: HTMLElement;
  destroy(): void;
}

interface MarkdownEditorOptions {
  parent: HTMLElement;
  value?: string;
  onChange(value: string): void;
  /** Host bridge for a pasted image: given the File, resolve the Markdown
   * image target URL to insert (typically a `finch-file://` URL after the
   * host writes it to disk). Omit to fall back to embedding a data: URL
   * with no host round-trip at all. */
  onPasteImage?(file: File): Promise<string>;
}

// --- Font-size model ---------------------------------------------------
// `&` (the `.cm-editor` root) is the ONE place an absolute pixel size is
// set; every other rule below expresses its size as `em`, which resolves
// against *this* 14px root because `.cm-scroller` and `.cm-gutters` are
// both direct children of `.cm-editor` (siblings, not nested inside one
// another) — so there is no hidden chained multiplication to account for.
// Previously the root itself was `1.2em` (relative to the *host page's*
// inherited font-size, an indirect and easy-to-miscalculate 16px×1.2×0.8
// chain) which is why hitting an exact "14px body / 12px gutter" target
// felt unreliable. Change `CM_ROOT_PX` to shift both together; the ratios
// below (body 1em, gutter 6/7em) keep the 14:12 relationship intact.
const CM_ROOT_PX = 16;
const finchTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--text)',
    backgroundColor: 'var(--card)',
    fontSize: `${CM_ROOT_PX}px`,
  },
  // CodeMirror marks Markdown code ranges with this generated class. Keep
  // their face explicitly monospace so the editor font menu only changes
  // prose, never inline/fenced code.
  '.ͼs':{
    padding: '0.08em 0.28em',
    borderRadius: '5px',
    background: 'none !important',
    fontSize: '14px',
    fontFamily: 'var(--finch-font-mono) !important',
  },
  '.ͼw':{
    fontFamily: 'monospace',
  },

  '.cm-foldGutter':{display:'none !important'},
  '&.cm-focused': { outline: 'none' },
  // Dim unselected/inactive editor text so attention stays on the currently
  // focused pane; syntax decorations keep their own explicit colors.
  // '&:not(.cm-focused) .cm-scroller': { color: 'var(--muted)' },
  '.cm-scroller': {
    fontFamily: 'var(--md-editor-font-family, var(--finch-font-mono))',
    // CodeMirror's lineWrapping extension handles long prose, URLs and code;
    // never expose a second horizontal scrollbar in the editor pane.
    overflowX: 'hidden',
    overflowY: 'auto',
    // Body text = the root size itself (14px), i.e. this is the reference
    // "14px" the human eye actually reads while typing.
    fontSize: '0.9em',
  },
  '.cm-content': {
    padding: '20px 0',
    caretColor: 'var(--text)',
    minHeight: '100%',
    // Let the content flex down with a narrow panel instead of retaining the
    // intrinsic width of its longest line.
    minWidth: '0',
  },
  // Keep `.cm-line` full-width so CodeMirror's active-line, selection and
  // search layers paint edge-to-edge. A responsive inner gutter leaves the
  // readable text column at most 750px wide on wide panes, but collapses to
  // 24px on either side on narrow panes — no fixed line width, no overflow.
  '.cm-line': {
    // '--md-line-pad': 'max(24px, calc((100% - 750px) / 2))',
    boxSizing: 'border-box',
    width: '40rem',
    maxWidth: '88%',
    marginInline: 'auto',
    paddingTop: '2px',
    paddingBottom: '2px',
    lineHeight: '1.7rem',
  },
  // Headings get a distinct size per level (h1 largest down to h6), like the
  // rendered preview, so the raw Markdown view already hints at document
  // structure instead of every line looking the same weight. All sizes are
  // `em` against the 14px body text set on `.cm-scroller` above (`.cm-line`
  // doesn't set its own font-size, so it inherits that 14px directly — no
  // extra multiplication step). Scale widens at the top and tightens near
  // the bottom (a standard modular-scale shape) so h1–h3 read as clearly
  // separate tiers while h5/h6 stay close to body size and lean on the
  // existing bold + accent-color syntax highlighting for distinction
  // instead of ballooning past body size the way a flat +0.1em/level did.
  // Kept deliberately compact for source editing: hierarchy comes mostly
  // from weight and Markdown's accent syntax, rather than oversized rows.
  '.cm-line.cm-md-h1': { fontSize: '1.45em', fontWeight: '700', lineHeight: '1.4' },
  '.cm-line.cm-md-h2': { fontSize: '1.3em', fontWeight: '700', lineHeight: '1.4' },
  '.cm-line.cm-md-h3': { fontSize: '1.2em', fontWeight: '700', lineHeight: '1.4' },
  '.cm-line.cm-md-h4': { fontSize: '1.1em', fontWeight: '700', lineHeight: '1.4' },
  '.cm-line.cm-md-h5': { fontSize: '1.04em', fontWeight: '700', lineHeight: '1.4' },
  '.cm-line.cm-md-h6': { fontSize: '1em', fontWeight: '700', lineHeight: '1.4' },
  // Source-mode live preview: non-active Markdown delimiters collapse out of
  // sight; the cursor/selection line deliberately has no such decoration.
  '.cm-md-bullet': {
    display: 'inline-block',
    // width: '1.15em',
    color: 'var(--accent)',
    fontWeight: '700',
    textAlign: 'center',
    fontFamily: 'monospace',
  },
  '.cm-md-inline-code': {
    padding: '0.08em 0.32em',
    borderRadius: '5px',
    color: 'var(--text)',
    backgroundColor: 'color-mix(in srgb, var(--text) 9%, transparent)',
    fontFamily: 'var(--finch-font-mono)',
  },
  '.cm-line.cm-md-quote': {
    borderLeft: '2px solid var(--border)',
    paddingLeft: '8px',
  },
  // List rows sit two characters in from ordinary body text.
  '.cm-line.cm-md-list-line': {
    paddingLeft: '3ch',
  },
  '.cm-line.cm-md-code-line': {
    color: 'var(--text)',
    // Keep the code surface translucent: CodeMirror paints its custom
    // selection layer behind line content, so an opaque `var(--card)` mix
    // would cover the selection completely.
    backgroundColor: 'color-mix(in srgb, var(--text) 8%, transparent)',
    lineHeight: '1.3rem',
    fontFamily: 'var(--finch-font-mono)',
    paddingTop: '0',
    paddingBottom: '0',
    paddingLeft: '12px',
    paddingRight: '12px',
    fontSize: '12px !important',
  },

  '.cm-line.cm-md-code-line span': {
    fontSize: '12px !important',
  },
  '.cm-line.cm-md-code-open': {
    fontSize: '12px',
    borderRadius: '8px 8px 0 0',
  },
  '.cm-line.cm-md-code-close': {
    fontSize: '12px',
    borderRadius: '0 0 8px 8px',
  },
  '.cm-md-code-fence-empty': { opacity: '0' },
  '.cm-md-code-copy': {
    float: 'right',
    height: '20px',
    margin: '4px -8px',
    padding: '0 7px',
    border: '0px',
    borderRadius: '6px',
    color: 'var(--muted)',
    backgroundColor: 'color-mix(in srgb, var(--card) 88%, transparent)',
    font: '11px var(--finch-font-mono)',
    cursor: 'pointer',
  },
  '.cm-md-code-copy:hover': { color: 'var(--text)', backgroundColor: 'var(--card)' },
  '.cm-md-hr': {
    display: 'inline-block',
    width: '100%',
    height: '1px',
    verticalAlign: 'middle',
    backgroundColor: 'var(--border)',
    cursor: 'text',
  },
  // Extra breathing room between blocks lives ONLY on the blank separator
  // line itself, as `padding-bottom` — never on a line that has actual text.
  // An earlier version put the padding on the first line of the *next*
  // block instead, which pushed that line's glyphs down inside a taller
  // box while CodeMirror's line-number gutter (a separate element that
  // mirrors each line's height) stayed top-aligned — the number and its
  // line's text visibly drifted apart (line number in the corner, text
  // near the bottom of its own row). A blank line has no glyphs to
  // misalign, so padding it is invisible except for the gap it creates.
  // Tuning: a blank row's total height = base line box (font-size 13.5px ×
  // line-height 1.625 ≈ 22px) + this padding-bottom. 0.5em/0.9em of 13.5px
  // (≈6.8px/12.2px) made the blank row ~30%/55% taller than a normal row —
  // visibly oversized, as in the "row 8 much taller than 7/9" report.
  // Dropped to a size that reads as "a bit more breathing room" rather
  // than "an empty row got fat": ~14%/32% taller. Raise/lower these two
  // values directly to taste; they're independent of every other line's
  // height (headings, code, etc.) so nothing else needs to change.
  '.cm-line.cm-md-gap': {},
  '.cm-line.cm-md-gap-heading': {},
  // `basicSetup` enables same-word selection matches. Keep the primary text
  // selection, but suppress those secondary match rectangles entirely.
  '.cm-selectionMatch': { backgroundColor: 'transparent !important' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '.cm-gutters': {
    color: 'var(--muted)',
    backgroundColor: 'var(--card)',
    borderRight: '0px',
    // `.cm-gutters` is a direct child of `.cm-editor` (a sibling of
    // `.cm-scroller`, not nested inside it), so this `em` resolves against
    // the same 14px root as body text — 6/7em = 12px exactly, independent
    // of whatever `.cm-scroller`/`.cm-content` end up doing.
    fontSize: `${12 / CM_ROOT_PX}em`,
  },
  '.cm-gutterElement': { padding: '0px 8px 0 10px' },
  // Scoped to the line-*number* gutter only (`.cm-lineNumbers` is that
  // gutter's own container class) — `.cm-gutterElement` above is shared by
  // every gutter column, including the fold-arrow gutter next to it, so a
  // top-padding tweak on the bare class also shoves the fold triangles
  // down by the same amount. This descendant selector nudges only the
  // number glyphs.
  '.cm-lineNumbers .cm-gutterElement': {
        padding: '0 5px 0 8px',
        lineHeight: '32px',
        color: 'color-mix(in srgb, var(--muted) 35%, transparent)',
        fontFamily: 'var(--finch-font-mono)',
  },
  // Fenced code lines render at a smaller font/line-height than prose
  // (`.cm-md-code-line` above), so their gutter row gets its own
  // line-height here — driven by `gutterLineClass`, since the number
  // gutter is a separate DOM tree from `.cm-content` and never inherits
  // classes from the content line decorations.
  '.cm-lineNumbers .cm-gutterElement.cm-gutter-code-line': {
        lineHeight: '21px',
  },
  '.cm-activeLine': {
    backgroundColor: 'color-mix(in srgb, var(--text) 7%, transparent)',
    boxShadow: [
      '-25vw 0 color-mix(in srgb, var(--text) 7%, transparent)',
      '25vw 0 color-mix(in srgb, var(--text) 7%, transparent)',
    ].join(', '),
  },
  '.cm-activeLineGutter': {
    color: 'var(--text) !important',
    backgroundColor: 'color-mix(in srgb, var(--text) 7%, transparent)',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 34%, transparent)',
  },
  '.cm-panels': {
    color: 'var(--text)',
    backgroundColor: 'var(--card)',
  },
  '.cm-tooltip': {
    color: 'var(--text)',
    backgroundColor: 'var(--card)',
    border: '1px solid var(--border)',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    color: 'var(--text)',
    backgroundColor: 'color-mix(in srgb, var(--accent) 20%, transparent)',
  },
});

// Fenced code (```lang) gets real syntax highlighting for this curated,
// bundle-size-conscious set of common languages, matched against the fence
// info string by name/alias/extension. Pulling in the full
// `@codemirror/language-data` catalog (every CodeMirror-supported language)
// would bloat this single-file bundle from ~600KB to well over 1.5MB, so
// only the languages most likely to appear in fenced code are included.
const fencedCodeLanguages = [
  LanguageDescription.of({ name: 'JavaScript', alias: ['js', 'mjs', 'cjs'], extensions: ['js', 'mjs', 'cjs'], support: javascript() }),
  LanguageDescription.of({ name: 'JSX', alias: ['jsx'], extensions: ['jsx'], support: javascript({ jsx: true }) }),
  LanguageDescription.of({ name: 'TypeScript', alias: ['ts'], extensions: ['ts'], support: javascript({ typescript: true }) }),
  LanguageDescription.of({ name: 'TSX', alias: ['tsx'], extensions: ['tsx'], support: javascript({ jsx: true, typescript: true }) }),
  LanguageDescription.of({ name: 'JSON', alias: ['json', 'json5'], extensions: ['json'], support: json() }),
  LanguageDescription.of({ name: 'CSS', alias: ['css'], extensions: ['css'], support: css() }),
  LanguageDescription.of({ name: 'HTML', alias: ['html', 'htm', 'xml', 'svg'], extensions: ['html'], support: html() }),
  LanguageDescription.of({ name: 'Python', alias: ['python', 'py'], extensions: ['py'], support: python() }),
  LanguageDescription.of({ name: 'SQL', alias: ['sql'], extensions: ['sql'], support: sql() }),
  LanguageDescription.of({ name: 'YAML', alias: ['yaml', 'yml'], extensions: ['yaml', 'yml'], support: yaml() }),
  LanguageDescription.of({
    name: 'Shell',
    alias: ['bash', 'sh', 'shell', 'zsh', 'console'],
    extensions: ['sh'],
    support: new LanguageSupport(StreamLanguage.define(shell)),
  }),
];

const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--accent)', fontWeight: '700' },
  { tag: tags.strong, color: 'var(--text)', fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.monospace, color: 'var(--muted)', backgroundColor: 'color-mix(in srgb, var(--text) 8%, transparent)' },
  { tag: tags.link, color: 'var(--accent)' },
  { tag: tags.url, color: 'var(--muted)', textDecoration: 'underline' },
  { tag: tags.quote, color: 'var(--muted)' },
  { tag: tags.meta, color: 'var(--muted)' },
  // --- Fenced code-block token colors (only reached inside a nested
  // `codeLanguages` grammar — regular Markdown prose never emits these
  // tags). Loosely follows the familiar One Dark palette, which stays
  // legible against both this app's light and dark card backgrounds.
  { tag: tags.keyword, color: '#c678dd' },
  { tag: [tags.name, tags.deleted, tags.character, tags.propertyName, tags.macroName], color: '#e06c75' },
  { tag: [tags.function(tags.variableName), tags.labelName], color: '#61afef' },
  { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name), tags.bool], color: '#d19a66' },
  { tag: [tags.definition(tags.name), tags.separator], color: 'var(--text)' },
  { tag: [tags.typeName, tags.className, tags.number, tags.changed, tags.annotation, tags.modifier, tags.self, tags.namespace], color: '#e5c07b' },
  { tag: [tags.operator, tags.operatorKeyword, tags.escape, tags.regexp, tags.special(tags.string)], color: '#56b6c2' },
  { tag: tags.string, color: '#98c379' },
  { tag: tags.comment, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: tags.invalid, color: '#fff', backgroundColor: '#e06c75' },
]);

// Regex-based rather than syntax-tree-based on purpose: an ATX heading
// (`#`..`######`) and "is this the first line after a blank line" are both
// trivial to detect straight from line text, and skipping a syntax-tree walk
// keeps this cheap enough to recompute on every viewport/doc change without
// its own debounce.
const HEADING_RE = /^(#{1,6})(?:\s|$)/;

function computeBlockDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  for (let lineNo = 1; lineNo <= doc.lines; lineNo++) {
    const line = doc.line(lineNo);
    const text = line.text;
    const headingMatch = HEADING_RE.exec(text);
    const isBlank = text.trim().length === 0;
    let cls: string | undefined;
    if (headingMatch) {
      // Font-size-only — this is safe to put on a line that has real text
      // because it's a pure text-metrics change; CodeMirror measures each
      // line's actual rendered height (including a bigger font) and keeps
      // its gutter row in sync automatically, the same way any prose
      // editor's heading styling works. It's *added* padding (see below)
      // that breaks that sync, not a taller line from bigger text.
      cls = `cm-md-h${headingMatch[1].length}`;
    } else if (isBlank && lineNo < doc.lines) {
      const nextText = doc.line(lineNo + 1).text;
      if (nextText.trim().length > 0) {
        cls = HEADING_RE.test(nextText) ? 'cm-md-gap-heading' : 'cm-md-gap';
      }
    }
    if (cls) builder.add(line.from, line.from, Decoration.line({ class: cls }));
  }
  return builder.finish();
}

const blockSpacingPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = computeBlockDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.decorations = computeBlockDecorations(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

// Obsidian-style source live preview. Each block type gets an explicit
// rendering rule. A cursor/selection touching a line always reveals that
// line's literal Markdown for predictable editing.
const INLINE_DELIMITER_RE = /(\*\*|__|~~|_)([^\n]*?)\1/g;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const FENCE_RE = /^\s*```+\s*([^\s`]*)?\s*$/;
const HR_RE = /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const UNORDERED_LIST_RE = /^(\s*)([-+*])(?=\s+)/;
const QUOTE_RE = /^(\s*>\s?)/;
// Hide delimiters with a replace decoration rather than `display: none`:
// CodeMirror measures cursor coordinates from the DOM, and a CSS-hidden span
// yields no rect, which makes vertical motion miscompute and skip the line.
const hiddenMarkdownDelimiter = Decoration.replace({});
const inlineCodeDecoration = Decoration.mark({ class: 'cm-md-inline-code' });

// Gutter rows live in a DOM tree separate from `.cm-content`, so a line
// decoration on the content side (`cm-md-code-line`) never reaches the
// number gutter. `gutterLineClass` is the CM6 mechanism for styling gutter
// rows independently — used here purely to give fenced-code rows their own
// `line-height`, matching the smaller code-line box on the content side.
class CodeGutterMarker extends GutterMarker {
  elementClass = 'cm-gutter-code-line';
}
const codeGutterMarker = new CodeGutterMarker();

function computeCodeGutterMarks(doc: Text): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>();
  let inFence = false;
  for (let lineNo = 1; lineNo <= doc.lines; lineNo++) {
    const line = doc.line(lineNo);
    const isFenceLine = FENCE_RE.test(line.text);
    if (isFenceLine || inFence) builder.add(line.from, line.from, codeGutterMarker);
    if (isFenceLine) inFence = !inFence;
  }
  return builder.finish();
}

const codeGutterLineField = StateField.define<RangeSet<GutterMarker>>({
  create: (state) => computeCodeGutterMarks(state.doc),
  update: (marks, tr) => (tr.docChanged ? computeCodeGutterMarks(tr.state.doc) : marks),
});

const codeGutterLineHighlighter = [codeGutterLineField, gutterLineClass.from(codeGutterLineField)];

class BulletWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-md-bullet';
    span.textContent = '•';
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
}

class HorizontalRuleWidget extends WidgetType {
  constructor(private readonly position: number) { super(); }
  eq(other: HorizontalRuleWidget): boolean { return other.position === this.position; }
  toDOM(view: EditorView): HTMLElement {
    const rule = document.createElement('span');
    rule.className = 'cm-md-hr';
    rule.title = '点击编辑分隔线';
    rule.addEventListener('mousedown', (event) => event.preventDefault());
    rule.addEventListener('click', () => {
      view.dispatch({ selection: { anchor: this.position } });
      view.focus();
    });
    return rule;
  }
}

class CodeFenceWidget extends WidgetType {
  constructor(private readonly language: string, private readonly code: string) { super(); }
  eq(other: CodeFenceWidget): boolean { return other.language === this.language && other.code === this.code; }
  toDOM(): HTMLElement {
    if (!this.language) {
      const empty = document.createElement('span');
      empty.className = 'cm-md-code-fence-empty';
      empty.textContent = '\u200b';
      return empty;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cm-md-code-copy';
    button.textContent = this.language.toUpperCase();
    button.title = '复制代码块';
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const original = button.textContent || this.language.toUpperCase();
      try {
        await navigator.clipboard.writeText(this.code);
        button.textContent = '已复制';
      } catch {
        button.textContent = '复制失败';
      }
      window.setTimeout(() => { button.textContent = original; }, 1200);
    });
    return button;
  }
}

function lineIntersectsSelection(view: EditorView, lineFrom: number, lineTo: number): boolean {
  return view.state.selection.ranges.some((range) => {
    if (range.empty) return range.head >= lineFrom && range.head <= lineTo;
    return range.from <= lineTo && range.to >= lineFrom;
  });
}

interface CodeLineInfo {
  role: 'open' | 'body' | 'close';
  language: string;
  code: string;
  blockFrom: number;
  blockTo: number;
}

// Inline formatting stays rendered while typing prose. Entering a formatted
// text span reveals both of its matching delimiters, including when the
// cursor is immediately outside either edge.
function selectionTouchesDelimiter(view: EditorView, from: number, to: number): boolean {
  const formatLine = view.state.doc.lineAt(from);
  return view.state.selection.ranges.some((range) => {
    // A line break is never an adjacent formatting position. Restrict the
    // one-character leeway around a span to the line that owns the span.
    if (range.empty) {
      return range.head >= formatLine.from
        && range.head <= formatLine.to
        && range.head >= from - 1
        && range.head <= to + 1;
    }
    return range.from <= formatLine.to
      && range.to >= formatLine.from
      && range.from <= to + 1
      && range.to >= from - 1;
  });
}

function collectCodeLines(view: EditorView): Map<number, CodeLineInfo> {
  const doc = view.state.doc;
  const result = new Map<number, CodeLineInfo>();
  let openLine = 0;
  let language = '';
  for (let lineNo = 1; lineNo <= doc.lines; lineNo++) {
    const line = doc.line(lineNo);
    const fence = FENCE_RE.exec(line.text);
    if (!openLine) {
      if (!fence) continue;
      openLine = lineNo;
      language = fence[1] || '';
      continue;
    }
    if (fence) {
      const code = Array.from({ length: lineNo - openLine - 1 }, (_, i) => doc.line(openLine + i + 1).text).join('\n');
      const blockFrom = doc.line(openLine).from;
      const blockTo = line.to;
      result.set(openLine, { role: 'open', language, code, blockFrom, blockTo });
      for (let body = openLine + 1; body < lineNo; body++) result.set(body, { role: 'body', language, code, blockFrom, blockTo });
      result.set(lineNo, { role: 'close', language, code, blockFrom, blockTo });
      openLine = 0;
      language = '';
    }
  }
  if (openLine) {
    const code = Array.from({ length: doc.lines - openLine }, (_, i) => doc.line(openLine + i + 1).text).join('\n');
    const blockFrom = doc.line(openLine).from;
    const blockTo = doc.length;
    result.set(openLine, { role: 'open', language, code, blockFrom, blockTo });
    for (let body = openLine + 1; body <= doc.lines; body++) result.set(body, { role: 'body', language, code, blockFrom, blockTo });
  }
  return result;
}

function computeMarkdownLivePreview(view: EditorView): DecorationSet {
  const ranges: any[] = [];
  const doc = view.state.doc;
  const codeLines = collectCodeLines(view);
  for (let lineNo = 1; lineNo <= doc.lines; lineNo++) {
    const line = doc.line(lineNo);
    const active = lineIntersectsSelection(view, line.from, line.to);
    const codeInfo = codeLines.get(lineNo);

    if (codeInfo) {
      // A code fence is one editing unit: entering any line of the block
      // reveals both its opening and closing fences.
      const codeBlockActive = lineIntersectsSelection(view, codeInfo.blockFrom, codeInfo.blockTo);
      const roleClass = codeInfo.role === 'open' ? ' cm-md-code-open' : codeInfo.role === 'close' ? ' cm-md-code-close' : '';
      ranges.push(Decoration.line({ class: `cm-md-code-line${roleClass}` }).range(line.from));
      if (!codeBlockActive && codeInfo.role !== 'body') {
        const widget = new CodeFenceWidget(codeInfo.role === 'open' ? codeInfo.language : '', codeInfo.code);
        // The fence text collapses, but its line box stays intact so the
        // cursor can still land on it with ArrowUp/ArrowDown.
        ranges.push(hiddenMarkdownDelimiter.range(line.from, line.to));
        // side: -1 keeps the widget outside the replaced range so the line
        // still has a measurable box and a reachable cursor position.
        ranges.push(Decoration.widget({ widget, side: -1 }).range(line.from));
      }
      continue;
    }

    const quote = QUOTE_RE.exec(line.text);
    if (quote) {
      ranges.push(Decoration.line({ class: 'cm-md-quote' }).range(line.from));
      if (!active) ranges.push(hiddenMarkdownDelimiter.range(line.from, line.from + quote[0].length));
    }

    if (!active && HR_RE.test(line.text)) {
      // Preserve the `---` positions so vertical keyboard navigation can
      // enter the line; only its visual glyphs are replaced by the rule.
      ranges.push(hiddenMarkdownDelimiter.range(line.from, line.to));
      ranges.push(Decoration.widget({ widget: new HorizontalRuleWidget(line.from), side: -1 }).range(line.from));
      continue;
    }

    if (LIST_ITEM_RE.test(line.text)) {
      ranges.push(Decoration.line({ class: 'cm-md-list-line' }).range(line.from));
    }

    if (!active) {
      const bullet = UNORDERED_LIST_RE.exec(line.text);
      if (bullet) {
        const markerFrom = line.from + bullet[1].length;
        ranges.push(Decoration.replace({ widget: new BulletWidget() }).range(markerFrom, markerFrom + 1));
      }

      const heading = /^(#{1,6}\s+)/.exec(line.text);
      if (heading) ranges.push(hiddenMarkdownDelimiter.range(line.from, line.from + heading[0].length));

    }

    // An inline format span reveals its paired markers together, rather than
    // revealing every Markdown marker on the line.
    INLINE_DELIMITER_RE.lastIndex = 0;
    let delimiter: RegExpExecArray | null;
    while ((delimiter = INLINE_DELIMITER_RE.exec(line.text))) {
      const from = line.from + delimiter.index;
      const to = from + delimiter[0].length;
      const markerLength = delimiter[1].length;
      if (!selectionTouchesDelimiter(view, from, to)) {
        ranges.push(hiddenMarkdownDelimiter.range(from, from + markerLength));
        ranges.push(hiddenMarkdownDelimiter.range(to - markerLength, to));
      }
    }

    INLINE_CODE_RE.lastIndex = 0;
    let inlineCode: RegExpExecArray | null;
    while ((inlineCode = INLINE_CODE_RE.exec(line.text))) {
      const from = line.from + inlineCode.index;
      const to = from + inlineCode[0].length;
      ranges.push(inlineCodeDecoration.range(from + 1, to - 1));
      if (!selectionTouchesDelimiter(view, from, to)) {
        ranges.push(hiddenMarkdownDelimiter.range(from, from + 1));
        ranges.push(hiddenMarkdownDelimiter.range(to - 1, to));
      }
    }
  }
  return Decoration.set(ranges, true);
}

const livePreviewMarkdownPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = computeMarkdownLivePreview(view); }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = computeMarkdownLivePreview(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

// Pasting an image (e.g. copied from a screenshot tool or another app) has
// no useful text representation, so the browser's default paste silently
// drops it. Intercept it and insert a Markdown image reference instead.
//
// Preferred path: hand the File to the host via `onPasteImage`, which
// writes it under this mini tool's own storage dir and replies with a
// `finch-file://local?path=...` URL — the same protocol Finch already uses
// for local images elsewhere, whitelisted for extension-owned storage. That
// keeps the .md source small (a URL, not a multi-MB inline blob) and still
// renders in the preview iframe, since `finch-file://` is a registered
// custom protocol (not a sandboxed `file://` load) and resolves inside a
// nested `srcdoc` frame the same as the top-level document.
// Fallback (no `onPasteImage` bridge available): embed a data: URL
// directly — heavier and never gets deduped/cleaned up on disk, but needs
// no host round-trip and still renders/saves correctly on its own.
// Shared paste/drop flow. `range` is omitted for clipboard paste (current
// selection) and supplied for a drop so the image lands exactly under the
// pointer rather than wherever the old cursor happened to be.
function insertImageFile(view: EditorView, imageFile: File, onPasteImage?: (file: File) => Promise<string>, range?: { from: number; to: number }): void {
  const sel = range ?? view.state.selection.main;
  if (!onPasteImage) {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!dataUrl) return;
      const text = `![Pasted image](${dataUrl})`;
      view.dispatch({ changes: { from: sel.from, to: sel.to, insert: text }, selection: { anchor: sel.from + text.length } });
      view.focus();
    };
    reader.readAsDataURL(imageFile);
    return;
  }

  // Insert a unique placeholder immediately (host file write happens async),
  // then locate/replace the token later so edits elsewhere cannot invalidate
  // a stored document position.
  const token = `![Uploading image…](pasting:${Math.random().toString(36).slice(2)})`;
  view.dispatch({ changes: { from: sel.from, to: sel.to, insert: token }, selection: { anchor: sel.from + token.length } });
  view.focus();
  const replaceToken = (replacement: string) => {
    const text = view.state.doc.toString();
    const idx = text.indexOf(token);
    if (idx < 0) return;
    view.dispatch({ changes: { from: idx, to: idx + token.length, insert: replacement } });
  };
  onPasteImage(imageFile).then(
    (url) => replaceToken(`![Pasted image](${url})`),
    () => replaceToken(''),
  );
}

function imagePasteHandler(view: EditorView, event: ClipboardEvent, onPasteImage?: (file: File) => Promise<string>): boolean {
  const items = event.clipboardData?.items;
  if (!items) return false;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === 'file' && item.type.indexOf('image/') === 0) {
      const imageFile = item.getAsFile();
      if (imageFile) { event.preventDefault(); insertImageFile(view, imageFile, onPasteImage); return true; }
    }
  }
  return false;
}

function imageDropHandler(view: EditorView, event: DragEvent, onPasteImage?: (file: File) => Promise<string>): boolean {
  const files = event.dataTransfer?.files;
  if (!files) return false;
  const images = Array.from(files).filter((file) => file.type.indexOf('image/') === 0);
  if (!images.length) return false;
  event.preventDefault();
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  // A single drop gives a predictable insertion point. Multi-file dropping
  // can be added later as a queued upload UI rather than guessing offsets
  // while several asynchronous placeholders are being replaced.
  const offset = pos ?? view.state.selection.main.from;
  insertImageFile(view, images[0], onPasteImage, { from: offset, to: offset });
  return true;
}

const LIST_ITEM_RE = /^\s*(?:[-+*]|\d+[.)])\s+/;

function selectionStartsOnListItem(view: EditorView): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  return LIST_ITEM_RE.test(line.text);
}

// Tab changes list nesting when the cursor is on a list item. The ordinary
// `indentWithTab` fallback keeps Tab useful for non-list content as well.
const PURE_DELIMITER_LINE_RE = /^\s*(?:#{1,6}|>|[-+*]|\d+[.)]|`{1,}|\*\*|__|~~|_)\s*$/;

function isPureDelimiterLine(text: string): boolean {
  return FENCE_RE.test(text) || HR_RE.test(text) || PURE_DELIMITER_LINE_RE.test(text);
}

function moveIntoSkippedDelimiterLine(view: EditorView, direction: -1 | 1): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const doc = view.state.doc;
  const current = doc.lineAt(selection.head);
  const targetNo = current.number + direction;
  if (targetNo < 1 || targetNo > doc.lines) return false;
  const target = doc.line(targetNo);
  if (!isPureDelimiterLine(target.text)) return false;

  // Ask CodeMirror where its visual-line movement would go. Only intervene
  // when collapsed syntax makes it skip the adjacent document line; wrapped
  // lines and normal vertical movement keep CodeMirror's native behavior.
  const nativeTarget = view.moveVertically(selection, direction > 0);
  const nativeLine = doc.lineAt(nativeTarget.head).number;
  if (nativeLine === targetNo) return false;
  const overshot = direction > 0 ? nativeLine > targetNo : nativeLine < targetNo;
  // A collapsed line can also leave the cursor completely stuck; treat that
  // as a skip too, while wrapped-line motion inside the same line is kept.
  const stuck = nativeTarget.head === selection.head;
  if (!overshot && !stuck) return false;

  const column = selection.head - current.from;
  view.dispatch({
    selection: { anchor: target.from + Math.min(column, target.length) },
    scrollIntoView: true,
  });
  return true;
}

// Pressing Enter on an unmatched opening fence completes the block before
// prose can accidentally become code. Do this on Enter (rather than as soon
// as the third backtick is typed) so ` ```ts` / ` ```python` remain natural
// to type. The cursor lands on the empty code line between the two fences.
function completeOpeningCodeFence(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const line = view.state.doc.lineAt(selection.head);
  if (selection.head !== line.to || !FENCE_RE.test(line.text)) return false;

  let precedingFences = 0;
  for (let lineNo = 1; lineNo < line.number; lineNo++) {
    if (FENCE_RE.test(view.state.doc.line(lineNo).text)) precedingFences++;
  }
  // An odd number of preceding fences means this one already closes an
  // existing block, so regular Enter behavior is correct.
  if (precedingFences % 2 !== 0) return false;

  const opening = /^(\s*)(`{3,})/.exec(line.text);
  if (!opening) return false;
  const closing = `${opening[1]}${opening[2]}`;
  view.dispatch({
    changes: { from: selection.head, insert: `\n\n${closing}` },
    selection: { anchor: selection.head + 1 },
    scrollIntoView: true,
  });
  return true;
}

const markdownEditorKeymap = keymap.of([
  { key: 'Enter', run: completeOpeningCodeFence },
  { key: 'ArrowUp', run: (view) => moveIntoSkippedDelimiterLine(view, -1) },
  { key: 'ArrowDown', run: (view) => moveIntoSkippedDelimiterLine(view, 1) },
  { key: 'Tab', run: (view) => selectionStartsOnListItem(view) && indentMore(view) },
  { key: 'Shift-Tab', run: (view) => selectionStartsOnListItem(view) && indentLess(view) },
  indentWithTab,
]);

function createMarkdownEditor(options: MarkdownEditorOptions): MarkdownEditorHandle {
  let suppressChange = false;
  const view = new EditorView({
    doc: options.value ?? '',
    parent: options.parent,
    extensions: [
      markdownEditorKeymap,
      basicSetup,
      codeGutterLineHighlighter,
      markdown({
        codeLanguages: fencedCodeLanguages,
        // CommonMark's Setext heading rule silently promotes a plain line of
        // text into a bold, accent-colored H1/H2 whenever it's immediately
        // followed (no blank line) by a `-`/`=` divider — surprising in this
        // editor, where `---` is meant to always read as a plain horizontal
        // rule. Dropping the SetextHeading block parser keeps that divider
        // literal instead of retroactively re-coloring the line above it.
        extensions: [{ remove: ['SetextHeading'] }],
      }),
      EditorView.lineWrapping,
      finchTheme,
      syntaxHighlighting(markdownHighlight),
      blockSpacingPlugin,
      livePreviewMarkdownPlugin,
      EditorView.domEventHandlers({
        paste: (event, dispatchView) => imagePasteHandler(dispatchView, event, options.onPasteImage),
        drop: (event, dispatchView) => imageDropHandler(dispatchView, event, options.onPasteImage),
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !suppressChange) options.onChange(update.state.doc.toString());
      }),
    ],
  });

  return {
    getValue: () => view.state.doc.toString(),
    setValue(value) {
      if (value === view.state.doc.toString()) return;
      suppressChange = true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
      suppressChange = false;
    },
    getSelection() {
      const range = view.state.selection.main;
      if (range.empty) return null;
      const start = range.from;
      const end = range.to;
      const text = view.state.sliceDoc(start, end);
      const anchor = view.coordsAtPos(range.head) ?? view.coordsAtPos(end) ?? view.dom.getBoundingClientRect();
      return {
        start,
        end,
        text,
        rect: { top: anchor.top, bottom: anchor.bottom, left: anchor.left, right: anchor.right },
      };
    },
    hasFocus: () => view.hasFocus,
    focus: () => view.focus(),
    layout: () => view.requestMeasure(),
    setFontSize(size) {
      view.dom.style.fontSize = `${size}px`;
      view.requestMeasure();
    },
    setFontFamily(family) {
      view.dom.style.setProperty('--md-editor-font-family', family);
      view.requestMeasure();
    },
    scrollDOM: view.scrollDOM,
    destroy: () => view.destroy(),
  };
}

declare global {
  interface Window {
    MarkdownCodeMirror: { create(options: MarkdownEditorOptions): MarkdownEditorHandle };
  }
}

window.MarkdownCodeMirror = { create: createMarkdownEditor };

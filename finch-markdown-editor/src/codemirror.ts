import { basicSetup, EditorView } from 'codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { python } from '@codemirror/lang-python';
import { sql } from '@codemirror/lang-sql';
import { yaml } from '@codemirror/lang-yaml';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { HighlightStyle, LanguageDescription, LanguageSupport, StreamLanguage, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import {
  insertEmptyMarkdownTable,
  markdownTableAutocompleter,
  markdownTables,
  TableStyle,
  TableTheme,
} from 'codemirror-markdown-tables';
import { EditorState, RangeSetBuilder, StateField, type RangeSet, type Text } from '@codemirror/state';
import { indentLess, indentMore, indentWithTab, defaultKeymap, historyKeymap } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
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
  /** Ask the mini tool host to open a web URL in Finch's Browser Panel. */
  onOpenLink?(href: string): void;
  /** Ask the mini tool host to preview a Markdown image. */
  onOpenImage?(src: string): void;
  /** Host bridge for a pasted image: given the File, resolve the Markdown
   * image target URL to insert (typically a `finch-file://` URL after the
   * host writes it to disk). Omit to fall back to embedding a data: URL
   * with no host round-trip at all. */
  onPasteImage?(file: File): Promise<string>;
}

// --- Font-size model ---------------------------------------------------
// `&` (the `.cm-editor` root) is the ONE place an absolute pixel size is
// set; every other rule below expresses its size as `em`, which resolves
// against this root because `.cm-scroller` and `.cm-gutters` are both
// direct children of `.cm-editor` (siblings, not nested inside one
// another) — so there is no hidden chained multiplication to account for.
// The toolbar font-size menu writes the chosen tier (14/16/18) onto this
// root as an inline style, and body text inherits it unchanged — the menu
// value IS the rendered body size. The gutter stays a fixed fraction
// (12/16) of the same root so it scales along.
const CM_ROOT_PX = 16;
const CM_LINE_WIDTH = '50rem';
const CM_LINE_MAX_WIDTH = '88%';
const finchTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--text)',
    backgroundColor: 'var(--card)',
    fontSize: `${CM_ROOT_PX}px`,
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
    // No font-size here on purpose: body text inherits the root's inline
    // size directly, so the toolbar font-size menu value (14/16/18) is
    // exactly what DevTools measures on body text. An earlier 0.9em made
    // the 14px tier render at ~12.6px.
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
  // The `:not()` guard is load-bearing: a selected table cell mounts an
  // embedded CodeMirror that inherits this editor's theme classes, so
  // without it the 40rem reading-column width would leak into every cell,
  // inflate the cell's min-content, and grow the whole table on selection.
  '.cm-line:not(.tbl-table-widget .cm-line)': {
    // '--md-line-pad': 'max(24px, calc((100% - 750px) / 2))',
    boxSizing: 'border-box',
    width: CM_LINE_WIDTH,
    maxWidth: CM_LINE_MAX_WIDTH,
    marginInline: 'auto',
    paddingTop: '2px',
    paddingBottom: '2px',
    lineHeight: '1.7rem',
  },
  // A block replacement leaves CodeMirror's source-line box immediately
  // before the widget. Collapse that empty box so the table occupies its
  // actual first source line instead of appearing one visual row below it.
  '.cm-content > .cm-line:has(+ .tbl-table-widget)': {
    height: '0 !important',
    minHeight: '0 !important',
    paddingTop: '0 !important',
    paddingBottom: '0 !important',
    lineHeight: '0 !important',
    overflow: 'hidden',
  },
  // Tables shrink to their intrinsic width, but are centered and never grow
  // beyond the same readable column as ordinary `.cm-line` content. The small
  // right/bottom inset keeps the package's append-row/column grips visible.
  '.cm-content > .tbl-table-widget': {
    boxSizing: 'border-box',
    width: 'auto !important',
    maxWidth: `min(${CM_LINE_WIDTH}, ${CM_LINE_MAX_WIDTH}) !important`,
    marginInline: 'auto !important',
    padding: '0 16px 16px 6px !important',
  },
  '.tbl-table-widget .tbl-table-wrapper': {
    // width: 'auto !important',
    maxWidth: '100%',
  },
  '.tbl-table-widget .tbl-table': {
    width: 'auto !important',
    maxWidth: '100%',
  },
  // The selected cell's embedded editor must render at exactly the body
  // size the surrounding table already shows. Its own root carries the
  // copied theme base (a fixed 16px), which tracks neither the root
  // editor's inline font-size (the toolbar font-size menu writes it there)
  // nor the 0.9em body ratio — so `inherit` from the DOM position is the
  // only value that stays correct across every menu size. The package's
  // `--tbl-style-font-size: inherit` then cascades it down to the
  // scroller/content/line elements unchanged.
  '.tbl-cell-editor .cm-editor .cm-line': {
    fontSize: '0.9rem',
    fontFamily: 'var(--md-editor-font-family, var(--finch-font-mono))',
  },
  // Keep the selected cell's editable text at the same body size: with the
  // 0.9em chain gone, `inherit` tracks the root editor's inline font-size
  // (the menu tier) through the DOM, matching the static cells exactly.
  // An earlier 0.9em here compensated for the old double-scaling chain.
  // '.tbl-cell-editor .cm-editor .cm-content': {
  //   fontSize: '0.8rem',
  // },
  '.tbl-cell-view': {
    fontSize: '0.9rem',
    fontFamily: 'var(--md-editor-font-family, var(--finch-font-mono))',
  },
  // Tint the active cell / row / column boundary against dark skins. The
  // outline itself keeps the package's default 2px width — its ::after
  // overlay geometry (`calc(100% + 2px)` at -1px offset) is designed for
  // exactly that, so wider borders also misaligned the overlay by a pixel.
  '.tbl-table-widget .tbl-cell[data-selected]': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 15%, var(--tbl-row-background))',
  },
  '.tbl-table-widget .tbl-cell[data-outline]::after': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 7%, transparent)',
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
  '.cm-line.cm-md-h1': { fontSize: '1.45em', fontWeight: '700', lineHeight: 'normal !important' },
  '.cm-line.cm-md-h2': { fontSize: '1.3em', fontWeight: '700', lineHeight: 'normal !important' },
  '.cm-line.cm-md-h3': { fontSize: '1.2em', fontWeight: '700', lineHeight: 'normal !important' },
  '.cm-line.cm-md-h4': { fontSize: '1.1em', fontWeight: '700', lineHeight: 'normal !important' },
  '.cm-line.cm-md-h5': { fontSize: '1.04em', fontWeight: '700', lineHeight: 'normal !important' },
  '.cm-line.cm-md-h6': { fontSize: '1em', fontWeight: '700', lineHeight: 'normal !important' },
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
  '.tbl-cell-view .cm-md-delimiter': { display: 'none' },
  '.tbl-cell-view .cm-md-strong': { fontWeight: '700' },
  '.tbl-cell-view .cm-md-emphasis': { fontStyle: 'italic' },
  '.tbl-table-widget .tbl-table-head .tbl-cell-view, .tbl-table-widget .tbl-table-head .tbl-cell-editor .cm-content': {
    color: 'var(--accent)',
  },
  '.cm-md-inline-code': {
    padding: '0.08em 0.32em',
    borderRadius: '5px',
    color: 'var(--text)',
    backgroundColor: 'color-mix(in srgb, var(--text) 9%, transparent)',
    fontFamily: 'var(--finch-font-mono)',
    fontSize: '0.8em',
  },
  // Image source is replaced inside its own `.cm-line`, rather than becoming
  // a separate CodeMirror block. The widget and image therefore inherit the
  // reading column's width instead of the full editor canvas.
  '.cm-line > .cm-widget:has(.cm-md-image-block)': {
    display: 'inline-block',
    width: '100%',
    maxWidth: '100%',
  },
  '.cm-md-image-block': {
    display: 'inline-block',
    maxWidth: '100%',
    margin: '8px 0',
    lineHeight: '1.4',
    verticalAlign: 'top',
  },
  '.cm-md-image-block img': {
    display: 'block',
    maxHeight: '80vh',
    maxWidth: '100%',
    width: 'auto',
    borderRadius: '8px',
    cursor: 'zoom-in',
  },
  // Caption is a separate contenteditable node so users can rename the
  // image's alt text without ever falling back to raw Markdown source —
  // that revert used to cause a visible layout jump on selection.
  '.cm-md-image-caption': {
    display: 'block',
    marginTop: '6px',
    fontSize: '0.82em',
    lineHeight: '1.4',
    // Muted until there is real content — matches the placeholder color —
    // then switches to full text color regardless of focus state.
    color: 'color-mix(in srgb, var(--muted) 80%, transparent)',
    outline: 'none',
    cursor: 'text',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  '.cm-md-image-caption:empty::before': {
    content: 'attr(data-placeholder)',
    color: 'color-mix(in srgb, var(--muted) 80%, transparent)',
  },
  '.cm-md-image-caption:not(:empty)': {
    color: 'var(--text)',
  },
  '.cm-md-link': {
    color: 'var(--accent) !important',
    textDecoration: 'underline',
    textDecorationColor: 'color-mix(in srgb, var(--accent) 55%, transparent)',
    textUnderlineOffset: '0.16em',
    cursor: 'pointer',
  },
  '.cm-md-link:hover': {
    textDecorationColor: 'var(--accent)',
  },
  '.cm-line.cm-md-quote': {
    borderLeft: '2px solid var(--border)',
    paddingLeft: '8px',
  },
  // List rows sit two characters in from ordinary body text.
  '.cm-line.cm-md-list-line': {
    paddingLeft: '2ch',
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
    paddingLeft: '24px',
    paddingRight: '24px',
    fontSize: '0.8em !important',
  },

  '.cm-line.cm-md-code-line span': {
    fontSize: '12px !important',
  },
  '.cm-line.cm-md-code-open': {
    fontSize: '12px',
    borderRadius: '8px 8px 0 0',
    height: '22px',
    paddingTop: '2px',
    paddingLeft: '12px',
    paddingRight: '12px',
  },
  '.cm-line.cm-md-code-close': {
    fontSize: '12px',
    borderRadius: '0 0 8px 8px',
    height: '22px',
    paddingLeft: '12px',
    paddingRight: '12px',
  },
  '.cm-md-code-fence-empty': { opacity: '0' },
  '.cm-md-code-copy': {
    float: 'right',
    height: '20px',
    margin: '4px -7px',
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
    // the same root the font-size menu writes — 12px at the 16px tier,
    // scaling with the menu, independent of `.cm-scroller`/`.cm-content`.
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
        fontSize: '12px',
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
  { tag: tags.strikethrough, color: 'var(--muted)', textDecoration: 'line-through' },
  // Background/padding belong solely to semantic `.cm-md-inline-code` below.
  // Keeping them here too paints nested CodeText/InlineCode spans twice.
  { tag: tags.monospace, color: 'var(--muted)' },
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

interface LinkPreviewResult {
  decorations: any[];
  urlRanges: Array<{ from: number; to: number }>;
}

// Links opened from the editor must never execute script/data URLs. Relative
// destinations remain literal Markdown because resolving them against the
// extension panel URL would be misleading. Finch's Browser API accepts only
// explicit HTTP(S) destinations, so mailto links remain literal too.
function safeClickableHref(raw: string): string | null {
  const href = raw.trim();
  return /^https?:\/\//i.test(href) ? href : null;
}

function clickableLinkMark(href: string): Decoration {
  return Decoration.mark({
    class: 'cm-md-link',
    attributes: {
      'data-md-href': href,
      role: 'link',
      title: href,
    },
  });
}

// Render inline links from the GFM syntax tree rather than a regex, so nested
// punctuation and image syntax stay correct:
//   [title](url) -> clickable "title"
//   <https://…>  -> clickable URL (angle brackets hidden)
//   https://…    -> clickable URL
// Entering/selecting a link restores its full source for editing.
class MarkdownImageWidget extends WidgetType {
  private captionEl: HTMLElement | null = null;

  constructor(private readonly src: string, private readonly alt: string) { super(); }
  eq(other: MarkdownImageWidget): boolean { return other.src === this.src && other.alt === this.alt; }

  // WidgetType ignores DOM events by default. Clicks on the image itself
  // (open preview) or on the wrapper background still need to reach the
  // EditorView, but the caption is a real contenteditable node and must
  // handle its own clicks/typing/selection without CodeMirror interfering —
  // otherwise every keystroke would fight with the main editor selection.
  ignoreEvent(event: Event): boolean {
    return !!(this.captionEl && event.target instanceof Node && this.captionEl.contains(event.target));
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-md-image-block';
    const image = document.createElement('img');
    image.src = this.src;
    image.alt = this.alt;
    image.dataset.mdImageSrc = this.src;
    image.title = this.alt || this.src;
    wrap.appendChild(image);

    // The caption doubles as the Markdown alt text. Edits commit back into
    // the document on blur/Enter rather than per keystroke, so typing never
    // triggers a decoration rebuild (no flicker, no lost caret).
    const caption = document.createElement('div');
    caption.className = 'cm-md-image-caption';
    caption.contentEditable = 'plaintext-only' as any;
    if (caption.contentEditable !== 'plaintext-only') caption.contentEditable = 'true';
    caption.spellcheck = false;
    caption.dataset.placeholder = '添加图片说明…';
    caption.textContent = this.alt;
    caption.addEventListener('paste', (event) => {
      event.preventDefault();
      const text = event.clipboardData?.getData('text/plain') ?? '';
      document.execCommand('insertText', false, text.replace(/[\r\n]+/g, ' '));
    });
    caption.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        caption.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        caption.textContent = this.alt;
        caption.blur();
      }
    });
    // Deleting all text with backspace often leaves a stray <br> behind,
    // which would defeat the CSS `:empty` check driving the muted/placeholder
    // color — normalize it away so "no caption yet" always looks muted.
    caption.addEventListener('input', () => {
      if (!caption.textContent) caption.replaceChildren();
    });
    caption.addEventListener('blur', () => commitImageCaption(view, wrap, this.alt, caption.textContent ?? ''));
    wrap.appendChild(caption);
    this.captionEl = caption;
    return wrap;
  }
}

// Reads back the Image node that currently owns `wrap` (positions shift as
// the document is edited elsewhere, so this is resolved fresh on commit
// rather than captured once at decoration build time) and rewrites just its
// alt text, leaving the URL and title untouched.
function commitImageCaption(view: EditorView, wrap: HTMLElement, previousAlt: string, nextAlt: string): void {
  if (nextAlt === previousAlt) return;
  let pos: number;
  try { pos = view.posAtDOM(wrap); } catch { return; }
  const line = view.state.doc.lineAt(Math.min(pos, view.state.doc.length));
  const found: Array<{ from: number; to: number }> = [];
  syntaxTree(view.state).iterate({
    from: line.from,
    to: line.to,
    enter: (ref) => {
      if (ref.name === 'Image' && ref.from <= pos && pos <= ref.to) {
        found.push({ from: ref.from, to: ref.to });
        return false;
      }
      return undefined;
    },
  });
  const range = found[0];
  if (!range) return;
  const source = view.state.sliceDoc(range.from, range.to);
  const match = /^!\[[^\]]*\](\([^)]*\))/.exec(source);
  if (!match) return;
  view.dispatch({ changes: { from: range.from, to: range.to, insert: `![${nextAlt}]${match[1]}` } });
}

// Block widgets must be delivered through a StateField's direct
// EditorView.decorations provider. ViewPlugin decorations are computed after
// viewport layout and may not change vertical layout. Keeping image wrappers
// in this field makes documents containing images safe to open.
function imageWrapperDecorations(state: EditorState): DecorationSet {
  const decorations: any[] = [];
  syntaxTree(state).iterate({
    enter: (ref) => {
      if (ref.name !== 'Image') return undefined;
      const line = state.doc.lineAt(ref.from);
      if (line.text.trim() !== state.sliceDoc(ref.from, ref.to)) return false;
      // Images stay rendered even while the selection sits on them — the
      // caption is directly editable and the whole node is deletable as one
      // atomic unit (see `imageAtomicRanges` below), so there is no need to
      // ever fall back to raw Markdown source and jar the layout.
      const url = ref.node.getChild('URL');
      if (!url) return false;
      const source = state.sliceDoc(ref.from, ref.to);
      const alt = /^!\[([^\]]*)\]/.exec(source)?.[1] ?? '';
      const src = state.sliceDoc(url.from, url.to).trim();
      if (!src) return false;
      decorations.push(Decoration.replace({
        widget: new MarkdownImageWidget(src, alt),
        inclusive: false,
      }).range(ref.from, ref.to));
      return false;
    },
  });
  return Decoration.set(decorations, true);
}

const imageWrapperExtension = StateField.define<DecorationSet>({
  create: imageWrapperDecorations,
  update(decorations, transaction) {
    // Selection no longer changes what an image renders as, so only doc
    // edits need to recompute this field (cheaper, and avoids needlessly
    // recreating widget objects — hence caption DOM — on every cursor move).
    return transaction.docChanged ? imageWrapperDecorations(transaction.state) : decorations.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

// Treat each image as a single indivisible unit for cursor motion and
// deletion: arrow keys skip over it in one step, and Backspace/Delete at
// either boundary removes the whole Markdown source in one keystroke —
// this is the "select the image and delete it" gesture, no custom
// selection/keymap handling required.
const imageAtomicRanges = EditorView.atomicRanges.of((view) => view.state.field(imageWrapperExtension));

function collectLinkPreview(view: EditorView): LinkPreviewResult {
  const decorations: any[] = [];
  const urlRanges: Array<{ from: number; to: number }> = [];
  const tree = syntaxTree(view.state);

  // Protect every parsed URL from the generic emphasis/code regex pass below
  // (`_` inside a URL must never disappear as if it were Markdown emphasis).
  tree.iterate({
    enter: (ref) => {
      if (ref.name === 'URL') urlRanges.push({ from: ref.from, to: ref.to });
    },
  });

  tree.iterate({
    enter: (ref) => {
      if (ref.name === 'Table' || ref.name === 'Image') return false;

      if (ref.name === 'Link') {
        const url = ref.node.getChild('URL');
        const marks = ref.node.getChildren('LinkMark');
        // Reference links have no inline URL; leave them literal until a
        // reference resolver is added rather than making a fake local link.
        if (!url || marks.length < 4 || selectionTouchesDelimiter(view, ref.from, ref.to)) return false;
        const href = safeClickableHref(view.state.sliceDoc(url.from, url.to));
        const labelOpen = marks[0];
        const labelClose = marks[1];
        if (!href || labelOpen.to >= labelClose.from) return false;
        decorations.push(hiddenMarkdownDelimiter.range(labelOpen.from, labelOpen.to));
        decorations.push(clickableLinkMark(href).range(labelOpen.to, labelClose.from));
        // Collapse `](destination)` as one range. This also handles an
        // optional Markdown link title after the URL without extra parsing.
        decorations.push(hiddenMarkdownDelimiter.range(labelClose.from, ref.to));
        return false;
      }

      if (ref.name === 'Autolink') {
        const url = ref.node.getChild('URL');
        const marks = ref.node.getChildren('LinkMark');
        if (!url || marks.length < 2 || selectionTouchesDelimiter(view, ref.from, ref.to)) return false;
        const href = safeClickableHref(view.state.sliceDoc(url.from, url.to));
        if (!href) return false;
        decorations.push(hiddenMarkdownDelimiter.range(marks[0].from, marks[0].to));
        decorations.push(clickableLinkMark(href).range(url.from, url.to));
        decorations.push(hiddenMarkdownDelimiter.range(marks[marks.length - 1].from, marks[marks.length - 1].to));
        return false;
      }

      if (ref.name === 'URL') {
        // URL children of Link/Autolink/Image were skipped with their parent;
        // reaching here means a GFM bare URL or a reference-definition URL.
        if (selectionTouchesDelimiter(view, ref.from, ref.to)) return undefined;
        const href = safeClickableHref(view.state.sliceDoc(ref.from, ref.to));
        if (href) decorations.push(clickableLinkMark(href).range(ref.from, ref.to));
      }
      return undefined;
    },
  });

  return { decorations, urlRanges };
}

// Hide only delimiter nodes that the GFM parser recognizes as real inline
// formatting. This covers `*text*`, `_text_`, strong emphasis, nested `***`,
// and strikethrough without mistaking list bullets, horizontal rules, or
// literal asterisks for formatting syntax.
function collectInlineFormatPreview(view: EditorView): any[] {
  const decorations: any[] = [];
  syntaxTree(view.state).iterate({
    enter: (ref) => {
      if (ref.name === 'Table' || ref.name === 'Image') return false;
      const markName = ref.name === 'Strikethrough'
        ? 'StrikethroughMark'
        : ref.name === 'Emphasis' || ref.name === 'StrongEmphasis'
          ? 'EmphasisMark'
          : undefined;
      if (!markName) return undefined;
      // Reveal the whole formatting unit while editing it. Returning false
      // also keeps nested markers (for example `***text***`) visible together.
      if (selectionTouchesDelimiter(view, ref.from, ref.to)) return false;
      for (const mark of ref.node.getChildren(markName)) {
        decorations.push(hiddenMarkdownDelimiter.range(mark.from, mark.to));
      }
      return undefined;
    },
  });
  return decorations;
}

function overlapsRanges(from: number, to: number, ranges: Array<{ from: number; to: number }>): boolean {
  return ranges.some((range) => from < range.to && to > range.from);
}

function markdownLinkFromEvent(event: MouseEvent): HTMLElement | null {
  if (event.button !== 0 || !(event.target instanceof Element)) return null;
  return event.target.closest<HTMLElement>('.cm-md-link[data-md-href]');
}

function handleMarkdownLinkMouseDown(event: MouseEvent): boolean {
  if (!markdownLinkFromEvent(event)) return false;
  // Keep CodeMirror from moving the cursor and removing the link decoration
  // before the subsequent click event can activate it.
  event.preventDefault();
  event.stopPropagation();
  return true;
}

function handleMarkdownLinkClick(event: MouseEvent, onOpenLink?: (href: string) => void): boolean {
  const href = markdownLinkFromEvent(event)?.dataset.mdHref;
  if (!href) return false;
  event.preventDefault();
  event.stopPropagation();
  onOpenLink?.(href);
  return true;
}

function markdownImageFromEvent(event: MouseEvent): HTMLImageElement | null {
  if (event.button !== 0 || !(event.target instanceof Element)) return null;
  return event.target.closest<HTMLImageElement>('.cm-md-image-block img[data-md-image-src]');
}

function handleMarkdownImageMouseDown(event: MouseEvent): boolean {
  if (!markdownImageFromEvent(event)) return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

function handleMarkdownImageClick(event: MouseEvent, onOpenImage?: (src: string) => void): boolean {
  const src = markdownImageFromEvent(event)?.dataset.mdImageSrc;
  if (!src) return false;
  event.preventDefault();
  event.stopPropagation();
  onOpenImage?.(src);
  return true;
}

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

// GFM Table blocks are rendered by the interactive table widget (a block
// replacing decoration spanning the whole table). The live-preview pass must
// leave those lines alone — its inline hidden-marker replacements would
// overlap the replaced block, and the widget draws cell content itself.
function collectTableLines(view: EditorView): Set<number> {
  const lines = new Set<number>();
  syntaxTree(view.state).iterate({
    enter: (node) => {
      if (node.name === 'Table') {
        const first = view.state.doc.lineAt(node.from).number;
        const last = view.state.doc.lineAt(node.to).number;
        for (let n = first; n <= last; n++) lines.add(n);
        return false;
      }
      return undefined;
    },
  });
  return lines;
}

function computeMarkdownLivePreview(view: EditorView, previewLinks = true): DecorationSet {
  const ranges: any[] = [];
  const doc = view.state.doc;
  const codeLines = collectCodeLines(view);
  const tableLines = collectTableLines(view);
  const linkPreview: LinkPreviewResult = previewLinks
    ? collectLinkPreview(view)
    : { decorations: [], urlRanges: [] };
  ranges.push(...linkPreview.decorations, ...collectInlineFormatPreview(view));
  for (let lineNo = 1; lineNo <= doc.lines; lineNo++) {
    const line = doc.line(lineNo);
    if (tableLines.has(lineNo)) continue;
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

    INLINE_CODE_RE.lastIndex = 0;
    let inlineCode: RegExpExecArray | null;
    while ((inlineCode = INLINE_CODE_RE.exec(line.text))) {
      const from = line.from + inlineCode.index;
      const to = from + inlineCode[0].length;
      if (overlapsRanges(from, to, linkPreview.urlRanges)) continue;
      ranges.push(inlineCodeDecoration.range(from + 1, to - 1));
      if (!selectionTouchesDelimiter(view, from, to)) {
        ranges.push(hiddenMarkdownDelimiter.range(from, from + 1));
        ranges.push(hiddenMarkdownDelimiter.range(to - 1, to));
      }
    }
  }
  return Decoration.set(ranges, true);
}

function createMarkdownLivePreviewPlugin(previewLinks: boolean) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) { this.decorations = computeMarkdownLivePreview(view, previewLinks); }
      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = computeMarkdownLivePreview(update.view, previewLinks);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

const livePreviewMarkdownPlugin = createMarkdownLivePreviewPlugin(true);

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

function moveIntoAdjacentTable(view: EditorView, direction: -1 | 1): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const currentLine = view.state.doc.lineAt(selection.head).number;
  let tableIndex = -1;
  let index = 0;
  syntaxTree(view.state).iterate({
    enter: (ref) => {
      if (ref.name !== 'Table') return undefined;
      const first = view.state.doc.lineAt(ref.from).number;
      const last = view.state.doc.lineAt(ref.to).number;
      if ((direction > 0 && first === currentLine + 1) || (direction < 0 && last === currentLine - 1)) {
        tableIndex = index;
      }
      index++;
      return false;
    },
  });
  if (tableIndex < 0) return false;

  // The table package selects a cell from pointerdown; replay that native
  // entry path so its own embedded editor, selection state and key bindings
  // remain authoritative. A frame lets the block widget be measured first.
  window.requestAnimationFrame(() => {
    const widget = view.dom.querySelectorAll<HTMLElement>('.tbl-table-widget')[tableIndex];
    const cells = widget?.querySelectorAll<HTMLElement>('.tbl-cell');
    if (!cells?.length) return;
    const cell = cells[direction > 0 ? 0 : cells.length - 1];
    const rect = cell.getBoundingClientRect();
    cell.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      clientX: rect.left + Math.min(12, rect.width / 2),
      clientY: rect.top + Math.min(12, rect.height / 2),
    }));
    window.requestAnimationFrame(() => cell.querySelector<HTMLElement>('.tbl-cell-editor .cm-content')?.focus());
  });
  return true;
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

// Completes the fence block the instant the 3rd backtick is typed — not on
// Enter — so it feels like the same "type ``` and it closes itself" moment
// editors like Typora/Obsidian give. Only intercepts the specific keystroke
// that turns "``" into "```" at the start of an otherwise-empty line (empty
// but for leading whitespace, and nothing after the cursor); any other
// backtick keystroke (inline code spans, a 4th+ backtick, etc.) falls
// through to normal self-insertion. `` ```ts `` / `` ```python `` are still
// natural to type: the cursor lands right after the 3rd backtick, on the
// same (opening) line, so the language name types in before the new blank
// + closing-fence lines below it.
function handleFenceTriggerBacktick(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const line = view.state.doc.lineAt(selection.head);
  const before = line.text.slice(0, selection.head - line.from);
  const after = line.text.slice(selection.head - line.from);
  if (!/^\s*``$/.test(before) || after.trim() !== '') return false;

  let precedingFences = 0;
  for (let lineNo = 1; lineNo < line.number; lineNo++) {
    if (FENCE_RE.test(view.state.doc.line(lineNo).text)) precedingFences++;
  }
  // An odd number of preceding fences means this one closes an existing
  // block, so it should type as a plain backtick, not trigger completion.
  if (precedingFences % 2 !== 0) return false;

  const indent = /^\s*/.exec(before)?.[0] ?? '';
  const closing = `${indent}\`\`\``;
  view.dispatch({
    changes: { from: selection.head, insert: `\`\n\n${closing}` },
    selection: { anchor: selection.head + 1 },
    scrollIntoView: true,
  });
  return true;
}

// Fallback for a pasted opening fence (three backticks landing in one paste,
// so the per-keystroke handler above never sees them individually): Enter
// still completes an unmatched opening fence into a full block. The cursor
// lands on the empty code line between the two fences.
function completeOpeningCodeFence(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const line = view.state.doc.lineAt(selection.head);
  if (selection.head !== line.to || !FENCE_RE.test(line.text)) return false;

  let fenceIndex = 0;
  let fenceTotal = 0;
  for (let lineNo = 1; lineNo <= view.state.doc.lines; lineNo++) {
    if (!FENCE_RE.test(view.state.doc.line(lineNo).text)) continue;
    fenceTotal++;
    if (lineNo === line.number) fenceIndex = fenceTotal;
  }
  // Fences pair sequentially: the 1st, 3rd, 5th… open blocks. This line
  // needs a closing fence only when it opens a block AND no fence follows
  // it in the document — the 3rd-backtick handler already inserts one, and
  // counting only the lines above (the old check) made Enter insert a
  // second closing fence into an already-complete block.
  if (fenceIndex % 2 !== 1 || fenceIndex !== fenceTotal) return false;

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

// --- Interactive Markdown tables ----------------------------------------
// `codemirror-markdown-tables` replaces GFM table syntax with an editable
// table component (Tab/Enter move between cells, borders insert/delete rows
// and columns, headers drag to reorder). All theme colors are expressed as
// panel CSS variables, so the table follows the Finch skin — light or dark —
// with no extra wiring; the single-theme form applies in both CodeMirror
// light/dark modes (the editor never sets the `dark` facet).
const finchTableTheme = TableTheme.light.with({
  '--tbl-theme-row-background': 'var(--card)',
  '--tbl-theme-odd-row-background': 'var(--card)',
  '--tbl-theme-even-row-background': 'color-mix(in srgb, var(--text) 4%, var(--card))',
  '--tbl-theme-header-row-background': 'color-mix(in srgb, var(--text) 9%, var(--card))',
  '--tbl-theme-text-color': 'var(--text)',
  '--tbl-theme-outline-color': 'var(--accent)',
  '--tbl-theme-border-color': 'color-mix(in srgb, var(--text) 16%, transparent)',
  '--tbl-theme-border-hover-color': 'color-mix(in srgb, var(--accent) 50%, transparent)',
  '--tbl-theme-border-active-color': 'var(--accent)',
  '--tbl-theme-menu-background': 'var(--card)',
  '--tbl-theme-menu-text-color': 'var(--text)',
  '--tbl-theme-menu-border-color': 'var(--border)',
  '--tbl-theme-menu-hover-background': 'color-mix(in srgb, var(--accent) 14%, transparent)',
  '--tbl-theme-menu-hover-text-color': 'var(--text)',
  '--tbl-theme-select-all-focus-overlay': 'color-mix(in srgb, var(--accent) 34%, transparent)',
  '--tbl-theme-select-all-blur-overlay': 'color-mix(in srgb, var(--accent) 18%, transparent)',
});

// Table prose follows the editor's own font menu (--md-editor-font-family is
// set on the editor root by setFontFamily); menus use the Finch UI font.
const finchTableStyle = TableStyle.default.with({
  '--tbl-style-font-family': 'var(--md-editor-font-family, var(--finch-font-mono))',
  '--tbl-style-menu-font-family': 'var(--finch-font-body, system-ui)',
});

// codemirror-markdown-tables v1.0.1 hardcodes its Svelte menu labels and does
// not expose a locale/labels config. Translate only the leaf text nodes at
// the portal boundary; actions, icons and DOM structure remain package-owned.
const TABLE_MENU_ZH: Record<string, string> = {
  'Sort by column (A-Z)': '按列升序（A–Z）',
  'Sort by column (Z-A)': '按列降序（Z–A）',
  'Sort by row (A-Z)': '按行升序（A–Z）',
  'Sort by row (Z-A)': '按行降序（Z–A）',
  'Align none': '取消对齐',
  'Align left': '左对齐',
  'Align center': '居中对齐',
  'Align right': '右对齐',
  'Add row above': '在上方添加行',
  'Add row below': '在下方添加行',
  'Add column before': '在左侧添加列',
  'Add column after': '在右侧添加列',
  'Move row up': '上移行',
  'Move row down': '下移行',
  'Move column left': '左移列',
  'Move column right': '右移列',
  'Duplicate row': '复制行',
  'Duplicate column': '复制列',
  'Clear row': '清空行',
  'Clear column': '清空列',
  'Delete row': '删除行',
  'Delete column': '删除列',
};
const TABLE_MENU_EN = new Map(Object.entries(TABLE_MENU_ZH).map(([en, zh]) => [zh, en]));

function translateTableMenus(): void {
  const isZh = /^zh/i.test(document.documentElement.lang);
  document.querySelectorAll<HTMLElement>('.tbl-menu-item-text').forEach((element) => {
    const current = (element.textContent || '').trim();
    const english = TABLE_MENU_EN.get(current) || current;
    const next = isZh ? TABLE_MENU_ZH[english] || current : english;
    // Avoid a MutationObserver feedback loop — setting identical textContent
    // would still emit another childList mutation.
    if (next !== current) element.textContent = next;
  });
}

function installTableMenuI18n(): () => void {
  translateTableMenus();
  const observer = new MutationObserver((mutations) => {
    const menuChanged = mutations.some((mutation) => {
      if (mutation.type === 'attributes') return true;
      if (mutation.target instanceof Element && mutation.target.closest('.tbl-menu')) return true;
      return Array.from(mutation.addedNodes).some((node) =>
        node instanceof Element
        && (node.matches('.tbl-menu, .tbl-menu-item-text') || !!node.querySelector('.tbl-menu-item-text')),
      );
    });
    if (menuChanged) translateTableMenus();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['lang'],
  });
  return () => observer.disconnect();
}

function escapeTableCellHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

// Unselected cells are package-owned static HTML, not CodeMirror views. Keep
// this deliberately small and self-contained: URLs, emphasis/strong emphasis
// and inline code only. The original delimiters remain in the DOM (hidden by
// CSS), so the table package can still map a click/selection back to Markdown.
function renderStaticTableCellMarkdown(source: string): string {
  const tokens: string[] = [];
  const token = (html: string) => `\u0000${tokens.push(html) - 1}\u0000`;
  let html = escapeTableCellHtml(source);

  html = html.replace(/`([^`\n]+)`/g, (_match, code) => token(
    '<span class="cm-md-delimiter">`</span>'
    + `<span class="cm-md-inline-code">${code}</span>`
    + '<span class="cm-md-delimiter">`</span>',
  ));
  // Resolve a Markdown link before bare URLs, otherwise the URL token would
  // leave its surrounding `[label]()` syntax visible in the static cell.
  html = html.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gi, (_match, label, url) => token(
    '<span class="cm-md-delimiter">[</span>'
    + `<span class="cm-md-link" data-md-href="${url}" role="link" title="${url}">${label}</span>`
    + '<span class="cm-md-delimiter">](</span>'
    + `<span class="cm-md-delimiter">${url}</span>`
    + '<span class="cm-md-delimiter">)</span>',
  ));
  html = html.replace(/https?:\/\/[^\s<]+/gi, (url) => token(
    `<span class="cm-md-link" data-md-href="${url}" role="link" title="${url}">${url}</span>`,
  ));
  html = html.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, (_match, delimiter, text) =>
    `<span class="cm-md-delimiter">${delimiter}</span><strong class="cm-md-strong">${text}</strong><span class="cm-md-delimiter">${delimiter}</span>`,
  );
  html = html.replace(/\*(?=\S)([^*\n]*?\S)\*/g, (_match, text) =>
    `<span class="cm-md-delimiter">*</span><em class="cm-md-emphasis">${text}</em><span class="cm-md-delimiter">*</span>`,
  );
  html = html.replace(/_(?=\S)([^_\n]*?\S)_/g, (_match, text) =>
    `<span class="cm-md-delimiter">_</span><em class="cm-md-emphasis">${text}</em><span class="cm-md-delimiter">_</span>`,
  );
  return html.replace(/\u0000(\d+)\u0000/g, (_match, index) => tokens[Number(index)]!);
}

function installStaticTableCellPreview(root: HTMLElement): () => void {
  const render = () => root.querySelectorAll<HTMLElement>('.tbl-cell-view').forEach((cell) => {
    const cellRoot = cell.closest<HTMLElement>('.tbl-cell');
    const editorContent = cellRoot?.querySelector<HTMLElement>('.tbl-cell-editor .cm-content');
    const alreadyRendered = !!cell.querySelector('[data-md-preview]');

    // A selected cell keeps its static sibling hidden while its embedded CM
    // editor changes. Cache that editor's source on the owning cell; when the
    // editor is later unmounted, the old static DOM must not win over it.
    if (editorContent) cellRoot!.dataset.mdPreviewEditedSource = editorContent.textContent || '';
    const source = editorContent
      ? editorContent.textContent || ''
      : alreadyRendered
        ? (cellRoot?.dataset.mdPreviewEditedSource ?? cell.textContent ?? '')
        : cell.textContent || '';

    if (cell.dataset.mdPreviewSource === source && alreadyRendered) return;
    cell.dataset.mdPreviewSource = source;
    cell.innerHTML = `<span data-md-preview="true">${renderStaticTableCellMarkdown(source)}</span>`;
  });
  // Svelte can unmount the cell editor and restore its static sibling across
  // several microtasks. Render on the next animation frame, after that DOM
  // transition settles, instead of racing its intermediate static markup.
  let frame = 0;
  const scheduleRender = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  };
  render();
  const observer = new MutationObserver(scheduleRender);
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  return () => {
    observer.disconnect();
    if (frame) window.cancelAnimationFrame(frame);
  };
}

const markdownEditorKeymap = keymap.of([
  { key: '`', run: handleFenceTriggerBacktick },
  { key: 'Enter', run: completeOpeningCodeFence },
  { key: 'ArrowUp', run: (view) => moveIntoAdjacentTable(view, -1) || moveIntoSkippedDelimiterLine(view, -1) },
  { key: 'ArrowDown', run: (view) => moveIntoAdjacentTable(view, 1) || moveIntoSkippedDelimiterLine(view, 1) },
  { key: 'Tab', run: (view) => selectionStartsOnListItem(view) && indentMore(view) },
  { key: 'Shift-Tab', run: (view) => selectionStartsOnListItem(view) && indentLess(view) },
  { key: 'Alt-Mod-t', run: insertEmptyMarkdownTable() },
  indentWithTab,
]);

function createMarkdownEditor(options: MarkdownEditorOptions): MarkdownEditorHandle {
  let suppressChange = false;
  // Shared parser configuration for the document and an interactive table
  // cell. A cell does not need fenced-code language loading, but it must use
  // the same GFM grammar so bare HTTP(S) URLs and inline Markdown parse.
  const markdownConfig = {
    // Default base is plain CommonMark — it has NO GFM table parsing, so
    // the syntax tree never grows `Table` nodes and the interactive table
    // widget (and `collectTableLines`) would never fire. `markdownLanguage`
    // is the GFM build (tables, task lists, strikethrough, autolinks).
    base: markdownLanguage,
    // CommonMark's Setext heading rule silently promotes a plain line of
    // text into a bold, accent-colored H1/H2 whenever it's immediately
    // followed (no blank line) by a `-`/`=` divider — surprising in this
    // editor, where `---` is meant to always read as a plain horizontal
    // rule. Dropping the SetextHeading block parser keeps that divider
    // literal instead of retroactively re-coloring the line above it.
    extensions: [{ remove: ['SetextHeading'] }],
  };
  const markdownSupport = markdown({ ...markdownConfig, codeLanguages: fencedCodeLanguages });
  const cellMarkdownSupport = markdown(markdownConfig);
  const view = new EditorView({
    doc: options.value ?? '',
    parent: options.parent,
    extensions: [
      markdownEditorKeymap,
      basicSetup,
      codeGutterLineHighlighter,
      markdownSupport,
      // Typing `|` on an empty line pops a table-size picker (2x2/3x3/4x4)
      // via CodeMirror's own autocompletion (basicSetup already includes
      // the autocompletion extension).
      markdownSupport.language.data.of({ autocomplete: markdownTableAutocompleter() }),
      // Interactive table component: Tab/Enter navigate cells, borders
      // insert/delete rows & columns, row/column headers drag to reorder.
      markdownTables({
        theme: finchTableTheme,
        style: finchTableStyle,
        // `.cm-content` has no horizontal padding, so the row/column grips
        // sit on the table's own top/left border instead of hanging outside
        // the editor edge where they would be clipped.
        handlePosition: 'inside',
        // Undo/redo and search inside a cell must act on the document's
        // history, which lives on the root editor — delegate those keys up.
        globalKeyBindings: [...historyKeymap, ...searchKeymap],
        // A selected cell is an editing surface: keep its Markdown entirely
        // literal. This also keeps the DOM text lossless for static-cell
        // synchronization when the embedded editor unmounts.
        extensions: [
          cellMarkdownSupport,
          syntaxHighlighting(markdownHighlight),
          keymap.of(defaultKeymap),
        ],
      }),
      EditorView.lineWrapping,
      finchTheme,
      syntaxHighlighting(markdownHighlight),
      blockSpacingPlugin,
      imageWrapperExtension,
      imageAtomicRanges,
      livePreviewMarkdownPlugin,
      EditorView.domEventHandlers({
        mousedown: (event) => handleMarkdownImageMouseDown(event) || handleMarkdownLinkMouseDown(event),
        click: (event) => handleMarkdownImageClick(event, options.onOpenImage) || handleMarkdownLinkClick(event, options.onOpenLink),
        paste: (event, dispatchView) => imagePasteHandler(dispatchView, event, options.onPasteImage),
        drop: (event, dispatchView) => imageDropHandler(dispatchView, event, options.onPasteImage),
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !suppressChange) options.onChange(update.state.doc.toString());
      }),
    ],
  });
  const disposeTableMenuI18n = installTableMenuI18n();
  const disposeStaticTableCellPreview = installStaticTableCellPreview(options.parent);

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
      // Always anchor to `end` (range.to), not `range.head`: head is
      // whichever side the caret landed on, so a backward drag (or a
      // backward keyboard selection) would put it at the *start* of the
      // selection instead of its end. Bias toward the upstream side (-1)
      // of that position: at a soft-wrap boundary, or right after a
      // literal "\n", the default (downstream) side reports the
      // coordinates of the *next* visual line's start instead of the
      // previous line's tail, which would pin the popup to the wrong line.
      const anchor =
        view.coordsAtPos(end, -1) ??
        view.coordsAtPos(end) ??
        view.dom.getBoundingClientRect();
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
    destroy() {
      disposeStaticTableCellPreview();
      disposeTableMenuI18n();
      view.destroy();
    },
  };
}

declare global {
  interface Window {
    MarkdownCodeMirror: { create(options: MarkdownEditorOptions): MarkdownEditorHandle };
  }
}

window.MarkdownCodeMirror = { create: createMarkdownEditor };

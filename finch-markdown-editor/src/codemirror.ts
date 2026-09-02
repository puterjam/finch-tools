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
import { EditorState, RangeSet, RangeSetBuilder, StateEffect, StateField, Transaction, type Text } from '@codemirror/state';
import { indentLess, indentMore, indentWithTab, defaultKeymap, historyKeymap } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { autocompletion, type Completion, type CompletionContext } from '@codemirror/autocomplete';
import {
  Decoration,
  type DecorationSet,
  GutterMarker,
  gutter,
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
  /** Anchor at the selection's end (tail). */
  rect: { top: number; bottom: number; left: number; right: number };
  /** Anchor at the selection's start (head of the first line). */
  startRect: { top: number; bottom: number; left: number; right: number };
}

interface ExternalChangeSummary {
  /** Number of separate edited regions. */
  hunks: number;
  /** Total lines flashed across all regions. */
  changedLines: number;
  /** 1-based first and last changed line, for a one-region summary. */
  fromLine: number;
  toLine: number;
}

interface MarkdownEditorHandle {
  getValue(): string;
  setValue(value: string): void;
  applyExternalValue(value: string): ExternalChangeSummary | null;
  getSelection(): EditorSelectionInfo | null;
  hasFocus(): boolean;
  focus(): void;
  layout(): void;
  setFontSize(size: number): void;
  setFontFamily(family: string): void;
  setComfortWriting(on: boolean): void;
  setFocusMode(on: boolean): void;
  setAiWorkingLines(fromLine: number, toLine: number): void;
  /** Hint shown on the caret's line while it is empty ("press space to…").
   * `codeText` is used for blank lines inside fenced code blocks, where
   * Markdown's slash-format menu is intentionally unavailable. Empty text
   * turns the affordance off (AppPanel). */
  setAiHint(text: string, codeText?: string): void;
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
  /** Space pressed on an otherwise empty line, with the AI hint enabled.
   * Return true to consume the key (the host opens its own prompt bar in
   * place of the space that would have been typed), false to type normally. */
  onAiHintTrigger?(info: { line: number; rect: { top: number; bottom: number; left: number; right: number } }): boolean;
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
    padding: '48px 0',
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
    // Anchor the blank-line AI hint to the line's final laid-out box. The
    // generated hint must be absolute because CodeMirror puts a literal
    // <br> in every empty contenteditable line; an inline ::after can only
    // flow after that <br>, i.e. onto a second visual row.
    position: 'relative',
    width: CM_LINE_WIDTH,
    maxWidth: CM_LINE_MAX_WIDTH,
    marginInline: 'auto',
    // Line spacing comes from CSS tokens so the toolbar's comfortable-
    // writing toggle can switch them without touching CodeMirror's managed
    // classes: CM rebuilds view.dom.className on updates, which would wipe
    // any hand-added class (e.g. cm-comfort-write). setComfortWriting()
    // sets these two on view.dom.style instead — inline style, never wiped.
    paddingTop: 'var(--md-line-pad-y, 2px)',
    paddingBottom: 'var(--md-line-pad-y, 2px)',
    lineHeight: 'var(--md-line-height, 1.7rem)',
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
    padding: '12px 16px 12px 6px !important',
  },
  '.tbl-table-widget .tbl-table-wrapper': {
    // width: 'auto !important',
    maxWidth: '100%',
    // paddingTop: '12px',
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
    minHeight: '82px',
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
  '.cm-line.cm-md-h1': { fontSize: '1.4em', fontWeight: '700', lineHeight: 'normal !important'},
  '.cm-line.cm-md-h2': { fontSize: '1.2em', fontWeight: '700', lineHeight: 'normal !important'},
  '.cm-line.cm-md-h3': { fontSize: '1.15em', fontWeight: '700', lineHeight: 'normal !important'},
  '.cm-line.cm-md-h4': { fontSize: '1.1em', fontWeight: '700', lineHeight: 'normal !important'},
  '.cm-line.cm-md-h5': { fontSize: '1.04em', fontWeight: '700', lineHeight: 'normal !important'},
  '.cm-line.cm-md-h6': { fontSize: '1em', fontWeight: '700', lineHeight: 'normal !important'},
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
  '.ͼx':{
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
    position: 'relative',
    top: '-0.1em',
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
  // The selection outline wraps only the image itself, not the caption
  // below it — the caption is a separate editable field, not part of the
  // "selected as one atomic unit" affordance.
  '.cm-md-image-block.cm-md-image-selected img': {
    outline: '2px solid var(--accent)',
    outlineOffset: '2px',
    borderRadius: '10px',
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
    lineHeight: '1.3rem !important',
    fontFamily: 'var(--finch-font-mono)',
    paddingTop: '0 !important',
    paddingBottom: '0 !important',
    width: 'calc(50rem - 30px) !important',
    paddingInline: '24px',
    // Empty-line AI hint is absolutely positioned, so it does not inherit
    // padding layout. Give it the same content-start offset as code text.
    '--cm-ai-hint-inline-offset': '26px',
    fontSize: '13px !important',
  },

  '.cm-line.cm-md-code-line span': {
    fontSize: '12px !important',
  },
  '.cm-line.cm-md-code-open': {
    fontSize: '12px',
    borderRadius: '8px 8px 0 0',
    height: '22px',
    paddingTop: '2px',
    paddingInline: '12px',
    lineHeight: '1.5rem !important',
  },
  '.cm-line.cm-md-code-close': {
    fontSize: '12px',
    borderRadius: '0 0 8px 8px',
    height: '22px',
    paddingInline: '12px'
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
        lineHeight: 'var(--md-gutter-line-height, 32px)',
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
        lineHeight: '22px',
  },
  // The line-number gutter keeps its normal position and look; the rewrite
  // indicator is a separate column placed to its right in the same gutter row.
  '.cm-gutters .cm-ai-gutter': {
    width: '22px',
    fontSize: '10px',
  },
  // No flex centering here: a wrapped row is taller than one line box, and
  // centering in the *whole* row would drop the spinner/corner below the
  // line number, which sits in the row's first line box (positioned by the
  // `line-height` band above). Everything inside is absolutely positioned
  // against this element instead — anchored either to that same first band
  // (so it lines up with the number) or to the full row height (so rails on
  // neighbouring rows touch).
  '.cm-ai-gutter .cm-gutterElement': {
    position: 'relative',
    padding: '0',
    color: 'var(--accent)',
  },
  // `gutterLineClass` (see codeGutterLineHighlighter) stamps this same
  // `cm-gutter-code-line` class onto every gutter's row for a fenced-code
  // line, not just the line-number gutter — including this one. Rescope
  // the line-height var locally so the spinner/rail/corner markers below,
  // which all size themselves off it, shrink to match the code gutter's
  // real (shorter) 22px row instead of the prose row height. Without this
  // the spinner circle on a code line overflows into the row underneath it.
  '.cm-ai-gutter .cm-gutterElement.cm-gutter-code-line': {
    '--md-gutter-line-height': '22px',
  },
  '.cm-ai-working-mark': {
    position: 'absolute',
    inset: '0',
  },
  // Same band the line number is centered in, so the two align exactly.
  '.cm-ai-working-spinner': {
    position: 'absolute',
    top: '0',
    left: '0',
    right: '0',
    height: 'var(--md-gutter-line-height, 32px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  '.cm-ai-gutter svg': {
    width: '13px',
    height: '13px',
    animation: 'cm-ai-spin 1s linear infinite',
  },
  // A wrapped prose row makes its gutter element taller, but its line number
  // stays aligned with the first line. Limit the dot to that same first-line
  // band; the dot itself uses the band height below to match the number.
  '.cm-ai-added-line': {
    position: 'absolute',
    top: '0',
    left: '0',
    right: '0',
    height: 'var(--md-gutter-line-height, 32px)',
    display: 'flex',
    // alignItems: 'center',
    justifyContent: 'center',
  },
  '.cm-ai-added-dot': {
    width: '6px',
    height: '6px',
    // Match the line-number glyph's vertical band: 12px at 32px compact,
    // 16px at 40px comfortable, and 7px on the 22px code-row override.
    // The -1px is the same optical lift the previous fixed 12px used.
    marginTop: 'calc((var(--md-gutter-line-height, 32px) - 6px) / 2 - 1px)',
    borderRadius: '50%',
    backgroundColor: '#35a854',
    boxShadow: '0 0 0 2px color-mix(in srgb, #35a854 16%, transparent)',
  },
  // Edge-to-edge so it meets the rail on the rows above and below with no
  // seam. `.cm-ai-working-rail-below` is the head row's continuation: it
  // starts just under the spinner instead of at the top of the row.
  '.cm-ai-working-rail': {
    position: 'absolute',
    top: '0',
    bottom: '0',
    left: '50%',
    width: '1.5px',
    marginLeft: '-0.75px',
    borderRadius: '1px',
    backgroundColor: 'var(--accent)',
    opacity: '0.45',
  },
  '.cm-ai-working-rail.cm-ai-working-rail-below': {
    top: 'calc(var(--md-gutter-line-height, 32px) - 7px)',
  },
  // The closing `╰`: down to the middle of the last row's first line box
  // (level with its line number), then a short rounded turn to the right.
  '.cm-ai-working-corner': {
    position: 'absolute',
    top: '0',
    left: '50%',
    width: '6px',
    height: 'calc(var(--md-gutter-line-height, 32px) / 2)',
    marginLeft: '-0.75px',
    borderLeft: '1.5px solid var(--accent)',
    borderBottom: '1.5px solid var(--accent)',
    borderBottomLeftRadius: '5px',
    opacity: '0.45',
  },
  // The hint text itself comes from `--cm-ai-hint` (set by the host, empty
  // when the affordance is off) so this stays out of the editable content.
  '.cm-ai-hint-line::after': {
    content: 'var(--cm-ai-hint, "")',
    color: 'var(--muted)',
    opacity: '0.5',
    pointerEvents: 'none',
    userSelect: 'none',
    // Every empty CodeMirror content line carries a literal <br>. An inline
    // ::after necessarily flows after it, creating the unwanted second
    // visual row. Instead, cover this line's *actual final layout box* and
    // vertically center within it. top+bottom+flex means the placement uses
    // the browser-computed height — it automatically follows different
    // font sizes, line-heights, symmetric line padding, code rows, and the
    // comfort-writing mode without any brittle negative margin constants.
    position: 'absolute',
    top: '0',
    bottom: '0',
    // Normal source lines retain the existing 10px visual inset. Code rows
    // override this token with their own content padding (24px), keeping the
    // hint directly to the right of the code cursor rather than at the box edge.
    left: 'var(--cm-ai-hint-inline-offset, 10px)',
    display: 'flex',
    alignItems: 'center',
    // An empty line is otherwise zero-width. The phrase deliberately never
    // wraps and never inherits prose's aggressive long-word breaking.
    whiteSpace: 'nowrap',
    wordBreak: 'keep-all',
    overflowWrap: 'normal',
  },
  // Fenced-code blank lines deliberately expose only the AI affordance:
  // Markdown block syntax is literal code there, so `/` must not be hinted.
  '.cm-ai-hint-code-line::after': {
    content: 'var(--cm-ai-hint-code, "")',
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
  // Focus mode ("专注" toolbar toggle): non-active lines fade to 70% so the
  // cursor's line stands out while writing. Driven by a CSS token on the
  // editor root (set by setFocusMode) rather than a hand-added class —
  // CM rebuilds view.dom.className on updates, which would drop the class.
  // The `:not(.cm-activeLine)` guard keeps the current line fully opaque.
  // Tables are block widgets, so their static cells do not match `.cm-line`;
  // fade each inactive cell directly instead. A selected cell owns an
  // embedded CodeMirror whose line *does* match the generic rule, therefore
  // restore opacity on both its cell and its inner line explicitly.
  '.cm-line:not(.cm-activeLine)': {
    opacity: 'var(--md-focus-opacity, 1)',
  },
  '.tbl-table-widget .tbl-cell': {
    opacity: 'var(--md-focus-opacity, 1)',
  },
  '.tbl-table-widget .tbl-cell[data-selected], .tbl-table-widget .tbl-cell[data-selected] .cm-line': {
    opacity: '1',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 34%, transparent)',
  },
  '.cm-panels': {
    color: 'var(--text)',
    backgroundColor: 'var(--card)',
    borderTop: 'none',
  },
  // Search / replace panel (Cmd/Ctrl-F, Cmd-Option-F). The default chrome
  // keeps browser-styled inputs/buttons and a bare `×` close, so restyle
  // the whole thing to match the editor: card background, bordered inputs
  // with accent focus, and quiet buttons. The panel is inline-flow (the
  // `<br>` between rows is load-bearing), so children stay inline-block.
  '.cm-panel.cm-search': {
    padding: '6px 30px 7px 8px',
    fontSize: '12px',
    color: 'var(--text)',
    backgroundColor: 'var(--card)',
    borderBottom: '1px solid var(--border)',
    boxShadow: '0 2px 10px rgba(0,0,0,.14)',
  },
  '.cm-panel.cm-search .cm-textfield': {
    width: '140px',
    marginRight: '6px',
    padding: '3px 7px',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    backgroundColor: 'var(--bg)',
    color: 'var(--text)',
    fontFamily: 'var(--finch-font-mono, monospace)',
    fontSize: '12px',
    outline: 'none',
    transition: 'border-color .12s ease, box-shadow .12s ease',
  },
  '.cm-panel.cm-search .cm-textfield:focus': {
    borderColor: 'var(--accent)',
    boxShadow: '0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent)',
  },
  '.cm-panel.cm-search .cm-textfield::placeholder': {
    color: 'color-mix(in srgb, var(--muted) 65%, transparent)',
  },
  '.cm-panel.cm-search .cm-button': {
    marginRight: '4px',
    padding: '3px 9px',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    // The base theme styles .cm-button with a light/dark gradient via
    // `backgroundImage` plus a hardcoded `border: 1px solid #888`, both of
    // which win over any `backgroundColor`/border override below. Kill the
    // gradient explicitly so our quiet solid background actually shows.
    backgroundImage: 'none',
    backgroundColor: 'color-mix(in srgb, var(--text) 4%, transparent)',
    color: 'var(--text)',
    fontSize: '12px',
    fontWeight: '500',
    cursor: 'pointer',
    transition: 'background-color .12s ease, border-color .12s ease',
  },
  '.cm-panel.cm-search .cm-button:hover': {
    backgroundImage: 'none',
    backgroundColor: 'color-mix(in srgb, var(--text) 9%, transparent)',
    borderColor: 'color-mix(in srgb, var(--text) 22%, transparent)',
  },
  '.cm-panel.cm-search .cm-button:active': {
    backgroundImage: 'none',
    backgroundColor: 'color-mix(in srgb, var(--accent) 18%, transparent)',
    borderColor: 'var(--accent)',
  },
  '.cm-panel.cm-search label': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    marginRight: '10px',
    color: 'var(--muted)',
    fontSize: '11.5px',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  },
  '.cm-panel.cm-search input[type=checkbox]': {
    width: '13px',
    height: '13px',
    margin: '0',
    accentColor: 'var(--accent)',
    cursor: 'pointer',
  },
  '.cm-panel.cm-search [name=close]': {
    position: 'absolute',
    top: '5px',
    right: '6px',
    width: '20px',
    height: '20px',
    lineHeight: '1',
    padding: '0',
    border: '1px solid transparent',
    borderRadius: '5px',
    backgroundColor: 'transparent',
    color: 'var(--muted)',
    fontSize: '15px',
    cursor: 'pointer',
  },
  '.cm-panel.cm-search [name=close]:hover': {
    color: 'var(--text)',
    backgroundColor: 'color-mix(in srgb, var(--text) 8%, transparent)',
    borderColor: 'var(--border)',
  },
  // Match highlighting: unselected matches get a quiet accent wash, the
  // currently-selected match (Enter/Shift-Enter cycling) stands out.
  '.cm-editor .cm-content .cm-searchMatch': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 26%, transparent)',
    outline: '1px solid color-mix(in srgb, var(--accent) 38%, transparent)',
    borderRadius: '2px',
  },
  '.cm-editor .cm-content .cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 48%, transparent)',
    outline: '1px solid var(--accent)',
  },
  '.cm-tooltip': {
    color: 'var(--text)',
    backgroundColor: 'var(--card)',
    border: '1px solid var(--border)',
  },
  // Slash-block completion is visually aligned with AppView's font menu:
  // rounded white/card surface, a quiet shallow elevation, compact rows,
  // and delimiter details held to the right rather than reading inline.
  '.cm-tooltip.cm-tooltip-autocomplete': {
    borderRadius: '10px',
    padding: '5px',
    boxShadow: '0 2px 8px rgba(0,0,0,.12)',
    overflow: 'hidden',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    minWidth: '188px',
    fontFamily: 'var(--finch-font-body, system-ui)',
    fontSize: '13px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    display: 'flex',
    alignItems: 'center',
    gap: '0',
    padding: '4px 7px',
    borderRadius: '6px',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    color: 'var(--text)',
    backgroundColor: 'var(--finch-bg-active, color-mix(in srgb, var(--text) 10%, transparent))',
  },
  '.cm-tooltip-autocomplete .cm-completionLabel': {
    flex: '1',
  },
  '.cm-tooltip-autocomplete .cm-completionDetail': {
    marginLeft: 'auto',
    color: 'var(--muted)',
    fontStyle: 'normal',
    fontSize: '0.86em',
  },
  '.cm-tooltip-autocomplete .cm-md-completion-icon': {
    flex: 'none',
    width: '16px',
    height: '16px',
    paddingRight: '8px',
    boxSizing: 'content-box',
    color: 'var(--muted)',
    opacity: '0.82',
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

/** Whether `lineNo` is a body row inside a fenced code block. The opening
 * fence itself is not "inside", while every row after an unmatched opening
 * fence is — including a blank one. */
function isInsideFencedCodeBlock(doc: Text, lineNo: number): boolean {
  let inFence = false;
  for (let current = 1; current < lineNo; current++) {
    if (FENCE_RE.test(doc.line(current).text)) inFence = !inFence;
  }
  return inFence;
}

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

  constructor(private readonly src: string, private readonly alt: string, private readonly selected: boolean) { super(); }
  eq(other: MarkdownImageWidget): boolean { return other.src === this.src && other.alt === this.alt && other.selected === this.selected; }

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
    wrap.className = `cm-md-image-block${this.selected ? ' cm-md-image-selected' : ''}`;
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

  // Selecting/deselecting an image only toggles a class — reuse the existing
  // DOM instead of falling through to `toDOM()`. Recreating the wrapper
  // would recreate the `<img>` too, and a freshly (re)inserted <img> renders
  // at zero height until the browser has its intrinsic size again, which
  // visibly collapsed the line and yanked the block below it upward for a
  // frame right as the cursor landed at the image's start position.
  //
  // This must only fire when *just* the selection changed. src/alt changing
  // is real content — most importantly the upload placeholder's `pasting:`
  // src being swapped for the real uploaded URL once the host round-trip
  // resolves — and has to fall through to a full `toDOM()` rebuild so the
  // new image actually gets requested and painted. Blindly returning true
  // here previously made CodeMirror believe the DOM was already up to date
  // and skip that rebuild entirely, so a finished upload just sat there
  // still showing the "Uploading image…" placeholder forever.
  updateDOM(dom: HTMLElement, _view: EditorView, from: MarkdownImageWidget): boolean {
    if (from.src !== this.src || from.alt !== this.alt) return false;
    dom.classList.toggle('cm-md-image-selected', this.selected);
    this.captionEl = dom.querySelector('.cm-md-image-caption');
    return true;
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

// The selected image is tracked independently from the regular text cursor,
// so a rendered widget can retain its visible selection across DOM rebuilds.
const setSelectedImage = StateEffect.define<{ from: number; to: number } | null>();
const selectedImageField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(selected, transaction) {
    for (const effect of transaction.effects) if (effect.is(setSelectedImage)) return effect.value;
    if (!selected) return null;
    const mapped = { from: transaction.changes.mapPos(selected.from), to: transaction.changes.mapPos(selected.to, 1) };
    // Selection is derived off the plain text cursor rather than a
    // stand-alone "is selected" flag that only clears on explicit action —
    // the moment the cursor moves off the image's own range (click
    // elsewhere, arrow keys, etc.), it is no longer selected. Mirrors how
    // the table widget's cell selection tracks the cursor instead of
    // requiring a separate deselect step.
    if (transaction.selection) {
      const head = transaction.selection.main.head;
      if (head < mapped.from || head > mapped.to) return null;
    }
    return mapped;
  },
});

// Block widgets must be delivered through a StateField's direct
// EditorView.decorations provider. ViewPlugin decorations are computed after
// viewport layout and may not change vertical layout. Keeping image wrappers
// in this field makes documents containing images safe to open.
function imageWrapperDecorations(state: EditorState): DecorationSet {
  const decorations: any[] = [];
  const selected = state.field(selectedImageField);
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
        widget: new MarkdownImageWidget(src, alt, selected?.from === ref.from && selected.to === ref.to),
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
    // Only document changes and explicit image-selection effects recreate
    // widgets; ordinary cursor moves keep caption editing stable.
    return transaction.docChanged || transaction.effects.some((effect) => effect.is(setSelectedImage))
      ? imageWrapperDecorations(transaction.state)
      : decorations.map(transaction.changes);
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

function imageRangeAtDOM(view: EditorView, image: HTMLImageElement): { from: number; to: number } | null {
  const wrap = image.closest<HTMLElement>('.cm-md-image-block');
  if (!wrap) return null;
  let pos: number;
  try { pos = view.posAtDOM(wrap); } catch { return null; }
  const line = view.state.doc.lineAt(Math.min(pos, view.state.doc.length));
  let range: { from: number; to: number } | null = null;
  syntaxTree(view.state).iterate({
    from: line.from,
    to: line.to,
    enter: (ref) => {
      if (ref.name === 'Image' && ref.from <= pos && pos <= ref.to) {
        range = { from: ref.from, to: ref.to };
        return false;
      }
      return undefined;
    },
  });
  return range;
}

function handleMarkdownImageClick(view: EditorView, event: MouseEvent, onOpenImage?: (src: string) => void): boolean {
  const image = markdownImageFromEvent(event);
  const src = image?.dataset.mdImageSrc;
  if (!image || !src) return false;
  event.preventDefault();
  event.stopPropagation();
  const range = imageRangeAtDOM(view, image);
  const selected = view.state.field(selectedImageField);
  if (range && selected?.from === range.from && selected.to === range.to) {
    onOpenImage?.(src);
    return true;
  }
  if (range) view.dispatch({ effects: setSelectedImage.of(range), selection: { anchor: range.from } });
  return true;
}

function deleteSelectedImage(view: EditorView): boolean {
  const selected = view.state.field(selectedImageField);
  if (!selected) return false;
  view.dispatch({
    changes: { from: selected.from, to: selected.to },
    selection: { anchor: selected.from },
    effects: setSelectedImage.of(null),
  });
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

// A rewrite runs in a Space-bound Agent Session, outside the editor process.
// Mark its exact source lines in a dedicated gutter column to the right of the
// line numbers (side: 'after'), so the writing surface itself never shifts.
// The markers come from a StateField — when the field's RangeSet changes, the
// gutter re-compares it and repaints that column automatically.
// Only the first touched line gets the working spinner; a multi-line hunk
// draws a connecting rail below it (a plain vertical bar for interior lines,
// finishing with a corner turn on the last line) so the whole group reads as
// one in-flight edit instead of a column of separate spinners.
//
// The rail is drawn with absolutely positioned boxes rather than the box
// glyphs `│`/`╰`: a glyph only fills its own font line-box, so consecutive
// rows rendered that way show a gap wherever the row is taller than the
// glyph. Each rail box instead spans its gutter element edge to edge
// (`top:0` → `bottom:0`), and gutter rows stack without gaps, so the strokes
// meet exactly and read as one unbroken line.
function aiWorkingMarkRoot(): HTMLElement {
  const root = document.createElement('span');
  root.className = 'cm-ai-working-mark';
  return root;
}
function aiWorkingRail(extra?: string): HTMLElement {
  const rail = document.createElement('span');
  rail.className = extra ? `cm-ai-working-rail ${extra}` : 'cm-ai-working-rail';
  return rail;
}
// `hasMore` distinguishes a single-line hunk (spinner only) from the head of
// a multi-line one (spinner plus a rail continuing to the row below).
class AiWorkingStartMarker extends GutterMarker {
  constructor(private readonly hasMore: boolean) { super(); }
  elementClass = 'cm-ai-working cm-ai-working-start';
  toDOM(): HTMLElement {
    const root = aiWorkingMarkRoot();
    const spinner = document.createElement('span');
    spinner.className = 'cm-ai-working-spinner';
    spinner.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10"/></svg>';
    root.appendChild(spinner);
    if (this.hasMore) root.appendChild(aiWorkingRail('cm-ai-working-rail-below'));
    return root;
  }
}
class AiWorkingLineMarker extends GutterMarker {
  elementClass = 'cm-ai-working cm-ai-working-line';
  toDOM(): HTMLElement {
    const root = aiWorkingMarkRoot();
    root.appendChild(aiWorkingRail());
    return root;
  }
}
class AiWorkingEndMarker extends GutterMarker {
  elementClass = 'cm-ai-working cm-ai-working-end';
  toDOM(): HTMLElement {
    const root = aiWorkingMarkRoot();
    const corner = document.createElement('span');
    corner.className = 'cm-ai-working-corner';
    root.appendChild(corner);
    return root;
  }
}
const aiWorkingStartMarker = new AiWorkingStartMarker(false);
const aiWorkingStartRailMarker = new AiWorkingStartMarker(true);
const aiWorkingLineMarker = new AiWorkingLineMarker();
const aiWorkingEndMarker = new AiWorkingEndMarker();
const setAiWorkingLines = StateEffect.define<{ fromLine: number; toLine: number } | null>();

function computeAiWorkingMarks(doc: Text, range: { fromLine: number; toLine: number } | null): RangeSet<GutterMarker> {
  if (!range) return RangeSet.empty;
  const builder = new RangeSetBuilder<GutterMarker>();
  const from = Math.max(1, Math.min(range.fromLine, doc.lines));
  const to = Math.max(from, Math.min(range.toLine, doc.lines));
  for (let lineNo = from; lineNo <= to; lineNo++) {
    const marker = lineNo === from
      ? (to > from ? aiWorkingStartRailMarker : aiWorkingStartMarker)
      : lineNo === to ? aiWorkingEndMarker : aiWorkingLineMarker;
    builder.add(doc.line(lineNo).from, doc.line(lineNo).from, marker);
  }
  return builder.finish();
}

const aiWorkingGutterField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update: (marks, transaction) => {
    let next = marks.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setAiWorkingLines)) next = computeAiWorkingMarks(transaction.state.doc, effect.value);
    }
    return next;
  },
});

// A completed AI write or rewrite leaves a quiet green dot in this gutter.
// It is intentionally a separate field from the in-flight markers so a
// cursor move can dismiss individual dots without disturbing a new rewrite's
// spinner/rail state.
class AiAddedLineMarker extends GutterMarker {
  elementClass = 'cm-ai-added-line';
  toDOM(): HTMLElement {
    const dot = document.createElement('span');
    dot.className = 'cm-ai-added-dot';
    return dot;
  }
}
const aiAddedLineMarker = new AiAddedLineMarker();
const setAiChangedLines = StateEffect.define<number[]>();
const aiAddedGutterField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update: (marks, transaction) => {
    let next = marks.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setAiChangedLines)) continue;
      const builder = new RangeSetBuilder<GutterMarker>();
      for (const lineNo of effect.value) {
        if (lineNo >= 1 && lineNo <= transaction.state.doc.lines) {
          builder.add(transaction.state.doc.line(lineNo).from, transaction.state.doc.line(lineNo).from, aiAddedLineMarker);
        }
      }
      next = builder.finish();
    }
    // Reaching a marked row acknowledges it. A transaction selection covers
    // keyboard, mouse, and programmatic cursor moves; editing elsewhere leaves dots in
    // place and their mapped document positions continue to track changes.
    if (transaction.selection) {
      const lineStart = transaction.state.doc.lineAt(transaction.selection.main.head).from;
      next = next.update({ filter: (from) => from !== lineStart });
    }
    return next;
  },
});

const aiWorkingGutter = gutter({
  class: 'cm-ai-gutter',
  markers: (view) => RangeSet.join([
    view.state.field(aiWorkingGutterField),
    view.state.field(aiAddedGutterField),
  ]),
  initialSpacer: () => aiWorkingStartMarker,
});

// ---- "Press space for AI" hint on an empty line ---------------------------
//
// A line decoration rather than a widget: the hint text is delivered through
// the `--cm-ai-hint` custom property and painted by a `::after` pseudo
// element, so nothing is ever inserted into the editable DOM where it could
// be selected, copied, or confuse CodeMirror's input handling. Setting that
// property to an empty string (the AppPanel shell) makes the rule paint
// nothing, which is also how the feature is switched off.
const aiHintLine = Decoration.line({ class: 'cm-ai-hint-line' });
const aiHintCodeLine = Decoration.line({ class: 'cm-ai-hint-line cm-ai-hint-code-line' });

/** True when the caret sits, without a selection, on a blank line. */
function aiHintTargetLine(state: EditorState): number | null {
  const range = state.selection.main;
  if (!range.empty) return null;
  const line = state.doc.lineAt(range.head);
  return line.text.trim() ? null : line.number;
}

const aiHintPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = this.build(view); }
  update(update: ViewUpdate): void {
    // `focusChanged` matters too: the hint is an affordance for the caret,
    // so it should not linger on a blurred editor.
    if (update.docChanged || update.selectionSet || update.focusChanged || update.viewportChanged) {
      this.decorations = this.build(update.view);
    }
  }
  build(view: EditorView): DecorationSet {
    if (!view.hasFocus) return Decoration.none;
    const lineNo = aiHintTargetLine(view.state);
    if (lineNo == null) return Decoration.none;
    const line = view.state.doc.line(lineNo);
    const hint = isInsideFencedCodeBlock(view.state.doc, lineNo) ? aiHintCodeLine : aiHintLine;
    return Decoration.set([hint.range(line.from)]);
  }
}, { decorations: (plugin) => plugin.decorations });

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

  // A table replaces multiple source lines with one block widget. Its syntax
  // range is therefore not a reliable neighbour of the cursor's *visual*
  // line: normal ArrowUp/Down can skip the widget entirely. Ask CodeMirror
  // where that native move would land, then see whether a table widget lies
  // between the current and skipped-to cursor rectangles.
  const currentCoords = view.coordsAtPos(selection.head);
  const nativeTarget = view.moveVertically(selection, direction > 0);
  const targetCoords = view.coordsAtPos(nativeTarget.head);
  if (!currentCoords || !targetCoords || nativeTarget.head === selection.head) return false;

  const candidates = Array.from(view.dom.querySelectorAll<HTMLElement>('.tbl-table-widget'))
    .map((widget) => ({ widget, rect: widget.getBoundingClientRect() }))
    .filter(({ rect }) => direction > 0
      ? rect.top >= currentCoords.bottom - 1 && rect.top <= targetCoords.top + 1
      : rect.bottom <= currentCoords.top + 1 && rect.bottom >= targetCoords.bottom - 1)
    .sort((a, b) => direction > 0 ? a.rect.top - b.rect.top : b.rect.bottom - a.rect.bottom);
  const widget = candidates[0]?.widget;
  if (!widget) return false;

  // A frame lets the block widget be measured before we reach into its DOM.
  window.requestAnimationFrame(() => {
    const cells = widget.querySelectorAll<HTMLElement>('.tbl-cell');
    if (!cells.length) return;
    const cell = cells[direction > 0 ? 0 : cells.length - 1];
    placeCaretInTableCell(cell, direction < 0);
  });
  return true;
}

/**
 * Move the caret into a table cell the way a real click does.
 *
 * codemirror-markdown-tables derives its cell selection from the *document*
 * selection (a `selectionchange` listener resolves the range's container back
 * to a cell). Synthetic pointer events only outline the cell, because they
 * carry no default action that would move the DOM selection — and the outline
 * drag they start never ends without a matching pointerup. Placing the range
 * ourselves is the entry path the package actually listens for: it promotes
 * the cell to a caret selection, which is what mounts its nested editor.
 */
function placeCaretInTableCell(cell: HTMLElement, atEnd: boolean): void {
  const doc = cell.ownerDocument;
  const walker = doc.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  // Note: `Text` here would resolve to CodeMirror's document type, so keep
  // these as plain DOM nodes and read their length from `textContent`.
  const textNodes: Node[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  const target = atEnd ? textNodes[textNodes.length - 1] : textNodes[0];
  const range = doc.createRange();
  if (target) range.setStart(target, atEnd ? (target.textContent?.length ?? 0) : 0);
  else range.selectNodeContents(cell);
  range.collapse(true);

  const domSelection = doc.getSelection();
  domSelection?.removeAllRanges();
  domSelection?.addRange(range);

  // The nested CodeMirror mounts asynchronously once that selection lands, so
  // wait for its contenteditable node before handing over keyboard focus.
  const focusCellEditor = (remainingFrames: number) => {
    const content = cell.querySelector<HTMLElement>('.tbl-cell-editor .cm-content');
    if (content) {
      content.focus({ preventScroll: true });
      return;
    }
    if (remainingFrames > 0) window.requestAnimationFrame(() => focusCellEditor(remainingFrames - 1));
  };
  window.requestAnimationFrame(() => focusCellEditor(8));
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

// Localization for CodeMirror's built-in search panel (Cmd/Ctrl-F,
// Cmd-Option-F). The `@codemirror/search` extension hardcodes English labels
// for its buttons/checkboxes, but renders them through `state.phrase(...)`,
// which looks translations up in the `EditorState.phrases` facet. Injecting
// this map via `EditorState.phrases.of(...)` localizes Find/Replace, the
// next/previous/all buttons, the case/regexp/word checkboxes, the × close,
// and the "Go to line" dialog without touching the library.
const searchPhrases = {
  'Find': '查找',
  'Replace': '替换',
  'next': '下一个',
  'previous': '上一个',
  'all': '全部',
  'replace': '替换',
  'replace all': '全部替换',
  'match case': '区分大小写',
  'regexp': '正则',
  'by word': '全词匹配',
  'close': '关闭',
  'Go to line': '跳转到行',
  'go': '跳转',
  'current match': '当前匹配',
  'replaced $ matches': '已替换 $ 处匹配',
  'replaced match on line $': '已在第 $ 行替换匹配',
  'on line': '位于第',
};

// Slash blocks are deliberately a small Markdown-only menu, not a generic
// command palette: it only appears after `/` on an otherwise blank line.
// `detail` renders as the quiet right-hand delimiter in CodeMirror's native
// completion list, while `apply` replaces the typed `/…` query on Enter.
const markdownSlashBlocks: Completion[] = [
  { label: '标题 1', detail: '#', apply: '# ', type: 'md-heading' },
  { label: '标题 2', detail: '##', apply: '## ', type: 'md-heading' },
  { label: '标题 3', detail: '###', apply: '### ', type: 'md-heading' },
  { label: '符号列表', detail: '-', apply: '- ', type: 'md-list' },
  { label: '有序列表', detail: '1.', apply: '1. ', type: 'md-list-ordered' },
  { label: '引用', detail: '>', apply: '> ', type: 'md-quote' },
  { label: '分隔线', detail: '---', apply: '---', type: 'md-minus' },
  { label: '代码', detail: '```', apply: '```', type: 'md-code' },
  // A real 2×2 Markdown table (two columns, header + one empty body row),
  // not a lone pipe that leaves writers to construct the table themselves.
  { label: '表格', detail: '|', apply: '|   |   |\n| --- | --- |\n|   |   |', type: 'md-table' },
];

const markdownCompletionIconPaths: Record<string, string[]> = {
  // Lucide: heading, list, list-ordered, quote, minus, code-xml, table.
  'md-heading': ['M6 12h12', 'M6 20V4', 'M18 20V4'],
  'md-list': ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
  'md-list-ordered': ['M10 6h11', 'M10 12h11', 'M10 18h11', 'M4 6h1v4', 'M4 10h2', 'M4 14h2a1 1 0 0 1 0 2l-2 2h2'],
  'md-quote': ['M3 21c3 0 7-1 7-8V5H3v8h4c0 1.5-1.2 3-4 3.5V21z', 'M14 21c3 0 7-1 7-8V5h-7v8h4c0 1.5-1.2 3-4 3.5V21z'],
  'md-minus': ['M5 12h14'],
  'md-code': ['m16 18 6-6-6-6', 'm8 6-6 6 6 6'],
  'md-table': ['M3 3h18v18H3z', 'M3 9h18', 'M3 15h18', 'M9 3v18', 'M15 3v18'],
};

function renderMarkdownCompletionIcon(completion: Completion): Node | null {
  const paths = completion.type ? markdownCompletionIconPaths[completion.type] : undefined;
  if (!paths) return null;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('cm-completionIcon', 'cm-md-completion-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  paths.forEach((d) => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  });
  return svg;
}

function markdownSlashAutocompleter(context: CompletionContext) {
  const line = context.state.doc.lineAt(context.pos);
  // A slash in a fenced code body is literal source text, not a Markdown
  // block command. Returning null leaves it to normal code editing.
  if (isInsideFencedCodeBlock(context.state.doc, line.number)) return null;
  const before = context.state.sliceDoc(line.from, context.pos);
  // Whitespace before `/` is kept intact, so slash blocks also work for an
  // indented list item. Any non-whitespace before the slash means it is
  // prose/a path instead and must never open this block menu.
  const match = /^(\s*)\/(\S*)$/.exec(before);
  if (!match) return null;
  const query = match[2].toLowerCase();
  const options = markdownSlashBlocks.filter((option) => {
    const label = option.label.toLowerCase();
    const delimiter = (option.detail || '').toLowerCase();
    return !query || label.includes(query) || delimiter.startsWith(query);
  });
  if (!options.length) return null;
  return {
    // Include the slash in the replacement range, preserving only indent.
    from: line.from + match[1].length,
    options,
    // We filter on delimiters as well as labels above; bypass CodeMirror's
    // label-only filter so typing `/##`, `/---`, or `/|` stays intuitive.
    filter: false,
  };
}

// Toggle paired Markdown delimiters around a real selection. Repeating the
// same shortcut unwraps an immediately surrounding pair, so Cmd/Ctrl+B/I
// behaves as a genuine toggle rather than endlessly nesting punctuation.
function toggleMarkdownDelimiter(view: EditorView, delimiter: string): boolean {
  const selection = view.state.selection.main;
  if (selection.empty) return false;
  const { from, to } = selection;
  const before = view.state.sliceDoc(Math.max(0, from - delimiter.length), from);
  const after = view.state.sliceDoc(to, Math.min(view.state.doc.length, to + delimiter.length));
  if (before === delimiter && after === delimiter) {
    view.dispatch({
      changes: [
        { from: from - delimiter.length, to: from },
        { from: to, to: to + delimiter.length },
      ],
      selection: { anchor: from - delimiter.length, head: to - delimiter.length },
      scrollIntoView: true,
    });
  } else {
    view.dispatch({
      changes: [{ from, insert: delimiter }, { from: to, insert: delimiter }],
      selection: { anchor: from + delimiter.length, head: to + delimiter.length },
      scrollIntoView: true,
    });
  }
  return true;
}

const markdownEditorKeymap = keymap.of([
  { key: 'Backspace', run: deleteSelectedImage },
  { key: 'Mod-b', run: (view) => toggleMarkdownDelimiter(view, '**') },
  { key: 'Mod-i', run: (view) => toggleMarkdownDelimiter(view, '*') },
  { key: '`', run: handleFenceTriggerBacktick },
  { key: 'Enter', run: completeOpeningCodeFence },
  { key: 'ArrowUp', run: (view) => moveIntoAdjacentTable(view, -1) || moveIntoSkippedDelimiterLine(view, -1) },
  { key: 'ArrowDown', run: (view) => moveIntoAdjacentTable(view, 1) || moveIntoSkippedDelimiterLine(view, 1) },
  { key: 'Tab', run: (view) => selectionStartsOnListItem(view) && indentMore(view) },
  { key: 'Shift-Tab', run: (view) => selectionStartsOnListItem(view) && indentLess(view) },
  { key: 'Alt-Mod-t', run: insertEmptyMarkdownTable() },
  indentWithTab,
]);

// ---- External (AI / on-disk) revisions -----------------------------------
//
// An external revision used to arrive as a whole-document replacement, which
// reset both the scroll offset and the caret: the reader lost their place
// every time the assistant touched the file, with nothing to show what had
// actually changed. Instead, diff the old text against the new one, dispatch
// only the differing span, pin the viewport to the position it was already
// showing, and flash the touched lines.

interface ExternalPatch {
  from: number;
  to: number;
  insert: string;
}

interface LineHunk {
  oldFrom: number; // [oldFrom, oldTo) as 0-based line indices in the old text
  oldTo: number;
  newFrom: number; // [newFrom, newTo) as 0-based line indices in the new text
  newTo: number;
}

interface ExternalDiff {
  changes: ExternalPatch[];
  /** 1-based, inclusive line ranges in the NEW document — what to flash. */
  lines: Array<{ from: number; to: number }>;
  /** Non-blank AI-written or AI-rewritten lines — eligible for the one-shot dot. */
  markedLines: number[];
}

// A single first-difference-to-last-difference span is far too coarse here:
// `apply` rewrites the whole file, so one reworded sentence plus any
// incidental difference elsewhere (a touched-up signature line, say) would
// mark every line in between as changed. Diff line-by-line instead so
// untouched lines between two real edits stay untouched.
function diffLineHunks(oldLines: string[], newLines: string[]): LineHunk[] {
  let start = 0;
  const shared = Math.min(oldLines.length, newLines.length);
  while (start < shared && oldLines[start] === newLines[start]) start++;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  if (start === oldEnd && start === newEnd) return [];

  const n = oldEnd - start;
  const m = newEnd - start;
  // Trimming the common head and tail usually leaves a tiny middle, so the
  // quadratic LCS is cheap in practice. Guard the pathological case (an
  // almost-entirely-rewritten large file) by falling back to one hunk.
  if (n * m > 1_500_000) return [{ oldFrom: start, oldTo: oldEnd, newFrom: start, newTo: newEnd }];

  const width = m + 1;
  const lcs = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = oldLines[start + i] === newLines[start + j]
        ? lcs[(i + 1) * width + (j + 1)] + 1
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + (j + 1)]);
    }
  }

  const hunks: LineHunk[] = [];
  let pendingOld = -1;
  let pendingNew = -1;
  let i = 0;
  let j = 0;
  const flush = (oldTo: number, newTo: number) => {
    if (pendingOld < 0) return;
    hunks.push({ oldFrom: pendingOld, oldTo, newFrom: pendingNew, newTo });
    pendingOld = -1;
    pendingNew = -1;
  };
  while (i < n && j < m) {
    if (oldLines[start + i] === newLines[start + j]) {
      flush(start + i, start + j);
      i++;
      j++;
      continue;
    }
    if (pendingOld < 0) {
      pendingOld = start + i;
      pendingNew = start + j;
    }
    if (lcs[(i + 1) * width + j] >= lcs[i * width + (j + 1)]) i++;
    else j++;
  }
  if (i < n || j < m) {
    if (pendingOld < 0) {
      pendingOld = start + i;
      pendingNew = start + j;
    }
    i = n;
    j = m;
  }
  flush(start + i, start + j);
  return hunks;
}

// Turn line hunks into document-offset edits. Each hunk swaps whole lines
// *including* the newline that terminates them, which keeps insertions and
// deletions from leaving a stray or missing line break behind.
function computeExternalDiff(oldText: string, newText: string): ExternalDiff | null {
  if (oldText === newText) return null;
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const hunks = diffLineHunks(oldLines, newLines);
  if (!hunks.length) return null;

  const oldStarts = new Array<number>(oldLines.length);
  for (let index = 0, offset = 0; index < oldLines.length; index++) {
    oldStarts[index] = offset;
    offset += oldLines[index].length + 1;
  }

  const changes: ExternalPatch[] = [];
  const lines: Array<{ from: number; to: number }> = [];
  const markedLines: number[] = [];
  for (const hunk of hunks) {
    const inserted = newLines.slice(hunk.newFrom, hunk.newTo).join('\n');
    const isInsertion = hunk.oldFrom === hunk.oldTo;
    const isDeletion = hunk.newFrom === hunk.newTo;
    const runsToLastLine = hunk.oldTo >= oldLines.length;
    let from: number;
    let to: number;
    let insert: string;
    if (isInsertion) {
      if (hunk.oldFrom >= oldLines.length) {
        // Appending past the final line: bring the separating newline along.
        from = to = oldText.length;
        insert = '\n' + inserted;
      } else {
        from = to = oldStarts[hunk.oldFrom];
        insert = inserted + '\n';
      }
    } else if (runsToLastLine) {
      // The final line has no trailing newline, so a deletion here has to eat
      // the newline *before* the block instead.
      from = isDeletion && hunk.oldFrom > 0 ? oldStarts[hunk.oldFrom] - 1 : oldStarts[hunk.oldFrom];
      to = oldText.length;
      insert = inserted;
    } else {
      from = oldStarts[hunk.oldFrom];
      to = oldStarts[hunk.oldTo];
      insert = isDeletion ? '' : inserted + '\n';
    }
    changes.push({ from, to, insert });
    if (isDeletion) {
      // Nothing new to flash — mark the seam the removed lines left behind.
      const seam = Math.min(Math.max(hunk.newFrom + 1, 1), newLines.length);
      lines.push({ from: seam, to: seam });
    } else {
      lines.push({ from: hunk.newFrom + 1, to: hunk.newTo });
      // Both writing (insertion) and rewriting (replacement) deserve the
      // same one-shot gutter reminder. Empty rows remain quiet so intentional
      // whitespace never looks like an AI-authored content change.
      for (let lineNo = hunk.newFrom; lineNo < hunk.newTo; lineNo++) {
        if (newLines[lineNo].trim()) markedLines.push(lineNo + 1);
      }
    }
  }
  return { changes, lines, markedLines };
}

const EXTERNAL_HIGHLIGHT_MS = 2000;
const externalChangedLine = Decoration.line({ class: 'cm-ai-changed' });
const setExternalHighlight = StateEffect.define<Array<{ from: number; to: number }> | null>();

const externalHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(highlights, transaction) {
    let next = highlights.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setExternalHighlight)) continue;
      if (!effect.value) {
        next = Decoration.none;
        continue;
      }
      const doc = transaction.state.doc;
      const ranges: any[] = [];
      for (const range of effect.value) {
        const from = Math.max(1, Math.min(range.from, doc.lines));
        const to = Math.max(from, Math.min(range.to, doc.lines));
        for (let lineNo = from; lineNo <= to; lineNo++) {
          ranges.push(externalChangedLine.range(doc.line(lineNo).from));
        }
      }
      next = Decoration.set(ranges, true);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function createMarkdownEditor(options: MarkdownEditorOptions): MarkdownEditorHandle {
  let suppressChange = false;
  let externalHighlightTimer = 0;
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

  // Focus mode ("专注"): when on, the cursor's line is kept vertically
  // centered in the window using the browser's native smooth scrolling
  // (scrollIntoView), so the eye never has to chase the caret. Deliberately
  // NOT via CM's scrollIntoView effect — that one snaps instantly and also
  // fights CM's own minimal-scroll behavior. The double rAF waits for CM's
  // post-update measure to settle first, otherwise the two scroll
  // authorities (CM's cursor-preserving scroll and ours) yank the window.
  let focusModeEnabled = false;
  let centerLineRaf = 0;
  // While the mouse is down (drag-selecting text), centering would fight
  // the drag: every selection change re-centers, and the smooth scroll
  // yanks the viewport mid-selection. Defer to the mouseup instead.
  let mouseSelecting = false;
  function centerActiveLine() {
    centerLineRaf = 0;
    if (!focusModeEnabled) return;
    const line = view.dom.querySelector('.cm-activeLine');
    if (line) line.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  function scheduleCenterActiveLine() {
    if (!focusModeEnabled || centerLineRaf || mouseSelecting) return;
    centerLineRaf = requestAnimationFrame(() => requestAnimationFrame(centerActiveLine));
  }
  // Attach on window so a drag that leaves the editor still ends cleanly.
  function onWindowMouseUp() {
    if (!mouseSelecting) return;
    mouseSelecting = false;
    // The selection just settled — center once now.
    scheduleCenterActiveLine();
  }
  window.addEventListener('mouseup', onWindowMouseUp);

  // "Press space to bring in the AI." Only fires while the hint is actually
  // on screen — the host enabled it (AppView) and the caret sits alone on a
  // blank line — and only consumes the key if the host says it took over,
  // so Space always falls through to typing a space otherwise.
  let aiHintText = '';
  const aiHintKeymap = keymap.of([{
    key: 'Space',
    run: (target) => {
      if (!aiHintText || !options.onAiHintTrigger) return false;
      const lineNo = aiHintTargetLine(target.state);
      if (lineNo == null) return false;
      const coords = target.coordsAtPos(target.state.doc.line(lineNo).from);
      if (!coords) return false;
      return options.onAiHintTrigger({
        line: lineNo,
        rect: { top: coords.top, bottom: coords.bottom, left: coords.left, right: coords.right },
      });
    },
  }]);

  const view = new EditorView({
    doc: options.value ?? '',
    parent: options.parent,
    extensions: [
      // Listed before `markdownEditorKeymap` (and therefore before
      // basicSetup's default bindings) so the empty-line Space hand-off
      // gets first refusal on the key; it declines whenever the hint is
      // off or the caret is not on a blank line, and Space types normally.
      aiHintKeymap,
      markdownEditorKeymap,
      basicSetup,
      // Replace CodeMirror's generic text/keyword glyphs with actual Lucide
      // SVGs for slash blocks; non-Markdown completion sources simply render
      // no icon instead of falling back to the default key symbol.
      autocompletion({
        icons: false,
        addToOptions: [{ position: 20, render: renderMarkdownCompletionIcon }],
      }),
      EditorState.phrases.of(searchPhrases),
      codeGutterLineHighlighter,
      aiWorkingGutterField,
      aiAddedGutterField,
      aiWorkingGutter,
      aiHintPlugin,
      markdownSupport,
      // Typing `|` on an empty line pops a table-size picker (2x2/3x3/4x4)
      // via CodeMirror's own autocompletion (basicSetup already includes
      // the autocompletion extension).
      markdownSupport.language.data.of({ autocomplete: markdownTableAutocompleter() }),
      // Slash on an otherwise empty line opens the Markdown block menu;
      // the native completion UI provides keyboard filtering/navigation.
      markdownSupport.language.data.of({ autocomplete: markdownSlashAutocompleter }),
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
      selectedImageField,
      imageWrapperExtension,
      imageAtomicRanges,
      externalHighlightField,
      livePreviewMarkdownPlugin,
      EditorView.domEventHandlers({
        // This runs before CodeMirror's default cursor-motion keymap. A table
        // is a block widget rather than a text line, so default ArrowUp/Down
        // skips straight over it before a normal key binding can transfer
        // focus into its first/last cell.
        keydown: (event, dispatchView) => {
          if (event.key === 'ArrowUp') return moveIntoAdjacentTable(dispatchView, -1);
          if (event.key === 'ArrowDown') return moveIntoAdjacentTable(dispatchView, 1);
          return false;
        },
        mousedown: (event) => {
          mouseSelecting = true;
          return handleMarkdownImageMouseDown(event) || handleMarkdownLinkMouseDown(event);
        },
        click: (event, dispatchView) => handleMarkdownImageClick(dispatchView, event, options.onOpenImage) || handleMarkdownLinkClick(event, options.onOpenLink),
        paste: (event, dispatchView) => imagePasteHandler(dispatchView, event, options.onPasteImage),
        drop: (event, dispatchView) => imageDropHandler(dispatchView, event, options.onPasteImage),
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !suppressChange) options.onChange(update.state.doc.toString());
        // Focus mode: keep the caret's line centered as the user types or
        // moves the cursor (native smooth scrollIntoView, see above).
        if ((update.selectionSet || update.docChanged) && focusModeEnabled) scheduleCenterActiveLine();
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
      // This is "load a different document" / "clear the editor", not a
      // user edit — it must never become an undo step. Without
      // addToHistory:false, opening a file makes the very first Cmd/Ctrl+Z
      // wipe the whole document back to whatever empty/placeholder doc the
      // view started with, which reads as data loss rather than undo.
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        annotations: Transaction.addToHistory.of(false),
      });
      suppressChange = false;
    },
    applyExternalValue(value) {
      const diff = computeExternalDiff(view.state.doc.toString(), value);
      if (!diff) return null;
      const changes = view.state.changes(diff.changes);
      // Anchor on whatever position sits at the viewport's top edge. Keeping
      // *that* pinned (rather than a raw scrollTop) is what makes an edit
      // above the fold — which shifts every following line — invisible to a
      // reader looking further down the document.
      const box = view.scrollDOM.getBoundingClientRect();
      const anchorPos = view.posAtCoords({ x: box.left + 1, y: box.top + 1 }, false);
      const anchorBefore = view.coordsAtPos(anchorPos);
      const anchorOffset = anchorBefore ? anchorBefore.top - box.top : 0;
      const mappedAnchor = changes.mapPos(anchorPos, 1);
      if (externalHighlightTimer) clearTimeout(externalHighlightTimer);
      // `suppressChange` keeps this from echoing back to the host as if the
      // user had typed it; `scrollIntoView: false` keeps CodeMirror from
      // chasing the caret to the edited span.
      suppressChange = true;
      view.dispatch({
        changes,
        effects: [
          setExternalHighlight.of(diff.lines),
          setAiChangedLines.of(diff.markedLines),
          // A file write is the visible completion point. The Agent turn may
          // still be composing its final text, but its spinner must not
          // overlap the successful-change dots already shown in this gutter.
          setAiWorkingLines.of(null),
        ],
        scrollIntoView: false,
      });
      suppressChange = false;
      const anchorDrift = (): number => {
        const after = view.coordsAtPos(Math.min(mappedAnchor, view.state.doc.length));
        if (!after) return 0;
        return after.top - view.scrollDOM.getBoundingClientRect().top - anchorOffset;
      };
      const correct = (drift: number) => {
        if (Math.abs(drift) > 0.5) view.scrollDOM.scrollTop += drift;
      };
      correct(anchorDrift());
      // Freshly inserted lines are estimated until CodeMirror measures them,
      // so re-anchor once real heights are known.
      view.requestMeasure({ read: anchorDrift, write: correct });
      externalHighlightTimer = window.setTimeout(() => {
        externalHighlightTimer = 0;
        view.dispatch({ effects: setExternalHighlight.of(null) });
      }, EXTERNAL_HIGHLIGHT_MS);
      let changedLines = 0;
      for (const range of diff.lines) changedLines += range.to - range.from + 1;
      return {
        hunks: diff.lines.length,
        changedLines,
        fromLine: diff.lines[0].from,
        toLine: diff.lines[diff.lines.length - 1].to,
      };
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
      // The head anchor above pins the popup's fallback position (below the
      // selection); `startRect` is its preferred one — above the selection's
      // first line — so the popup never covers the text being rewritten.
      const head = view.coordsAtPos(start) ?? view.coordsAtPos(start, -1) ?? anchor;
      return {
        start,
        end,
        text,
        rect: { top: anchor.top, bottom: anchor.bottom, left: anchor.left, right: anchor.right },
        startRect: { top: head.top, bottom: head.bottom, left: head.left, right: head.right },
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
    setComfortWriting(on) {
      // CSS tokens on the root's inline style — CM's own class management
      // rebuilds view.dom.className on updates, which would silently drop a
      // hand-added class, so switching via tokens is the durable approach.
      const writing = !!on;
      view.dom.style.setProperty('--md-line-pad-y', writing ? '4px' : '2px');
      view.dom.style.setProperty('--md-line-height', writing ? '2em' : '1.7rem');
      // Line-number gutter rows track the same rhythm (prose lines only;
      // fenced-code gutter rows keep their own fixed 22px height).
      view.dom.style.setProperty('--md-gutter-line-height', writing ? '40px' : '32px');
      view.requestMeasure();
    },
    setFocusMode(on) {
      // Same token approach as setComfortWriting: non-active lines fade to
      // 70% (see the `.cm-line:not(.cm-activeLine)` theme rule). `1` keeps
      // the rule inert when focus mode is off.
      focusModeEnabled = !!on;
      view.dom.style.setProperty('--md-focus-opacity', on ? '0.5' : '1');
      if (on) scheduleCenterActiveLine();
      view.requestMeasure();
    },
    setAiWorkingLines(fromLine, toLine) {
      const active = fromLine > 0 && toLine >= fromLine;
      view.dispatch({ effects: setAiWorkingLines.of(active ? { fromLine, toLine } : null) });
    },
    setAiHint(text, codeText) {
      aiHintText = text || '';
      // `content` needs a CSS string literal, so quote/escape both phrases
      // rather than interpolating them raw. Code rows use the shorter
      // codeText because slash blocks are disabled inside fenced code.
      view.dom.style.setProperty('--cm-ai-hint', aiHintText ? JSON.stringify(aiHintText) : '""');
      view.dom.style.setProperty('--cm-ai-hint-code', codeText ? JSON.stringify(codeText) : '""');
    },
    scrollDOM: view.scrollDOM,
    destroy() {
      if (centerLineRaf) { cancelAnimationFrame(centerLineRaf); centerLineRaf = 0; }
      if (externalHighlightTimer) { clearTimeout(externalHighlightTimer); externalHighlightTimer = 0; }
      window.removeEventListener('mouseup', onWindowMouseUp);
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

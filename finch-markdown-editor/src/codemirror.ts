import { basicSetup, EditorView } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, type DecorationSet, ViewPlugin, type ViewUpdate } from '@codemirror/view';

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
  '.ͼs':{background:'none !important', fontSize:'14px', fontFamily:'var(--finch-font-mono, ui-monospace, SFMono-Regular, Menlo, Cascadia Mono, Consolas, monospace) !important'},
  '.cm-foldGutter':{display:'none !important'},
  '&.cm-focused': { outline: 'none' },
  // Dim unselected/inactive editor text so attention stays on the currently
  // focused pane; syntax decorations keep their own explicit colors.
  // '&:not(.cm-focused) .cm-scroller': { color: 'var(--muted)' },
  '.cm-scroller': {
    fontFamily: 'var(--md-editor-font-family, var(--finch-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace))',
    // lineHeight: '2rem',
    overflow: 'auto',
    // color: 'var(--muted)',
    // Body text = the root size itself (14px), i.e. this is the reference
    // "14px" the human eye actually reads while typing.
    fontSize: '0.9em',
  },
  '.cm-content': {
    padding: '20px 0',
    caretColor: 'var(--text)',
    minHeight: '100%',
  },
  // Keep `.cm-line` FULL-WIDTH: CodeMirror paints active-line, selection,
  // search and syntax backgrounds on this element, so constraining it with
  // max-width visibly chops those backgrounds into a narrow centre strip.
  // Instead, only grow its left/right padding. `max(24px, …)` preserves the
  // 24px minimum on narrow panes; past 798px, the excess becomes symmetric
  // padding, leaving an editable/content column no wider than 750px while
  // every CodeMirror highlight still spans the full available line width.
  '.cm-line': {
    paddingTop: '2px',
    paddingBottom: '2px',
    paddingLeft: 'max(48px, calc((100% - 750px) / 2))',
    paddingRight: 'max(48px, calc((100% - 750px) / 2))',
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
  '.cm-line.cm-md-h1': { fontSize: '1.7em', fontWeight: '700', lineHeight: '1.4' },  // ~23.8px
  '.cm-line.cm-md-h2': { fontSize: '1.5em', fontWeight: '700', lineHeight: '1.4' },  // ~21px
  '.cm-line.cm-md-h3': { fontSize: '1.3em', fontWeight: '700', lineHeight: '1.4' },  // ~18.2px
  '.cm-line.cm-md-h4': { fontSize: '1.15em', fontWeight: '700', lineHeight: '1.4' }, // ~16.1px
  '.cm-line.cm-md-h5': { fontSize: '1.05em', fontWeight: '700', lineHeight: '1.4' }, // ~14.7px
  '.cm-line.cm-md-h6': { fontSize: '1em', fontWeight: '700', lineHeight: '1.4' },    // 14px, bold+colored only
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
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '.cm-gutters': {
    color: 'var(--muted)',
    backgroundColor: 'var(--card)',
    borderRight: '1px solid var(--border)',
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
        color: 'var(--muted)',
  },
  '.cm-activeLine': {
    backgroundColor: 'color-mix(in srgb, var(--text) 7%, transparent)',
  },
  '.cm-activeLineGutter': {
    color: 'var(--text)',
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

const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--accent)', fontWeight: '700' },
  { tag: tags.strong, color: 'var(--text)', fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.monospace, color: 'var(--muted)', backgroundColor: 'color-mix(in srgb, var(--text) 8%, transparent)' },
  { tag: tags.link, color: 'var(--accent)' },
  { tag: tags.url, color: 'var(--muted)', textDecoration: 'underline' },
  { tag: tags.quote, color: 'var(--muted)' },
  { tag: tags.meta, color: 'var(--muted)' },
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

function createMarkdownEditor(options: MarkdownEditorOptions): MarkdownEditorHandle {
  let suppressChange = false;
  const view = new EditorView({
    doc: options.value ?? '',
    parent: options.parent,
    extensions: [
      basicSetup,
      markdown(),
      EditorView.lineWrapping,
      finchTheme,
      syntaxHighlighting(markdownHighlight),
      blockSpacingPlugin,
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

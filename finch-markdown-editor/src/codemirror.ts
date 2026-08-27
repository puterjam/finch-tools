import { basicSetup, EditorView } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

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
  scrollDOM: HTMLElement;
  destroy(): void;
}

interface MarkdownEditorOptions {
  parent: HTMLElement;
  value?: string;
  onChange(value: string): void;
}

const finchTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--text)',
    backgroundColor: 'var(--card)',
    fontSize: '13.5px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--finch-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
    lineHeight: '1.625',
    overflow: 'auto',
  },
  '.cm-content': {
    padding: '20px 0',
    caretColor: 'var(--text)',
    minHeight: '100%',
  },
  '.cm-line': { padding: '0 24px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '.cm-gutters': {
    color: 'var(--muted)',
    backgroundColor: 'var(--card)',
    borderRight: '1px solid var(--border)',
  },
  '.cm-gutterElement': { padding: '0 8px 0 10px' },
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

import type * as finch from 'finch';
import { Archive, Check, Circle, CircleAlert, CircleCheck, createElement, EllipsisVertical, Eye, Files, FolderInput, FolderOpen, FolderPlus, FolderSync, HardDrive, Loader, PenLine, Plus, RefreshCw, Search, Tag as TagIcon, Trash2, X } from 'lucide';
import type { IconNode } from 'lucide';
import { highlightTerms, snippetParts } from './snippet.js';
import { openListedDocument, previewRoute } from './preview.js';
import { inScope } from './scope.js';

type Bridge = finch.WebviewBridgeApi;
declare global { interface Window { finch: Bridge } }
interface Document { id: string; name: string; path: string; tags: string[]; chunks: number; added_at: number; indexed_at: number }
interface Tag { id: string; name: string; count: number }
interface Match { document_id: string; name: string; path: string; tag_id: string; chunk: number; text: string; matched?: string[] }
interface LibraryInfo { root: string; isDefault: boolean; documents: number; tags: number; unavailable: string | null }
interface EnvironmentStep { id: string; status: 'pending' | 'running' | 'ready' | 'failed'; optional?: boolean; message?: string; percent?: number; detail?: string; error?: string }
interface EnvironmentState { running: boolean; ready: boolean; usable: boolean; steps: EnvironmentStep[]; startedAt?: number; finishedAt?: number }
interface Reply { type: string; requestId?: string; tags?: Tag[]; tag?: Tag; documents?: Document[]; total?: number; offset?: number; focusId?: string; matches?: Match[]; error?: string; message?: string; unchanged?: number; backupDirectory?: string; path?: string; count?: number; missing?: number; verified?: { before: { documents: number; tags: number }; after: { documents: number; tags: number }; missing: number }; library?: LibraryInfo; mode?: string; previousRoot?: string; environment?: EnvironmentState; sessionId?: string; names?: string[]; change?: { kind?: string; documentId?: string; tags?: string[] }; sync?: { updated: string[]; removed: string[]; unchanged: number; unreachable: string[]; failed: Array<{ name: string; reason: string }> } }
type Copy = Record<string, string>;
const english: Copy = {
  heading: 'Your knowledge, within reach.', intro: 'Index on this device. AI answers may send retrieved passages to your selected model.',
  browse: 'Browse passages', add: 'Add files',
  noTags: 'No categories yet — create one in the left column first.', dropHint: 'Or drop files on this page · Added to {tag}.',
  tagsTitle: 'TAGS', tagRequired: 'Enter a tag name.', newTag: 'New tag', renameTag: 'Rename tag', deleteTag: 'Delete tag',
  all: 'All sources', unclassified: 'Unclassified', librarySubtitle: 'Browse and organize your local material.', totalFiles: '{count} files', sortLabel: 'Sort by', sortUpdated: 'Last indexed', sortAdded: 'Date added', sortName: 'File name',
  searchLabel: 'Search your own sources', searchPlaceholderIn: 'Search in {tag}…',
  empty: 'No files in this view. Add some on the left.', emptyMatches: 'No matching passages.', searchHint: 'Type a word or phrase to inspect indexed passages.', loading: 'Loading…', loaded: 'Showing {shown} of {total}',
  remove: 'Remove', removeTitle: 'Remove this source?', removeMessage: 'This deletes its index and managed copy, not the original file.', reveal: 'Show in file manager', preview: 'Preview', locate: 'Locate in file list', move: 'Move to tag',
  menuReveal: 'Open in file manager', menuClassify: 'Set category',
  tagDeleteTitle: 'Delete this tag?', tagDeleteMessage: 'Documents carrying this tag lose it and keep their other tags; one that had no other tag moves to Unclassified.', tagPlaceholder: 'New tag · Enter', tagHint: 'Enter to create · Esc to cancel', chunk: 'passages', added: 'Added {date}', updated: 'Indexed {date}',
  complete: 'Indexed {count} file(s).', completeUnchanged: 'Indexed {count} file(s); {unchanged} unchanged.', failed: 'Failed: {details}', unavailable: 'Finch bridge is unavailable.',
  unsupported: 'Unsupported file type', tooLarge: 'File must be between 1 byte and {max} MB', reading: 'Reading {name}…', uploading: 'Importing {name} ({percent}%)…', externalSource: 'Outside the library: {path}',
  backupLabel: 'Back up to a folder', syncLabel: 'Refresh changed sources', syncWorking: 'Refreshing changed sources…', syncDone: 'Refreshed: {updated} updated, {removed} removed, {unchanged} unchanged.', syncIdle: 'Nothing to refresh: every source file is unchanged.',
  syncUnreachable: '{count} source file(s) cannot be reached right now; their indexes were kept.', syncFailed: '{count} source file(s) could not be refreshed.',
  engineNeeded: 'Importing this needs {name}. Its installation just started in the background — drop it again once it is ready.',
  syncNoSources: 'Nothing to refresh: only files the Agent imported from a workspace remember their source file. Update App-View files by importing the changed file again.',
  syncHint: 'Re-checks the source files the Agent imported: changed ones are re-indexed in place, deleted ones are dropped, and unreachable ones are kept. Files added in this App View have no recorded source.',
  libraryLocation: 'Choose location…', libraryEnvironment: 'Update runtime',
  onboardTitle: 'Preparing the knowledge engine',
  onboardLibraryTitle: 'Library location',
  onboardLibraryDefault: 'Default location',
  onboardLibraryChosen: 'Custom location',
  onboardLibraryUnavailable: 'Unavailable',
  onboardLibraryAction: 'Choose location…',
  onboardLibraryHint: 'Pick a folder: a library inside it is opened, an empty folder gets a new one.',
  onboardIntro: 'The first run installs three local engines. This is a one-time download, and nothing leaves this device.',
  onboardLancedb: 'Vector search (LanceDB)', onboardAnydoc: 'Office & PDF reading (AnyDoc)', onboardOcr: 'Image text recognition (OCR)',
  onboardPending: 'waiting', onboardRunning: 'installing', onboardReady: 'ready', onboardFailed: 'failed',
  onboardWorking: 'Working…',
  onboardRetry: 'Retry setup', onboardHelp: 'Ask the assistant to fix it',
  engineOcr: 'image text recognition (OCR)', engineAnydoc: 'document parsing (AnyDoc)',
  onboardOptionalFailed: 'Background setup failed for {name}. Retry it from the library menu.',
  bgProgress: '{name} · downloading in the background {percent}%',
  bgProgressWorking: '{name} · downloading in the background…',
  menuDownloading: '{name} · {percent}%',
  menuDownloadingWorking: '{name} · downloading…',
  stepLancedb: 'LanceDB', stepAnydoc: 'AnyDoc', stepOcr: 'OCR',
  removedMissing: 'Removed from the index ({count}) — source file gone: {names}',
  onboardFailedNote: 'Setup did not finish. Retry, or hand the details to the assistant to fix this machine.',
  onboardHelpOpening: 'Opening a chat with the details…',
  libraryLabel: 'Library location', 
  libraryReveal: 'Show the library folder in the file manager',
  libraryNote: 'The library can live in any folder you pick, including a synced or NAS directory. Engines stay on this device.',
  libraryDefault: 'Using the default folder inside Finch.',
  libraryUnavailable: 'The saved library folder is unavailable: {path}',
  libraryWorking: 'Working on the library folder…',
  libraryDoneMove: 'Library moved to {path}. The previous folder is untouched at {previous}.',
  libraryDoneCreate: 'New empty library created at {path}. The previous folder is untouched at {previous}.',
  libraryDoneOpen: 'Opened the library at {path}.',
  libraryMissing: '{missing} stored source file(s) could not be found.',
  menu: 'Library actions',
  backupDone: 'Backed up {count} sources to {path}.', backupPartial: 'Snapshot saved to {path}; {missing} source file(s) are missing. Check manifest.json.', backupWorking: 'Copying the library snapshot…',
};
const DEFAULT_TAG = 'default';
/** How many category badges a row shows before it summarises the rest as "+N". */
const MAX_ROW_BADGES = 3;
const ALLOWED = new Set(['md','markdown','txt','doc','docx','pdf','png','jpg','jpeg','webp','bmp','tif','tiff']);
// Mirrors MAX_FILE_BYTES in the store — the page cannot import the backend bundle. A test keeps
// the two in step, so raising one without the other fails the build.
const MAX_FILE = 200 * 1024 * 1024;
const MAX_FILE_MB = MAX_FILE / (1024 * 1024);
const CHUNK_SIZE = 192 * 1024;
const byId = (id: string) => document.getElementById(id)!;
const bridge = window.finch;
let copy = english;
let tags: Tag[] = [];
let docs: Document[] = [];
let selectedTag: string | null = null;
let sort: 'name' | 'added' | 'updated' = 'updated';
let total = 0;
let beforeOffset = 0;
let nextOffset = 0;
let loadingPage = false;
let pageEpoch = 0;
let searchEpoch = 0;
let sequence = 0;
let uploading = false;
let backingUp = false;
let environment: EnvironmentState | null = null;
let environmentAutoStarted = false;
/** Set once the user leaves setup for the library; optional installs then continue in the background. */
let libraryPath = '';
let libraryDefault = false;
let libraryUnavailable = '';
let libraryBusy = false;
/** What the footer hairline is showing right now; foreground work wins over downloads. */
let importProgress: { label: string; percent: number } | null = null;
/** Set while a page-initiated library operation runs; cleared when its result lands. */
let busyLabel = '';
/** The backend reports progress as a stream with no end marker, so this expires on quiet. */
let streamedProgress = '';
let streamedTimer: number | undefined;
const STREAM_QUIET_MS = 4_000;
let inlineTagEditing: string | null = null;
/** True while the inline "new tag" row is open above the list. */
let creatingTag = false;
let draggingTag: string | null = null;
let debounce: number | undefined;
let searchQuery = '';
let localeEpoch = 0;
const pending = new Map<string, { type: string; epoch: number; mode?: 'replace' | 'append' | 'prepend' | 'locate' }>();
const transfers = new Map<string, { resolve: (reply: Reply) => void; reject: (error: Error) => void; timer: number }>();
function tr(key: string, values?: Record<string, string | number>): string {
  let value = copy[key] ?? english[key] ?? key;
  for (const [token, replacement] of Object.entries(values ?? {})) value = value.replace(`{${token}}`, String(replacement));
  return value;
}
function tagName(id: string | null): string {
  if (id === null) return tr('all');
  return id === DEFAULT_TAG ? tr('unclassified') : (tags.find((tag) => tag.id === id)?.name ?? tr('unclassified'));
}
/**
 * A file-type icon per format, from the JetBrains icon set (see icons/LICENSE.md), so a glance down
 * the list separates a note from a document from a picture. The `_auto` variants carry a light and a
 * dark drawing chosen by `prefers-color-scheme`, which follows the theme Finch hands its windows.
 * `.doc`/`.docx` have no icon of their own in that set, so they take the plain file — the same one
 * anything unsupported falls back to.
 */
const FILE_ICONS: Array<{ extensions: string[]; icon: string }> = [
  { extensions: ['.md', '.markdown'], icon: 'markdown_auto.svg' },
  { extensions: ['.txt'], icon: 'text_auto.svg' },
  { extensions: ['.doc', '.docx'], icon: 'file.svg' },
  { extensions: ['.pdf'], icon: 'pdf.svg' },
  { extensions: ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'], icon: 'image_auto.svg' },
];
function iconForFile(name: string): string {
  const extension = `.${name.split('.').pop()?.toLowerCase() ?? ''}`;
  return FILE_ICONS.find((entry) => entry.extensions.includes(extension))?.icon ?? 'file.svg';
}
/**
 * Results are told as native Finch toasts. The in-page strip stays as a fallback for the
 * one case the toast cannot serve: a page whose bridge is missing or rejects the call.
 */
function status(message: string, error = false): void { byId('status').textContent = message; byId('status').classList.toggle('error', error); }
function toast(message: string, variant: 'default' | 'success' | 'info' | 'warning' | 'error' = 'default'): void {
  if (!message) return;
  // Clear any earlier fallback: a newer message supersedes an older one.
  status('');
  if (bridge?.ui?.toast) {
    void bridge.ui.toast({ title: message, variant }).catch(() => status(message, variant === 'error'));
    return;
  }
  status(message, variant === 'error');
}
/**
 * One hairline in the sidebar footer carries every running task: a foreground import first,
 * a busy library operation next, and background engine downloads last.
 */
function activityNow(): { label: string; percent: number | null } | null {
  if (importProgress) return importProgress;
  const label = streamedProgress || busyLabel;
  if (label) return { label, percent: null };
  const state = environment;
  if (!state?.usable || !state.running) return null;
  const step = state.steps.find((item) => item.status === 'running');
  const name = step ? STEP_LABELS[step.id]?.() ?? step.id : '';
  const percent = typeof step?.percent === 'number' ? step.percent : null;
  return {
    label: percent === null ? tr('bgProgressWorking', { name }) : tr('bgProgress', { name, percent }),
    percent,
  };
}
/** A progress push means work is still happening; a quiet gap means it finished. */
function noteProgress(message: string): void {
  streamedProgress = message;
  if (streamedTimer !== undefined) clearTimeout(streamedTimer);
  streamedTimer = window.setTimeout(() => {
    streamedProgress = '';
    streamedTimer = undefined;
    renderActivity();
  }, STREAM_QUIET_MS);
  if (!importProgress) renderActivity();
}
function renderActivity(): void {
  const bar = byId('activity') as HTMLElement;
  const current = activityNow();
  bar.hidden = current === null;
  if (!current) return;
  bar.title = current.label;
  bar.classList.toggle('indeterminate', current.percent === null);
  (byId('activity-fill') as HTMLElement).style.width = current.percent === null
    ? '30%'
    : `${Math.max(3, Math.min(100, current.percent))}%`;
}
/** The menu row doubles as the download readout: a spinning icon and the component in flight. */
function renderEnvironmentMenu(): void {
  const button = byId('library-environment');
  const detail = byId('library-environment-detail');
  const step = environment?.running ? environment.steps.find((item) => item.status === 'running') : undefined;
  button.classList.toggle('spinning', Boolean(step));
  if (!step) { detail.textContent = ''; button.removeAttribute('title'); return; }
  const name = STEP_SHORT[step.id]?.() ?? step.id;
  button.setAttribute('title', STEP_LABELS[step.id]?.() ?? step.id);
  detail.textContent = typeof step.percent === 'number'
    ? tr('menuDownloading', { name, percent: step.percent })
    : tr('menuDownloadingWorking', { name });
}
function node(tag: string, className: string, value?: string): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  if (value !== undefined) element.textContent = value;
  return element;
}
function svg(iconNode: IconNode): SVGElement {
  return createElement(iconNode, { width: 18, height: 18, 'aria-hidden': 'true' });
}
function icon(iconNode: IconNode, label: string): HTMLButtonElement {
  const button = node('button', 'icon-button') as HTMLButtonElement;
  button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
  button.append(svg(iconNode));
  return button;
}
function mountStaticIcons(): void {
  const staticIcons: Record<string, IconNode> = { search: Search, plus: Plus, x: X, archive: Archive, 'folder-input': FolderInput, 'folder-plus': FolderPlus, 'folder-open': FolderOpen, 'folder-sync': FolderSync, 'hard-drive': HardDrive, 'ellipsis-vertical': EllipsisVertical, 'refresh-cw': RefreshCw, tag: TagIcon, trash: Trash2 };
  for (const placeholder of document.querySelectorAll<HTMLElement>('[data-icon]')) {
    const iconNode = staticIcons[placeholder.dataset.icon ?? ''];
    if (iconNode) placeholder.replaceWith(svg(iconNode));
  }
}
function request(type: string, payload: Record<string, unknown> = {}, mode?: 'replace' | 'append' | 'prepend' | 'locate'): string {
  const requestId = String(++sequence);
  pending.set(requestId, { type, mode, epoch: type === 'search' ? searchEpoch : pageEpoch });
  bridge.postMessage({ type, requestId, ...payload });
  return requestId;
}
function page(offset: number, mode: 'replace' | 'append' | 'prepend' = 'replace'): void {
  if (loadingPage) return;
  loadingPage = true;
  byId('list-end').textContent = tr('loading');
  request('page', { tagId: selectedTag, sort, offset }, mode);
}
function resetPage(): void {
  pageEpoch++;
  loadingPage = false;
  docs = []; total = 0; beforeOffset = 0; nextOffset = 0;
  renderDocs();
  page(0);
}
/**
 * Adopts a fresh tag list. `list: false` skips the list rebuild, for a change that patches a
 * single row instead — the left column still needs its new counts either way.
 */
function applyTags(next: Tag[], list = true): void {
  tags = next;
  if (selectedTag !== null && selectedTag !== DEFAULT_TAG && !tags.some((tag) => tag.id === selectedTag)) selectedTag = null;
  renderTags();
  if (list) renderDocs();
}
function finishTagRename(id: string, previous: string, next?: string, focusChoice = true): void {
  if (inlineTagEditing !== id) return;
  inlineTagEditing = null;
  renderTags();
  const choice = Array.from(byId('tags').querySelectorAll<HTMLElement>('.tag-row'))
    .find((row) => row.dataset.id === id)?.querySelector<HTMLButtonElement>('.tag-choice');
  if (focusChoice) choice?.focus();
  if (next && next !== previous) request('tagRename', { id, name: next });
}
/**
 * Enter must never submit while an IME candidate window is open, or a Chinese name would be
 * created half-composed. Escape always abandons without touching the library.
 */
function wireTagField(field: HTMLInputElement, onEnter: () => void, onEscape: () => void): void {
  let composing = false;
  let justComposed = false;
  field.addEventListener('compositionstart', () => { composing = true; justComposed = false; });
  field.addEventListener('compositionend', () => {
    composing = false; justComposed = true;
    window.setTimeout(() => { justComposed = false; }, 0);
  });
  field.addEventListener('input', () => field.setCustomValidity(''));
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.isComposing && !composing) { event.preventDefault(); onEscape(); return; }
    if (event.key !== 'Enter' || event.isComposing || composing || justComposed || event.keyCode === 229) return;
    event.preventDefault();
    onEnter();
  });
}
/** The creating row behaves like the rename editor: Enter saves, Esc drops it. */
function tagCreateRow(): HTMLElement {
  const row = node('div', 'tag-row creating');
  const editor = node('div', 'tag-editor');
  const field = node('input', 'tag-name-input') as HTMLInputElement;
  field.type = 'text'; field.maxLength = 60; field.autocomplete = 'off';
  field.placeholder = tr('tagPlaceholder');
  field.setAttribute('aria-label', tr('newTag'));
  // The full hint lives in the tooltip: the column is too narrow for it inline.
  field.setAttribute('title', tr('tagHint'));
  wireTagField(field, () => {
    const name = field.value.trim();
    if (!name) { field.setCustomValidity(tr('tagRequired')); field.reportValidity(); return; }
    request('tagCreate', { name });
  }, () => cancelTagCreate());
  field.addEventListener('blur', () => window.setTimeout(() => {
    if (creatingTag && document.activeElement !== field) cancelTagCreate();
  }, 0));
  editor.append(svg(TagIcon), field, node('span', 'tag-count', ''));
  row.append(editor);
  return row;
}
/**
 * The order the user dragged tags into, which is the order the panel just showed. The two fixed
 * rows — All sources and Unclassified — never take part.
 */
function movableTagIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.tag-row'))
    .map((row) => row.dataset.id ?? '')
    .filter((id) => id && id !== 'all' && id !== DEFAULT_TAG);
}
function clearDropHints(): void {
  for (const row of byId('tags').querySelectorAll<HTMLElement>('.tag-row')) row.classList.remove('drop-before', 'drop-after');
}
function endTagDrag(): void {
  draggingTag = null;
  for (const row of byId('tags').querySelectorAll<HTMLElement>('.tag-row')) row.classList.remove('dragging', 'drop-before', 'drop-after');
}
function moveTagBy(id: string, delta: number): void {
  const order = movableTagIds(byId('tags'));
  const from = order.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) return;
  order.splice(to, 0, ...order.splice(from, 1));
  request('tagReorder', { ids: order });
}
/** Native drag and drop, with Alt+↑/↓ doing the same thing from the keyboard. */
function wireTagDrag(row: HTMLElement, id: string, choice: HTMLElement): void {
  row.classList.add('draggable');
  row.draggable = true;
  choice.setAttribute('title', tr('tagDragHint'));
  row.addEventListener('dragstart', (event) => {
    // A row mid-rename holds a text field, and its own action buttons are not drag handles.
    if (creatingTag || inlineTagEditing !== null || (event.target as HTMLElement | null)?.closest('.tag-actions')) {
      event.preventDefault();
      return;
    }
    draggingTag = id;
    row.classList.add('dragging');
    event.dataTransfer?.setData('text/plain', id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  });
  row.addEventListener('dragover', (event) => {
    if (!draggingTag || draggingTag === id) return;
    event.preventDefault();
    const before = event.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2;
    clearDropHints();
    row.classList.add(before ? 'drop-before' : 'drop-after');
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  });
  row.addEventListener('drop', (event) => {
    if (!draggingTag) return;
    event.preventDefault();
    const before = event.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2;
    const dragged = draggingTag;
    const order = movableTagIds(byId('tags')).filter((entry) => entry !== dragged);
    const index = order.indexOf(id);
    endTagDrag();
    if (index < 0) return;
    order.splice(before ? index : index + 1, 0, dragged);
    request('tagReorder', { ids: order });
  });
  row.addEventListener('dragend', endTagDrag);
  choice.addEventListener('keydown', (event) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    moveTagBy(id, event.key === 'ArrowUp' ? -1 : 1);
  });
}
function startTagCreate(): void {
  // A rename field that still holds focus would make renderTags() keep the column as it is, and
  // "+" would look dead. Clicking "+" is an explicit intent to leave that edit behind.
  const active = document.activeElement as HTMLElement | null;
  if (active && byId('tags').contains(active) && typeof active.blur === 'function') active.blur();
  creatingTag = true;
  inlineTagEditing = null;
  renderTags();
  byId('tags').querySelector<HTMLInputElement>('.tag-row.creating .tag-name-input')?.focus();
}
function cancelTagCreate(): void {
  if (!creatingTag) return;
  creatingTag = false;
  renderTags();
  byId('new-tag').focus();
}
function renderTags(): void {
  const container = byId('tags');
  draggingTag = null;
  const liveEditor = container.querySelector<HTMLInputElement>('.tag-editor input');
  // A re-render while the user is typing would throw away the field they are in.
  if ((inlineTagEditing !== null || creatingTag) && liveEditor && document.activeElement === liveEditor) return;
  container.replaceChildren();
  const all: Tag = { id: 'all', name: tr('all'), count: tags.reduce((sum, tag) => sum + tag.count, 0) };
  // Rows are collected first, then the new-tag row is spliced in: it belongs below Unclassified,
  // but that row is skipped when it is empty, and appending the creating row inside the loop under
  // it meant "+" did nothing at all in a library with nothing unclassified.
  const rows: HTMLElement[] = [];
  let createAfter = 1;
  const push = (row: HTMLElement, id: string | null): void => {
    rows.push(row);
    if (id === DEFAULT_TAG) createAfter = rows.length;
  };
  for (const tag of [all, ...tags]) {
    const id = tag.id === 'all' ? null : tag.id;
    // An empty Unclassified has nothing to open, so its row drops out instead of parking a "0" in
    // the list. It comes straight back the moment a file lands in it — the drop hint still names
    // it, and the row menu still offers it as a destination for any file.
    if (id === DEFAULT_TAG && tag.count === 0) continue;
    const row = node('div', 'tag-row');
    row.dataset.id = tag.id;
    row.classList.toggle('active', selectedTag === id);
    if (id && id === inlineTagEditing) {
      row.classList.add('editing');
      const editor = node('div', 'tag-editor');
      const field = node('input', 'tag-name-input') as HTMLInputElement;
      field.type = 'text'; field.maxLength = 60; field.autocomplete = 'off'; field.value = tag.name;
      field.setAttribute('aria-label', tr('renameTag'));
      wireTagField(field, () => {
        const next = field.value.trim();
        if (!next) { field.setCustomValidity(tr('tagRequired')); field.reportValidity(); return; }
        finishTagRename(id, tag.name, next);
      }, () => finishTagRename(id, tag.name));
      field.addEventListener('blur', () => window.setTimeout(() => {
        if (inlineTagEditing === id && document.activeElement !== field) finishTagRename(id, tag.name, undefined, false);
      }, 0));
      editor.append(svg(TagIcon), field, node('span', 'tag-count', String(tag.count)));
      row.append(editor); push(row, id); continue;
    }
    const choice = node('button', 'tag-choice') as HTMLButtonElement;
    choice.type = 'button'; choice.setAttribute('aria-pressed', String(selectedTag === id));
    choice.append(svg(tag.id === 'all' ? Files : tag.id === DEFAULT_TAG ? FolderOpen : TagIcon), node('span', 'tag-name', tag.id === DEFAULT_TAG ? tr('unclassified') : tag.name), node('span', 'tag-count', String(tag.count)));
    choice.addEventListener('click', () => { if (selectedTag === id) return; selectedTag = id; inlineTagEditing = null; renderTags(); resetPage(); updateScope(); });
    row.append(choice);
    if (id && id !== DEFAULT_TAG) {
      const actions = node('span', 'tag-actions');
      const rename = icon(PenLine, tr('renameTag'));
      rename.addEventListener('click', () => {
        inlineTagEditing = id; renderTags();
        const input = Array.from(container.querySelectorAll<HTMLElement>('.tag-row'))
          .find((item) => item.dataset.id === id)?.querySelector<HTMLInputElement>('.tag-editor input');
        input?.focus(); input?.select();
      });
      const remove = icon(Trash2, tr('deleteTag'));
      remove.addEventListener('click', async () => {
        const { confirmed } = await bridge.ui.confirm({ title: tr('tagDeleteTitle'), message: tr('tagDeleteMessage'), variant: 'danger' });
        if (confirmed) request('tagDelete', { id });
      });
      actions.append(rename, remove); row.append(actions);
      wireTagDrag(row, id, choice);
    }
    push(row, id);
  }
  if (creatingTag) rows.splice(Math.min(createAfter, rows.length), 0, tagCreateRow());
  container.append(...rows);
  byId('library-title').textContent = tagName(selectedTag);
  updateScope();
}
function updateScope(): void {
  const target = tagName(selectedTag);
  const importTarget = tagName(selectedTag ?? DEFAULT_TAG);
  const hint = byId('drop-hint');
  hint.textContent = tr('dropHint', { tag: importTarget });
  hint.setAttribute('title', hint.textContent);
  // With no title and no note above it, the field itself says what a search would cover.
  (byId('query') as HTMLInputElement).placeholder = tr('searchPlaceholderIn', { tag: target });
  byId('library-title').textContent = target;
  byId('library-title').setAttribute('title', target);
}
/** The sort control is sized by its own label, so keep that label in sync with the selection. */
function updateSortSizer(): void {
  const select = byId('sort') as HTMLSelectElement;
  byId('sort-sizer').textContent = select.selectedOptions[0]?.textContent ?? '';
}
/**
 * The row's primary action, routed by type: Markdown and text open in Finch's document preview,
 * an image in its dedicated image viewer, and anything else — PDF, Word — externally in the file
 * manager, which is also where the first two land when the host cannot preview them.
 */
function openDocument(doc: Document): void {
  const reveal = () => request('reveal', { id: doc.id });
  if (!openListedDocument(bridge, doc.name, doc.path, reveal)) reveal();
}
/**
 * One row of the list. Building a row is separate from rendering the list because re-filing a
 * document rebuilds exactly one: the rest of the list, and the scroll position with it, stays put.
 */
function buildRow(doc: Document): HTMLElement {
  const row = node('div', 'doc'); row.dataset.id = doc.id;
  const fileIcon = node('span', 'doc-icon');
  const glyph = node('img', 'doc-icon-image') as HTMLImageElement;
  glyph.src = new URL(`../icons/${iconForFile(doc.name)}`, location.href).href;
  glyph.alt = '';
  fileIcon.append(glyph);
  row.append(fileIcon);
  row.append(node('span', 'doc-title', doc.name));
  // One line: the categories show as badges (a file may carry several), re-filing lives in the
  // row menu. Unclassified is not a tag but the absence of one, so it gets a dashed badge.
  const shown = doc.tags.slice(0, MAX_ROW_BADGES);
  if (!shown.length) {
    const badge = node('span', 'doc-tag unclassified', tagName(DEFAULT_TAG));
    badge.setAttribute('title', tr('move'));
    row.append(badge);
  } else {
    for (const tagId of shown) row.append(node('span', 'doc-tag', tagName(tagId)));
    if (doc.tags.length > shown.length) {
      const rest = node('span', 'doc-tag more', `+${doc.tags.length - shown.length}`);
      rest.setAttribute('title', doc.tags.slice(MAX_ROW_BADGES).map((tagId) => tagName(tagId)).join(' · '));
      row.append(rest);
    }
  }
  const added = new Date(doc.added_at).toLocaleDateString();
  const indexed = new Date(doc.indexed_at).toLocaleDateString();
  // The row keeps only the size of the material; when it was indexed lives in the row menu.
  row.append(node('span', 'doc-status', `${doc.chunks} ${tr('chunk')}`));
  // Everything the shortened row no longer shows stays one hover away, full path included.
  const external = !/[/\\]imports[/\\]/.test(doc.path);
  row.setAttribute('title', [
    external ? tr('externalSource', { path: doc.path }) : doc.path,
    `${doc.chunks} ${tr('chunk')}`, tr('added', { date: added }), tr('updated', { date: indexed }),
  ].join('\n'));

  // The row itself performs the same action as its own first button, so the pointer cursor is
  // not a lie: that button is the eye for the file types Finch can show, and the folder for the
  // ones that leave Finch. Anything that lands on a button keeps its own job.
  row.addEventListener('click', (event) => {
    if ((event.target as HTMLElement | null)?.closest('.doc-tools')) return;
    openDocument(doc);
  });
  const tools = node('div', 'doc-tools');
  const previewable = previewRoute(doc.name) !== 'external';
  const primary = previewable ? icon(Eye, tr('preview')) : icon(FolderOpen, tr('reveal'));
  primary.addEventListener('click', () => openDocument(doc));
  const more = icon(EllipsisVertical, tr('menu'));
  more.setAttribute('aria-haspopup', 'menu');
  more.addEventListener('click', (event) => {
    event.stopPropagation();
    openRowMenu(doc, more);
  });
  // A right-click asks for this row's menu wherever the pointer happens to be — that is where a
  // context menu belongs. The ⋯ button stays the anchor, so an open menu still tracks the row.
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openRowMenu(doc, more, { x: event.clientX, y: event.clientY });
  });
  tools.append(primary, more);
  row.append(tools);
  return row;
}
function renderDocs(focusId?: string): void {
  // Rows are rebuilt here, so a menu whose document is gone has to close — but one whose document
  // is still listed keeps its place, which is what makes ticking several categories possible.
  const survivor = rowMenuDoc ? docs.find((doc) => doc.id === rowMenuDoc!.id) ?? null : null;
  // A refresh empties the list before refilling it, and that moment is not a reason to forget the
  // menu: hide it, and the next render puts it back on the row it belongs to.
  if (!survivor) { if (docs.length || !rowMenuDoc) closeRowMenu(); else hideRowMenu(); }
  byId('count').textContent = tr('totalFiles', { count: total });
  const target = byId('documents'); target.replaceChildren();
  if (!docs.length) target.append(node('div', 'empty', tr('empty')));
  for (const doc of docs) target.append(buildRow(doc));
  if (survivor) restoreRowMenu(survivor, rowMenuFlyoutOpen);
  // Only carry a tail line while rows remain; a fully shown list needs no dangling footer.
  byId('list-end').textContent = docs.length < total ? tr('loaded', { shown: docs.length, total }) : '';
  if (focusId) {
    const row = Array.from(target.children).find((element) => (element as HTMLElement).dataset.id === focusId) as HTMLElement | undefined;
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (row) {
      // Restart the one-shot flash even when the same row is located twice in a row.
      row.classList.remove('flash');
      void row.offsetWidth;
      row.classList.add('flash');
    }
  }
}

/**
 * Applies one re-filing to the list already on screen: only the row that changed is rebuilt, so the
 * scroll position and every other row survive, and a row that no longer belongs to the tag being
 * viewed leaves with the count following it. Reloading the page instead is what made ticking a
 * category look like a full refresh, which is the whole reason this patch exists.
 *
 * A document outside the loaded window needs no DOM update. It must never trigger a full reload:
 * another toggle can arrive after an earlier one already removed the row from the current scope.
 */
function patchTagToggle(documentId: string, nextTags: string[]): void {
  const index = docs.findIndex((doc) => doc.id === documentId);
  if (index === -1) return;
  const row = byId('documents').querySelector<HTMLElement>(`.doc[data-id="${documentId}"]`);
  const menuWasHere = rowMenuDoc?.id === documentId;
  const flyoutWasOpen = rowMenuFlyoutOpen;
  if (!inScope(nextTags, selectedTag)) {
    docs.splice(index, 1);
    total = Math.max(0, total - 1);
    // The loaded window now ends one catalogue position earlier; using the old offset would
    // skip the first unseen document when infinite scrolling fetches its next page.
    nextOffset = Math.max(beforeOffset, nextOffset - 1);
    if (menuWasHere) closeRowMenu();
    row?.remove();
    // The last row leaving brings the empty-library hint back, which only a full render draws.
    if (!docs.length) { renderDocs(); return; }
    byId('count').textContent = tr('totalFiles', { count: total });
    byId('list-end').textContent = docs.length < total ? tr('loaded', { shown: docs.length, total }) : '';
    return;
  }
  const updated: Document = { ...docs[index], tags: nextTags };
  docs[index] = updated;
  // A document can be listed without being drawn (a page the user has not scrolled to); the rest
  // of the list is then already correct, so there is nothing to replace.
  if (!row) return;
  row.replaceWith(buildRow(updated));
  // The menu is anchored to a button inside the row that has just been rebuilt.
  if (menuWasHere) restoreRowMenu(updated, flyoutWasOpen);
}
/** One menu is shared by every row and positioned in viewport coordinates. */
let rowMenuDoc: Document | null = null;
let rowMenuAnchor: HTMLElement | null = null;
/**
 * Where the menu was put when a right-click asked for it. Kept so re-anchoring it after a row is
 * rebuilt leaves it under the pointer the user put it at, instead of jumping to the ⋯ button.
 */
let rowMenuBox: AnchorBox | null = null;

/** Hides the popup but remembers the row, so a refresh that empties the list can restore it. */
function hideRowMenu(): void {
  (byId('row-menu') as HTMLElement).hidden = true;
  (byId('row-submenu') as HTMLElement).hidden = true;
  byId('row-classify').setAttribute('aria-expanded', 'false');
  byId('row-menu-button')?.setAttribute('aria-expanded', 'false');
  for (const row of byId('documents').querySelectorAll('.menu-open')) row.classList.remove('menu-open');
}
function closeRowMenu(): void {
  rowMenuFlyoutOpen = false;
  (byId('row-menu') as HTMLElement).hidden = true;
  (byId('row-submenu') as HTMLElement).hidden = true;
  byId('row-classify').setAttribute('aria-expanded', 'false');
  rowMenuAnchor?.setAttribute('aria-expanded', 'false');
  anchorRow()?.classList.remove('menu-open');
  rowMenuDoc = null;
  rowMenuAnchor = null;
}
let rowMenuFreshUntil = 0;
/** Whether the category flyout is wanted open; a transient hide must not drop this. */
let rowMenuFlyoutOpen = false;
function anchorRow(): HTMLElement | null {
  return (rowMenuAnchor?.closest('.doc') as HTMLElement | null) ?? null;
}
/**
 * Re-attaches an open menu to the row it belongs to after the list was rebuilt, so a toggle can
 * re-tick the flyout in place instead of the user having to reopen everything.
 */
function restoreRowMenu(doc: Document, flyoutWasOpen: boolean): void {
  // Rebuilding the list nudges the scroll position, and the browser reports that as a scroll a
  // moment later. It is not the user scrolling, so it must not close what is being restored.
  rowMenuFreshUntil = Date.now() + 250;
  const row = byId('documents').querySelector<HTMLElement>(`.doc[data-id="${doc.id}"]`);
  const anchor = row?.querySelector<HTMLElement>('.doc-tools .icon-button:last-child') ?? null;
  if (!row || !anchor) { closeRowMenu(); return; }
  rowMenuDoc = doc;
  rowMenuAnchor = anchor;
  byId('row-menu-note').textContent = tr('updated', { date: new Date(doc.indexed_at).toLocaleDateString() });
  const submenu = byId('row-submenu');
  const submenuScroll = submenu.scrollTop;
  fillRowSubmenu(doc);
  row.classList.add('menu-open');
  anchor.setAttribute('aria-expanded', 'true');
  placeMenu(byId('row-menu') as HTMLElement, rowMenuBox ?? anchor.getBoundingClientRect());
  if (flyoutWasOpen) {
    byId('row-classify').setAttribute('aria-expanded', 'true');
    placeMenu(submenu, byId('row-classify').getBoundingClientRect(), 'left');
    // Re-ticking must preserve the user's place, not jump back to the first selected category.
    submenu.scrollTop = submenuScroll;
  }
}
function menuOpenFor(element: HTMLElement): boolean { return !element.hidden; }

/** What a popup needs to know about its anchor: a real element's box, or a point on screen. */
interface AnchorBox { top: number; bottom: number; left: number; right: number; width: number; height: number }

/** Keeps a popup on screen, stacked beside the anchor on the requested side. */
function placeMenu(menu: HTMLElement, anchor: AnchorBox, side: 'below' | 'left' | 'right' = 'below'): void {
  menu.hidden = false;
  const box = menu.getBoundingClientRect();
  const gap = 4;
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const clamp = (value: number, max: number) => Math.max(8, Math.min(value, max));
  // 'left' opens away from the panel edge so a flyout never runs off the window.
  const rawLeft = side === 'left' ? anchor.left - box.width - gap
    : side === 'right' ? anchor.right + gap
      : anchor.right - box.width;
  menu.style.left = `${scrollX + clamp(rawLeft, window.innerWidth - box.width - 8)}px`;
  // A flyout lines up with the middle of the item it belongs to; a stacked menu sits under its
  // anchor and flips above it when the window runs out of room.
  const rawTop = side === 'left'
    ? anchor.top + anchor.height / 2 - box.height / 2
    : anchor.bottom + gap + box.height > window.innerHeight - 8
      ? anchor.top - box.height - gap
      : anchor.bottom + gap;
  menu.style.top = `${scrollY + clamp(rawTop, window.innerHeight - box.height - 8)}px`;
}

/** The second level lists every category, marking the one the document already has. */
/** Fills the category flyout for one document: a checkbox per tag, ticked where it applies. */
function fillRowSubmenu(doc: Document): void {
  const submenu = byId('row-submenu') as HTMLElement;
  submenu.replaceChildren();
  // Clicking adds or removes that category without closing anything: several are usually set in one
  // visit, so the flyout stays where it is and re-ticks itself when the reply comes back.
  for (const tag of tags) {
    if (tag.id === DEFAULT_TAG) continue;
    const checked = doc.tags.includes(tag.id);
    const choice = node('button', 'menu-item') as HTMLButtonElement;
    choice.type = 'button';
    choice.setAttribute('role', 'menuitemcheckbox');
    choice.setAttribute('aria-checked', String(checked));
    choice.append(node('span', 'menu-label', tagName(tag.id)));
    const check = node('span', 'menu-check');
    if (checked) check.append(svg(Check));
    choice.append(check);
    choice.addEventListener('click', () => request('tagToggle', { id: doc.id, tagId: tag.id }));
    submenu.append(choice);
  }
  // With no categories at all there is nothing to tick, so the flyout says so instead of opening on
  // an empty box.
  if (!submenu.children.length) {
    const note = node('span', 'menu-hint', tr('noTags'));
    note.setAttribute('role', 'presentation');
    submenu.append(note);
  }
}
/**
 * Opens the shared row menu for one document. `at` places it at a point — a right-click — instead
 * of beside the anchor, and re-opening an already open menu is then a request, not a toggle.
 */
function openRowMenu(doc: Document, anchor: HTMLElement, at?: { x: number; y: number }): void {
  setMenu(false);
  const menu = byId('row-menu') as HTMLElement;
  if (!at && rowMenuAnchor === anchor && menuOpenFor(menu)) { closeRowMenu(); return; }
  closeRowMenu();
  rowMenuDoc = doc;
  rowMenuAnchor = anchor;
  // The indexed date leads the menu as a plain note; the row itself no longer carries it on hover.
  byId('row-menu-note').textContent = tr('updated', { date: new Date(doc.indexed_at).toLocaleDateString() });
  fillRowSubmenu(doc);
  anchor.setAttribute('aria-expanded', 'true');
  anchorRow()?.classList.add('menu-open');
  rowMenuBox = at ? { top: at.y, bottom: at.y, left: at.x, right: at.x, width: 0, height: 0 } : null;
  placeMenu(menu, rowMenuBox ?? anchor.getBoundingClientRect());
}
/** Scroll only the flyout, never the document list or page that its row belongs to. */
function scrollToCheckedCategory(submenu: HTMLElement): void {
  submenu.scrollTop = 0;
  const checked = submenu.querySelector<HTMLElement>('[aria-checked="true"]');
  if (!checked) return;
  const menuBox = submenu.getBoundingClientRect();
  const checkedBox = checked.getBoundingClientRect();
  const middle = checkedBox.top - menuBox.top - submenu.clientTop + checkedBox.height / 2;
  submenu.scrollTop = Math.max(0, Math.min(submenu.scrollHeight - submenu.clientHeight, middle - submenu.clientHeight / 2));
}
function openRowSubmenu(): void {
  const submenu = byId('row-submenu') as HTMLElement;
  if (menuOpenFor(submenu)) return;
  rowMenuFlyoutOpen = true;
  const item = byId('row-classify');
  item.setAttribute('aria-expanded', 'true');
  placeMenu(submenu, item.getBoundingClientRect(), 'left');
  // The flyout must be visible before measuring its viewport and selected row.
  scrollToCheckedCategory(submenu);
}
function closeRowSubmenu(): void {
  rowMenuFlyoutOpen = false;
  (byId('row-submenu') as HTMLElement).hidden = true;
  byId('row-classify').setAttribute('aria-expanded', 'false');
}
function wireRowMenu(): void {
  const menu = byId('row-menu') as HTMLElement;
  const submenu = byId('row-submenu') as HTMLElement;
  byId('row-open').addEventListener('click', () => {
    if (rowMenuDoc) request('reveal', { id: rowMenuDoc.id });
    closeRowMenu();
  });
  byId('row-classify').addEventListener('click', () => {
    if (menuOpenFor(submenu)) closeRowSubmenu(); else openRowSubmenu();
  });
  // Hovering the entry opens the second level, which is where a mouse expects it to be.
  byId('row-classify').addEventListener('mouseenter', openRowSubmenu);
  let leaving: number | undefined;
  const keep = () => { if (leaving !== undefined) { clearTimeout(leaving); leaving = undefined; } };
  const drop = () => { keep(); leaving = window.setTimeout(closeRowSubmenu, 220); };
  for (const element of [byId('row-classify'), submenu]) {
    element.addEventListener('mouseenter', keep);
    element.addEventListener('mouseleave', drop);
  }
  byId('row-remove').addEventListener('click', async () => {
    const doc = rowMenuDoc;
    closeRowMenu();
    if (!doc) return;
    const { confirmed } = await bridge.ui.confirm({ title: tr('removeTitle'), message: tr('removeMessage'), variant: 'danger' });
    if (confirmed) request('delete', { id: doc.id });
  });
  // Anything outside, a scroll, or Escape dismisses the menu.
  document.addEventListener('pointerdown', (event) => {
    const target = event.target as Node;
    if (menu.hidden || menu.contains(target) || submenu.contains(target) || rowMenuAnchor?.contains(target)) return;
    closeRowMenu();
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeRowMenu(); });
  const scroller = byId('documents-scroll');
  scroller.addEventListener('scroll', () => { if (Date.now() >= rowMenuFreshUntil) closeRowMenu(); }, { passive: true });
  window.addEventListener('resize', closeRowMenu);
}

/** Keyboard navigation walks the same highlighted row a hover sets, so both read as one selection. */
let activeMatch = -1;
function matchRows(): HTMLElement[] { return Array.from(byId('matches').querySelectorAll<HTMLElement>('.match')); }
function setActiveMatch(index: number): void {
  const rows = matchRows();
  if (!rows.length) { activeMatch = -1; return; }
  activeMatch = Math.max(0, Math.min(rows.length - 1, index));
  rows.forEach((row, at) => {
    row.classList.toggle('active', at === activeMatch);
    row.setAttribute('aria-selected', String(at === activeMatch));
  });
  rows[activeMatch]?.scrollIntoView({ block: 'nearest' });
}
function moveActiveMatch(delta: number): void {
  const rows = matchRows();
  if (!rows.length) return;
  // Before any selection, ↓ starts at the first row and ↑ at the last, like every list.
  setActiveMatch(activeMatch < 0 ? (delta > 0 ? 0 : rows.length - 1) : activeMatch + delta);
}
function locateMatch(match: Match): void {
  pageEpoch++; loadingPage = false;
  request('locate', { id: match.document_id, tagId: selectedTag, sort }, 'locate');
}
let matches: Match[] = [];
function renderMatches(next: Match[]): void {
  matches = next;
  activeMatch = -1;
  const target = byId('matches'); target.replaceChildren();
  byId('search-dialog').classList.toggle('has-results', next.length > 0);
  if (!next.length) { target.append(node('div', 'empty', tr('emptyMatches'))); return; }
  // The backend reports what each passage actually matched, which is not always the whole query.
  const terms = (match: Match) => match.matched?.length ? match.matched : highlightTerms(searchQuery);
  next.forEach((match, index) => {
    const row = node('article', 'match') as HTMLElement;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');
    row.append(node('div', 'match-title', `${match.name} · #${match.chunk}`));
    const text = node('p', 'match-text');
    for (const part of snippetParts(match.text, terms(match))) {
      text.append(part.hit ? node('mark', '', part.text) : document.createTextNode(part.text));
    }
    row.append(text);
    // The whole row is the target: hovering lights it, clicking jumps to the file in the list.
    row.addEventListener('mouseenter', () => setActiveMatch(index));
    row.addEventListener('click', () => locateMatch(match));
    target.append(row);
  });
}
/** Ids are shared by the setup list and the background progress bar. */
const STEP_LABELS: Record<string, () => string> = {
  lancedb: () => tr('onboardLancedb'), anydoc: () => tr('onboardAnydoc'), ocr: () => tr('onboardOcr'),
};
/** Short names for the sidebar menu row, where the full label would wrap. */
const STEP_SHORT: Record<string, () => string> = {
  lancedb: () => tr('stepLancedb'), anydoc: () => tr('stepAnydoc'), ocr: () => tr('stepOcr'),
};

function environmentIcon(status: EnvironmentStep['status']): IconNode {
  if (status === 'running') return Loader;
  if (status === 'ready') return CircleCheck;
  if (status === 'failed') return CircleAlert;
  return Circle;
}

function renderEnvironment(state: EnvironmentState): void {
  const overlay = byId('onboard') as HTMLElement;
  // The screen exists only while something mandatory is missing. As soon as those parts are in it
  // steps aside by itself — nobody sits and watches an optional engine download — and it comes
  // back if a retry or a reinstall makes the library unusable again.
  overlay.hidden = state.usable;
  if (state.usable) return;
  const list = byId('onboard-steps');
  list.replaceChildren();
  renderOnboardLibrary();
  const labels: Record<string, string> = { lancedb: tr('onboardLancedb'), anydoc: tr('onboardAnydoc'), ocr: tr('onboardOcr') };
  const statuses: Record<EnvironmentStep['status'], string> = {
    pending: tr('onboardPending'), running: tr('onboardRunning'), ready: tr('onboardReady'), failed: tr('onboardFailed'),
  };
  for (const step of state.steps) {
    const row = node('li', `onboard-step ${step.status}`);
    const iconBox = node('span', 'onboard-step-icon');
    iconBox.append(svg(environmentIcon(step.status)));
    row.append(iconBox);
    // The icon is centred against the whole text block, not just its first line.
    const content = node('div', 'onboard-step-content');
    const title = node('div', 'onboard-step-title');
    title.append(node('span', 'onboard-step-name', labels[step.id] ?? step.id), node('span', 'onboard-step-status', statuses[step.status]));
    content.append(title);
    const detail = step.error ?? step.message ?? step.detail ?? (step.status === 'running' ? tr('onboardWorking') : '');
    if (detail) content.append(node('div', 'onboard-step-detail', detail));
    if (step.status === 'running' && typeof step.percent === 'number') {
      const bar = node('div', 'onboard-bar');
      const fill = node('span', '');
      fill.style.width = `${Math.max(4, Math.min(100, step.percent))}%`;
      bar.append(fill);
      content.append(bar);
    }
    row.append(content);
    list.append(row);
  }
  const failures = state.steps.filter((step) => step.status === 'failed');
  const blockingFailure = failures.some((step) => !step.optional);
  byId('onboard-retry').hidden = state.running || !blockingFailure;
  byId('onboard-help').hidden = state.running || !blockingFailure;
  byId('onboard-note').textContent = blockingFailure ? tr('onboardFailedNote') : '';
}

/**
 * The library row is a step row like the engine ones: the icon carries its state, the title line
 * says which kind of location it is, and the detail line is the folder itself.
 */
function renderOnboardLibrary(): void {
  const row = byId('onboard-library-row');
  const state = libraryUnavailable ? 'failed' : libraryBusy ? 'running' : 'ready';
  row.className = `onboard-step onboard-library ${state}`;
  byId('onboard-library-icon').replaceChildren(svg(environmentIcon(state)));
  byId('onboard-library-status').textContent = state === 'running' ? tr('onboardWorking')
    : state === 'failed' ? tr('onboardLibraryUnavailable')
      : libraryDefault ? tr('onboardLibraryDefault') : tr('onboardLibraryChosen');
  const path = byId('onboard-library-path');
  path.textContent = shortPath(libraryUnavailable || libraryPath);
  path.setAttribute('title', libraryUnavailable || libraryPath);
}

/** A hairline in the sidebar footer is the only trace of an install still running after setup. */
function applyEnvironment(state: EnvironmentState | undefined): void {
  if (!state) return;
  const previous = environment;
  environment = state;
  renderEnvironment(state);
  renderActivity();
  renderEnvironmentMenu();
  // Report an optional failure once, after the user has already gone back to the library.
  const failures = state.steps.filter((step) => step.status === 'failed' && step.optional);
  // Reported once the run has stopped, and only while the library is actually on screen.
  if (failures.length && !state.running && previous?.running && state.usable) {
    toast(tr('onboardOptionalFailed', { name: failures.map((step) => STEP_LABELS[step.id]?.() ?? step.id).join(', ') }), 'error');
  }
  // First sight of a missing runtime starts setup by itself; a failure always waits for a click.
  const untouched = state.steps.every((step) => step.status === 'pending' || step.status === 'ready');
  if (!state.ready && !state.running && untouched && !environmentAutoStarted) {
    environmentAutoStarted = true;
    request('environmentInstall');
  }
}
function applyLibrary(info: LibraryInfo | undefined): void {
  if (!info) return;
  libraryPath = info.root;
  libraryDefault = info.isDefault;
  libraryUnavailable = info.unavailable ?? '';
  updateLibrary();
  renderOnboardLibrary();
}
function shortPath(path: string): string {
  const parts = path.split(/[/\\]+/).filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-2).join('/')}`;
}
function updateLibrary(): void {
  const short = shortPath(libraryPath);
  const path = byId('library-path');
  path.textContent = short;
  // The row shows only the folder name, so the tooltip carries what it is and the full path.
  const reveal = byId('library-reveal');
  reveal.setAttribute('title', `${libraryUnavailable ? '⚠ ' : ''}${tr('libraryLabel')}\n${libraryUnavailable ?? libraryPath}`);
  reveal.setAttribute('aria-label', `${tr('libraryLabel')}: ${libraryUnavailable ?? libraryPath}, ${tr('libraryReveal')}`);
  byId('library-footer').classList.toggle('warning', Boolean(libraryUnavailable));
  const note = byId('library-note');
  note.textContent = libraryUnavailable ? `${tr('libraryUnavailable', { path: libraryUnavailable })}

${tr('libraryNote')}` : libraryDefault ? `${tr('libraryDefault')}

${tr('libraryNote')}` : tr('libraryNote');
}
function setMenu(open: boolean): void {
  if (open) closeRowMenu();
  (byId('library-menu') as HTMLElement).hidden = !open;
  byId('library-menu-button').setAttribute('aria-expanded', String(open));
}
function menuOpen(): boolean { return !(byId('library-menu') as HTMLElement).hidden; }
function setLibraryBusy(busy: boolean, label = ''): void {
  libraryBusy = busy;
  busyLabel = busy ? label : '';
  for (const id of ['library-location', 'backup', 'library-reveal', 'library-menu-button', 'sync', 'onboard-library-action']) (byId(id) as HTMLButtonElement).disabled = busy;
  if (busy) setMenu(false);
  renderActivity();
  renderOnboardLibrary();
}
function applyCopy(): void {
  const elements: Record<string, string> = {
    heading: 'heading', intro: 'intro', add: 'add-label',
    tagsTitle: 'tags-title',
    sortLabel: 'sort-label',
    libraryLocation: 'library-location-label', backupLabel: 'backup-label', syncLabel: 'sync-label',
    libraryEnvironment: 'library-environment-label',
    menuReveal: 'row-open-label', menuClassify: 'row-classify-label', remove: 'row-remove-label',
    onboardTitle: 'onboard-title', onboardIntro: 'onboard-intro', onboardRetry: 'onboard-retry', onboardHelp: 'onboard-help',
    onboardLibraryTitle: 'onboard-library-title', onboardLibraryAction: 'onboard-library-action-label',
    searchLabel: 'search-label',
  };
  for (const [key, id] of Object.entries(elements)) byId(id).textContent = tr(key);
  byId('new-tag').setAttribute('title', tr('newTag')); byId('new-tag').setAttribute('aria-label', tr('newTag'));
  byId('browse').setAttribute('title', tr('browse')); byId('browse').setAttribute('aria-label', tr('browse'));
  byId('onboard-library-action').setAttribute('title', tr('onboardLibraryHint'));
  byId('sync').setAttribute('title', tr('syncHint'));
  byId('library-location').setAttribute('title', tr('libraryLocationHint'));
  byId('library-menu-button').setAttribute('title', tr('menu')); byId('library-menu-button').setAttribute('aria-label', tr('menu'));
  (byId('query') as HTMLInputElement).placeholder = tr('searchPlaceholderIn', { tag: tr('all') });
  byId('search-dialog').setAttribute('aria-label', tr('searchLabel'));
  const options = (byId('sort') as HTMLSelectElement).options;
  options[0]!.textContent = tr('sortUpdated'); options[1]!.textContent = tr('sortAdded'); options[2]!.textContent = tr('sortName');
  updateSortSizer();
  renderTags(); renderDocs(); updateLibrary();
}
async function localeChanged(locale: string): Promise<void> {
  const epoch = ++localeEpoch;
  const language = locale.startsWith('zh') ? 'zh-CN' : 'en';
  let nextCopy: Copy = english;
  try {
    const file = language === 'zh-CN' ? 'zh-CN' : 'en-US';
    const response = await fetch(new URL(`../i18n/${file}.json`, location.href));
    if (response.ok) nextCopy = { ...english, ...((await response.json()) as { ui?: Copy }).ui };
  } catch { /* English fallback remains available. */ }
  if (epoch !== localeEpoch) return;
  document.documentElement.lang = language;
  copy = nextCopy;
  applyCopy();
  document.documentElement.classList.remove('booting');
}
function uploadRequest(type: string, payload: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const requestId = String(++sequence);
    const timer = window.setTimeout(() => { transfers.delete(requestId); reject(new Error('File transfer timed out.')); }, timeoutMs);
    transfers.set(requestId, { resolve, reject, timer });
    try { bridge.postMessage({ type, requestId, ...payload }); }
    catch (error) { clearTimeout(timer); transfers.delete(requestId); reject(error instanceof Error ? error : new Error(String(error))); }
  });
}
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
async function importOne(file: File, tagId: string): Promise<boolean> {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!ALLOWED.has(extension)) throw new Error(tr('unsupported'));
  if (file.size < 1 || file.size > MAX_FILE) throw new Error(tr('tooLarge', { max: MAX_FILE_MB }));
  importProgress = { label: tr('reading', { name: file.name }), percent: 0 };
  renderActivity();
  await uploadRequest('uploadStart', { name: file.name, size: file.size, tagId });
  try {
    for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
      const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer());
      await uploadRequest('uploadChunk', { data: base64(bytes) });
      const percent = Math.floor(Math.min(100, (offset + bytes.length) / file.size * 100));
      importProgress = { label: tr('uploading', { name: file.name, percent }), percent };
      renderActivity();
    }
    return (await uploadRequest('uploadFinish', { name: file.name }, 900_000)).unchanged === 1;
  } catch (error) {
    bridge.postMessage({ type: 'uploadAbort', requestId: String(++sequence) });
    throw error;
  }
}
/**
 * A format's engine has to be installed before its bytes are worth sending: the backend refuses
 * such an import on purpose (an engine download must not happen under the library lock), and
 * uploading a 40 MB image first only to be told that is a waste. The mapping mirrors the store.
 */
const ENGINE_STEPS: Array<{ extensions: string[]; step: string }> = [
  { extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'], step: 'ocr' },
  { extensions: ['doc', 'docx', 'pdf'], step: 'anydoc' },
];
function pendingEngine(name: string): string | null {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  const step = ENGINE_STEPS.find((entry) => entry.extensions.includes(extension))?.step;
  if (!step) return null;
  const state = environment?.steps.find((item) => item.id === step);
  return state && state.status !== 'ready' ? step : null;
}
/** Returns the names to skip, and asks for the missing engine once. */
function gateImports(names: string[]): Set<string> {
  const blocked = new Set<string>();
  let step: string | null = null;
  for (const name of names) {
    const pending = pendingEngine(name);
    if (!pending) continue;
    blocked.add(name);
    step = pending;
  }
  if (step) {
    const label = tr(step === 'ocr' ? 'engineOcr' : 'engineAnydoc');
    toast(tr('engineNeeded', { name: label }), 'info');
    environmentAutoStarted = true;
    request('environmentInstall');
  }
  return blocked;
}
async function importFiles(files: File[]): Promise<void> {
  if (!bridge || uploading || !files.length) return;
  uploading = true;
  (byId('add') as HTMLButtonElement).disabled = true;
  const tagId = selectedTag ?? DEFAULT_TAG;
  let imported = 0; let unchanged = 0;
  const errors: string[] = [];
  // Formats whose engine is still missing are held back before a single byte is sent; the toast and
  // the background install are raised by the guard itself.
  const blocked = gateImports(files.map((file) => file.name));
  try {
    for (const file of files) {
      if (blocked.has(file.name)) continue;
      try { if (await importOne(file, tagId)) unchanged++; else imported++; }
      catch (error) { errors.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    // Nothing was sent and nothing failed: the engine toast already said why.
    if (!imported && !unchanged && !errors.length && blocked.size) return;
    toast(errors.length
      ? tr('failed', { details: errors.join('; ') })
      : unchanged > 0 ? tr('completeUnchanged', { count: imported, unchanged }) : tr('complete', { count: imported }),
    errors.length ? 'error' : 'success');
  } finally {
    uploading = false;
    importProgress = null;
    renderActivity();
    (byId('add') as HTMLButtonElement).disabled = false;
  }
}
function queueSearch(): void {
  if (debounce !== undefined) clearTimeout(debounce);
  searchEpoch++;
  const query = (byId('query') as HTMLInputElement).value.trim();
  if (!query) { byId('matches').replaceChildren(node('div', 'empty', tr('searchHint'))); return; }
  debounce = window.setTimeout(() => { searchQuery = query; request('search', { query, tagId: selectedTag }); }, 240);
}
mountStaticIcons();
applyCopy();
wireRowMenu();
window.setTimeout(() => {
  if (document.documentElement.classList.contains('booting')) void localeChanged(navigator.language || 'en-US');
}, 600);
if (bridge) {
  bridge.onMessage((message: unknown) => {
    const data = message as Reply & { locale?: string };
    if (data.type === 'finch:env') { void localeChanged(data.locale ?? 'en-US'); return; }
    // Backend progress is backend work (copying, indexing); it belongs on the same hairline.
    if (data.type === 'progress') { noteProgress(data.message ?? ''); return; }
    if (data.type === 'environment') { applyEnvironment(data.environment); return; }
    if (data.type === 'removed') {
      // Entries whose source file vanished are dropped by the backend; say so rather than silently shrinking the list.
      toast(tr('removedMissing', { count: data.count ?? 0, names: (data.names ?? []).join(', ') }), 'warning');
      return;
    }
    if (data.type === 'changed') {
      // Re-filing one document patches that single row: the list keeps its scroll position and
      // never blanks. Everything else the backend reports — an import, a deletion, a tag rename —
      // still reloads it, because a row can have appeared or disappeared anywhere.
      if (data.change?.kind === 'tagToggle') {
        applyTags(data.tags ?? [], false);
        patchTagToggle(String(data.change.documentId ?? ''), data.change.tags ?? []);
        // Catalogue counts also cover changes outside the loaded window. All sources keeps its
        // total: adding/removing a tag cannot add/remove a document (nor may multi-tag counts be summed).
        if (selectedTag !== null) total = tags.find((tag) => tag.id === selectedTag)?.count ?? total;
        byId('count').textContent = tr('totalFiles', { count: total });
        byId('list-end').textContent = docs.length < total ? tr('loaded', { shown: docs.length, total }) : '';
        if ((byId('search-dialog') as HTMLDialogElement).open) queueSearch();
        return;
      }
      applyTags(data.tags ?? []);
      resetPage();
      if ((byId('search-dialog') as HTMLDialogElement).open) queueSearch();
      return;
    }
    const transfer = data.requestId && transfers.get(data.requestId);
    if (transfer) {
      clearTimeout(transfer.timer); transfers.delete(data.requestId!);
      if (data.type === 'error') transfer.reject(new Error(data.error ?? 'File import failed.'));
      else transfer.resolve(data);
      return;
    }
    const task = data.requestId && pending.get(data.requestId);
    if (!task) return;
    pending.delete(data.requestId!);
    if (task.type === 'search' && task.epoch !== searchEpoch) return;
    if ((task.type === 'page' || task.type === 'locate') && task.epoch !== pageEpoch) return;
    if (data.type === 'error') {
      loadingPage = false;
      byId('list-end').textContent = '';
      if (task.type === 'backup') backingUp = false;
      if (task.type === 'backup' || task.type === 'libraryAction' || task.type === 'libraryReveal') setLibraryBusy(false);
      toast(data.error ?? '', 'error'); return;
    }
    switch (data.type) {
      case 'tags':
        applyTags(data.tags ?? []);
        applyLibrary(data.library);
        applyEnvironment(data.environment);
        break;
      case 'environmentHelpOpened':
        // The chat opens in front of this page, so the hand-off speaks for itself.
        break;
      case 'library':
        applyLibrary(data.library);
        break;
      case 'syncDone': {
        setLibraryBusy(false);
        const sync = data.sync ?? { updated: [], removed: [], unchanged: 0, unreachable: [], failed: [] };
        const changed = sync.updated.length + sync.removed.length;
        // Every recorded source lands in one of these buckets, so an empty total means the library
        // simply has no source files to follow up on — not that everything is up to date.
        const tracked = changed + sync.unchanged + sync.unreachable.length + sync.failed.length;
        const details: string[] = [];
        if (!tracked) details.push(tr('syncNoSources'));
        else if (changed > 0) details.push(tr('syncDone', { updated: sync.updated.length, removed: sync.removed.length, unchanged: sync.unchanged }));
        else if (!sync.unreachable.length) details.push(tr('syncIdle'));
        if (sync.unreachable.length) details.push(tr('syncUnreachable', { count: sync.unreachable.length }));
        if (sync.failed.length) details.push(tr('syncFailed', { count: sync.failed.length }));
        toast(details.join(' '), sync.failed.length || sync.unreachable.length ? 'warning' : 'success');
        if (changed) { request('tags'); resetPage(); }
        break;
      }
      case 'libraryRevealed':
        setLibraryBusy(false); break;
      case 'libraryCanceled':
        setLibraryBusy(false); break;
      case 'libraryDone': {
        setLibraryBusy(false);
        applyLibrary(data.library);
        // A switched library can still point at files that are not on this disk any more.
        const missing = data.verified?.missing ?? 0;
        // An empty outgoing library makes a copy read as a plain new library.
        const before = data.verified?.before;
        const wasEmpty = !before || (before.documents === 0 && before.tags === 0);
        const key = data.mode === 'open' ? 'libraryDoneOpen' : wasEmpty ? 'libraryDoneCreate' : 'libraryDoneMove';
        const details = [tr(key, { path: data.library?.root ?? '', previous: data.previousRoot ?? '' })];
        if (missing > 0) details.push(tr('libraryMissing', { missing }));
        toast(details.join(' '), missing > 0 ? 'warning' : 'success');
        // The listing, counts and tags all belong to the previous directory.
        request('tags');
        resetPage();
        break;
      }
      case 'backupCanceled':
        backingUp = false; setLibraryBusy(false); break;
      case 'backupDone':
        backingUp = false; setLibraryBusy(false);
        toast(tr((data.missing ?? 0) > 0 ? 'backupPartial' : 'backupDone', {
          count: data.count ?? 0, missing: data.missing ?? 0, path: data.path ?? '',
        }), (data.missing ?? 0) > 0 ? 'warning' : 'success');
        break;
      case 'tagCreated':
        // The inline row closes itself; an error keeps it open so the name can be fixed.
        creatingTag = false;
        if (data.tag) { selectedTag = data.tag.id; tags.push(data.tag); renderTags(); resetPage(); }
        break;
      case 'page': {
        const container = byId('documents-scroll');
        const oldHeight = container.scrollHeight;
        const offset = data.offset ?? 0;
        const mode = task.mode ?? 'replace';
        if (mode === 'replace' || mode === 'locate') { docs = data.documents ?? []; beforeOffset = offset; nextOffset = offset + docs.length; container.scrollTop = 0; }
        else if (mode === 'prepend') { docs = [...(data.documents ?? []), ...docs]; beforeOffset = offset; }
        else { docs = [...docs, ...(data.documents ?? [])]; nextOffset = offset + (data.documents?.length ?? 0); }
        total = data.total ?? 0; loadingPage = false;
        renderDocs(data.focusId);
        if (mode === 'prepend') container.scrollTop += container.scrollHeight - oldHeight;
        if (mode === 'locate') (byId('search-dialog') as HTMLDialogElement).close();
        break;
      }
      case 'matches': renderMatches(data.matches ?? []); break;
      // The file manager window is its own confirmation, so there is nothing to report.
      case 'revealed': break;
    }
  });
  resetPage(); request('ready');
  byId('new-tag').addEventListener('click', startTagCreate);
  byId('onboard-retry').addEventListener('click', () => {
    if (environment) renderEnvironment({ ...environment, running: true });
    request('environmentInstall');
  });
  byId('onboard-help').addEventListener('click', () => {
    toast(tr('onboardHelpOpening'), 'info');
    request('environmentHelp');
  });
  // One button, one decision — on the setup screen and in the library menu alike: the backend
  // inspects the chosen folder, opens the library it finds there, or copies the current one into
  // an empty folder.
  for (const id of ['onboard-library-action', 'library-location']) {
    byId(id).addEventListener('click', () => {
      if (libraryBusy || backingUp) return;
      setMenu(false);
      setLibraryBusy(true, tr('libraryWorking'));
      request('libraryAction', { mode: 'choose' });
    });
  }
  byId('library-environment').addEventListener('click', () => {
    if (libraryBusy || backingUp) return;
    setMenu(false);
    environmentAutoStarted = true;
    if (environment) renderEnvironment({ ...environment, running: true });
    renderEnvironmentMenu();
    request('environmentInstall');
  });
  const picker = byId('file-input') as HTMLInputElement;
  byId('add').addEventListener('click', () => picker.click());
  // The library lives behind one compact footer button plus an overflow menu.
  byId('library-menu-button').addEventListener('click', (event) => {
    event.stopPropagation();
    if (libraryBusy) return;
    setMenu(!menuOpen());
  });
  document.addEventListener('click', (event) => {
    if (!menuOpen()) return;
    const target = event.target as Node | null;
    if (target && byId('library-menu').contains(target)) return;
    if (target && byId('library-menu-button').contains(target)) return;
    setMenu(false);
  });
  byId('library-menu').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { setMenu(false); byId('library-menu-button').focus(); }
  });
  byId('library-reveal').addEventListener('click', () => {
    if (libraryBusy) return;
    setMenu(false);
    setLibraryBusy(true);
    request('libraryReveal');
  });
  byId('backup').addEventListener('click', () => {
    if (backingUp || libraryBusy) return;
    setMenu(false);
    backingUp = true; setLibraryBusy(true, tr('backupWorking'));
    request('backup');
  });
  byId('sync').addEventListener('click', () => {
    if (libraryBusy || backingUp) return;
    setMenu(false);
    setLibraryBusy(true, tr('syncWorking'));
    request('sync');
  });
  picker.addEventListener('change', () => { const files = Array.from(picker.files ?? []); picker.value = ''; void importFiles(files); });
  const isFileDrag = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  document.addEventListener('dragenter', (event) => { if (isFileDrag(event)) { event.preventDefault(); document.body.classList.add('dragging-file'); } });
  document.addEventListener('dragover', (event) => { if (isFileDrag(event)) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; } });
  document.addEventListener('dragleave', (event) => { if (!event.relatedTarget) document.body.classList.remove('dragging-file'); });
  document.addEventListener('drop', (event) => { if (!isFileDrag(event)) return; event.preventDefault(); document.body.classList.remove('dragging-file'); void importFiles(Array.from(event.dataTransfer?.files ?? [])); });
  (byId('sort') as HTMLSelectElement).addEventListener('change', (event) => {
    sort = (event.target as HTMLSelectElement).value as typeof sort;
    updateSortSizer();
    resetPage();
  });
  byId('documents-scroll').addEventListener('scroll', () => {
    if (loadingPage || total <= docs.length) return;
    const view = byId('documents-scroll');
    if (view.scrollTop < 80 && beforeOffset > 0) page(Math.max(0, beforeOffset - 50), 'prepend');
    else if (view.scrollTop + view.clientHeight > view.scrollHeight - 180 && nextOffset < total) page(nextOffset, 'append');
  });
  const dialog = byId('search-dialog') as HTMLDialogElement;
  byId('browse').addEventListener('click', () => { updateScope(); dialog.showModal(); (byId('query') as HTMLInputElement).focus(); queueSearch(); });
  // The palette has no close button: Escape and a click on the backdrop both dismiss it.
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  byId('query').addEventListener('input', queueSearch);
  dialog.addEventListener('keydown', (event) => {
    if (!matches.length) return;
    // Enter while an IME candidate list is open belongs to the IME, not to this list.
    if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      const row = matches[activeMatch < 0 ? 0 : activeMatch];
      if (row) locateMatch(row);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    moveActiveMatch(event.key === 'ArrowDown' ? 1 : -1);
  });
  dialog.addEventListener('close', () => { if (debounce !== undefined) clearTimeout(debounce); searchEpoch++; });
} else { status(tr('unavailable'), true); void localeChanged(navigator.language || 'en-US'); }

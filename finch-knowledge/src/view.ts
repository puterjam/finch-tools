import type * as finch from 'finch';
import { Cpu, EyeOff, Archive, Check, Circle, CircleAlert, CircleCheck, createElement, ChevronRight, Folder, EllipsisVertical, Settings, Files, FolderInput, FolderOpen, FolderPlus, HardDrive, Loader, PenLine, Plus, RefreshCw, Search, Tag as TagIcon, Trash2, TriangleAlert, X } from 'lucide';
import type { IconNode } from 'lucide';
import { highlightTerms, snippetParts } from './snippet.js';
import { openListedDocument } from './preview.js';
import { inScope } from './scope.js';
import type { DocumentState } from './document-status.js';
import { createSortMenu, type SortOrder } from './sort-menu.js';
import { wireWorkspaceResize } from './workspace-resize.js';
import { createColorSurface } from './color-picker.js';
import { wireScrollbars } from './scrollbars.js';
import { isLibraryScoped } from './library-scope.js';
import type { LibraryRecord } from './libraries.js';
import type {LibraryState,LibraryStateRow} from './library-availability.js';
type LibraryChoice=LibraryRecord&{availability?:LibraryState};

type Bridge = finch.WebviewBridgeApi;
declare global { interface Window { finch: Bridge } }
interface Document { file_id?:string; source_revision?:number; issueKind?: 'pending' | 'unsupported' | 'failed' | 'empty_file' | 'no_text' | 'image_no_text' | 'unavailable'; size_bytes?: number | null; modified_at?: number | null; file_type?: string; id: string; name: string; path: string; tags: string[]; chunks: number; added_at: number; indexed_at: number; indexState?: 'indexed' | 'partial' | 'missing' | 'unavailable'; indexedChunks?: number | null; status?: DocumentState; statusReason?: string }
interface Tag { id: string; name: string; count: number; color?: string }
interface IndexedDirectory { path: string; parent: string | null; name: string; count: number }
interface Match { document_id: string; name: string; path: string; tag_id: string; chunk: number; text: string; matched?: string[] }
interface LibraryInfo { availabilityEpoch?:string;availabilityVersion?:number; indexStorage?: 'source' | 'local'; indexRoot?: string; version?: number; name?: string; activeId?: string; libraries?: LibraryChoice[]; entered?: boolean; selected?: boolean; root: string; isDefault: boolean; documents: number; tags: number; unavailable: string | null }
interface EnvironmentStep { id: string; status: 'pending' | 'running' | 'ready' | 'failed'; optional?: boolean; lazy?: boolean; message?: string; percent?: number; detail?: string; error?: string }
interface EnvironmentState { running: boolean; ready: boolean; usable: boolean; steps: EnvironmentStep[]; startedAt?: number; finishedAt?: number }
interface Reply { id?:string;availabilityEpoch?:string;availabilityVersion?:number;states?:LibraryStateRow[];warning?:string; nextCursor?:string; previousCursor?:string; catalogVersion?:number; preferences?: { hideUnsupported: boolean }; paused?: boolean; scanning?: boolean; issuesTotal?: number; type: string; libraryVersion?: number; directories?: IndexedDirectory[]; percent?: number; root?: string; phase?: 'processing' | 'settled'; version?: number; document?: Document; requestId?: string; tags?: Tag[]; tag?: Tag; documents?: Document[]; total?: number; offset?: number; focusId?: string; matches?: Match[]; error?: string; message?: string; unchanged?: number; path?: string; count?: number; missing?: number; library?: LibraryInfo; mode?: string; previousRoot?: string; environment?: EnvironmentState; sessionId?: string; names?: string[]; change?: { kind?: string; documentId?: string; tags?: string[] }; sync?: { paused?: boolean; updated: string[]; removed: string[]; unchanged: number; unreachable: string[]; failed: Array<{ name: string; reason: string }>; skipped?: Array<{ name: string; reason: string }>; moved?: string[] } }
type Copy = Record<string, string>;
const english: Copy = {
  scanPause: 'Pause indexing', scanPauseHint: 'Pause after the current file. Existing indexes remain searchable.', scanPausing: 'Pausing…', scanPaused: 'Indexing paused; completed files remain searchable.',
  directoriesTitle: 'SOURCE FOLDERS', directoriesHint: 'Counts show unique files, including unsupported and failed files. All sources includes root-level files; issues are a cross-folder filter, not an additional folder.', tagColor: 'Tag color',
  sourceIssues: 'Not indexed / issues', sourceIssuesEmpty: 'No unindexed or failed files in this scope.', sourceIssuesHint: 'Reasons appear in the Index status column. Originals stay untouched; scan again to retry.',
  issueUnsupported: 'Unsupported format', issueFailed: 'Cannot parse', issueEmpty: 'Empty file', issueNoText: 'No searchable text', issueImageNoText: 'No text recognized', issueUnavailable: 'Temporarily unavailable',
  emptyFolderTitle: 'No indexed documents in this folder', emptyFolderHint: 'Empty folders remain visible. Check Not indexed / issues for unsupported or unrecognized files.',
  filterByTag: 'Show sources tagged {tag}', scanIssuesClear: 'Clear notices',
  sortModified: 'Date modified', sortType: 'Type', sortSize: 'Size', columnStatus: 'Index status', fileGeneric: 'File',
  'fileType.md': 'Markdown', 'fileType.txt': 'Text document', 'fileType.doc': 'Word document', 'fileType.docx': 'Word document', 'fileType.xls': 'Excel workbook', 'fileType.xlsx': 'Excel workbook', 'fileType.ppt': 'PowerPoint presentation', 'fileType.pptx': 'PowerPoint presentation', 'fileType.pdf': 'PDF document',
  'fileType.png': 'PNG image', 'fileType.jpeg': 'JPEG image', 'fileType.webp': 'WebP image', 'fileType.bmp': 'Bitmap image', 'fileType.tiff': 'TIFF image',
  resizeSidebar: 'Drag to resize the sidebar. Double-click to reset; arrow keys also resize.',
  directoriesEmpty: 'Source folders appear here after scanning.', tagsEmpty: 'No tags yet. Use + to create one.',
  colorPlane: 'Saturation and brightness; arrow keys adjust each axis.', colorHue: 'Hue', colorValue: 'Saturation {s}%, brightness {v}%.',
  colorHint: 'Drag the color plane or hue strip, or enter a HEX value.', colorInvalid: 'Enter a color such as #5393d8.', colorReset: 'Default', colorCancel: 'Cancel', colorSave: 'Save',
  'tagColor.red': 'Red', 'tagColor.orange': 'Orange', 'tagColor.yellow': 'Yellow', 'tagColor.green': 'Green', 'tagColor.blue': 'Blue', 'tagColor.purple': 'Purple', 'tagColor.gray': 'Gray',
  libraryNameLabel:'Knowledge base name',libraryNameHint:'Enter to save; Esc to cancel.',libraryNameInvalid:'Use a name of 1–60 characters.',librarySave:'Save name',libraryCancel:'Cancel rename',
  'libraryState.unknown':'Unknown','libraryState.checking':'Checking','libraryState.available':'Available','libraryState.offline':'Offline','libraryState.unavailable':'Unavailable',
  'libraryStateHint.unknown':'Not checked yet.','libraryStateHint.checking':'Checking the source folder in the background.','libraryStateHint.available':'The source folder is accessible; index readiness is separate.','libraryStateHint.offline':'The source folder or original share is disconnected or missing.','libraryStateHint.unavailable':'Access could not be verified. Check permissions, network or the share mapping.',
  renameLibrary:'Rename {name}',removeLibrary:'Remove {name}',libraryRenamed:'Knowledge base renamed.',libraryRemoved:'Knowledge base removed. Source files are unchanged.',
  openDirectory: 'Open source folder', directoryOpen: 'Open folder', preferences: 'Preferences', hideUnsupported: 'Hide unsupported files', librarySettings: 'Library settings',
  emptyTitle: 'No searchable documents yet',
  emptyHint: 'Place documents in the source folder, then use Scan and update at the top right. Originals stay untouched.',
  emptyDirectory: 'Source folder', emptyStepFiles: 'Add source files', emptyStepScan: 'Scan and update', emptyStepTags: 'Organize with tags',
  emptyTypes: 'Markdown, text, Word, Excel, PowerPoint, PDF and images',
  emptyCategoryTitle: 'No documents in {tag} yet', emptyCategoryHint: 'Browse All sources and add this tag to documents. Tags never move files.',
  emptyScanningTitle: 'Checking your source folder', emptyScanningHint: 'Comparing file content and preparing indexes. Documents will appear here as the scan completes.',
  emptyLoadingTitle: 'Loading your documents', emptyLoadingHint: 'Reading the index. Your source files are unchanged.',
  statusProcessing: 'Processing', statusReady: 'Indexed', statusOutdated: 'Update needed', statusPending: 'Index needed',
  statusIncomplete: 'Incomplete index', statusFailed: 'Processing failed', statusSourceMissing: 'Source missing', statusSourceUnavailable: 'Unavailable', statusUnverified: 'Not checked',
  statusProcessingHint: 'Processing this file. Existing searchable passages are retained until the update succeeds.',
  statusReadyHint: 'The source matches the complete index and can be searched.',
  statusOutdatedHint: 'The original has changed. Scan and update before relying on its indexed content.',
  statusPendingHint: 'No usable index exists for this version. Scan and update to build it.',
  statusIncompleteHint: 'Some passages are missing. Scan and update to repair the index.',
  statusFailedHint: 'The last processing attempt failed. Existing indexed content is retained; fix the cause and scan again.',
  statusSourceMissingHint: 'The original file is missing. The next scan will confirm and reconcile its entry.',
  statusSourceUnavailableHint: 'The source or its directory cannot currently be accessed. Its previous index is retained.',
  statusUnverifiedHint: 'Index availability could not be checked. Retry when the runtime is ready.',
  statusCoverage: 'Indexed passages: {actual}/{expected}.', statusReason: 'Reason: {reason}',
  heading: 'Your knowledge, within reach.', intro: 'Index on this device. AI answers may send retrieved passages to your selected model.',
  browse: 'Browse passages', add: 'Index directory files',
  dropHint: 'Files stay in place · Added to {tag}.',
  tagsTitle: 'TAGS', tagRequired: 'Enter a tag name.', newTag: 'New tag', renameTag: 'Rename tag', deleteTag: 'Delete tag',
  all: 'All sources', unclassified: 'Untagged', librarySubtitle: 'Browse and organize your local material.', totalFiles: '{count} files', sortLabel: 'Sort by', sortUpdated: 'Last indexed', sortAdded: 'Date added', sortName: 'File name',
  searchLabel: 'Search your own sources', searchPlaceholderIn: 'Search in {tag}…',
  empty: 'Place documents in the source folder, then scan and update. Tags never move your files.', emptyMatches: 'No matching content. Try different keywords.', searchHint: 'Enter keywords to search your sources.', loading: 'Loading…', loaded: 'Showing {shown} of {total}',
  remove: 'Remove', removeTitle: 'Remove this source?', removeMessage: 'Remove only the index, never the file. Automatic scans skip it; select it to index again.', reveal: 'Show in file manager', preview: 'Preview', locate: 'Locate in file list', move: 'Change tags',
  menuReveal: 'Open in file manager', menuClassify: 'Tags',
  tagDeleteTitle: 'Delete this tag?', tagDeleteMessage: 'Only this tag is removed. Documents keep their other tags; source files and indexes are unchanged.', tagPlaceholder: 'New tag · Enter', tagHint: 'Enter to create · Esc to cancel', chunk: 'passages', added: 'Added {date}', updated: 'Indexed {date}',
  complete: 'Indexed {count} file(s).', completeUnchanged: 'Indexed {count} file(s); {unchanged} unchanged.', failed: 'Failed: {details}', unavailable: 'Finch bridge is unavailable.',
  unsupported: 'Unsupported file type', tooLarge: 'File must be between 1 byte and {max} MB', reading: 'Reading {name}…', uploading: 'Importing {name} ({percent}%)…', externalSource: 'Outside the library: {path}',
  syncLabel: 'Scan directory and update index', syncWorking: 'Refreshing changed sources…', syncDone: 'Refreshed: {updated} updated, {removed} removed, {unchanged} unchanged.', syncIdle: 'Nothing to refresh: every source file is unchanged.',
  syncUnreachable: '{count} source file(s) cannot be reached right now; their indexes were kept.', syncFailed: '{count} source file(s) could not be refreshed.',
  syncFinished: 'Scan finished.', syncDetails: 'Use the warning button beside Scan and update for individual notices.',
  syncSkipped: 'Skipped {count}: {reasons}.', syncSkippedEmpty: '{count} empty file(s)', syncSkippedImage: '{count} image(s) with no recognized text', syncSkippedNoText: '{count} file(s) with no searchable text', syncMoved: 'Followed {count} moved file(s).',
  scanIssueEmpty: 'Empty file; skipped without changing the original.', scanIssueImageNoText: 'No text was recognized in this image; skipped without changing the original.',
  scanIssuesTitle: 'Scan notices ({count})', scanIssuesButton: 'View scan notices ({count})', scanIssueNoText: 'No searchable text; skipped without changing the original.',
  scanIssueSize: 'The file is empty or exceeds the size limit. Choose a nonempty file smaller than {max} MB.', scanIssueUnreachable: 'The source cannot be reached right now. Its existing index was kept.',
  engineNeeded: 'Importing this needs {name}. Its installation just started in the background — drop it again once it is ready.',
  syncNoSources: 'No indexable sources. Place supported files in the directory, then scan again.',
  syncHint: 'Compare SHA-256 hashes: index new or changed files, skip unchanged content, repair missing passages. Clean confirmed missing entries and retain unreadable sources. Skip .knowledge and hidden files.',
  libraryLocation: 'Add knowledge base…', libraryEnvironment: 'Check runtime',
  librariesTitle: 'Knowledge bases',
  libraryNoteRemote: 'Remote sources are read only. This knowledge base keeps its own index and tags on this computer.',
  libraryDoneRemote: 'Opened {path}. Its independent index and tags stay on this computer.',
  libraryDoneSwitch: 'Switched to {name}. Searches use only this knowledge base.',
  onboardChooseTitle: 'Choose your source directory first',
  onboardChooseIntro: 'Choose an empty or populated directory. Local libraries use .knowledge; mounted network libraries keep independent indexes on this computer.',
  directoryDropHint: 'Place files in the source directory, then scan. Files are never copied or moved.',
  onboardTitle: 'Prepare your knowledge base',
  onboardEnter: 'Enter Knowledge Base',
  onboardLibraryTitle: 'Library location',
  onboardLibraryDefault: 'Default location',
  onboardLibraryChosen: 'Custom location',
  onboardLibraryUnavailable: 'Unavailable',
  onboardLibraryAction: 'Choose location…',
  onboardLibraryHint: 'Local directories use .knowledge. Mounted network directories keep their indexes on this computer.',
  onboardIntro: 'Search and document engines prepare automatically. OCR loads in the background on the first image. Choose your directory to enter once the required engines are ready.',
  onboardLancedb: 'Vector search (LanceDB)', onboardAnydoc: 'Office & PDF reading (AnyDoc)', onboardOcr: 'Image text recognition (OCR)',
  onboardOnDemand: 'on demand', onboardOcrHint: 'Prepared in the background when the first image is processed; does not block entry.',
  onboardPending: 'waiting', onboardRunning: 'installing', onboardReady: 'ready', onboardFailed: 'failed',
  onboardWorking: 'Working…',
  onboardRetry: 'Retry setup', onboardHelp: 'Ask the assistant to fix it',
  engineOcr: 'image text recognition (OCR)', engineAnydoc: 'document parsing (AnyDoc)',
  onboardOptionalFailed: 'Background preparation failed for {name}. Retry by processing an image again; see the document status for details.',
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
  libraryNote: 'Each knowledge base keeps its own index and tags. Search uses only the current one.',
  libraryDefault: 'Using the default folder inside Finch.',
  libraryUnavailable: 'The saved library folder is unavailable: {path}',
  libraryWorking: 'Working on the library folder…',
  libraryDoneCreate: 'Selected {path}. Index data lives in .knowledge; checking sources in the background.',
  libraryDoneOpen: 'Opened {path}; checking sources incrementally in the background.',
  libraryMissing: '{missing} stored source file(s) could not be found.',
  menu: 'Library actions',
};
const DEFAULT_TAG = 'default';
/** How many category badges a row shows before it summarises the rest as "+N". */
const MAX_ROW_BADGES = 3;
const byId = (id: string) => document.getElementById(id)!;
const bridge = window.finch;
let copy = english;
let tags: Tag[] = [];
let docs: Document[] = [];
let showIssues = false;
let issuesTotal = 0;
let selectedTag: string | null = null;
let selectedDirectory: string | null = null;
let directories: IndexedDirectory[] = [];
const expandedDirectories = new Set<string>();
let colorEditingTag: string | null = null;
const TAG_TONES: Record<string, string> = { red: '#ec635d', orange: '#ed9b43', yellow: '#d6b62c', green: '#55ad70', blue: '#5393d8', purple: '#a27bce', gray: '#92969d' };
let sort: SortOrder = 'updated';
let sortDescending: boolean | undefined;
function currentDescending(): boolean { return sortDescending ?? (sort !== 'name' && sort !== 'type'); }
let sortControl: ReturnType<typeof createSortMenu> | undefined;
let total = 0;
let beforeOffset = 0;
let nextOffset = 0;
let nextCursor: string | undefined;
let previousCursor: string | undefined;
let catalogVersion = -1;
let loadingPage = false;
let pageEpoch = 0;
let searchEpoch = 0;
let sequence = 0;
let scanBusy = false;
let pauseRequested = false;
let scanPercent: number | null = null;
const documentStatusVersions = new Map<string, number>();
let environment: EnvironmentState | null = null;
let environmentAutoStarted = false;
let libraryEntered = false;
let libraryPath = '';
let libraryName = '';
let libraryIndexStorage: 'source' | 'local' = 'source';
let libraryVersion = -1;
let activeLibraryId = '';
let libraryEntries: LibraryChoice[] = [];
let availabilityEpoch='',availabilityVersion=-1;
let availabilityTimer:ReturnType<typeof setInterval>|undefined;
let editingLibrary:{id:string;value:string;saving:boolean;error?:string}|undefined;
const libraryStatusFingerprint=(record:LibraryRecord)=>JSON.stringify([record.root,record.index??null]);
let libraryDefault = false;
let libraryUnavailable = '';
let libraryBusy = false;
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
const pending = new Map<string, { type: string; root?: string; version?: number; epoch: number; mode?: 'replace' | 'append' | 'prepend' | 'locate' | 'refresh' }>();
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
 * Office icons are from vscode-icons; their MIT license ships beside the assets.
 */
const FILE_ICONS: Array<{ extensions: string[]; icon: string }> = [
  { extensions: ['.md', '.markdown'], icon: 'markdown_auto.svg' },
  { extensions: ['.txt'], icon: 'text_auto.svg' },
  { extensions: ['.doc', '.docx'], icon: 'word.svg' },
  { extensions: ['.xls', '.xlsx'], icon: 'excel.svg' },
  { extensions: ['.ppt', '.pptx'], icon: 'powerpoint.svg' },
  { extensions: ['.pdf'], icon: 'pdf.svg' },
  { extensions: ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'], icon: 'image_auto.svg' },
];
function iconForFile(name: string): string {
  const extension = `.${name.split('.').pop()?.toLowerCase() ?? ''}`;
  return FILE_ICONS.find((entry) => entry.extensions.includes(extension))?.icon ?? 'file.svg';
}
/**
 * Both native notifications and their page fallback appear at the top center.
 * Scan completion can outlive the initiating gesture, so the fallback must behave identically.
 */
let toastVersion = 0;
let fallbackToastTimer: number | undefined;
function status(message: string, error = false): void { byId('status').textContent = message; byId('status').classList.toggle('error', error); }
function toast(message: string, variant: 'default' | 'success' | 'info' | 'warning' | 'error' = 'default'): void {
  if (!message) return;
  const version = ++toastVersion;
  if (fallbackToastTimer !== undefined) clearTimeout(fallbackToastTimer);
  fallbackToastTimer = undefined; status('');
  const fallback = (): void => {
    if (version !== toastVersion) return;
    status(message, variant === 'error');
    fallbackToastTimer = window.setTimeout(() => {
      if (version === toastVersion) { status(''); fallbackToastTimer = undefined; }
    }, variant === 'error' ? 7000 : 5000);
  };
  if (bridge?.ui?.toast) {
    void bridge.ui.toast({ title: message, variant, position: 'TC' }).catch(fallback);
    return;
  }
  fallback();
}
/** The footer hairline belongs exclusively to source scans, never environment or directory checks. */
function activityNow(): { label: string; percent: number | null } | null {
  if (!scanBusy) return null;
  return { label: streamedProgress || tr('syncWorking'), percent: scanPercent };
}
function updateScanProgress(percent?: number, message?: string): void {
  if (!scanBusy) return;
  if (typeof percent === 'number' && Number.isFinite(percent)) scanPercent = Math.max(scanPercent ?? 0, Math.max(0, Math.min(100, percent)));
  if (message) noteProgress(message); else renderActivity();
}
/** A progress push means work is still happening; a quiet gap means it finished. */
function noteProgress(message: string): void {
  if (!scanBusy) return;
  streamedProgress = message;
  if (streamedTimer !== undefined) clearTimeout(streamedTimer);
  streamedTimer = window.setTimeout(() => {
    streamedProgress = '';
    streamedTimer = undefined;
    renderActivity();
  }, STREAM_QUIET_MS);
  renderActivity();
}
function renderActivity(): void {
  const bar = byId('activity') as HTMLElement;
  const current = activityNow();
  bar.hidden = current === null;
  if (!current) return;
  bar.title = current.label;
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', current.label);
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  if (current.percent === null) bar.removeAttribute('aria-valuenow');
  else bar.setAttribute('aria-valuenow', String(Math.round(current.percent)));
  bar.classList.toggle('indeterminate', current.percent === null);
  (byId('activity-fill') as HTMLElement).style.width = current.percent === null
    ? '30%'
    : `${Math.max(0, Math.min(100, current.percent))}%`;
}
/** The menu row doubles as the download readout: a spinning icon and the component in flight. */
function renderEnvironmentMenu(): void {
  const button = byId('library-environment');
  const detail = byId('library-environment-detail');
  const step = environment?.running ? environment.steps.find((item) => item.status === 'running') : undefined;
  button.classList.toggle('spinning', Boolean(step));
  button.querySelector('svg')?.replaceWith(svg(step?Loader:Cpu));
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
  const staticIcons: Record<string, IconNode> = {cpu:Cpu,'eye-off':EyeOff, search: Search, settings: Settings, check: Check, plus: Plus, x: X, archive: Archive, 'folder-input': FolderInput, 'folder-plus': FolderPlus, 'folder-open': FolderOpen, 'hard-drive': HardDrive, 'ellipsis-vertical': EllipsisVertical, 'refresh-cw': RefreshCw, 'triangle-alert': TriangleAlert, tag: TagIcon, trash: Trash2 };
  for (const placeholder of document.querySelectorAll<HTMLElement>('[data-icon]')) {
    const iconNode = staticIcons[placeholder.dataset.icon ?? ''];
    if (iconNode) placeholder.replaceWith(svg(iconNode));
  }
}
function request(type: string, payload: Record<string, unknown> = {}, mode?: 'replace' | 'append' | 'prepend' | 'locate' | 'refresh'): string {
  const requestId = String(++sequence);
  const root = isLibraryScoped(type) && libraryPath ? libraryPath : undefined;
  const version = root && libraryVersion >= 0 ? libraryVersion : undefined;
  pending.set(requestId, { type, mode, root, version, epoch: type === 'search' ? searchEpoch : pageEpoch });
  bridge.postMessage({ type, requestId, ...(root ? { libraryRoot: root } : {}), ...(version !== undefined ? { libraryVersion: version } : {}), ...payload });
  return requestId;
}
function page(offset: number, mode: 'replace' | 'append' | 'prepend' = 'replace'): void {
  if (loadingPage) return;
  loadingPage = true;
  byId('list-end').textContent = tr('loading');
  if (!docs.length) renderDocs();
  const cursor=mode==='append'?nextCursor:mode==='prepend'?previousCursor:undefined;
  request('page', { ...(showIssues ? { issues: true } : {}), ...(cursor?{cursor,before:mode==='prepend'}:{}), tagId: selectedTag, directory: selectedDirectory, sort, descending: currentDescending(), offset }, mode);
}
let refreshQueued = false;
function visibleAnchor(): { path?: string; index: number; top: number } {
  const container = byId('documents-scroll');
  const edge = container.getBoundingClientRect().top;
  const row = Array.from(byId('documents').children).find(item => (item as HTMLElement).dataset.path && item.getBoundingClientRect().bottom > edge) as HTMLElement | undefined;
  return { path: row?.dataset.path, index: row ? Math.max(0, docs.findIndex(doc => doc.path === row.dataset.path)) : 0, top: row ? row.getBoundingClientRect().top - edge : 0 };
}
/** Keep the current window visible while a bounded snapshot is fetched in the background. */
function refreshPage(): void {
  if (loadingPage) { refreshQueued = true; return; }
  refreshQueued = false; loadingPage = true;
  const anchor = visibleAnchor();
  request('page', { refresh: true, anchorPath: anchor.path, anchorIndex: anchor.index, limit: Math.max(50, docs.length), offset: beforeOffset,
    ...(showIssues ? { issues: true } : {}), tagId: selectedTag, directory: selectedDirectory, sort, descending: currentDescending() }, 'refresh');
}
function resetPage(): void {
  refreshQueued = false;
  pageEpoch++;
  loadingPage = false;
  docs = []; total = 0; beforeOffset = 0; nextOffset = 0;nextCursor=previousCursor=undefined;catalogVersion=-1;
  renderDocs();
  page(0);
}
/**
 * Adopts a fresh tag list. `list: false` skips the list rebuild, for a change that patches a
 * single row instead — the left column still needs its new counts either way.
 */
function applyTags(next: Tag[], list = true): void {
  const changed = JSON.stringify(tags.filter(tag => tag.id !== DEFAULT_TAG)) !== JSON.stringify(next.filter(tag => tag.id !== DEFAULT_TAG));
  tags = next;
  if (selectedTag !== null && selectedTag !== DEFAULT_TAG && !tags.some((tag) => tag.id === selectedTag)) selectedTag = null;
  if (list || changed) renderTags();
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
  editor.append(field);
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
    if (creatingTag || inlineTagEditing !== null || ((event.target as HTMLElement | null)?.closest('.tag-actions') || (event.target as HTMLElement | null)?.closest('.tag-color-trigger'))) {
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
function applyDirectories(next?: IndexedDirectory[]): void {
  if (!next || JSON.stringify(next) === JSON.stringify(directories)) return;
  directories = next;
  if (selectedDirectory !== null && !next.some(item => item.path === selectedDirectory)) selectedDirectory = null;
  renderDirectories();
}
function selectTag(id: string | null): void {
  if (!showIssues && selectedTag === id && selectedDirectory === null) return;
  showIssues = false; updateSortSizer();
  closeTagColor(); selectedDirectory = null; selectedTag = id; inlineTagEditing = null;
  renderDirectories(); renderTags(); resetPage(); updateScope();
}
function selectDirectory(path: string | null): void {
  if (!showIssues && selectedDirectory === path && selectedTag === null) return;
  showIssues = false; updateSortSizer();
  closeTagColor(); selectedDirectory = path; selectedTag = null; inlineTagEditing = null;
  renderDirectories(); renderTags(); resetPage(); updateScope();
}
function selectIssueList(): void {
  showIssues = true; selectedTag = null; selectedDirectory = null; closeRowMenu(); closeTagColor();
  if (sort === 'added' || sort === 'updated') { sort = 'name'; sortDescending = undefined; }
  updateSortSizer();
  renderDirectories(); renderTags(); resetPage(); updateScope();
}
function applyIssueCount(count?: number): void {
  if (count === undefined || count === issuesTotal) return;
  issuesTotal = count; renderDirectories();
}
function directoryOpenButton(directory: string): HTMLButtonElement {
  const button = icon(FolderOpen, tr('directoryOpen'));
  button.classList.add('directory-open');
  button.addEventListener('click', event => { event.stopPropagation(); if (!libraryBusy) request('libraryReveal', { directory }); });
  return button;
}
function renderDirectories(): void {
  const container = byId('directories');
  const scroll = container.scrollTop;
  container.replaceChildren();
  container.setAttribute('aria-label', tr('directoriesTitle'));
  container.title = tr('directoriesHint');
  const heading = byId('directories-title'); heading.textContent = tr('directoriesTitle');
  const all = node('button', 'directory-choice directory-all') as HTMLButtonElement;
  all.type = 'button'; all.classList.toggle('active', !showIssues && selectedTag === null && selectedDirectory === null);
  all.setAttribute('aria-pressed', String(!showIssues && selectedTag === null && selectedDirectory === null));
  all.append(svg(Files), node('span', 'tag-name', tr('all')), node('span', 'tag-count', String(directories.find(item => item.path === '')?.count ?? 0)));
  all.addEventListener('click', () => selectTag(null));
  const allRow = node('div', 'directory-row has-directory-action'); allRow.append(all, directoryOpenButton('')); container.append(allRow);
  const issueChoice = node('button', 'directory-choice directory-issues') as HTMLButtonElement;
  issueChoice.type = 'button'; issueChoice.classList.toggle('active', showIssues); issueChoice.setAttribute('aria-pressed', String(showIssues));
  issueChoice.append(svg(CircleAlert), node('span', 'tag-name', tr('sourceIssues')), node('span', 'tag-count', String(issuesTotal)));
  issueChoice.addEventListener('click', selectIssueList);
  const children = new Map<string, IndexedDirectory[]>();
  for (const entry of directories) if (entry.parent !== null) {
    const group = children.get(entry.parent) ?? []; group.push(entry); children.set(entry.parent, group);
  }
  let sequence = 0;
  const branch = (parent: string): HTMLElement => {
    const list = node('ul', 'directory-list');
    for (const entry of children.get(parent) ?? []) {
      const item = node('li', 'directory-item'), row = node('div', 'directory-row');
      const nested = children.has(entry.path), expanded = expandedDirectories.has(entry.path);
      const childId = `directory-children-${++sequence}`;
      const toggle = node('button', 'directory-toggle') as HTMLButtonElement;
      toggle.type = 'button'; toggle.disabled = !nested;
      toggle.setAttribute('aria-label', entry.name); toggle.setAttribute('aria-expanded', String(expanded));
      if (nested) toggle.setAttribute('aria-controls', childId);
      toggle.append(svg(ChevronRight));
      toggle.addEventListener('click', () => {
        if (expanded) expandedDirectories.delete(entry.path); else expandedDirectories.add(entry.path);
        renderDirectories();
        container.querySelector<HTMLButtonElement>(`[aria-controls="${childId}"]`)?.focus();
      });
      const choice = node('button', 'directory-choice') as HTMLButtonElement;
      choice.type = 'button'; choice.title = entry.path;
      choice.classList.toggle('active', !showIssues && selectedTag === null && selectedDirectory === entry.path);
      choice.setAttribute('aria-pressed', String(!showIssues && selectedTag === null && selectedDirectory === entry.path));
      choice.append(svg(expanded ? FolderOpen : Folder), node('span', 'tag-name', entry.name), node('span', 'tag-count', String(entry.count)));
      choice.addEventListener('click', () => selectDirectory(entry.path));
      row.classList.add('has-directory-action');
      row.append(toggle, choice, directoryOpenButton(entry.path)); item.append(row);
      if (nested) { const sub = branch(entry.path); sub.id = childId; sub.hidden = !expanded; item.append(sub); }
      list.append(item);
    }
    return list;
  };
  const rootList = branch('');
  const builtin = node('li', 'directory-item directory-builtin'), builtinRow = node('div', 'directory-row');
  const spacer = node('span', 'directory-toggle'); spacer.setAttribute('aria-hidden', 'true');
  builtinRow.append(spacer, issueChoice); builtin.append(builtinRow); rootList.append(builtin);
  container.append(rootList);
  if (!children.size) container.append(node('p', 'side-empty', tr('directoriesEmpty')));
  container.scrollTop = scroll;
}
function tagDot(color = 'gray'): HTMLElement {
  const dot = node('span', 'tag-dot'); dot.setAttribute('aria-hidden', 'true');
  dot.style.backgroundColor = TAG_TONES[color] ?? (/^#[0-9a-f]{6}$/i.test(color) ? color : TAG_TONES.gray);
  return dot;
}
let colorAnchor: HTMLElement | null = null;
function closeTagColor(restoreFocus = false): void {
  if (colorEditingTag === null) return;
  byId('tag-color-picker').hidden = true; colorEditingTag = null;
  colorAnchor?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) colorAnchor?.focus({ preventScroll: true });
  colorAnchor = null;
}
/** Opaque custom colors are metadata only; cancel never changes a tag. */
function openTagColor(tag: Tag, anchor: HTMLElement): void {
  if (colorEditingTag === tag.id) { closeTagColor(true); return; }
  closeTagColor(); closeRowMenu();
  colorEditingTag = tag.id; colorAnchor = anchor;
  anchor.setAttribute('aria-expanded', 'true');
  const panel = byId('tag-color-picker');
  const heading = node('h3', '', `${tr('tagColor')} · ${tag.name}`); heading.id = 'tag-color-title';
  const initialHex = TAG_TONES[tag.color ?? 'gray'] ?? (/^#[0-9a-f]{6}$/i.test(tag.color ?? '') ? tag.color! : TAG_TONES.gray!);
  const surface = createColorSurface({ initialHex, label: tr('colorPlane'), hueLabel: tr('colorHue'),
    valueText: (s, v) => tr('colorValue', { s, v }), onChange: value => update(value) });
  const hex = node('input', 'color-hex') as HTMLInputElement;
  hex.type = 'text'; hex.maxLength = 7; hex.spellcheck = false;
  hex.setAttribute('aria-label', 'HEX'); hex.setAttribute('aria-describedby', 'color-message');
  const label = node('label', 'color-hex-label', 'HEX'); label.append(hex);
  const message = node('p', 'color-message', tr('colorHint')); message.id = 'color-message';
  const palette = node('div', 'tag-palette'); palette.setAttribute('role', 'group'); palette.setAttribute('aria-label', tr('tagColor'));
  const actions = node('div', 'color-actions');
  const reset = node('button', 'quiet color-reset', tr('colorReset')) as HTMLButtonElement;
  const cancel = node('button', 'outline', tr('colorCancel')) as HTMLButtonElement;
  const save = node('button', 'primary', tr('colorSave')) as HTMLButtonElement;
  for (const button of [reset, cancel, save]) button.type = 'button';
  const update = (value: string): void => {
    const valid = /^#[0-9a-f]{6}$/i.test(value);
    hex.value = value; hex.setAttribute('aria-invalid', String(!valid)); save.disabled = !valid;
    message.textContent = tr(valid ? 'colorHint' : 'colorInvalid');
    if (valid) surface.setHex(value);
    for (const option of palette.querySelectorAll<HTMLButtonElement>('button')) option.setAttribute('aria-pressed', String(option.dataset.color === value.toLowerCase()));
  };
  for (const [name, value] of Object.entries(TAG_TONES)) {
    const option = node('button', 'tag-color-option') as HTMLButtonElement;
    option.type = 'button'; option.dataset.color = value; option.title = tr(`tagColor.${name}`);
    option.setAttribute('aria-label', option.title); option.append(tagDot(name));
    option.addEventListener('click', () => update(value)); palette.append(option);
  }
  hex.addEventListener('input', () => update(hex.value.trim()));
  reset.addEventListener('click', () => update(TAG_TONES.gray!));
  cancel.addEventListener('click', () => closeTagColor(true));
  save.addEventListener('click', () => {
    if (save.disabled || colorEditingTag !== tag.id) return;
    const value = hex.value.toLowerCase();
    request('tagColor', { id: tag.id, color: value === TAG_TONES.gray ? 'gray' : value }); closeTagColor(true);
  });
  actions.append(reset, cancel, save); panel.replaceChildren(heading, surface.element, label, palette, message, actions);
  update(initialHex);
  placeMenu(panel, anchor.getBoundingClientRect(), 'right'); surface.focus();
}
function wireTagColor(): void {
  const panel = byId('tag-color-picker');
  document.addEventListener('pointerdown', event => {
    const target = event.target as Node;
    if (colorEditingTag !== null && !panel.contains(target) && !colorAnchor?.contains(target)) closeTagColor();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && colorEditingTag !== null) { event.preventDefault(); closeTagColor(true); }
  });
  window.addEventListener('resize', () => closeTagColor());
}
function renderTags(): void {
  const container = byId('tags');
  draggingTag = null;
  const liveEditor = container.querySelector<HTMLInputElement>('.tag-editor input');
  // A re-render while the user is typing would throw away the field they are in.
  if ((inlineTagEditing !== null || creatingTag) && liveEditor && document.activeElement === liveEditor) return;
  container.replaceChildren();
  // Only user-created tags belong here; the create row always leads the list.
  const rows: HTMLElement[] = [];
  for (const tag of tags) {
    const id = tag.id;
    if (id === DEFAULT_TAG || id === 'all') continue;
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
      row.append(editor); rows.push(row); continue;
    }
    const choice = node('button', 'tag-choice') as HTMLButtonElement;
    choice.type = 'button'; choice.setAttribute('aria-pressed', String(selectedTag === id));
    const editableColor = Boolean(id && id !== DEFAULT_TAG);
    const leading = editableColor ? node('span', 'tag-dot-slot') : tagDot(tag.color);
    leading.setAttribute('aria-hidden', 'true');
    choice.append(leading, node('span', 'tag-name', tag.name), node('span', 'tag-count', String(tag.count)));
    choice.addEventListener('click', () => selectTag(id));
    if (editableColor) {
      const trigger = node('button', 'tag-color-trigger') as HTMLButtonElement;
      trigger.type = 'button'; trigger.title = tr('tagColor'); trigger.setAttribute('aria-label', `${tr('tagColor')} · ${tag.name}`);
      trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-expanded', 'false');
      trigger.append(tagDot(tag.color));
      trigger.addEventListener('click', () => openTagColor(tag, trigger)); row.append(trigger);
    }
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
        const root = libraryPath;
        const { confirmed } = await bridge.ui.confirm({ title: tr('tagDeleteTitle'), message: tr('tagDeleteMessage'), variant: 'danger' });
        if (confirmed && root === libraryPath) request('tagDelete', { id });
      });
      actions.append(rename, remove); row.append(actions);
      wireTagDrag(row, id, choice);
    }
    rows.push(row);
  }
  if (creatingTag) rows.unshift(tagCreateRow());
  container.append(...rows);
  if (!creatingTag && !tags.some(tag => tag.id !== DEFAULT_TAG && tag.id !== 'all')) container.append(node('p', 'side-empty', tr('tagsEmpty')));
  if (colorEditingTag !== null) closeTagColor();
  byId('library-title').textContent = tagName(selectedTag);
  updateScope();
}
function updateScope(): void {
  const target = showIssues ? [selectedDirectory, tr('sourceIssues')].filter(Boolean).join(' · ') : selectedDirectory ?? tagName(selectedTag);
  // With no title and no note above it, the field itself says what a search would cover.
  (byId('query') as HTMLInputElement).placeholder = tr('searchPlaceholderIn', { tag: selectedDirectory ?? tagName(selectedTag) });
  byId('library-title').textContent = target;
  byId('library-title').setAttribute('title', target);
}
/** Refresh the themed trigger and menu after a selection or locale change. */
function updateSortSizer(): void {
  sortControl?.refresh(); renderColumnHeaders();
  for (const item of byId('sort-menu').querySelectorAll<HTMLElement>('[data-sort]')) item.hidden = showIssues && ['added', 'updated'].includes(item.dataset.sort ?? '');
}
function sortLabel(value: SortOrder): string { return tr({ updated: 'sortUpdated', added: 'sortAdded', name: 'sortName', modified: 'sortModified', type: 'sortType', size: 'sortSize' }[value]); }
function renderColumnHeaders(): void {
  byId('document-columns').setAttribute('aria-label', tr('sortLabel'));
  for (const value of ['name', 'modified', 'type', 'size'] as const) {
    const button = byId(`column-${value}`); button.textContent = sortLabel(value);
    button.setAttribute('aria-pressed', String(sort === value));
    button.dataset.direction = sort === value ? currentDescending() ? 'descending' : 'ascending' : '';
  }
  byId('column-status-label').textContent = tr('columnStatus');
}
function wireColumns(): void {
  for (const value of ['name', 'modified', 'type', 'size'] as const) byId(`column-${value}`).addEventListener('click', () => {
    sortDescending = sort === value ? !currentDescending() : undefined;
    sort = value; updateSortSizer(); resetPage();
  });
}
function fileSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
  const unit = bytes < 1 ? 0 : Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** unit;
  return `${new Intl.NumberFormat(document.documentElement.lang || 'en', { maximumFractionDigits: unit > 0 && value < 10 ? 1 : 0 }).format(value)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
}
function fileModified(timestamp: number | null | undefined): string {
  if (timestamp == null || !Number.isFinite(timestamp)) return '—';
  return new Date(timestamp).toLocaleString(document.documentElement.lang || 'en', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}
function fileType(doc: Document): string {
  let extension = (doc.file_type ?? doc.name.match(/\.([^.]+)$/)?.[1] ?? '').toLowerCase();
  extension = ({ jpg: 'jpeg', tif: 'tiff', markdown: 'md' } as Record<string, string>)[extension] ?? extension;
  return copy[`fileType.${extension}`] ?? english[`fileType.${extension}`] ?? (extension ? `${extension.toUpperCase()} ${tr('fileGeneric')}` : tr('fileGeneric'));
}
/**
 * The row's primary action, routed by type: Markdown and text open in Finch's document preview,
 * an image in its dedicated image viewer, and anything else — PDF, Word — externally in the file
 * manager, which is also where the first two land when the host cannot preview them.
 */
function openDocument(doc: Document): void {
  const root=libraryPath,version=libraryVersion;
  const reveal = () => {if(root===libraryPath&&version===libraryVersion)request('reveal', { id: doc.id });};
  if (!openListedDocument(bridge, doc.name, doc.path, reveal)) reveal();
}
/** Non-indexed originals have no tag/preview actions; the reason stays in Index status. */
function buildIssueRow(doc: Document): HTMLElement {
  const row = node('div', doc.issueKind === 'pending' ? 'doc pending-doc' : 'doc issue-doc'); row.dataset.id = doc.id; row.dataset.issueKind = doc.issueKind;
  row.dataset.path = doc.path; row.dataset.signature = rowSignature(doc);
  row.tabIndex = 0; row.setAttribute('role', 'group');
  const nameCell = node('div', 'doc-name'), fileIcon = node('span', 'doc-icon');
  const glyph = node('img', 'doc-icon-image') as HTMLImageElement;
  glyph.src = new URL(`../icons/${iconForFile(doc.name)}`, location.href).href; glyph.alt = ''; fileIcon.append(glyph);
  const title = node('span', 'doc-title', doc.name); title.title = doc.path;
  nameCell.append(fileIcon, title);
  const key = { pending: 'statusPending', unsupported: 'issueUnsupported', failed: 'issueFailed', empty_file: 'issueEmpty', no_text: 'issueNoText', image_no_text: 'issueImageNoText', unavailable: 'issueUnavailable' }[doc.issueKind!];
  const reason = [tr(key), doc.statusReason].filter(Boolean).join(' · ');
  const status = node('span', 'doc-status'); status.dataset.state = doc.issueKind === 'failed' ? 'failed' : 'unverified';
  status.setAttribute('title', reason); status.setAttribute('aria-label', reason); status.append(svg(doc.issueKind === 'pending' ? Circle : CircleAlert), node('span', '', reason));
  row.append(nameCell, node('span', 'doc-modified', fileModified(doc.modified_at)), node('span', 'doc-type', fileType(doc)), node('span', 'doc-size', fileSize(doc.size_bytes)), status);
  row.setAttribute('aria-label', `${doc.name} · ${reason}`); row.title = `${doc.path}\n${reason}`;
  const reveal = () => request('reveal', { id: doc.id, issues: true });
  const tools = node('div', 'doc-tools');
  const open = icon(FolderOpen, tr('directoryOpen')); open.addEventListener('click', reveal); tools.append(open); row.append(tools);
  row.addEventListener('dblclick', reveal);
  row.addEventListener('keydown', event => { if (event.target === row && event.key === 'Enter') { event.preventDefault(); reveal(); } });
  return row;
}
/** Build one row so re-filing never rebuilds the rest of the visible list. */
function buildRow(doc: Document): HTMLElement {
  if (doc.issueKind) return buildIssueRow(doc);
  const row = node('div', 'doc'); row.dataset.id = doc.id;
  row.dataset.path = doc.path; row.dataset.signature = rowSignature(doc);
  row.tabIndex = 0; row.setAttribute('role', 'group');
  const fileIcon = node('span', 'doc-icon');
  const glyph = node('img', 'doc-icon-image') as HTMLImageElement;
  glyph.src = new URL(`../icons/${iconForFile(doc.name)}`, location.href).href;
  glyph.alt = '';
  fileIcon.append(glyph);
  const nameCell = node('div', 'doc-name'); nameCell.append(fileIcon); row.append(nameCell);
  const displayPath = libraryPath && doc.path.startsWith(libraryPath) ? doc.path.slice(libraryPath.length).replace(/^[/\\]+/, '') : doc.name;
  const title = node('span', 'doc-title', displayPath.split(/[/\\]/).pop() ?? doc.name);
  title.title = displayPath; nameCell.append(title);
  // Only assigned categories earn badges; Unclassified remains a sidebar filter and menu choice.
  const assigned = doc.tags.filter(tagId => tagId !== DEFAULT_TAG);
  const shown = assigned.slice(0, MAX_ROW_BADGES);
  if (shown.length) {
    for (const tagId of shown) {
      const badge = node('button', 'doc-tag') as HTMLButtonElement;
      badge.type = 'button'; badge.dataset.tagId = tagId; badge.title = tr('filterByTag', { tag: tagName(tagId) });
      badge.setAttribute('aria-label', badge.title);
      badge.append(tagDot(tags.find(tag => tag.id === tagId)?.color), node('span', '', tagName(tagId)));
      badge.addEventListener('click', event => { event.stopPropagation(); selectTag(tagId); }); nameCell.append(badge);
    }
    if (assigned.length > shown.length) {
      const rest = node('span', 'doc-tag more', `+${assigned.length - shown.length}`);
      rest.setAttribute('title', assigned.slice(MAX_ROW_BADGES).map((tagId) => tagName(tagId)).join(' · '));
      nameCell.append(rest);
    }
  }
  const added = new Date(doc.added_at).toLocaleDateString();
  const indexed = new Date(doc.indexed_at).toLocaleDateString();
  // Coverage comes from LanceDB, never inferred from catalogue presence or timestamps.
  const state = doc.status ?? 'unverified';
  const statusKey = { processing: 'statusProcessing', ready: 'statusReady', outdated: 'statusOutdated', pending: 'statusPending', incomplete: 'statusIncomplete', failed: 'statusFailed', source_missing: 'statusSourceMissing', source_unavailable: 'statusSourceUnavailable', unverified: 'statusUnverified' }[state];
  const collectionStatus = node('span', 'doc-status');
  collectionStatus.dataset.state = state;
  collectionStatus.append(svg(state === 'ready' ? CircleCheck : state === 'processing' ? Loader : state === 'unverified' ? Circle : CircleAlert), node('span', '', tr(statusKey)));
  const collectionHint = [tr(`${statusKey}Hint`),
    doc.indexedChunks != null ? tr('statusCoverage', { actual: doc.indexedChunks, expected: doc.chunks }) : '',
    state === 'failed' && doc.statusReason ? tr('statusReason', { reason: doc.statusReason }) : '',
  ].filter(Boolean).join('\n');
  collectionStatus.setAttribute('title', collectionHint);
  collectionStatus.setAttribute('aria-label', tr(statusKey));
  row.setAttribute('aria-label', `${displayPath} · ${tr(statusKey)}`);
  const modified = fileModified(doc.modified_at), type = fileType(doc), size = fileSize(doc.size_bytes);
  row.append(node('span', 'doc-modified', modified), node('span', 'doc-type', type), node('span', 'doc-size', size), collectionStatus);
  // Everything the shortened row no longer shows stays one hover away, full path included.
  const external = false; // Directory sources are the originals, not managed copies.
  row.setAttribute('title', [
    external ? tr('externalSource', { path: doc.path }) : doc.path,
    `${tr('sortModified')}: ${modified}`, `${tr('sortType')}: ${type}`, `${tr('sortSize')}: ${size}`,
    assigned.map(tagName).join(' · '), tr(statusKey), collectionHint,
    `${doc.chunks} ${tr('chunk')}`, tr('added', { date: added }), tr('updated', { date: indexed }),
  ].join('\n'));

  // Preserve row activation without treating a completed text-selection gesture as a click.
  const hasRowSelection = (): boolean => {
    const selection = window.getSelection();
    return Boolean(selection && !selection.isCollapsed && selection.rangeCount
      && selection.getRangeAt(0).intersectsNode(row));
  };
  let pointerStart: { x: number; y: number } | null = null;
  let dragged = false, selecting = false;
  row.addEventListener('pointerdown', event => {
    pointerStart = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
    dragged = false; selecting = hasRowSelection();
  });
  row.addEventListener('pointermove', event => {
    if (pointerStart && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 4) dragged = true;
  });
  row.addEventListener('pointercancel', () => { pointerStart = null; dragged = true; });
  row.addEventListener('click', event => {
    if ((event.target as HTMLElement | null)?.closest('button, a, input, textarea, select')) return;
    const moved = pointerStart && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 4;
    pointerStart = null;
    if (event.button !== 0 || event.detail > 1 || dragged || moved || selecting || hasRowSelection()) return;
    openDocument(doc);
  });
  row.addEventListener('keydown', event => {
    if (event.target !== row || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault(); openDocument(doc);
  });
  const tools = node('div', 'doc-tools');
  const primary = icon(FolderOpen, tr('reveal'));
  primary.addEventListener('click', () => request('reveal', { id: doc.id }));
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
function buildEmptyState(): HTMLElement {
  const mode = scanBusy ? 'scanning' : loadingPage ? 'loading' : selectedDirectory !== null ? 'directory' : selectedTag !== null ? 'category' : 'library';
  const section = node('section', 'library-empty');
  section.dataset.mode = mode;
  section.setAttribute('role', 'status');
  section.setAttribute('aria-busy', String(mode === 'scanning' || mode === 'loading'));
  section.setAttribute('aria-labelledby', 'empty-heading');
  const illustration = node('div', 'empty-illustration');
  illustration.setAttribute('aria-hidden', 'true');
  illustration.append(svg(mode === 'scanning' || mode === 'loading' ? Loader : mode === 'category' ? TagIcon : Files));
  const titleKey = { library: 'emptyTitle', directory: 'emptyFolderTitle', category: 'emptyCategoryTitle', scanning: 'emptyScanningTitle', loading: 'emptyLoadingTitle' }[mode];
  const hintKey = { library: 'emptyHint', directory: 'emptyFolderHint', category: 'emptyCategoryHint', scanning: 'emptyScanningHint', loading: 'emptyLoadingHint' }[mode];
  const heading = node('h3', 'empty-heading', tr(titleKey, { tag: tagName(selectedTag ?? DEFAULT_TAG) }));
  heading.id = 'empty-heading';
  section.append(illustration, heading, node('p', 'empty-description', tr(hintKey)));
  if ((mode === 'library' || mode === 'scanning') && libraryPath) {
    const directory = node('div', 'empty-directory');
    directory.setAttribute('title', libraryPath);
    const path = node('code', 'empty-directory-path', libraryPath);
    directory.append(svg(FolderOpen), node('span', 'empty-directory-label', tr('emptyDirectory')), path);
    section.append(directory);
  }
  if (mode === 'library') {
    const steps = node('ol', 'empty-steps');
    for (const [index, key] of ['emptyStepFiles', 'emptyStepScan', 'emptyStepTags'].entries()) {
      const step = node('li', 'empty-step');
      step.append(node('span', 'empty-step-number', String(index + 1)), node('span', '', tr(key)));
      steps.append(step);
    }
    section.append(steps, node('p', 'empty-types', tr('emptyTypes')));
  }
  return section;
}

function rowSignature(doc: Document): string { return JSON.stringify([doc, doc.tags.map(id => tags.find(tag => tag.id === id))]); }
function renderDocs(focusId?: string, preserve = false): void {
  // Rows are rebuilt here, so a menu whose document is gone has to close — but one whose document
  // is still listed keeps its place, which is what makes ticking several categories possible.
  const survivor = rowMenuDoc ? docs.find((doc) => doc.id === rowMenuDoc!.id) ?? null : null;
  // A refresh empties the list before refilling it, and that moment is not a reason to forget the
  // menu: hide it, and the next render puts it back on the row it belongs to.
  if (!survivor) { if (docs.length || !rowMenuDoc) closeRowMenu(); else hideRowMenu(); }
  byId('knowledge-content').classList.toggle('issues-view', showIssues);
  byId('count').textContent = tr('totalFiles', { count: total });
  byId('document-columns').hidden = docs.length === 0;
  const target = byId('documents');
  const existing = new Map(preserve ? Array.from(target.children).map(row => [(row as HTMLElement).dataset.path, row as HTMLElement] as const) : []);
  if (!preserve || !docs.length) target.replaceChildren();
  if (!docs.length) {
    if (showIssues) {
      const empty = node('section', 'library-empty'); empty.setAttribute('role', 'status');
      empty.append(node('h3', 'empty-heading', tr(loadingPage ? 'emptyLoadingTitle' : 'sourceIssuesEmpty')), node('p', 'empty-description', tr('sourceIssuesHint'))); target.append(empty);
    } else target.append(buildEmptyState());
  }
  const keep = new Set<HTMLElement>();
  if (preserve && docs.length) {
    const wanted = new Set(docs.map(doc => doc.path));
    for (const row of Array.from(target.children)) if (!wanted.has((row as HTMLElement).dataset.path ?? '')) row.remove();
  }
  for (const [index, doc] of docs.entries()) {
    const previous = preserve ? existing.get(doc.path) : undefined;
    const row = previous && previous.dataset.signature === rowSignature(doc) ? previous : buildRow(doc);
    keep.add(row);
    if (previous && previous !== row) previous.replaceWith(row);
    if (!preserve) target.append(row);
    else if (target.children[index] !== row) target.insertBefore(row, target.children[index] ?? null);
  }
  if (preserve && docs.length) for (const row of Array.from(target.children)) if (!keep.has(row as HTMLElement)) row.remove();
  if (survivor) restoreRowMenu(survivor, rowMenuFlyoutOpen);
  // Only carry a tail line while rows remain; a fully shown list needs no dangling footer.
  byId('list-end').textContent = docs.length && docs.length < total ? tr('loaded', { shown: docs.length, total }) : '';
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
function patchDocumentStatus(path: string, phase: 'processing' | 'settled', update?: Document): void {
  const index = docs.findIndex(doc => doc.path === path);
  if (index < 0) return;
  const previous = docs[index]!;
  if (update && update.id !== previous.id) return;
  if(update?.file_id&&previous.file_id&&update.file_id!==previous.file_id)return;
  if(update?.source_revision!==undefined&&previous.source_revision!==undefined&&update.source_revision<previous.source_revision)return;
  docs[index] = phase === 'processing' ? { ...previous, status: 'processing', statusReason: undefined }
    : update ? { ...previous, ...update, tags: previous.tags } : { ...previous, status: 'unverified' };
  const row = byId('documents').querySelector<HTMLElement>(`.doc[data-id="${previous.id}"]`);
  row?.replaceWith(buildRow(docs[index]!));
  if (rowMenuDoc?.id === previous.id) restoreRowMenu(docs[index]!, rowMenuFlyoutOpen);
}

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
    placeRowSubmenu(submenu);
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
  const point = anchor.width === 0 && anchor.height === 0;
  const right = anchor.right + (point ? 0 : gap);
  const left = anchor.left - box.width - (point ? 0 : gap);
  const fitsRight = right + box.width <= window.innerWidth - 8;
  const fitsLeft = left >= 8;
  let rawLeft = anchor.right - box.width;
  if (point || side !== 'below') {
    const preferRight = point || side === 'right';
    rawLeft = preferRight ? (fitsRight || !fitsLeft ? right : left) : (fitsLeft || !fitsRight ? left : right);
  }
  menu.style.left = `${scrollX + clamp(rawLeft, window.innerWidth - box.width - 8)}px`;
  // Context menus begin at the pointer; flyouts align with their parent item. Flip upward only
  // when needed, then clamp to keep every action reachable in a short viewport.
  const below = point ? anchor.top : anchor.bottom + gap;
  const rawTop = !point && side !== 'below' ? anchor.top
    : below + box.height > window.innerHeight - 8 ? anchor.top - box.height - (point ? 0 : gap) : below;
  menu.style.top = `${scrollY + clamp(rawTop, window.innerHeight - box.height - 8)}px`;
}

/** Use the outer menu edges so its padding never makes the flyout overlap its parent. */
function placeRowSubmenu(submenu: HTMLElement): void {
  const item = byId('row-classify').getBoundingClientRect();
  const parent = byId('row-menu').getBoundingClientRect();
  placeMenu(submenu, { top:item.top, bottom:item.bottom, height:item.height, left:parent.left, right:parent.right, width:parent.width }, 'right');
}

/** A multi-select flyout: independent checkboxes reflect every tag on the document. */
function fillRowSubmenu(doc: Document): void {
  const submenu = byId('row-submenu') as HTMLElement;
  const active = document.activeElement as HTMLElement | null;
  const focusedTag = active && submenu.contains(active) ? active.dataset.tagId : undefined;
  submenu.replaceChildren();
  submenu.setAttribute('aria-label', tr('menuClassify'));
  // Clicking adds or removes that category without closing anything: several are usually set in one
  // visit, so the flyout stays where it is and re-ticks itself when the reply comes back.
  for (const tag of tags) {
    if (tag.id === DEFAULT_TAG) continue;
    const checked = doc.tags.includes(tag.id);
    const choice = node('button', 'menu-item') as HTMLButtonElement;
    choice.type = 'button';
    choice.dataset.tagId = tag.id;
    choice.setAttribute('role', 'menuitemcheckbox');
    choice.setAttribute('aria-checked', String(checked));
    choice.append(tagDot(tag.color), node('span', 'menu-label', tagName(tag.id)));
    const check = node('span', 'menu-check');
    if (checked) check.append(svg(Check));
    choice.append(check);
    choice.addEventListener('click', () => request('tagToggle', { id: doc.id, tagId: tag.id }));
    submenu.append(choice);
  }
  // Creating a tag belongs beside tag assignments, including when there are no tags yet.
  if (submenu.children.length) {
    const divider = node('div', 'menu-separator'); divider.setAttribute('role', 'separator'); submenu.append(divider);
  }
  const create = node('button', 'menu-item') as HTMLButtonElement;
  create.id = 'row-new-tag'; create.type = 'button'; create.setAttribute('role', 'menuitem');
  create.append(svg(Plus), node('span', 'menu-label', tr('newTag')));
  create.addEventListener('click', () => { closeRowMenu(); startTagCreate(); });
  submenu.append(create);
  if (focusedTag) Array.from(submenu.querySelectorAll<HTMLButtonElement>('button[data-tag-id]')).find(choice => choice.dataset.tagId === focusedTag)?.focus({ preventScroll: true });
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
  placeRowSubmenu(submenu);
  // The flyout must be visible before measuring its viewport and selected row.
  scrollToCheckedCategory(submenu);
}
function closeRowSubmenu(): void {
  rowMenuFlyoutOpen = false;
  (byId('row-submenu') as HTMLElement).hidden = true;
  byId('row-classify').setAttribute('aria-expanded', 'false');
}
/** External applications must not leave pointer highlights or button focus latched in this view. */
function wireWindowActivity(): void {
  const root = document.documentElement;
  const deactivate = (): void => {
    root.classList.add('window-inactive', 'pointer-quiet');
    closeRowMenu(); closeTagColor(); setMenu(false);
    const active = document.activeElement as HTMLElement | null;
    // Preserve text drafts when switching applications; only transient action focus is cleared.
    if (active?.closest('.doc') || active?.matches('button, a')) active.blur();
  };
  window.addEventListener('blur', deactivate);
  window.addEventListener('focus', () => root.classList.remove('window-inactive'));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) deactivate();
    else if (document.hasFocus()) root.classList.remove('window-inactive');
  });
  const resumePointer = (): void => {
    if (!document.hidden && document.hasFocus()) {
      // Embedded views can miss focus events when returning from a host-owned preview.
      root.classList.remove('window-inactive');
      root.classList.remove('pointer-quiet');
    }
  };
  document.addEventListener('pointermove', resumePointer, { passive:true });
  document.addEventListener('pointerdown', resumePointer, { passive:true });
}
function wireTagContextMenu(): void {
  const menu = byId('tag-context-menu');
  const section = byId('tags').parentElement!;
  const close = (): void => { menu.hidden = true; };
  section.addEventListener('contextmenu', event => {
    if ((event.target as HTMLElement | null)?.closest('input, textarea')) return;
    event.preventDefault(); event.stopPropagation(); closeRowMenu(); setMenu(false); closeTagColor();
    const box = section.getBoundingClientRect();
    const x = event.clientX || box.left + 16, y = event.clientY || box.top + 36;
    placeMenu(menu, { left:x, right:x, top:y, bottom:y, width:0, height:0 });
    byId('tag-context-new').focus({ preventScroll: true });
  });
  byId('tag-context-new').addEventListener('click', () => { close(); startTagCreate(); });
  document.addEventListener('pointerdown', event => { if (!menu.hidden && !menu.contains(event.target as Node)) close(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); close(); byId('new-tag').focus(); }
  });
  window.addEventListener('resize', close); window.addEventListener('blur', close);
  byId('tags').addEventListener('scroll', close, { passive:true });
}
function wireRowMenu(): void {
  const menu = byId('row-menu') as HTMLElement;
  const submenu = byId('row-submenu') as HTMLElement;

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
  showIssues = false; updateSortSizer(); renderDirectories();
  pageEpoch++; loadingPage = false;
  request('locate', { id: match.document_id, tagId: selectedTag, directory: selectedDirectory, sort, descending: currentDescending() }, 'locate');
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
  overlay.hidden = libraryEntered && Boolean(libraryPath) && state.usable && !libraryUnavailable;
  if (overlay.hidden) return;
  const list = byId('onboard-steps');
  list.replaceChildren();
  renderOnboardLibrary();
  byId('onboard-title').textContent = tr('onboardTitle');
  byId('onboard-intro').textContent = tr('onboardIntro');
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
    title.append(node('span', 'onboard-step-name', labels[step.id] ?? step.id), node('span', 'onboard-step-status', step.lazy && step.status === 'pending' ? tr('onboardOnDemand') : statuses[step.status]));
    content.append(title);
    const detail = step.error ?? step.message ?? step.detail ?? (step.lazy && step.status === 'pending' ? tr('onboardOcrHint') : step.status === 'running' ? tr('onboardWorking') : '');
    // Keep both slots in every state: finishing a download must not resize the card.
    const detailLine = node('div', 'onboard-step-detail', detail);
    detailLine.setAttribute('title', detail);
    content.append(detailLine);
    const bar = node('div', 'onboard-bar');
    const fill = node('span', '');
    const showProgress = step.status === 'running' && typeof step.percent === 'number';
    bar.style.visibility = showProgress ? 'visible' : 'hidden';
    bar.setAttribute('aria-hidden', String(!showProgress));
    fill.style.width = `${Math.max(4, Math.min(100, step.percent ?? 0))}%`;
    bar.append(fill);
    content.append(bar);
    row.append(content);
    list.append(row);
  }
  const failures = state.steps.filter((step) => step.status === 'failed');
  const blockingFailure = failures.some(step => !step.optional);
  byId('onboard-enter').hidden = false;
  (byId('onboard-enter') as HTMLButtonElement).disabled = !libraryPath || Boolean(libraryUnavailable) || !state.usable;
  byId('onboard-enter').textContent = tr('onboardEnter');
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
  const state = libraryUnavailable ? 'failed' : libraryBusy ? 'running' : !libraryPath ? 'pending' : 'ready';
  row.className = `onboard-step onboard-library ${state}`;
  byId('onboard-library-icon').replaceChildren(svg(environmentIcon(state)));
  byId('onboard-library-status').textContent = state === 'running' ? tr('onboardWorking')
    : state === 'failed' ? tr('onboardLibraryUnavailable')
      : state === 'pending' ? tr('onboardPending') : libraryDefault ? tr('onboardLibraryDefault') : tr('onboardLibraryChosen');
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
  if (libraryEntered && failures.length && !state.running && previous?.running && state.usable) {
    toast(tr('onboardOptionalFailed', { name: failures.map((step) => STEP_LABELS[step.id]?.() ?? step.id).join(', ') }), 'error');
  }
  // First sight of a missing runtime starts setup by itself; a failure always waits for a click.
  const untouched = state.steps.every((step) => step.status === 'pending' || step.status === 'ready');
  if (!state.usable && !state.running && untouched && !environmentAutoStarted) {
    environmentAutoStarted = true;
    request('environmentInstall');
  }
}
function applyLibrary(info: LibraryInfo | undefined): boolean {
  if (!info || (info.version !== undefined && info.version < libraryVersion)) return false;
  const newerScope = info.version !== undefined && libraryVersion >= 0 && info.version !== libraryVersion;
  if (info.version !== undefined) libraryVersion = info.version;
  const nextPath = info.selected === false ? '' : info.root;
  const changed = libraryPath !== nextPath || newerScope;
  libraryPath = nextPath;
  libraryName = info.name ?? '';
  libraryIndexStorage = info.indexStorage ?? 'source';
  activeLibraryId = info.activeId ?? '';
  const preserveStates=info.availabilityEpoch===availabilityEpoch&&(info.availabilityVersion??-1)<availabilityVersion;
  const previousEntries=libraryEntries;
  libraryEntries = (info.libraries ?? []).map(entry=>{const previous=previousEntries.find(v=>v.id===entry.id&&libraryStatusFingerprint(v)===libraryStatusFingerprint(entry));return preserveStates&&previous?{...entry,availability:previous.availability}:entry;});
  if(info.availabilityEpoch!==undefined&&info.availabilityEpoch!==availabilityEpoch){availabilityEpoch=info.availabilityEpoch;availabilityVersion=-1;}
  if(info.availabilityVersion!==undefined)availabilityVersion=Math.max(availabilityVersion,info.availabilityVersion);
  if (changed) {
    editingLibrary=undefined;
    setMenu(false); setLibraryBusy(false);
    closeRowMenu(); closeTagColor(); closeSearch();
    pageEpoch++; loadingPage = false;
    creatingTag = false; inlineTagEditing = null; draggingTag = null;
    selectedTag = null; selectedDirectory = null; showIssues = false; issuesTotal = 0;
    directories = []; expandedDirectories.clear(); tags = []; docs = [];
    total = 0; beforeOffset = 0; nextOffset = 0;nextCursor=previousCursor=undefined;catalogVersion=-1;
    documentStatusVersions.clear();
    updateSortSizer(); renderDirectories(); renderTags(); renderDocs();
    setScanBusy(false);
  }
  libraryDefault = info.isDefault;
  libraryEntered = info.entered === true;
  libraryUnavailable = info.unavailable ?? '';
  setScanBusy(scanBusy);
  updateLibrary();
  renderOnboardLibrary();
  if (environment) renderEnvironment(environment);
  return changed;
}
function shortPath(path: string): string {
  const parts = path.split(/[/\\]+/).filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-2).join('/')}`;
}
function updateLibrary(): void {
  const short = shortPath(libraryPath);
  byId('heading').textContent = tr('heading');
  byId('heading').setAttribute('title', tr('heading'));
  const path = byId('library-path');
  path.textContent = libraryName || (libraryUnavailable ? shortPath(libraryUnavailable) : short);
  // The row shows only the folder name, so the tooltip carries what it is and the full path.
  const reveal = byId('library-picker-button');
  reveal.setAttribute('title', `${libraryUnavailable ? '⚠ ' : ''}${tr('libraryLabel')}\n${libraryUnavailable || libraryPath}`);
  reveal.setAttribute('aria-label', `${tr('librariesTitle')}: ${libraryUnavailable || libraryPath}`);
  byId('library-footer').classList.toggle('warning', Boolean(libraryUnavailable));
  const note = byId('library-note');
  const libraryNote = tr(libraryIndexStorage === 'local' ? 'libraryNoteRemote' : 'libraryNote');
  note.textContent = libraryUnavailable ? `${tr('libraryUnavailable', { path: libraryUnavailable })}

${libraryNote}` : libraryDefault ? `${tr('libraryDefault')}

${libraryNote}` : libraryNote;
  renderLibraryChoices();
}
function paintLibraryState(target:HTMLElement,state:LibraryState):void{target.dataset.state=state;target.textContent=tr(`libraryState.${state}`);target.title=tr(`libraryStateHint.${state}`);target.setAttribute('aria-label',target.title);}
function applyLibraryStates(data:Reply):void{
  if(data.availabilityEpoch!==availabilityEpoch||(data.availabilityVersion??-1)<availabilityVersion)return;
  availabilityVersion=data.availabilityVersion??availabilityVersion;
  for(const update of data.states??[]){
    const entry=libraryEntries.find(v=>v.id===update.id&&libraryStatusFingerprint(v)===update.fingerprint);if(!entry)continue;
    if(!['unknown','checking','available','offline','unavailable'].includes(update.state))continue;
    entry.availability=update.state;
    const row=Array.from(byId('library-list').children).find(v=>(v as HTMLElement).dataset.libraryId===entry.id);
    const target=row?.querySelector<HTMLElement>('.library-entry-state');if(target)paintLibraryState(target,update.state);
    row?.querySelector('.library-choice')?.setAttribute('aria-label',`${entry.name} — ${tr(`libraryStateHint.${update.state}`)}`);
  }
}
function beginLibraryEdit(entry:LibraryChoice):void{
  if(editingLibrary?.saving)return;
  editingLibrary={id:entry.id,value:entry.name,saving:false};renderLibraryChoices();
  const input=byId('library-list').querySelector<HTMLInputElement>('.library-name-input');input?.focus();input?.select();
}
function endLibraryEdit():void{
  const id=editingLibrary?.id;editingLibrary=undefined;renderLibraryChoices();
  const row=Array.from(byId('library-list').children).find(v=>(v as HTMLElement).dataset.libraryId===id);
  if(menuOpen('libraries')){row?.querySelector<HTMLButtonElement>('.library-choice')?.focus({preventScroll:true});row?.querySelector<HTMLButtonElement>('[data-action="libraryRename"]')?.focus({preventScroll:true});}
}
function saveLibraryEdit():void{
  if(!editingLibrary||editingLibrary.saving)return;
  const name=editingLibrary.value.trim();
  if(!name||name.length>60){editingLibrary.error=tr('libraryNameInvalid');const input=byId('library-list').querySelector<HTMLInputElement>('.library-name-input');input?.setAttribute('aria-invalid','true');if(input)input.title=editingLibrary.error;input?.focus();return;}
  editingLibrary.saving=true;request('libraryRename',{id:editingLibrary.id,name});
  const input=byId('library-list').querySelector<HTMLInputElement>('.library-name-input');if(input)input.readOnly=true;
}
function renderLibraryChoices(): void {
  const container = byId('library-list');
  container.setAttribute('aria-label', tr('librariesTitle'));
  const scroll=container.scrollTop;
  container.replaceChildren(...libraryEntries.map(entry => {
    const row = node('div', 'library-entry');
    row.dataset.libraryId = entry.id;
    row.dataset.selected=String(entry.id===activeLibraryId);
    if(editingLibrary?.id===entry.id){
      row.classList.add('editing');
      const main=node('div','library-edit-main');
      const input=node('input','library-name-input') as HTMLInputElement;
      input.type='text';input.maxLength=60;input.value=editingLibrary.value;input.readOnly=editingLibrary.saving;
      input.setAttribute('aria-label',tr('libraryNameLabel'));input.setAttribute('aria-invalid',String(Boolean(editingLibrary.error)));input.title=editingLibrary.error??tr('libraryNameHint');
      input.addEventListener('input',()=>{if(editingLibrary){editingLibrary.value=input.value;editingLibrary.error=undefined;input.setAttribute('aria-invalid','false');}});
      input.addEventListener('keydown',event=>{if(event.isComposing)return;if(event.key==='Enter'){event.preventDefault();event.stopPropagation();saveLibraryEdit();}else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(!editingLibrary?.saving)endLibraryEdit();}});
      main.append(input);row.append(main);return row;
    }
    const current = entry.id === activeLibraryId;
    const choice = node('button', 'menu-item library-choice') as HTMLButtonElement;
    choice.type = 'button'; choice.disabled = libraryBusy;
    choice.setAttribute('role', 'menuitemradio'); choice.setAttribute('aria-checked', String(current));
    choice.setAttribute('aria-label',`${entry.name} — ${tr(`libraryStateHint.${entry.availability??'unknown'}`)}`);
    choice.title = entry.root;
    const label = node('span', 'library-entry-label');
    label.append(node('span', 'library-entry-name', entry.name));
    choice.append(label);
    choice.addEventListener('click', () => {
      if (libraryBusy) return;
      setMenu(false);
      if (current) return;
      setLibraryBusy(true); request('librarySwitch', { id: entry.id });
    });
    const controls=node('span','library-entry-controls');
    for(const [action,icon,key] of [['libraryRename',PenLine,'renameLibrary'],['libraryRemove',Trash2,'removeLibrary']] as const){
      const button=node('button','plain-icon library-manage') as HTMLButtonElement;
      button.type='button';button.disabled=libraryBusy;button.dataset.action=action;button.setAttribute('role','menuitem');
      button.title=tr(key,{name:entry.name});button.setAttribute('aria-label',button.title);button.append(svg(icon));
      button.addEventListener('click',event=>{event.stopPropagation();if(libraryBusy)return;if(action==='libraryRename'){beginLibraryEdit(entry);return;}setMenu(false);setLibraryBusy(true);request(action,{id:entry.id});});
      controls.append(button);
    }
    const tail=node('span','library-entry-tail'),state=node('span','library-entry-state');paintLibraryState(state,entry.availability??'unknown');tail.append(state,controls);
    row.append(choice,tail);
    return row;
  }));
  container.scrollTop=scroll;
}
type LibraryMenuKind = 'libraries' | 'actions';
let activeLibraryMenu: LibraryMenuKind = 'libraries';
let libraryMenuAnchor:HTMLElement|undefined;
function libraryMenuTrigger(): HTMLElement { return libraryMenuAnchor??byId(activeLibraryMenu === 'libraries' ? 'library-picker-button' : 'library-menu-button'); }
function setMenu(open: boolean, kind: LibraryMenuKind = 'libraries',anchor?:HTMLElement): void {
  for (const id of ['library-menu', 'library-actions-menu']) byId(id).hidden = true;
  for (const id of ['library-picker-button', 'library-menu-button','onboard-library-action']) byId(id).setAttribute('aria-expanded', 'false');
  if(availabilityTimer!==undefined){clearInterval(availabilityTimer);availabilityTimer=undefined;}
  if (!open) {if(editingLibrary&&!editingLibrary.saving){editingLibrary=undefined;renderLibraryChoices();}return;}
  activeLibraryMenu = kind;libraryMenuAnchor=anchor;
  closeRowMenu();
  const menu = byId(kind === 'libraries' ? 'library-menu' : 'library-actions-menu');
  // Both menus escape the sidebar clipping boundary, but have independent triggers.
  document.body.append(menu); menu.classList.add('library-picker-floating');
  placeMenu(menu, libraryMenuTrigger().getBoundingClientRect());
  libraryMenuTrigger().setAttribute('aria-expanded', 'true');
  if(kind==='libraries'){
    request('libraryAvailability');
    availabilityTimer=setInterval(()=>{if(!document.hidden)request('libraryAvailability');},15000);
  }
}
function menuOpen(kind?: LibraryMenuKind): boolean {
  return kind ? !byId(kind === 'libraries' ? 'library-menu' : 'library-actions-menu').hidden
    : ['library-menu', 'library-actions-menu'].some(id => !byId(id).hidden);
}
function setScanBusy(busy: boolean): void {
  if (!busy || !scanBusy) {
    scanPercent = null;
    streamedProgress = '';
    if (streamedTimer !== undefined) clearTimeout(streamedTimer);
    streamedTimer = undefined;
  }
  scanBusy = busy;
  const button = byId('sync') as HTMLButtonElement;
  if (!busy) pauseRequested = false;
  button.disabled = pauseRequested || libraryBusy || !libraryPath || Boolean(libraryUnavailable);
  const label = busy ? tr(pauseRequested ? 'scanPausing' : 'scanPause') : tr('syncLabel');
  byId('sync-label').textContent = label; byId('settings-scan-label').textContent = label;
  button.setAttribute('aria-label', label);
  (byId('settings-scan') as HTMLButtonElement).disabled = button.disabled;
  button.setAttribute('aria-busy', String(busy));
  button.setAttribute('title', busy ? tr('scanPauseHint') : tr('syncHint'));
  renderActivity();
  if (!docs.length) renderDocs();
}
/** Completion is a reconciliation boundary, not proof that a batch snapshot reached the page. */
function finishScan(): void {
  const wasBusy = scanBusy;
  setScanBusy(false);
  if (wasBusy) refreshPage();
}
function requestScan(): void {
  if (libraryBusy || pauseRequested || !libraryPath || libraryUnavailable) return;
  setMenu(false);
  if (scanBusy) { pauseRequested = true; setScanBusy(true); request('scanPause'); return; }
  setScanBusy(true);
  request('sync');
}
function setLibraryBusy(busy: boolean): void {
  libraryBusy = busy;
  renderLibraryChoices();
  for (const id of ['library-location', 'library-picker-button', 'library-menu-button', 'open-directory', 'onboard-library-action']) (byId(id) as HTMLButtonElement).disabled = busy;
  if (busy) setMenu(false);
  setScanBusy(scanBusy);
  renderActivity();
  renderOnboardLibrary();
}
function applyCopy(): void {
  byId('workspace-resizer').setAttribute('aria-label', tr('resizeSidebar'));
  byId('workspace-resizer').title = tr('resizeSidebar');
  const elements: Record<string, string> = {
    heading: 'heading', intro: 'intro', openDirectory: 'open-directory-label',
    tagsTitle: 'tags-title',
    sortLabel: 'sort-label',
    libraryLocation: 'library-location-label', syncLabel: 'sync-label',
    libraryEnvironment: 'library-environment-label',
    menuClassify: 'row-classify-label', hideUnsupported: 'hide-unsupported-label',
    onboardTitle: 'onboard-title', onboardIntro: 'onboard-intro', onboardRetry: 'onboard-retry', onboardHelp: 'onboard-help',
    onboardLibraryTitle: 'onboard-library-title', onboardLibraryAction: 'onboard-library-action-label',
    searchLabel: 'search-label',
  };
  for (const [key, id] of Object.entries(elements)) byId(id).textContent = tr(key);
  const createLabel = document.querySelector('#row-new-tag .menu-label');
  if (createLabel) createLabel.textContent = tr('newTag');
  byId('tag-context-new-label').textContent = tr('newTag');
  byId('new-tag').setAttribute('title', tr('newTag')); byId('new-tag').setAttribute('aria-label', tr('newTag'));
  byId('browse').setAttribute('title', tr('browse')); byId('browse').setAttribute('aria-label', tr('browse'));
  byId('onboard-library-action').setAttribute('title', tr('onboardLibraryHint'));
  setScanBusy(scanBusy);
  byId('library-location').setAttribute('title', tr('libraryLocationHint'));
  byId('library-menu-button').setAttribute('title', tr('librarySettings')); byId('library-menu-button').setAttribute('aria-label', tr('librarySettings'));
  (byId('query') as HTMLInputElement).placeholder = tr('searchPlaceholderIn', { tag: tr('all') });
  byId('search-dialog').setAttribute('aria-label', tr('searchLabel'));
  updateSortSizer();
  renderDirectories(); renderTags(); renderDocs(); updateLibrary();
  if (environment) renderEnvironment(environment);
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
function resetSearch(): void {
  if (debounce !== undefined) clearTimeout(debounce);
  debounce = undefined;
  searchEpoch++;
  for (const [id, task] of pending) if (task.type === 'search') pending.delete(id);
  searchQuery = ''; matches = []; activeMatch = -1;
  (byId('query') as HTMLInputElement).value = '';
  byId('search-dialog').classList.toggle('has-results', false);
  const results = byId('matches');
  results.replaceChildren(node('div', 'empty', tr('searchHint')));
  results.scrollTop = 0;
}
function closeSearch(): void {
  resetSearch();
  const dialog = byId('search-dialog') as HTMLDialogElement;
  if (dialog.open) dialog.close();
}
function wireSearchDialog(): void {
  const dialog = byId('search-dialog') as HTMLDialogElement;
  byId('browse').addEventListener('click', () => {
    resetSearch(); updateScope(); dialog.showModal(); (byId('query') as HTMLInputElement).focus();
  });
  dialog.addEventListener('click', event => { if (event.target === dialog) closeSearch(); });
  dialog.addEventListener('cancel', resetSearch);
  dialog.addEventListener('close', () => { if (!dialog.open) resetSearch(); });
  dialog.addEventListener('focusout', event => {
    // Moving between the query and a result is not leaving the search palette.
    if (event.relatedTarget instanceof Node && !dialog.contains(event.relatedTarget)) closeSearch();
  });
  window.addEventListener('blur', () => { if (dialog.open) closeSearch(); });
  byId('query').addEventListener('input', queueSearch);
  dialog.addEventListener('keydown', event => {
    if (!matches.length) return;
    if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      const row = matches[activeMatch < 0 ? 0 : activeMatch];
      if (row) locateMatch(row);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault(); moveActiveMatch(event.key === 'ArrowDown' ? 1 : -1);
  });
}
function queueSearch(): void {
  if (debounce !== undefined) clearTimeout(debounce);
  debounce = undefined;
  searchEpoch++;
  const query = (byId('query') as HTMLInputElement).value.trim();
  if (!query) { resetSearch(); return; }
  const epoch = searchEpoch;
  debounce = window.setTimeout(() => {
    debounce = undefined;
    if (epoch !== searchEpoch || !(byId('search-dialog') as HTMLDialogElement).open) return;
    searchQuery = query; request('search', { query, tagId: selectedTag, directory: selectedDirectory });
  }, 240);
}
mountStaticIcons();
window.addEventListener('pagehide', wireScrollbars(document), { once: true });
sortControl = createSortMenu({
  trigger: byId('sort') as HTMLButtonElement, menu: byId('sort-menu'), label: byId('sort-current'),
  getValue: () => sort,
  getLabel: sortLabel,
  onChange(value) { sort = value; sortDescending = undefined; renderColumnHeaders(); resetPage(); },
  onOpen() { closeRowMenu(); setMenu(false); },
});
window.addEventListener('pagehide', () => sortControl?.dispose(), { once: true });
applyCopy();
wireRowMenu();
window.setTimeout(() => {
  if (document.documentElement.classList.contains('booting')) void localeChanged(navigator.language || 'en-US');
}, 600);
if (bridge) {
  bridge.onMessage((message: unknown) => {
    const data = message as Reply & { locale?: string };
    if (data.type === 'finch:env') { void localeChanged(data.locale ?? 'en-US'); return; }
    if (!data.library && data.libraryVersion !== undefined && data.libraryVersion < libraryVersion) {
      if (data.requestId) pending.delete(data.requestId);
      return;
    }
    // Detailed backend messages may refine an active scan, but never start the bar.
    if (data.type === 'progress') { noteProgress(data.message ?? ''); return; }
    if (data.type === 'environment') { applyEnvironment(data.environment); return; }
    if (data.library?.version !== undefined && data.library.version < libraryVersion) {
      const task = data.requestId ? pending.get(data.requestId) : undefined;
      if (data.requestId) pending.delete(data.requestId);
      if (task?.type.startsWith('library')) setLibraryBusy(false);
      return;
    }
    if (data.preferences) byId('hide-unsupported').setAttribute('aria-checked', String(data.preferences.hideUnsupported));
    if(data.type==='libraryAvailability'){if(data.requestId)pending.delete(data.requestId);applyLibraryStates(data);return;}
    if (data.type === 'libraries') {
      if (applyLibrary(data.library)) { request('tags'); resetPage(); }
      return;
    }
    if (data.type === 'documentStatus') {
      if (data.root !== libraryPath || !data.path) return;
      const version = data.version ?? 0;
      if (version <= (documentStatusVersions.get(data.path) ?? -1)) return;
      documentStatusVersions.set(data.path, version);
      patchDocumentStatus(data.path, data.phase ?? 'settled', data.document);
      return;
    }
    if (['scanStarted', 'scanDone', 'scanFailed', 'syncDone'].includes(data.type) && data.root && data.root !== libraryPath) {
      if (data.requestId) pending.delete(data.requestId);
      return;
    }
    // This is only an acknowledgement; keep the request until its final outcome arrives.
    if (data.type === 'syncStarted') return;
    if (data.type === 'scanStarted') { setScanBusy(true); return; }
    if (data.type === 'scanProgress') {
      if (data.root && data.root !== libraryPath) return;
      updateScanProgress(data.percent, data.message);
      return;
    }
    if (data.type === 'scanFailed') { setScanBusy(false); return; }
    if (data.type === 'scanDone') {
      finishScan();
      // Manual scans also get a final reply; only that reply owns their completion toast.
      if ([...pending.values()].some(task => task.type === 'sync')) return;
      toast(tr(data.paused ? 'scanPaused' : 'syncFinished'), data.paused ? 'info' : 'success');
      return;
    }
    if (data.type === 'changed') {
      if (data.root && data.root !== libraryPath) return;
      if (data.issuesTotal !== undefined) applyIssueCount(data.issuesTotal);
      applyDirectories(data.directories);
      if (data.change?.kind === 'scanBatch') {
        applyTags(data.tags ?? [], false);
        refreshPage();
        if ((byId('search-dialog') as HTMLDialogElement).open && ![...pending.values()].some(task => task.type === 'search')) queueSearch();
        return;
      }
      if (data.change?.kind === 'tagColor') {
        const scroll = byId('documents-scroll').scrollTop;
        applyTags(data.tags ?? [], false); renderDocs();
        byId('documents-scroll').scrollTop = scroll;
        return;
      }
      // Re-filing one document patches that single row: the list keeps its scroll position and
      // never blanks. Everything else the backend reports — an import, a deletion, a tag rename —
      // still reloads it, because a row can have appeared or disappeared anywhere.
      if (data.change?.kind === 'tagToggle') {
        applyTags(data.tags ?? [], false);
        patchTagToggle(String(data.change.documentId ?? ''), data.change.tags ?? []);
        // Catalogue counts also cover changes outside the loaded window. All sources keeps its
        // total: adding/removing a tag cannot add/remove a document (nor may multi-tag counts be summed).
        if (!showIssues && selectedTag !== null) total = tags.find((tag) => tag.id === selectedTag)?.count ?? total;
        byId('count').textContent = tr('totalFiles', { count: total });
        byId('list-end').textContent = docs.length < total ? tr('loaded', { shown: docs.length, total }) : '';
        if ((byId('search-dialog') as HTMLDialogElement).open) queueSearch();
        return;
      }
      // Same-library catalogue updates retain the visible snapshot until its replacement arrives.
      applyTags(data.tags ?? [], false);
      pageEpoch++; loadingPage = false; refreshQueued = false;
      refreshPage();
      if ((byId('search-dialog') as HTMLDialogElement).open) queueSearch();
      return;
    }
    const task = data.requestId && pending.get(data.requestId);
    if (!task) return;
    pending.delete(data.requestId!);
    if (task.root && (task.root !== libraryPath || (task.version !== undefined && task.version !== libraryVersion))) return;
    if (isLibraryScoped(task.type) && data.root && libraryPath && data.root !== libraryPath) return;
    if (task.type === 'search' && (task.epoch !== searchEpoch || !(byId('search-dialog') as HTMLDialogElement).open)) return;
    if ((task.type === 'page' || task.type === 'locate') && task.epoch !== pageEpoch) return;
    if (data.type === 'error') {
      loadingPage = false;
      byId('list-end').textContent = '';
      if (task.type === 'sync') { setScanBusy(false); return; }
      if(task.type==='libraryRename'&&editingLibrary&&editingLibrary.id===data.id){editingLibrary.saving=false;editingLibrary.error=data.error;}
      if (task.type.startsWith('library')) {setLibraryBusy(false);if(data.library){const changed=applyLibrary(data.library);if(changed&&data.library.selected){request('tags');resetPage();}}}
      if(task.type==='libraryRename'&&editingLibrary&&editingLibrary.id===data.id)byId('library-list').querySelector<HTMLInputElement>('.library-name-input')?.focus();
      toast(data.error ?? '', 'error'); return;
    }
    switch (data.type) {
      case 'tags': {
        const changed = applyLibrary(data.library);
        if (data.issuesTotal !== undefined) applyIssueCount(data.issuesTotal);
        applyDirectories(data.directories);
        applyTags(data.tags ?? []);
        applyEnvironment(data.environment);
        if (data.scanning !== undefined) setScanBusy(data.scanning);
        if (changed) resetPage();
        break;
      }
      case 'preferences': break;
      case 'environmentHelpOpened':
        // The chat opens in front of this page, so the hand-off speaks for itself.
        break;
      case 'library':
        applyLibrary(data.library);
        break;
      case 'syncDone': {
        finishScan();
        toast(tr(data.sync?.paused ? 'scanPaused' : 'syncFinished'), data.sync?.paused ? 'info' : 'success');
        // Also reconciles hosts where only the manual reply reaches the page.
        break;
      }
      case 'libraryEntered':
        applyLibrary(data.library);
        applyEnvironment(data.environment);
        request('tags'); resetPage();
        break;
      case 'libraryRenamed':
        applyLibrary(data.library);if(editingLibrary?.id===data.id)endLibraryEdit();break;
      case 'libraryRemoved':
        setLibraryBusy(false);applyLibrary(data.library);toast(data.warning??tr('libraryRemoved'),data.warning?'warning':'success');break;
      case 'libraryRevealed':
        setLibraryBusy(false); break;
      case 'libraryCanceled':
        setLibraryBusy(false); break;
      case 'libraryDone': {
        setLibraryBusy(false);
        environmentAutoStarted = false;
        applyLibrary(data.library);
        applyEnvironment(data.environment);
        const key = data.library?.indexStorage === 'local' ? 'libraryDoneRemote' : data.mode === 'switch' ? 'libraryDoneSwitch' : data.mode === 'open' ? 'libraryDoneOpen' : 'libraryDoneCreate';
        toast(tr(key, { path: data.library?.root ?? '', name: data.library?.name ?? data.library?.root ?? '' }), 'success');
        // The listing, counts and tags all belong to the previous directory.
        request('tags');
        resetPage();
        break;
      }
      case 'tagCreated':
        // The inline row closes itself; an error keeps it open so the name can be fixed.
        creatingTag = false;
        if (data.tag) { showIssues = false; updateSortSizer(); selectedDirectory = null; selectedTag = data.tag.id; tags.push(data.tag); renderDirectories(); renderTags(); resetPage(); }
        break;
      case 'page': {
        if(data.catalogVersion!==undefined&&data.catalogVersion<catalogVersion){loadingPage=false;refreshPage();break;}
        if(data.catalogVersion!==undefined)catalogVersion=data.catalogVersion;
        const container = byId('documents-scroll');
        const oldHeight = container.scrollHeight;
        const offset = data.offset ?? 0;
        const mode = task.mode ?? 'replace';
        const anchor = mode === 'refresh' ? visibleAnchor() : { path: undefined, index: 0, top: 0 }, scroll = container.scrollTop;
        if (mode === 'replace' || mode === 'locate' || mode === 'refresh') { docs = data.documents ?? []; beforeOffset = offset; nextOffset = offset + docs.length; if (mode !== 'refresh') container.scrollTop = 0; }
        else if (mode === 'prepend') { docs = [...(data.documents ?? []), ...docs]; beforeOffset = offset; }
        else { docs = [...docs, ...(data.documents ?? [])]; nextOffset = offset + (data.documents?.length ?? 0); }
        if(mode==='replace'||mode==='locate'||mode==='refresh'||mode==='append')nextCursor=data.nextCursor;
        if(mode==='replace'||mode==='locate'||mode==='refresh'||mode==='prepend')previousCursor=data.previousCursor;
        total = data.total ?? 0; loadingPage = false;
        renderDocs(data.focusId, mode === 'refresh');
        if (mode === 'refresh') {
          const row = Array.from(byId('documents').children).find(item => (item as HTMLElement).dataset.path === anchor.path);
          container.scrollTop = scroll;
          if (row) container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.top;
        }
        if (refreshQueued) refreshPage();
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
  byId('onboard-enter').addEventListener('click', () => request('enterLibrary'));
  byId('onboard-retry').addEventListener('click', () => {
    if (environment) renderEnvironment({ ...environment, running: true });
    request('environmentInstall');
  });
  byId('onboard-help').addEventListener('click', () => {
    toast(tr('onboardHelpOpening'), 'info');
    request('environmentHelp');
  });
  // Adding registers the chosen directory and opens its own index in place.
  // Existing libraries remain registered; no files or index data are copied.
  for (const id of ['onboard-library-action', 'library-location']) {
    byId(id).addEventListener('click', (event) => {
      if (libraryBusy) return;
      event.stopPropagation();
      if(id==='onboard-library-action'&&!libraryPath&&libraryEntries.length){setMenu(!menuOpen('libraries'),'libraries',byId(id));return;}
      setMenu(false);
      setLibraryBusy(true);
      request('libraryAction', { mode: 'choose' });
    });
  }
  byId('library-environment').addEventListener('click', () => {
    if (libraryBusy) return;
    setMenu(false);
    environmentAutoStarted = true;
    if (environment) renderEnvironment({ ...environment, running: true });
    renderEnvironmentMenu();
    request('environmentInstall');
  });
  for (const [id, kind] of [['library-picker-button', 'libraries'], ['library-menu-button', 'actions']] as const) {
    byId(id).addEventListener('click', (event) => {
      event.stopPropagation();
      if (!libraryBusy) setMenu(!menuOpen(kind), kind);
    });
  }
  document.addEventListener('click', (event) => {
    if (!menuOpen()) return;
    const target = event.target as Node | null;
    if (target && ['library-menu', 'library-actions-menu', 'library-picker-button', 'library-menu-button','onboard-library-action'].some(id => byId(id).contains(target))) return;
    setMenu(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menuOpen()) { event.preventDefault(); setMenu(false); libraryMenuTrigger().focus(); }
  });
  byId('open-directory').addEventListener('click', () => {
    if (libraryBusy) return;
    setMenu(false);
    setLibraryBusy(true);
    request('libraryReveal');
  });
  window.addEventListener('resize', () => setMenu(false));
  byId('sync').addEventListener('click', requestScan);
  byId('settings-scan').addEventListener('click', requestScan);
  byId('hide-unsupported').addEventListener('click', () => request('preferences', { hideUnsupported: byId('hide-unsupported').getAttribute('aria-checked') !== 'true' }));
  const isFileDrag = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  document.addEventListener('dragenter', (event) => { if (isFileDrag(event)) { event.preventDefault(); document.body.classList.add('dragging-file'); } });
  document.addEventListener('dragover', (event) => { if (isFileDrag(event)) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; } });
  document.addEventListener('dragleave', (event) => { if (!event.relatedTarget) document.body.classList.remove('dragging-file'); });
  document.addEventListener('drop', (event) => { if (!isFileDrag(event)) return; event.preventDefault(); document.body.classList.remove('dragging-file'); toast(tr('directoryDropHint'), 'info'); });
  byId('documents-scroll').addEventListener('scroll', () => {
    if (loadingPage || total <= docs.length) return;
    const view = byId('documents-scroll');
    if (view.scrollTop < 80 && beforeOffset > 0) page(Math.max(0, beforeOffset - 50), 'prepend');
    else if (view.scrollTop + view.clientHeight > view.scrollHeight - 180 && nextOffset < total) page(nextOffset, 'append');
  });
  wireWindowActivity();
  wireTagContextMenu();
  wireColumns();
  wireWorkspaceResize(byId('workspace'), byId('workspace-resizer'));
  wireTagColor();
  wireSearchDialog();
} else { status(tr('unavailable'), true); void localeChanged(navigator.language || 'en-US'); }

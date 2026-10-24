import type * as finch from 'finch';
import { el, icon, labelButton, notice, paintIcons, textNode, installTooltips } from './gallery-dom';
import { imageDimensions, masonryMetrics, type GalleryItem } from './gallery-model';
import { setLocale, t } from './gallery-i18n';
import { GalleryEditor } from './gallery-editor';
import { insertComposerRequest } from './gallery-composer';
import { captureCards, animateCards } from './gallery-motion';

const api = (window as Window & { finch?: finch.WebviewBridgeApi }).finch;
const grid = el('grid');
let records: GalleryItem[] = [];
let view = '';
let sessionId = '';
let filter: 'all' | 'current' = 'all';
let pickedFilter = false;
let authoritativeEnv = false;
let canSend = false;
const cache = new Map<string, string>();
const thumbs = new Map<string, string>();
/**
 * One in-flight request per (variant, path). The reply carries the variant that
 * was actually sent, so a `thumb` request can be answered with the original when
 * no thumbnail exists yet.
 */
type Variant = 'thumb' | 'full';
type Reply = { dataUrl: string; variant: Variant };
const waiting = new Map<string, { resolve: (value: Reply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

/** Event-driven image RPC, not a polling timer; rejected requests stay retryable. */
function requestImage(filePath: string, variant: Variant): Promise<Reply> {
  if (!api) return Promise.reject(new Error(t('image.failed')));
  return new Promise((resolve, reject) => {
    const key = `${variant}|${filePath}`;
    const previous = waiting.get(key);
    if (previous) {
      const oldResolve = previous.resolve; const oldReject = previous.reject;
      previous.resolve = (value) => { oldResolve(value); resolve(value); };
      previous.reject = (error) => { oldReject(error); reject(error); };
      return;
    }
    const timer = setTimeout(() => { waiting.delete(key); reject(new Error(t('image.failed'))); }, 12000);
    waiting.set(key, { resolve, reject, timer });
    api.postMessage({ type: 'requestImage', filePath, variant });
  });
}

/** The original bytes: for the editor, the preview and attaching by hand. */
function getImage(filePath: string): Promise<string> {
  const cached = cache.get(filePath);
  if (cached) return Promise.resolve(cached);
  return requestImage(filePath, 'full').then((reply) => {
    cache.set(filePath, reply.dataUrl);
    if (cache.size > 12) cache.delete(cache.keys().next().value!);
    return reply.dataUrl;
  });
}

/** A grid-sized copy if one has been kept, otherwise the original. */
function getThumb(filePath: string): Promise<string> {
  const cached = thumbs.get(filePath);
  if (cached) return Promise.resolve(cached);
  return requestImage(filePath, 'thumb').then((reply) => {
    if (reply.variant === 'thumb') {
      thumbs.set(filePath, reply.dataUrl);
      if (thumbs.size > 400) thumbs.delete(thumbs.keys().next().value!);
    } else {
      cache.set(filePath, reply.dataUrl);
    }
    return reply.dataUrl;
  });
}

/**
 * Shrink a decoded picture for the grid and hand it back for keeping. The page
 * is the only side with an image decoder, so this is where thumbnails come from.
 */
function keepThumb(filePath: string, img: HTMLImageElement): void {
  if (thumbs.has(filePath) || !api) return;
  try {
    const max = 440;
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/webp', .72);
    if (!dataUrl.startsWith('data:image/webp;base64,') || dataUrl.length < 128) return;
    thumbs.set(filePath, dataUrl);
    api.postMessage({ type: 'saveThumb', filePath, dataUrl });
  } catch {
    // A thumbnail is an optimisation: any failure just means the original is
    // sent again next time.
  }
}

const editor = new GalleryEditor(api, getImage, (draft) => {
  const record = records.find((item) => item.id === draft.id);
  if (record) { record.annotations = draft.annotations; record.note = draft.note; }
  el('app').hidden = false;
  render();
});
/**
 * Cards and their already-decoded images survive a re-layout. Rebuilding them
 * would blank every picture and force a fresh decode, which reads as the image
 * "reloading and flashing" on every window resize.
 */
const cardCache = new Map<string, HTMLElement>();
let pendingEdit = '';

/** Opens the editor for one record, whether the click or the extension asked. */
function openEditorFor(id: string): void {
  const record = records.find((item) => item.id === id);
  if (!record) { pendingEdit = id; return; }
  pendingEdit = '';
  el('app').hidden = true;
  void editor.open(record);
}

/**
 * Cards load only once they are, or are about to be, on screen. A gallery can
 * hold thousands of records and every request is real image bytes, so loading
 * them all at once is what made opening the library feel slow.
 */
const lazy = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    lazy.unobserve(entry.target);
    const card = entry.target as HTMLElement;
    const img = card.querySelector('img');
    const filePath = card.dataset.path;
    if (!img || !filePath) return;
    // A reused card keeps its decoded bitmap: never re-assign a live src.
    if (img.dataset.loaded === '1') return;
    getThumb(filePath).then((dataUrl) => {
      if (!img.isConnected || img.dataset.loaded === '1') return;
      img.onload = () => {
        img.dataset.loaded = '1';
        const record = records.find((r) => r.filePath === filePath);
        if (record && (!record.width || !record.height)) {
          record.width = img.naturalWidth; record.height = img.naturalHeight;
          card.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
        }
        // Only the original needs shrinking; a kept thumbnail is already small.
        if (!dataUrl.startsWith('data:image/webp;base64,')) keepThumb(filePath, img);
        card.querySelector<HTMLElement>('.image-placeholder')?.remove();
      };
      img.src = dataUrl;
    }).catch(() => { card.querySelector<HTMLElement>('.image-placeholder')?.setAttribute('title', t('image.failed')); });
  });
}, { rootMargin: '160px' });

/**
 * Editing happens where the edit can be delivered. The App View is a browsing
 * surface with no Composer, so its cards jump to the Session that produced the
 * image instead; the right-side Panel is where the editor opens.
 */
function editableHere(): boolean {
  return view !== 'appView';
}

/** Only a scope with a Composer of its own can take an attachment. */
function composerHere(): boolean {
  return view === 'session' || view === 'home';
}

/** Which actions a card offers depends on the surface, so a scope change must
 * rebuild the cached cards or the previous buttons stay on screen. */
function cardSurface(): string {
  return `${editableHere() ? 'edit' : 'adjust'}${composerHere() ? '+insert' : ''}`;
}

function applyEnv(env: Record<string, unknown>): void {
  const wasSurface = cardSurface();
  view = typeof env.view === 'string' ? env.view : view;
  sessionId = typeof env.sessionId === 'string' ? env.sessionId : sessionId;
  if (!view && sessionId) view = 'session';
  if (typeof env.locale === 'string') setLocale(env.locale);
  if (typeof env.canSend === 'boolean') canSend = env.canSend;
  if (!pickedFilter) filter = view === 'session' && sessionId ? 'current' : 'all';
  if (view !== 'session' || !sessionId) filter = 'all';
  if (wasSurface !== cardSurface()) cardCache.clear();
  editor.setScope(view, canSend);
  paintCopy();
}

api?.onMessage((raw) => {
  if (!raw || typeof raw !== 'object') return;
  const message = raw as Record<string, unknown>;
  if (message.type === 'finch:env') {
    authoritativeEnv = true; applyEnv(message); render();
  } else if (message.type === 'gallery') {
    if (Array.isArray(message.data)) records = message.data as GalleryItem[];
    if (!authoritativeEnv && message.env && typeof message.env === 'object') applyEnv(message.env as Record<string, unknown>);
    render();
    if (pendingEdit) openEditorFor(pendingEdit);
  } else if (message.type === 'imageData' && typeof message.filePath === 'string') {
    const filePath = message.filePath;
    const variant: Variant = message.variant === 'thumb' ? 'thumb' : 'full';
    // A thumb request is answered with the original when none exists yet, so
    // fall back to the other key before giving up on the reply.
    const pending = waiting.get(`${variant}|${filePath}`) ?? waiting.get(`${variant === 'thumb' ? 'full' : 'thumb'}|${filePath}`);
    if (pending) {
      for (const [key, entry] of waiting) if (entry === pending) { clearTimeout(entry.timer); waiting.delete(key); }
    }
    if (typeof message.dataUrl === 'string' && message.dataUrl.startsWith('data:image/')) {
      pending?.resolve({ dataUrl: message.dataUrl, variant });
    } else pending?.reject(new Error(t(message.error === 'too-large' ? 'image.large' : 'image.failed')));
  } else if (message.type === 'annotationsSaved' || message.type === 'panelError') {
    editor.onSaved(message);
  } else if (message.type === 'annotationSendResult') {
    editor.onSendResult(message);
  } else if (message.type === 'editImage' && typeof message.id === 'string') {
    openEditorFor(message.id);
  } else if (message.type === 'adjustResult' && typeof message.error === 'string') {
    notice(t(message.error === 'no-session' ? 'adjust.noSession' : 'adjust.failed'));
  } else if (message.type === 'deleteResult') {
    records = records.filter((r) => r.id !== message.id); render(); notice(t('removed'));
  }
});

function paintCopy(): void {
  el('title').textContent = t('title'); document.title = t('title');
  el('tabs').setAttribute('aria-label', t('title'));
  paintIcons();
}

/** One page of cards; the rest arrives as the page is scrolled. */
const PAGE_SIZE = 20;
let shown = PAGE_SIZE;

function render(): void {
  if (el('app').hidden) return;
  const before = captureCards(grid);
  const filtered = filter === 'current' ? records.filter((r) => r.sessionId === sessionId) : records;
  // Never render the whole library at once: a big gallery is thousands of
  // pictures, and each visible card costs real image bytes.
  const items = filtered.slice(0, shown);
  el('count').textContent = t('count', { n: filtered.length });
  const tabs = el('tabs'); tabs.replaceChildren();
  const choices: ('all' | 'current')[] = view === 'session' && sessionId ? ['all', 'current'] : ['all'];
  choices.forEach((key) => {
    const button = textNode('button', t(key === 'all' ? 'tab.all' : 'tab.current'), `tab${filter === key ? ' active' : ''}`);
    button.setAttribute('aria-pressed', String(filter === key));
    button.onclick = () => { pickedFilter = true; filter = key; shown = PAGE_SIZE; render(); };
    tabs.append(button);
  });
  const { columns, width } = masonryMetrics(grid.clientWidth);
  layoutColumns = columns;
  layoutWidth = grid.clientWidth;
  grid.style.setProperty('--columns', String(columns));
  grid.style.setProperty('--card-width', `${width}px`);
  el('empty').hidden = filtered.length > 0;
  el('emptyTitle').textContent = t(filter === 'current' ? 'empty.current' : 'empty.title');
  el('emptyHint').textContent = t('empty.hint');
  // Keep the nodes of items that are still shown: their <img> elements hold the
  // decoded bitmap, so moving them into new columns costs no reload.
  lazy.disconnect();
  const live = new Set(items.map((record) => record.id));
  cardCache.forEach((node, id) => { if (!live.has(id)) { node.remove(); cardCache.delete(id); } });
  grid.replaceChildren();
  const heights = Array<number>(columns).fill(0);
  const columnNodes = Array.from({ length: columns }, () => {
    const column = document.createElement('div'); column.className = 'column'; grid.append(column); return column;
  });
  items.forEach((record) => {
    const index = heights.indexOf(Math.min(...heights));
    columnNodes[index].append(cardFor(record));
    const dimensions = imageDimensions(record);
    heights[index] += width * dimensions.height / dimensions.width + 12;
  });
  animateCards(before);
  requestAnimationFrame(updateScrollEdges);
}

/** Reuses an existing card (and its loaded image) instead of rebuilding it. */
function cardFor(record: GalleryItem): HTMLElement {
  const existing = cardCache.get(record.id);
  const card = existing ?? buildCard(record);
  cardCache.set(record.id, card);
  lazy.observe(card);
  return card;
}

function buildCard(record: GalleryItem): HTMLElement {
  const card = document.createElement('article');
  card.className = 'card'; card.tabIndex = 0; card.dataset.path = record.filePath; card.dataset.id = record.id;
  card.setAttribute('aria-label', `${t('card.preview')} · ${record.name}`);
  const { width, height } = imageDimensions(record);
  card.style.aspectRatio = `${width} / ${height}`;
  card.innerHTML = `<span class="image-placeholder">${icon('image')}</span><img alt="" draggable="false"><div class="card-actions"></div><div class="prompt-overlay"><div class="prompt"></div></div>`;
  const actions = card.querySelector<HTMLElement>('.card-actions')!;
  if (composerHere()) {
    // Quick path for the common case: no edits, just hand the picture to the
    // Composer. The bytes come from the same cache the card's own image uses.
    const insert = document.createElement('button'); insert.className = 'card-action'; insert.dataset.act = 'insert'; insert.innerHTML = icon('copy-plus');
    labelButton(insert, t('card.insert'));
    insert.onclick = (event) => { event.stopPropagation(); attachToComposer(record); };
    actions.append(insert);
    // addContexts needs the bytes at click time (a real gesture), so warm them
    // while the pointer is on the card rather than discovering a miss then.
    card.onpointerenter = () => { if (!cache.has(record.filePath)) void getImage(record.filePath).catch(() => {}); };
  }
  if (editableHere()) {
    const edit = document.createElement('button'); edit.className = 'card-action'; edit.dataset.act = 'edit'; edit.innerHTML = icon('pencil-line');
    labelButton(edit, t('card.edit'));
    edit.onclick = (event) => { event.stopPropagation(); openEditorFor(record.id); };
    actions.append(edit);
  } else if (record.sessionId) {
    // No Composer here, so the card opens the Session instead of the editor.
    const adjust = document.createElement('button'); adjust.className = 'card-action'; adjust.dataset.act = 'adjust'; adjust.innerHTML = icon('arrow-up-right');
    labelButton(adjust, t('card.adjust'));
    adjust.onclick = (event) => { event.stopPropagation(); api?.postMessage({ type: 'adjustImage', id: record.id }); };
    actions.append(adjust);
  }
  const remove = document.createElement('button'); remove.className = 'card-action danger'; remove.dataset.act = 'remove'; remove.innerHTML = icon('trash-2');
  labelButton(remove, t('card.remove'));
  remove.onclick = (event) => { event.stopPropagation(); void removeRecord(record); };
  actions.append(remove);
  card.querySelector<HTMLElement>('.prompt')!.textContent = record.prompt;
  card.onclick = () => {
    if (api?.appView) void api.appView.openPreview(record.filePath).catch(() => api.postMessage({ type: 'openPreview', filePath: record.filePath }));
  };
  card.onkeydown = (event) => { if (event.target === card && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); card.click(); } };
  return card;
}

async function removeRecord(record: GalleryItem): Promise<void> {
  if (!api) return;
  const { confirmed } = await api.ui.confirm({ title: t('remove.title'), message: t('remove.body'), confirmLabel: t('remove.confirm'), cancelLabel: t('cancel'), variant: 'danger' });
  if (confirmed) api.postMessage({ type: 'deleteRecord', id: record.id, deleteFile: false });
}

/**
 * Hands the original picture to the Composer as a quoted reference (the host
 * turns `[quote]<path>[/quote]` into an image reference), with the prompt that
 * produced it as quoted detail. Deliberately synchronous up to the insert call:
 * it needs the live user gesture, so the bytes have to be ready before the click.
 */
function attachToComposer(record: GalleryItem): void {
  if (!api) return;
  const dataUrl = cache.get(record.filePath);
  if (!dataUrl) {
    // Rare: the bytes were evicted or are still arriving. Warm them back up and
    // say so, instead of silently doing nothing.
    notice(t('insert.loading'));
    void getImage(record.filePath).catch(() => {});
    return;
  }
  const comma = dataUrl.indexOf(',');
  const mimeType = /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? 'image/png';
  // No toast of our own: the new reference appears in the input box, and an
  // outdated host still announces the annotation it had to fall back to.
  void insertComposerRequest(api, {
    quoted: record.prompt,
    imagePath: record.filePath,
    // Bytes only matter to hosts that have no reference syntax yet.
    attachment: {
      type: 'image-region', name: record.name, mimeType,
      content: dataUrl.slice(comma + 1), regions: [],
    },
    legacyText: record.prompt,
  }).catch(() => notice(t('insert.failed')));
}

let layoutFrame = 0;
let layoutWidth = -1;
let layoutColumns = 0;
new ResizeObserver(([entry]) => {
  const width = entry.contentRect.width;
  // Image decoding and route changes affect height, not column packing. Do
  // not rebuild focused/hovered cards on those changes or while hidden.
  if (el('app').hidden || width <= 0 || Math.abs(width - layoutWidth) < .5) return;
  layoutWidth = width;
  const { columns, width: cardWidth } = masonryMetrics(width);
  if (columns === layoutColumns && layoutColumns > 0) {
    // Same packing, only narrower cards: a pure CSS change. Rebuilding here is
    // what made every picture blank out and flash while resizing.
    const before = captureCards(grid);
    grid.style.setProperty('--card-width', `${cardWidth}px`);
    animateCards(before);
    requestAnimationFrame(updateScrollEdges);
    return;
  }
  cancelAnimationFrame(layoutFrame);
  layoutFrame = requestAnimationFrame(render);
}).observe(grid);

function visibleRecords(): GalleryItem[] {
  return filter === 'current' ? records.filter((r) => r.sessionId === sessionId) : records;
}

/** One more page of cards, if the library has one. */
function pageMore(): void {
  if (shown >= visibleRecords().length) return;
  shown += PAGE_SIZE;
  render();
}

/** A short page in a tall window never scrolls, so keep paging until it does. */
function fillViewport(): void {
  if (document.documentElement.scrollHeight <= window.innerHeight + 8) pageMore();
}

/** Only shade edges where actual cards continue beyond the visible area. */
function updateScrollEdges(): void {
  if (el('app').hidden) return;
  const bar = el('topbar');
  const bounds = grid.getBoundingClientRect();
  bar.classList.toggle('stuck', window.scrollY > 1);
  bar.classList.toggle('has-before', bounds.top < bar.getBoundingClientRect().bottom - 1 && window.scrollY > 1);
  el('scrollShadeBottom').classList.toggle('has-after', bounds.bottom > window.innerHeight + 1);
}

let scrollFrame = 0;
/**
 * Two jobs on scroll: reveal the divider once the grid slides under the sticky
 * title, and grow the window before the user actually hits the bottom.
 */
function onScroll(): void {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    updateScrollEdges();
    if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 480) pageMore();
    fillViewport();
  });
}
window.addEventListener('scroll', onScroll, { passive: true });
window.addEventListener('resize', onScroll, { passive: true });

installTooltips();
paintCopy(); render();
requestAnimationFrame(fillViewport);
api?.postMessage({ type: 'requestGallery' });

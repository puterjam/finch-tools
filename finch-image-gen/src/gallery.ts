import type * as finch from 'finch';
import { el, icon, labelButton, notice, paintIcons, textNode } from './gallery-dom';
import { imageDimensions, masonryMetrics, type GalleryItem } from './gallery-model';
import { setLocale, t } from './gallery-i18n';
import { GalleryEditor } from './gallery-editor';

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
const waiting = new Map<string, { resolve: (value: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

/** Event-driven image RPC, not a polling timer; rejected requests stay retryable. */
function getImage(filePath: string): Promise<string> {
  const cached = cache.get(filePath);
  if (cached) return Promise.resolve(cached);
  if (!api) return Promise.reject(new Error(t('image.failed')));
  // The gallery does not need the original bytes before an item is visible.
  return new Promise((resolve, reject) => {
    const previous = waiting.get(filePath);
    if (previous) {
      const oldResolve = previous.resolve; const oldReject = previous.reject;
      previous.resolve = (value) => { oldResolve(value); resolve(value); };
      previous.reject = (error) => { oldReject(error); reject(error); };
      return;
    }
    const timer = setTimeout(() => { waiting.delete(filePath); reject(new Error(t('image.failed'))); }, 12000);
    waiting.set(filePath, { resolve, reject, timer });
    api.postMessage({ type: 'requestImage', filePath });
  });
}

const editor = new GalleryEditor(api, getImage, (draft) => {
  const record = records.find((item) => item.id === draft.id);
  if (record) { record.annotations = draft.annotations; record.note = draft.note; }
  el('app').hidden = false;
  render();
});
const lazy = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    lazy.unobserve(entry.target);
    const card = entry.target as HTMLElement;
    const img = card.querySelector('img');
    const filePath = card.dataset.path;
    if (!img || !filePath) return;
    getImage(filePath).then((dataUrl) => {
      if (!img.isConnected) return;
      img.onload = () => {
        const record = records.find((r) => r.filePath === filePath);
        if (record && (!record.width || !record.height)) {
          record.width = img.naturalWidth; record.height = img.naturalHeight;
          card.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
        }
        card.querySelector<HTMLElement>('.image-placeholder')?.remove();
      };
      img.src = dataUrl;
    }).catch(() => { card.querySelector<HTMLElement>('.image-placeholder')?.setAttribute('title', t('image.failed')); });
  });
}, { rootMargin: '240px' });

function applyEnv(env: Record<string, unknown>): void {
  view = typeof env.view === 'string' ? env.view : view;
  sessionId = typeof env.sessionId === 'string' ? env.sessionId : sessionId;
  if (!view && sessionId) view = 'session';
  if (typeof env.locale === 'string') setLocale(env.locale);
  if (typeof env.canSend === 'boolean') canSend = env.canSend;
  if (!pickedFilter) filter = view === 'session' && sessionId ? 'current' : 'all';
  if (view !== 'session' || !sessionId) filter = 'all';
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
  } else if (message.type === 'imageData' && typeof message.filePath === 'string') {
    const pending = waiting.get(message.filePath);
    if (pending) { clearTimeout(pending.timer); waiting.delete(message.filePath); }
    if (typeof message.dataUrl === 'string' && message.dataUrl.startsWith('data:image/')) {
      cache.set(message.filePath, message.dataUrl);
      if (cache.size > 48) cache.delete(cache.keys().next().value!);
      pending?.resolve(message.dataUrl);
    } else pending?.reject(new Error(t(message.error === 'too-large' ? 'image.large' : 'image.failed')));
  } else if (message.type === 'annotationsSaved' || message.type === 'panelError') {
    editor.onSaved(message);
  } else if (message.type === 'annotationSendResult') {
    editor.onSendResult(message);
  } else if (message.type === 'deleteResult') {
    records = records.filter((r) => r.id !== message.id); render(); notice(t('removed'));
  }
});

function paintCopy(): void {
  el('title').textContent = t('title'); document.title = 'Image 2.5';
  el('tabs').setAttribute('aria-label', t('title'));
  paintIcons();
}

function render(): void {
  if (el('app').hidden) return;
  const items = filter === 'current' ? records.filter((r) => r.sessionId === sessionId) : records;
  el('count').textContent = t('count', { n: items.length });
  const tabs = el('tabs'); tabs.replaceChildren();
  const choices: ('all' | 'current')[] = view === 'session' && sessionId ? ['all', 'current'] : ['all'];
  choices.forEach((key) => {
    const button = textNode('button', t(key === 'all' ? 'tab.all' : 'tab.current'), `tab${filter === key ? ' active' : ''}`);
    button.setAttribute('aria-pressed', String(filter === key));
    button.onclick = () => { pickedFilter = true; filter = key; render(); };
    tabs.append(button);
  });
  lazy.disconnect(); grid.replaceChildren();
  el('empty').hidden = items.length > 0;
  el('emptyTitle').textContent = t(filter === 'current' ? 'empty.current' : 'empty.title');
  el('emptyHint').textContent = t('empty.hint');
  const { columns, width } = masonryMetrics(grid.clientWidth);
  grid.style.setProperty('--columns', String(columns));
  grid.style.setProperty('--card-width', `${width}px`);
  const heights = Array<number>(columns).fill(0);
  const columnNodes = Array.from({ length: columns }, () => {
    const column = document.createElement('div'); column.className = 'column'; grid.append(column); return column;
  });
  items.forEach((record) => {
    const index = heights.indexOf(Math.min(...heights));
    columnNodes[index].append(buildCard(record));
    const dimensions = imageDimensions(record);
    heights[index] += width * dimensions.height / dimensions.width + 12;
  });
}

function buildCard(record: GalleryItem): HTMLElement {
  const card = document.createElement('article');
  card.className = 'card'; card.tabIndex = 0; card.dataset.path = record.filePath; card.dataset.id = record.id;
  card.setAttribute('aria-label', `${t('card.preview')} · ${record.name}`);
  const { width, height } = imageDimensions(record);
  card.style.aspectRatio = `${width} / ${height}`;
  card.innerHTML = `<span class="image-placeholder">${icon('image')}</span><img alt="" draggable="false"><div class="badges"></div><div class="card-actions"></div><div class="prompt-overlay"><div class="prompt"></div></div>`;
  const badges = card.querySelector<HTMLElement>('.badges')!;
  const format = String(record.format || record.name.split('.').pop() || 'png').toUpperCase();
  badges.append(textNode('span', format, 'badge'), textNode('span', `${width}×${height}`, 'badge'));
  badges.title = `${record.model} · ${record.quality} · ${format} · ${width}×${height}`;
  const actions = card.querySelector<HTMLElement>('.card-actions')!;
  const edit = document.createElement('button'); edit.className = 'card-action'; edit.dataset.act = 'edit'; edit.innerHTML = icon('pencil-line');
  labelButton(edit, t('card.edit'));
  edit.onclick = (event) => { event.stopPropagation(); el('app').hidden = true; void editor.open(record); };
  const remove = document.createElement('button'); remove.className = 'card-action danger'; remove.dataset.act = 'remove'; remove.innerHTML = icon('trash-2');
  labelButton(remove, t('card.remove'));
  remove.onclick = (event) => { event.stopPropagation(); void removeRecord(record); };
  actions.append(edit, remove);
  card.querySelector<HTMLElement>('.prompt')!.textContent = record.prompt;
  card.onclick = () => {
    if (api?.appView) void api.appView.openPreview(record.filePath).catch(() => api.postMessage({ type: 'openPreview', filePath: record.filePath }));
  };
  card.onkeydown = (event) => { if (event.target === card && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); card.click(); } };
  lazy.observe(card);
  return card;
}

async function removeRecord(record: GalleryItem): Promise<void> {
  if (!api) return;
  const { confirmed } = await api.ui.confirm({ title: t('remove.title'), message: t('remove.body'), confirmLabel: t('remove.confirm'), cancelLabel: t('cancel'), variant: 'danger' });
  if (confirmed) api.postMessage({ type: 'deleteRecord', id: record.id, deleteFile: false });
}

let layoutFrame = 0;
let layoutWidth = -1;
new ResizeObserver(([entry]) => {
  const width = entry.contentRect.width;
  // Image decoding and route changes affect height, not column packing. Do
  // not rebuild focused/hovered cards on those changes or while hidden.
  if (el('app').hidden || width <= 0 || Math.abs(width - layoutWidth) < .5) return;
  layoutWidth = width;
  cancelAnimationFrame(layoutFrame);
  layoutFrame = requestAnimationFrame(render);
}).observe(grid);
paintCopy(); render();
api?.postMessage({ type: 'requestGallery' });

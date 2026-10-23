import type * as finch from 'finch';
import { el, icon, labelButton, notice } from './gallery-dom';
import { clamp, emptyAnnotations, parseAnnotations, type GalleryAnnotations, type GalleryItem, type ImageComment, type Point, type Stroke } from './gallery-model';
import { t } from './gallery-i18n';

type Mode = 'view' | 'pen' | 'comment';
type AnnotationDraft = Extract<finch.ComposerContextDraft, { type: 'annotation' }>;
const clone = (data: GalleryAnnotations): GalleryAnnotations => structuredClone(data);
const uid = (): string => crypto.randomUUID();
/** Keeps the floating bubble inside the stage. */
const between = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);
/** Escaping for the few places a row is built as markup rather than nodes. */
const escapeText = (value: string): string => value.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch] as string);
const MAX_STROKES = 100;
const MAX_COMMENTS = 50;
const MAX_POINTS = 20000;
const POPOVER_WIDTH = 232;

/** Same aspect presets the Composer menu writes, so both surfaces agree. */
const SIZE_OPTIONS = [
  { size: '1024x1024', ratio: '1:1', icon: 'square', label: 'size.square' },
  { size: '768x1024', ratio: '3:4', icon: 'rectangle-vertical', label: 'size.portrait' },
  { size: '720x1280', ratio: '9:16', icon: 'rectangle-vertical', label: 'size.story' },
  { size: '1024x768', ratio: '4:3', icon: 'rectangle-horizontal', label: 'size.landscape' },
  { size: '1280x720', ratio: '16:9', icon: 'rectangle-horizontal', label: 'size.wide' },
  { size: 'auto', ratio: '', icon: 'image-upscale', label: 'size.auto' },
] as const;

/** A route within the webview, with image-relative geometry and prebuilt evidence. */
export class GalleryEditor {
  private item: GalleryItem | null = null;
  private data = emptyAnnotations();
  private history: GalleryAnnotations[] = [];
  private mode: Mode = 'view';
  private scope = '';
  private canSend = false;
  private stroke: Stroke | null = null;
  private activeComment = '';
  private pinDrag: { id: string; moved: boolean } | null = null;
  private revision = 0;
  private preparedRevision = -1;
  private annotated: AnnotationDraft | null = null;
  /** Image-only attachment: the instructions travel separately as an editable draft. */
  private attachment: AnnotationDraft | null = null;
  private loaded = false;
  private busy = false;
  private pendingSend = '';
  private attempt = 0;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private instruction = '';
  private sourceUrl = '';
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingSave = '';
  private prepareFrame = 0;
  private dirty = false;
  /** The default output size, mirrored from the extension so both agree. */
  private outputSize = '1024x1024';
  private readonly image = el<HTMLImageElement>('editorImage');
  private readonly surface = el('imageSurface');
  private readonly stage = el('stage');
  private readonly popover = el('commentPopover');

  constructor(
    private readonly api: finch.WebviewBridgeApi | undefined,
    private readonly getImage: (path: string) => Promise<string>,
    private readonly onClose: (draft: GalleryItem) => void,
  ) {
    el('back').onclick = () => this.close();
    el('toolPen').onclick = () => this.setMode(this.mode === 'pen' ? 'view' : 'pen');
    el('toolComment').onclick = () => this.setMode(this.mode === 'comment' ? 'view' : 'comment');
    el('undo').onclick = () => this.undo();
    el('clear').onclick = () => { void this.clear(); };
    el('send').onclick = () => { void this.deliver(); };
    el('deleteComment').onclick = () => this.removeActiveComment();
    el('toolSize').onclick = () => (el('sizeMenu').hidden ? this.openSizeMenu() : this.closeSizeMenu());
    const instruction = el<HTMLTextAreaElement>('instruction');
    instruction.maxLength = 8000;
    instruction.oninput = () => { this.instruction = instruction.value; this.grow(instruction); this.changed(false); };
    instruction.onkeydown = (event) => {
      // Enter sends, Shift+Enter adds a line — the footer stays a single row.
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void this.deliver(); }
    };
    const text = el<HTMLTextAreaElement>('commentText');
    text.maxLength = 4000;
    text.oninput = () => {
      const comment = this.active();
      if (!comment) return;
      comment.text = text.value;
      this.syncPinLabel(comment);
      this.changed(false);
    };
    this.surface.addEventListener('pointerdown', (event) => this.pointerDown(event));
    this.surface.addEventListener('pointermove', (event) => this.pointerMove(event));
    this.surface.addEventListener('pointerup', (event) => this.endStroke(event));
    // Losing capture (cursor left the webview, OS took over) must keep the line
    // that was already drawn instead of discarding it.
    this.surface.addEventListener('pointercancel', () => this.endStroke());
    this.surface.addEventListener('lostpointercapture', () => this.endStroke());
    this.stage.addEventListener('pointerdown', (event) => {
      const target = event.target as HTMLElement;
      // The toolbar and its menus manage their own open state on click.
      if (target.closest('.toolbar') || target.closest('.tool-menu')) return;
      this.closeSizeMenu();
      // The surface handler already decided (new pin, close, or nothing) — this
      // only closes the bubble for presses that land next to the picture.
      if (target.closest('.image-surface') || this.popover.contains(target)) return;
      this.closePopover();
    });
    new ResizeObserver(() => this.fit()).observe(this.stage);
    document.addEventListener('keydown', (event) => {
      if (!this.item) return;
      if (event.key === 'Escape') {
        if (!el('sizeMenu').hidden) { event.stopPropagation(); this.closeSizeMenu(); return; }
        if (!this.popover.hidden) { event.stopPropagation(); this.closePopover(); return; }
        if (!(event.target instanceof HTMLInputElement)) this.close();
      }
      if (event.target instanceof HTMLInputElement) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); this.undo(); }
    });
  }

  setScope(scope: string, canSend = this.canSend): void {
    this.scope = scope;
    this.canSend = canSend;
    if (this.item) this.controls();
  }

  /** The extension owns the value; this only mirrors what every surface shows. */
  setOutputSize(size: string): void {
    if (typeof size !== 'string' || !size.trim()) return;
    this.outputSize = size.trim();
    if (!el('sizeMenu').hidden) this.openSizeMenu();
  }

  private openSizeMenu(): void {
    const menu = el('sizeMenu');
    el('sizeMenuTitle').textContent = t('size.title');
    const list = el('sizeMenuList');
    list.replaceChildren();
    SIZE_OPTIONS.forEach((option) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'menu-row';
      row.setAttribute('role', 'menuitemradio');
      row.setAttribute('aria-checked', String(option.size === this.outputSize));
      row.innerHTML = `<span>${icon(option.icon)}</span><span>${escapeText(t(option.label))}</span>` +
        (option.ratio ? `<span class="menu-ratio">${option.ratio}</span>` : '');
      row.onclick = () => { this.pickSize(option.size); };
      list.append(row);
    });
    menu.hidden = false;
    this.positionSizeMenu();
  }

  private closeSizeMenu(): void {
    el('sizeMenu').hidden = true;
    el('sizeMenu').removeAttribute('style');
  }

  /** Anchored above the toolbar, so it reads as part of that capsule. */
  private positionSizeMenu(): void {
    const menu = el('sizeMenu');
    if (menu.hidden) return;
    const stage = this.stage.getBoundingClientRect();
    const anchor = el('toolSize').getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = between(anchor.left - stage.left + anchor.width / 2 - width / 2, 6, Math.max(6, stage.width - width - 6));
    const top = between(anchor.top - stage.top - height - 6, 6, Math.max(6, stage.height - height - 6));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  private pickSize(size: string): void {
    // Optimistic: the extension validates and broadcasts the settled value back.
    this.outputSize = size;
    this.closeSizeMenu();
    this.api?.postMessage({ type: 'setDefaultSize', size });
  }

  async open(item: GalleryItem): Promise<void> {
    if (this.item) this.flushSave();
    this.item = item;
    this.data = clone(parseAnnotations(item.annotations) || emptyAnnotations());
    this.instruction = item.note || '';
    this.dirty = false; this.pendingSave = ''; this.pendingSend = '';
    this.loaded = false; this.busy = false; this.annotated = null;
    this.revision++; this.preparedRevision = -1;
    this.history = []; this.stroke = null; this.pinDrag = null; this.activeComment = '';
    this.mode = 'view';
    this.surface.hidden = true;
    this.image.removeAttribute('src');
    this.closePopover();
    const instruction = el<HTMLTextAreaElement>('instruction');
    instruction.value = this.instruction; this.grow(instruction);
    el('editor').hidden = false; document.body.classList.add('editing');
    el('saveState').textContent = '';
    el('imageStatus').hidden = false; el('imageStatus').textContent = t('image.loading');
    this.copy(); this.controls();
    el('back').focus();
    try {
      const dataUrl = await this.getImage(item.filePath);
      if (this.item !== item) return;
      this.sourceUrl = dataUrl;
      this.image.src = dataUrl;
      await this.image.decode();
      if (this.item !== item) return;
      this.loaded = true; this.surface.hidden = false; el('imageStatus').hidden = true;
      // Hand the natural size to CSS once; everything else scales natively.
      const naturalWidth = this.image.naturalWidth; const naturalHeight = this.image.naturalHeight;
      this.surface.style.setProperty('--natural', `${naturalWidth} / ${naturalHeight}`);
      this.surface.style.setProperty('--natural-ratio', String(naturalWidth / naturalHeight));
      this.redraw(); this.prepare(); this.controls();
    } catch (error) {
      if (this.item !== item) return;
      el('imageStatus').textContent = error instanceof Error ? error.message : t('image.failed');
      this.controls();
    }
  }

  /** Every string, attribute and control state in one place. */
  private copy(): void {
    el('editorTitle').textContent = t('editor.title');
    const item = this.item!;
    el('editorMeta').textContent = `${item.model.replace('gpt-image-2.5-', '')} · ${item.quality} · ${item.width}×${item.height} · ${item.format.toUpperCase()}`;
    el('editor').querySelectorAll<HTMLElement>('[data-text]').forEach((node) => {
      const key = node.dataset.text as Parameters<typeof t>[0];
      if (key !== 'editor.deliver') node.textContent = t(key);
    });
    labelButton(el('back'), t('editor.back'));
    labelButton(el('undo'), t('editor.undo'));
    labelButton(el('clear'), t('editor.clear'));
    labelButton(el('deleteComment'), t('editor.removeComment'));
    el<HTMLTextAreaElement>('commentText').placeholder = t('editor.commentPlaceholder');
    el<HTMLTextAreaElement>('instruction').placeholder = t('editor.instruction');
    el('toolbar').setAttribute('aria-label', t('editor.title'));
    this.controls();
  }

  /** The single button means "attach" inside a Composer scope and "send" outside. */
  private deliverLabel(): Parameters<typeof t>[0] {
    return this.scope === 'session' || this.scope === 'home' ? 'editor.deliver' : 'editor.deliverSend';
  }

  private controls(): void {
    const composer = this.scope === 'session' || this.scope === 'home';
    const sendable = !composer && this.canSend;
    const ready = this.loaded && !this.busy && this.preparedRevision === this.revision;
    const button = el<HTMLButtonElement>('send');
    button.hidden = !(composer || sendable);
    button.disabled = !ready;
    el('sendLabel').textContent = t(this.busy ? 'editor.delivering' : this.deliverLabel());
    el('sendIcon').innerHTML = icon(composer ? 'corner-down-left' : 'send');
    el('scopeHint').hidden = composer || sendable;
    el('scopeHint').textContent = t(this.canSend ? 'editor.scopeHint' : 'editor.sendUnsupported');
    el('toolPen').setAttribute('aria-pressed', String(this.mode === 'pen'));
    el('toolComment').setAttribute('aria-pressed', String(this.mode === 'comment'));
    this.surface.dataset.mode = this.mode;
    const hint = t(this.mode === 'pen' ? 'editor.penHint' : this.mode === 'comment' ? 'editor.commentHint' : 'editor.viewHint');
    el('toolHint').textContent = hint;
    el('toolHint').hidden = !hint;
    el('undo').hidden = !this.history.length;
    el('clear').hidden = !this.data.strokes.length && !this.data.comments.length;
    el('toolDivider').hidden = !this.history.length && !this.data.strokes.length && !this.data.comments.length;
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
    if (mode !== 'comment') this.closePopover();
    this.controls();
  }

  /**
   * The frame is fitted by CSS from the natural size, so resizing needs no
   * per-frame maths — only the floating bubble has to be re-anchored.
   */
  private fit(): void {
    this.positionPopover();
    this.positionSizeMenu();
  }

  private point(event: { clientX: number; clientY: number }): Point {
    const rect = this.surface.getBoundingClientRect();
    return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) };
  }

  private snapshot(): void {
    this.history.push(clone(this.data));
    if (this.history.length > 50) this.history.shift();
  }

  private pointerDown(event: PointerEvent): void {
    if (!this.loaded || this.busy || event.button !== 0 || !event.isPrimary) return;
    if ((event.target as HTMLElement).closest('button')) return;
    if (this.mode === 'comment') {
      if (this.data.comments.length >= MAX_COMMENTS) { notice(t('editor.limit')); return; }
      this.snapshot();
      const comment: ImageComment = { id: uid(), ...this.point(event), text: '' };
      this.data.comments.push(comment);
      this.selected(comment.id);
      this.openPopover(comment, true);
      this.changed();
    } else if (this.mode === 'pen') {
      // A second press while drawing must finish the previous line, not replace it.
      if (this.stroke) this.endStroke();
      if (this.data.strokes.length >= MAX_STROKES) { notice(t('editor.limit')); return; }
      this.snapshot();
      // Image-relative width, so the line keeps its weight in a narrow Panel.
      this.stroke = { id: uid(), points: [this.point(event)], width: .004 };
      this.data.strokes.push(this.stroke);
      // Capture keeps the line going when the cursor leaves the webview; a host
      // that refuses it still works, the stroke just ends at the edge.
      try { this.surface.setPointerCapture(event.pointerId); } catch { /* not fatal */ }
      this.preparedRevision = -1; this.controls(); this.redraw();
    } else {
      this.closePopover();
    }
    event.preventDefault();
  }

  private pointerMove(event: PointerEvent): void {
    if (!this.stroke) return;
    const next = this.point(event); const prev = this.stroke.points.at(-1)!;
    if (Math.hypot(next.x - prev.x, next.y - prev.y) < .001) return;
    const total = this.data.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
    if (this.stroke.points.length < 2000 && total < MAX_POINTS) this.stroke.points.push(next);
    this.redrawInk();
  }

  /** Ends and keeps whatever has been drawn — never throws the line away. */
  private endStroke(event?: PointerEvent): void {
    if (!this.stroke) return;
    if (event) this.pointerMove(event);
    const had = this.stroke.points.length > 1;
    this.stroke = null;
    if (event?.pointerId !== undefined) {
      try { if (this.surface.hasPointerCapture?.(event.pointerId)) this.surface.releasePointerCapture(event.pointerId); } catch { /* already gone */ }
    }
    if (!had) this.redrawInk();
    this.changed();
  }

  private selected(id: string): void { this.activeComment = id; }

  private active(): ImageComment | undefined {
    return this.data.comments.find((comment) => comment.id === this.activeComment);
  }

  private redraw(): void {
    if (!this.loaded) return;
    this.redrawInk();
    this.redrawPins();
    this.positionPopover();
  }

  private redrawInk(): void {
    const layer = document.getElementById('inkLayer') as unknown as SVGSVGElement;
    const width = this.image.naturalWidth; const height = this.image.naturalHeight;
    layer.setAttribute('viewBox', `0 0 ${width} ${height}`);
    layer.replaceChildren();
    this.data.strokes.forEach((stroke) => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      let d = stroke.points.map((p, i) => `${i ? 'L' : 'M'}${p.x * width} ${p.y * height}`).join(' ');
      if (stroke.points.length === 1) d += 'l.01 .01';
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', '#ef5350');
      path.setAttribute('stroke-width', String(stroke.width * Math.min(width, height)));
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      layer.append(path);
    });
  }

  private redrawPins(): void {
    const pins = el('pins');
    pins.replaceChildren();
    this.data.comments.forEach((comment, index) => {
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = `pin${comment.id === this.activeComment ? ' selected' : ''}`;
      pin.dataset.comment = comment.id;
      pin.textContent = String(index + 1);
      this.placePin(pin, comment);
      this.syncPinLabel(comment);
      pin.addEventListener('pointerdown', (event) => this.startPinDrag(event, comment, pin));
      pin.addEventListener('pointermove', (event) => this.dragPin(event, comment, pin));
      pin.addEventListener('pointerup', () => this.endPinDrag(comment));
      pin.addEventListener('pointercancel', () => this.endPinDrag(comment));
      pin.addEventListener('lostpointercapture', () => this.endPinDrag(comment));
      pins.append(pin);
    });
  }

  private placePin(pin: HTMLElement, comment: ImageComment): void {
    pin.style.left = `clamp(11px, ${comment.x * 100}%, calc(100% - 11px))`;
    pin.style.top = `clamp(11px, ${comment.y * 100}%, calc(100% - 11px))`;
  }

  private syncPinLabel(comment: ImageComment): void {
    const index = this.data.comments.indexOf(comment) + 1;
    const pin = el('pins').querySelector<HTMLElement>(`[data-comment="${comment.id}"]`);
    if (pin) labelButton(pin, comment.text.trim() || t('editor.commentLabel', { n: index }));
  }

  /** Pins are draggable so a comment can be repositioned without retyping it. */
  private startPinDrag(event: PointerEvent, comment: ImageComment, pin: HTMLElement): void {
    if (!this.loaded || this.busy || event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    this.snapshot();
    this.pinDrag = { id: comment.id, moved: false };
    this.selected(comment.id);
    this.openPopover(comment, false);
    pin.classList.add('dragging');
    this.redrawPins();
    try { el('pins').querySelector<HTMLElement>(`[data-comment="${comment.id}"]`)?.setPointerCapture?.(event.pointerId); } catch { /* not fatal */ }
  }

  private dragPin(event: PointerEvent, comment: ImageComment, pin: HTMLElement): void {
    if (this.pinDrag?.id !== comment.id) return;
    const next = this.point(event);
    if (!this.pinDrag.moved && Math.hypot(next.x - comment.x, next.y - comment.y) < .002) return;
    this.pinDrag.moved = true;
    comment.x = next.x; comment.y = next.y;
    const live = el('pins').querySelector<HTMLElement>(`[data-comment="${comment.id}"]`) ?? pin;
    this.placePin(live, comment);
    this.positionPopover();
  }

  private endPinDrag(comment: ImageComment): void {
    if (this.pinDrag?.id !== comment.id) return;
    const moved = this.pinDrag.moved;
    this.pinDrag = null;
    if (!moved) this.history.pop();
    else this.changed();
  }

  private openPopover(comment: ImageComment, focus: boolean): void {
    this.selected(comment.id);
    const index = this.data.comments.indexOf(comment) + 1;
    el('popoverIndex').textContent = t('editor.commentLabel', { n: index });
    labelButton(el('deleteComment'), t('editor.removeComment'));
    const text = el<HTMLTextAreaElement>('commentText');
    if (text.dataset.comment !== comment.id) { text.value = comment.text; text.dataset.comment = comment.id; }
    this.popover.hidden = false;
    this.positionPopover();
    this.redrawPins();
    if (focus) {
      text.focus();
      text.setSelectionRange(text.value.length, text.value.length);
    }
  }

  private closePopover(): void {
    if (this.popover.hidden) return;
    this.popover.hidden = true;
    this.popover.removeAttribute('style');
    el<HTMLTextAreaElement>('commentText').dataset.comment = '';
    this.activeComment = '';
    this.redrawPins();
  }

  /** Anchored to the pin, flipping above/below so it stays inside the stage. */
  private positionPopover(): void {
    if (this.popover.hidden || !this.item) return;
    const comment = this.active();
    if (!comment) return;
    const stage = this.stage.getBoundingClientRect();
    const surface = this.surface.getBoundingClientRect();
    const width = Math.min(POPOVER_WIDTH, Math.max(160, stage.width - 16));
    this.popover.style.width = `${width}px`;
    const height = this.popover.offsetHeight || 92;
    const pinX = surface.left - stage.left + comment.x * surface.width;
    const pinY = surface.top - stage.top + comment.y * surface.height;
    const left = between(pinX - width / 2, 6, Math.max(6, stage.width - width - 6));
    let top = pinY - height - 16;
    if (top < 6) top = pinY + 16;
    top = between(top, 6, Math.max(6, stage.height - height - 6));
    this.popover.style.left = `${left}px`;
    this.popover.style.top = `${top}px`;
  }

  private removeActiveComment(): void {
    const comment = this.active();
    if (!comment) return;
    this.snapshot();
    this.data.comments = this.data.comments.filter((item) => item.id !== comment.id);
    this.closePopover();
    this.changed();
    this.redrawPins();
  }

  private changed(redraw = true): void {
    if (!this.item) return;
    this.revision++; this.preparedRevision = -1; this.dirty = true;
    // Keep an in-memory draft even if a host write fails or a snapshot arrives.
    this.item.annotations = clone(this.data); this.item.note = this.instruction;
    if (redraw) this.redraw();
    this.controls();
    cancelAnimationFrame(this.prepareFrame);
    this.prepareFrame = requestAnimationFrame(() => this.prepare());
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushSave(), 350);
  }

  private undo(): void {
    if (this.busy || !this.history.length) return;
    this.stroke = null; this.pinDrag = null;
    this.data = this.history.pop()!;
    if (this.activeComment && !this.active()) this.closePopover();
    this.changed();
    const comment = this.active();
    if (comment) this.openPopover(comment, false);
  }

  private async clear(): Promise<void> {
    if (!this.api || this.busy) return;
    const { confirmed } = await this.api.ui.confirm({ title: t('editor.clearTitle'), message: t('editor.clearBody'), confirmLabel: t('editor.clear'), cancelLabel: t('cancel') });
    if (!confirmed || !this.item) return;
    this.snapshot(); this.data = emptyAnnotations(); this.closePopover(); this.changed();
  }

  private grow(node: HTMLTextAreaElement): void {
    node.style.height = 'auto';
    node.style.height = `${Math.min(96, Math.max(34, node.scrollHeight))}px`;
  }

  private instructionText(): string {
    const lines = this.instruction.trim() ? [this.instruction.trim()] : [];
    if (this.data.strokes.length) lines.push(t('editor.linesText', { n: this.data.strokes.length }));
    if (this.data.comments.length) {
      lines.push(t('editor.commentsText'));
      this.data.comments.forEach((comment, index) => {
        lines.push(t('editor.commentText', { n: index + 1, x: Math.round(comment.x * 100), y: Math.round(comment.y * 100), text: comment.text.trim() }));
      });
    }
    return lines.join('\n');
  }

  /**
   * Flatten strokes and pins once, before the click: the Composer protocol has no
   * freehand path type, so the evidence image carries the marks while
   * `annotation.reminder` keeps the ORIGINAL file address intact. Nothing is sent
   * automatically and the original file is never overwritten.
   */
  private prepare(): void {
    if (!this.loaded || !this.item || this.stroke) return;
    try {
      const name = this.item.name;
      const separator = this.sourceUrl.indexOf(',');
      const mimeType = /^data:([^;]+);/.exec(this.sourceUrl)?.[1] || 'image/png';
      const scale = Math.min(1, 2048 / Math.max(this.image.naturalWidth, this.image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(this.image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(this.image.naturalHeight * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error(t('editor.failed'));
      ctx.drawImage(this.image, 0, 0, canvas.width, canvas.height);
      const minEdge = Math.min(canvas.width, canvas.height);
      ctx.strokeStyle = '#ef5350'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      this.data.strokes.forEach((stroke) => {
        ctx.lineWidth = Math.max(2, stroke.width * minEdge); ctx.beginPath();
        stroke.points.forEach((p, i) => {
          if (i === 0) ctx.moveTo(p.x * canvas.width, p.y * canvas.height);
          else ctx.lineTo(p.x * canvas.width, p.y * canvas.height);
        });
        if (stroke.points.length === 1) ctx.lineTo(stroke.points[0].x * canvas.width + .1, stroke.points[0].y * canvas.height + .1);
        ctx.stroke();
      });
      const radius = Math.max(10, minEdge * .018);
      this.data.comments.forEach((comment, index) => {
        const x = Math.max(radius + 2, Math.min(canvas.width - radius - 2, comment.x * canvas.width));
        const y = Math.max(radius + 2, Math.min(canvas.height - radius - 2, comment.y * canvas.height));
        ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = '#ef5350'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.font = `600 ${Math.round(radius * 1.15)}px -apple-system, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(index + 1), x, y + .5);
      });
      const evidence = canvas.toDataURL('image/png').split(',')[1];
      if (evidence.length > 24 * 1024 * 1024) throw new Error(t('editor.sendTooLarge'));
      const text = this.instructionText();
      const image = { name: `${name.replace(/\.[^.]+$/, '')}-annotated.png`, mimeType: 'image/png', content: evidence };
      this.annotated = {
        type: 'annotation', label: t('editor.annotationLabel', { name }),
        note: text || undefined, promptText: text || undefined,
        reminder: t('editor.reminder', { path: this.item.filePath }),
        image,
      };
      // Inside a Composer the instructions go into the input as an editable
      // prompt instead, so the chip stays a plain image attachment — but the
      // reminder still carries them, in case the user never pulls them across.
      this.attachment = {
        type: 'annotation', label: name,
        reminder: `${t('editor.reminder', { path: this.item.filePath })}\n\n${text}`,
        image,
      };
      this.preparedRevision = this.revision;
      this.controls();
    } catch (error) {
      notice(error instanceof Error ? error.message : t('editor.failed'));
    }
  }

  private sessionText(): string {
    const parts: string[] = [];
    const body = this.instructionText();
    if (body) parts.push(body);
    parts.push(t('editor.reminder', { path: this.item?.filePath ?? '' }));
    parts.push(t('editor.attachOrder'));
    return parts.join('\n\n');
  }

  private readyEvidence(): string | null {
    if (this.preparedRevision !== this.revision || !this.annotated?.image) this.prepare();
    return this.preparedRevision === this.revision ? this.annotated?.image?.content ?? null : null;
  }

  /**
   * One button, two destinations: inside a Composer scope the marked preview is
   * attached to the draft; in the App View there is no draft, so the edit is sent
   * into a Session this mini tool owns and the host is asked to open it.
   */
  private async deliver(): Promise<void> {
    const item = this.item;
    if (!item || !this.api || this.busy) return;
    const composer = this.scope === 'session' || this.scope === 'home';
    if (!composer && !this.canSend) return;
    const evidence = this.readyEvidence();
    if (!evidence) { notice(t('editor.failed')); return; }
    this.busy = true; this.controls();
    try {
      if (composer) {
        // Invoke addContexts straight from this click: it needs the trusted
        // gesture, so nothing may be awaited before it.
        const result = await this.api.composer.addContexts([this.attachment ?? this.annotated!]);
        if (this.item !== item) return;
        if (result.added < 1) throw new Error(t('editor.failed'));
        // The page cannot type into the input, so the instructions wait for the
        // toolbar button, which fills them as an editable draft.
        this.api.postMessage({ type: 'stagePrompt', id: item.id, name: item.name, text: this.sessionText() });
        this.flushSave();
        this.close();
        notice(t('editor.attachedStaged'));
        return;
      }
      this.attempt += 1;
      const attempt = `${item.id}-${Date.now()}-${this.attempt}`;
      // A fresh idempotency key per attempt: reusing one makes the host replay the
      // old receipt and silently skip dispatching a new turn.
      this.pendingSend = `send-${attempt}`;
      this.api.postMessage({
        type: 'sendToSession', id: item.id, requestId: this.pendingSend, evidence,
        text: this.sessionText(), idempotencyKey: attempt,
      });
      clearTimeout(this.deadline);
      this.deadline = setTimeout(() => {
        if (this.item !== item || !this.busy) return;
        this.busy = false; this.controls(); notice(t('editor.failed'));
      }, 45000);
    } catch {
      if (this.item === item) { this.busy = false; this.controls(); notice(t('editor.failed')); }
    }
  }

  onSendResult(message: Record<string, unknown>): void {
    const item = this.item;
    if (!item || message.id !== item.id) return;
    if (this.pendingSend && message.requestId && message.requestId !== this.pendingSend) return;
    clearTimeout(this.deadline);
    this.busy = false;
    const error = typeof message.error === 'string' ? message.error : '';
    // 'duplicate' means the host already queued this exact message.
    if (!error || error === 'duplicate') { this.flushSave(); this.close(); notice(t('editor.sent')); return; }
    this.controls();
    notice(t(error === 'unsupported' ? 'editor.sendUnsupported' : error === 'too-large' ? 'editor.sendTooLarge' : 'editor.failed'));
  }

  private flushSave(): void {
    clearTimeout(this.saveTimer);
    if (!this.item || !this.dirty || !this.api) return;
    this.pendingSave = `${this.item.id}:${this.revision}`;
    this.api.postMessage({ type: 'saveAnnotations', id: this.item.id, requestId: this.pendingSave, annotations: clone(this.data), note: this.instruction });
    this.dirty = false;
    el('saveState').textContent = t('editor.saving');
  }

  onSaved(message: Record<string, unknown>): void {
    if (!this.item || message.id !== this.item.id || (message.requestId && message.requestId !== this.pendingSave)) return;
    if (message.type === 'panelError') {
      this.dirty = true; el('saveState').textContent = t('editor.saveFailed');
    } else el('saveState').textContent = t('editor.saved');
  }

  private close(): void {
    this.endStroke(); this.flushSave();
    cancelAnimationFrame(this.prepareFrame);
    clearTimeout(this.deadline);
    const draft = this.item;
    this.item = null; this.sourceUrl = ''; this.annotated = null; this.activeComment = '';
    this.closePopover(); this.closeSizeMenu();
    el('editor').hidden = true; document.body.classList.remove('editing');
    if (draft) this.onClose(draft);
  }
}

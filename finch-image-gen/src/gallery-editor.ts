import type * as finch from 'finch';
import { el, icon, labelButton, notice } from './gallery-dom';
import { clamp, emptyAnnotations, parseAnnotations, type GalleryAnnotations, type GalleryItem, type Point, type Stroke } from './gallery-model';
import { t } from './gallery-i18n';

type Mode = 'view' | 'pen' | 'comment';
const clone = (data: GalleryAnnotations): GalleryAnnotations => structuredClone(data);
const uid = (): string => crypto.randomUUID();

/** A route within the webview, with image-relative geometry and prebuilt evidence. */
export class GalleryEditor {
  private item: GalleryItem | null = null;
  private data = emptyAnnotations();
  private history: GalleryAnnotations[] = [];
  private mode: Mode = 'view';
  private scope = '';
  private stroke: Stroke | null = null;
  private selectedComment = '';
  private revision = 0;
  private preparedRevision = -1;
  private original: finch.ComposerContextDraft | null = null;
  private annotated: finch.ComposerContextDraft | null = null;
  private loaded = false;
  private busy = false;
  private note = '';
  private sourceUrl = '';
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingSave = '';
  private prepareFrame = 0;
  private noteDirty = false;
  private readonly image = el<HTMLImageElement>('editorImage');
  private readonly surface = el('imageSurface');
  private readonly stage = el('stage');

  constructor(
    private readonly api: finch.WebviewBridgeApi | undefined,
    private readonly getImage: (path: string) => Promise<string>,
    private readonly onClose: (draft: GalleryItem) => void,
  ) {
    el('back').onclick = () => this.close();
    el('toolPen').onclick = () => this.setMode(this.mode === 'pen' ? 'view' : 'pen');
    el('toolComment').onclick = () => this.setMode(this.mode === 'comment' ? 'view' : 'comment');
    el('addComment').onclick = () => this.setMode('comment');
    el('undo').onclick = () => this.undo();
    el('clear').onclick = () => { void this.clear(); };
    el('insertOriginal').onclick = () => { void this.insert(false); };
    el('insertAnnotated').onclick = () => { void this.insert(true); };
    el<HTMLTextAreaElement>('overallNote').maxLength = 8000;
    el<HTMLTextAreaElement>('overallNote').oninput = (event) => {
      this.note = (event.target as HTMLTextAreaElement).value;
      this.changed(false);
    };
    this.surface.addEventListener('pointerdown', (event) => this.pointerDown(event));
    this.surface.addEventListener('pointermove', (event) => this.pointerMove(event));
    this.surface.addEventListener('pointerup', (event) => this.pointerUp(event));
    this.surface.addEventListener('pointercancel', () => this.cancelStroke());
    this.surface.addEventListener('lostpointercapture', () => this.cancelStroke());
    new ResizeObserver(() => this.fit()).observe(this.stage);
    document.addEventListener('keydown', (event) => {
      if (!this.item) return;
      const typing = event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement;
      if (event.key === 'Escape' && !typing) this.close();
      if (!typing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); this.undo(); }
    });
  }

  setScope(scope: string): void {
    this.scope = scope;
    if (this.item) { this.copy(); this.controls(); }
  }

  async open(item: GalleryItem): Promise<void> {
    if (this.item) this.flushSave();
    this.item = item;
    this.data = clone(parseAnnotations(item.annotations) || emptyAnnotations());
    this.note = item.note || '';
    this.noteDirty = false; this.pendingSave = '';
    this.loaded = false; this.busy = false; this.original = null; this.annotated = null;
    this.revision++; this.preparedRevision = -1;
    this.history = []; this.stroke = null; this.selectedComment = '';
    this.mode = 'view';
    this.surface.hidden = true;
    this.image.removeAttribute('src');
    el('editor').hidden = false; document.body.classList.add('editing');
    el('saveState').textContent = '';
    el('editorError').hidden = true;
    el('imageStatus').hidden = false; el('imageStatus').textContent = t('image.loading');
    this.copy(); this.renderComments(); this.controls();
    el<HTMLTextAreaElement>('overallNote').value = this.note;
    el('back').focus();
    try {
      const dataUrl = await this.getImage(item.filePath);
      if (this.item !== item) return;
      this.sourceUrl = dataUrl;
      this.image.src = dataUrl;
      await this.image.decode();
      if (this.item !== item) return;
      this.loaded = true; this.surface.hidden = false; el('imageStatus').hidden = true;
      this.fit(); this.redraw(); this.prepare(); this.controls();
    } catch (error) {
      if (this.item !== item) return;
      el('imageStatus').textContent = error instanceof Error ? error.message : t('image.failed');
      this.controls();
    }
  }

  private copy(): void {
    el('editorTitle').textContent = t('editor.title');
    const item = this.item!;
    el('editorMeta').textContent = `${item.model.replace('gpt-image-2.5-', '')} · ${item.quality} · ${item.width}×${item.height} · ${item.format.toUpperCase()}`;
    el('editor').querySelectorAll<HTMLElement>('[data-text]').forEach((node) => {
      node.textContent = t(node.dataset.text as Parameters<typeof t>[0]);
    });
    labelButton(el('back'), t('editor.back'));
    labelButton(el('undo'), t('editor.undo'));
    labelButton(el('clear'), t('editor.clear'));
    labelButton(el('addComment'), t('editor.addComment'));
    el<HTMLTextAreaElement>('overallNote').placeholder = t('editor.overall');
    el('overallNote').setAttribute('aria-label', t('editor.overall'));
    el('scopeHint').textContent = t('editor.scopeHint');
    el('toolbar').setAttribute('aria-label', t('editor.title'));
  }

  private controls(): void {
    const insertable = this.scope === 'session' || this.scope === 'home';
    el('insertActions').hidden = !insertable;
    el('scopeHint').hidden = insertable;
    el<HTMLButtonElement>('insertOriginal').disabled = !this.loaded || this.busy;
    el<HTMLButtonElement>('insertAnnotated').disabled = !this.loaded || this.busy || this.preparedRevision !== this.revision;
    const label = el('insertAnnotated').querySelector('[data-text]')!;
    label.textContent = t(this.busy ? 'editor.inserting' : this.loaded && this.preparedRevision !== this.revision ? 'editor.preparing' : 'editor.insert');
    el('toolPen').setAttribute('aria-pressed', String(this.mode === 'pen'));
    el('toolComment').setAttribute('aria-pressed', String(this.mode === 'comment'));
    this.surface.dataset.mode = this.mode;
    el('toolHint').textContent = t(this.mode === 'pen' ? 'editor.penHint' : this.mode === 'comment' ? 'editor.commentHint' : 'editor.viewHint');
    el('undo').hidden = !this.history.length;
    el('clear').hidden = !this.data.strokes.length && !this.data.comments.length;
    el('toolbar').querySelector<HTMLElement>('.divider')!.hidden = !this.history.length && !this.data.strokes.length && !this.data.comments.length;
  }

  private setMode(mode: Mode): void {
    this.mode = mode; this.controls();
  }

  private fit(): void {
    if (!this.item || !this.loaded) return;
    const { width, height } = this.stage.getBoundingClientRect();
    const scale = Math.min(width / this.image.naturalWidth, height / this.image.naturalHeight);
    const w = this.image.naturalWidth * scale; const h = this.image.naturalHeight * scale;
    Object.assign(this.surface.style, { width: `${w}px`, height: `${h}px`, left: `${(width - w) / 2}px`, top: `${(height - h) / 2}px` });
  }

  private point(event: PointerEvent): Point {
    const rect = this.surface.getBoundingClientRect();
    return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) };
  }

  private snapshot(): void {
    this.history.push(clone(this.data));
    if (this.history.length > 50) this.history.shift();
  }

  private pointerDown(event: PointerEvent): void {
    if (!this.loaded || this.busy || event.button !== 0 || !event.isPrimary || (event.target as HTMLElement).closest('button')) return;
    if (this.mode === 'comment') {
      if (this.data.comments.length >= 50) { notice(t('editor.limit')); return; }
      this.snapshot();
      const comment = { id: uid(), ...this.point(event), text: '' };
      this.data.comments.push(comment); this.selectedComment = comment.id;
      this.changed(); this.renderComments();
      const input = el('commentList').querySelector<HTMLTextAreaElement>(`[data-comment="${comment.id}"]`);
      input?.focus(); input?.scrollIntoView({ block: 'nearest' });
    } else if (this.mode === 'pen') {
      if (this.data.strokes.length >= 100) { notice(t('editor.limit')); return; }
      this.snapshot();
      // A stable image-relative width survives fitting into a narrow Panel.
      this.stroke = { id: uid(), points: [this.point(event)], width: .004 };
      this.data.strokes.push(this.stroke);
      this.surface.setPointerCapture(event.pointerId);
      this.preparedRevision = -1; this.controls(); this.redraw();
    }
    event.preventDefault();
  }

  private pointerMove(event: PointerEvent): void {
    if (!this.stroke) return;
    const next = this.point(event); const prev = this.stroke.points.at(-1)!;
    if (Math.hypot(next.x - prev.x, next.y - prev.y) < .001) return;
    if (this.stroke.points.length < 2000 && this.data.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0) < 20000) this.stroke.points.push(next);
    this.redraw();
  }

  private pointerUp(event: PointerEvent): void {
    if (!this.stroke) return;
    this.pointerMove(event); this.stroke = null;
    if (this.surface.hasPointerCapture(event.pointerId)) this.surface.releasePointerCapture(event.pointerId);
    this.changed();
  }

  private cancelStroke(): void {
    if (!this.stroke) return;
    this.data.strokes = this.data.strokes.filter((stroke) => stroke !== this.stroke);
    this.stroke = null; this.history.pop(); this.changed();
  }

  private redraw(): void {
    if (!this.loaded) return;
    const layer = document.getElementById('inkLayer') as unknown as SVGSVGElement;
    const width = this.image.naturalWidth; const height = this.image.naturalHeight;
    layer.setAttribute('viewBox', `0 0 ${width} ${height}`);
    layer.replaceChildren();
    this.data.strokes.forEach((stroke) => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const points = stroke.points;
      let d = points.map((p, i) => `${i ? 'L' : 'M'}${p.x * width} ${p.y * height}`).join(' ');
      if (points.length === 1) d += `l.01 .01`;
      path.setAttribute('d', d); path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#ef5350');
      path.setAttribute('stroke-width', String(stroke.width * Math.min(width, height)));
      path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round'); layer.append(path);
    });
    const pins = el('pins'); pins.replaceChildren();
    this.data.comments.forEach((comment, index) => {
      const pin = document.createElement('button');
      pin.className = `pin${comment.id === this.selectedComment ? ' selected' : ''}`;
      pin.style.left = `clamp(11px, ${comment.x * 100}%, calc(100% - 11px))`;
      pin.style.top = `clamp(11px, ${comment.y * 100}%, calc(100% - 11px))`;
      pin.textContent = String(index + 1); pin.dataset.comment = comment.id;
      labelButton(pin, comment.text || t('editor.commentLabel', { n: index + 1 }));
      pin.onclick = (event) => {
        event.stopPropagation();
        this.selectedComment = comment.id;
        this.redraw();
        [...el('commentList').querySelectorAll<HTMLTextAreaElement>('textarea')].find((input) => input.dataset.comment === comment.id)?.focus();
      };
      pins.append(pin);
    });
  }

  private renderComments(): void {
    el('comments').hidden = !this.data.comments.length;
    el('commentsTitle').textContent = t('editor.comments', { n: this.data.comments.length });
    const list = el('commentList'); list.replaceChildren();
    this.data.comments.forEach((comment, index) => {
      const row = document.createElement('div'); row.className = 'comment-row';
      const number = document.createElement('button'); number.className = 'comment-number'; number.textContent = String(index + 1);
      labelButton(number, t('editor.commentLabel', { n: index + 1 }));
      const input = document.createElement('textarea');
      input.rows = 1; input.maxLength = 4000; input.dataset.comment = comment.id;
      input.value = comment.text; input.placeholder = t('editor.commentPlaceholder');
      input.setAttribute('aria-label', t('editor.commentLabel', { n: index + 1 }));
      input.onfocus = () => { this.snapshot(); this.selectedComment = comment.id; this.redraw(); this.controls(); };
      input.oninput = () => { comment.text = input.value; this.changed(false); };
      number.onclick = () => { input.focus(); };
      const remove = document.createElement('button'); remove.className = 'icon-button'; remove.innerHTML = icon('x');
      labelButton(remove, t('editor.removeComment', { n: index + 1 }));
      remove.onclick = () => {
        this.snapshot(); this.data.comments = this.data.comments.filter((c) => c.id !== comment.id);
        this.changed(); this.renderComments();
      };
      row.append(number, input, remove); list.append(row);
    });
  }

  private changed(redraw = true): void {
    if (!this.item) return;
    this.revision++; this.preparedRevision = -1; this.noteDirty = true;
    // Keep an in-memory draft even if a host write fails or a snapshot arrives.
    this.item.annotations = clone(this.data); this.item.note = this.note;
    if (redraw) this.redraw();
    this.controls();
    cancelAnimationFrame(this.prepareFrame);
    this.prepareFrame = requestAnimationFrame(() => this.prepare());
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushSave(), 350);
  }

  private undo(): void {
    if (this.busy || !this.history.length) return;
    this.stroke = null; this.data = this.history.pop()!;
    this.changed(); this.renderComments();
  }

  private async clear(): Promise<void> {
    if (!this.api || this.busy) return;
    const { confirmed } = await this.api.ui.confirm({ title: t('editor.clearTitle'), message: t('editor.clearBody'), confirmLabel: t('editor.clear'), cancelLabel: t('cancel') });
    if (!confirmed || !this.item) return;
    this.snapshot(); this.data = emptyAnnotations(); this.changed(); this.renderComments();
  }

  private instructionText(): string {
    const lines = this.note.trim() ? [this.note.trim()] : [];
    if (this.data.strokes.length) lines.push(t('editor.linesText', { n: this.data.strokes.length }));
    if (this.data.comments.length) {
      lines.push(t('editor.commentsText'));
      this.data.comments.forEach((comment, index) => {
        lines.push(t('editor.commentText', { n: index + 1, x: Math.round(comment.x * 100), y: Math.round(comment.y * 100), text: comment.text.trim() }));
      });
    }
    return lines.join('\n');
  }

  /** Flatten paths and numbered pins once, *before* the insert click. The
   * Composer protocol has no freehand path type; annotation.image carries the
   * evidence and annotation.reminder keeps the ORIGINAL file address intact.
   * Nothing is sent automatically, and the original file is never overwritten. */
  private prepare(): void {
    if (!this.loaded || !this.item || this.stroke) return;
    try {
      const name = this.item.name;
      const separator = this.sourceUrl.indexOf(',');
      const mimeType = /^data:([^;]+);/.exec(this.sourceUrl)?.[1] || 'image/png';
      this.original = {
        type: 'annotation', label: name,
        image: { name, mimeType, content: this.sourceUrl.slice(separator + 1) },
        reminder: t('editor.reminder', { path: this.item.filePath }),
      };
      const scale = Math.min(1, 2048 / Math.max(this.image.naturalWidth, this.image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(this.image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(this.image.naturalHeight * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error(t('editor.insertFailed'));
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
      if (evidence.length > 24 * 1024 * 1024) throw new Error(t('image.large'));
      const note = this.instructionText();
      this.annotated = {
        type: 'annotation', label: t('editor.annotationLabel', { name }),
        note: note || undefined, promptText: note || undefined,
        reminder: t('editor.reminder', { path: this.item.filePath }),
        image: { name: `${name.replace(/\.[^.]+$/, '')}-annotated.png`, mimeType: 'image/png', content: evidence },
      };
      this.preparedRevision = this.revision;
      this.controls();
    } catch (error) { this.showError(error instanceof Error ? error.message : t('editor.insertFailed')); }
  }

  private async insert(withAnnotations: boolean): Promise<void> {
    const item = this.item;
    if (!item || !this.api || this.busy || (this.scope !== 'session' && this.scope !== 'home')) return;
    const context = withAnnotations ? this.annotated : this.original;
    if (!context || (withAnnotations && this.preparedRevision !== this.revision)) return;
    this.busy = true; this.controls(); el('editorError').hidden = true;
    try {
      // Do NOT await image loading, rendering or persistence here: addContexts
      // must be invoked directly from this click's trusted user gesture.
      const resultPromise = this.api.composer.addContexts([context]);
      const result = await resultPromise;
      if (this.item !== item) return;
      if (result.added < 1) throw new Error(t('editor.insertFailed'));
      this.flushSave(); this.close(); notice(t('editor.inserted'));
    } catch {
      if (this.item === item) this.showError(t('editor.insertFailed'));
    } finally { this.busy = false; if (this.item) this.controls(); }
  }

  private showError(message: string): void {
    el('editorError').textContent = message; el('editorError').hidden = false;
  }

  private flushSave(): void {
    clearTimeout(this.saveTimer);
    if (!this.item || !this.noteDirty || !this.api) return;
    this.pendingSave = `${this.item.id}:${this.revision}`;
    this.api.postMessage({ type: 'saveAnnotations', id: this.item.id, requestId: this.pendingSave, annotations: clone(this.data), note: this.note });
    this.noteDirty = false;
    el('saveState').textContent = t('editor.saving');
  }

  onSaved(message: Record<string, unknown>): void {
    if (!this.item || message.id !== this.item.id || (message.requestId && message.requestId !== this.pendingSave)) return;
    if (message.type === 'panelError') {
      this.noteDirty = true; el('saveState').textContent = t('editor.saveFailed');
    } else el('saveState').textContent = t('editor.saved');
  }

  private close(): void {
    this.cancelStroke(); this.flushSave();
    cancelAnimationFrame(this.prepareFrame);
    const draft = this.item;
    this.item = null; this.sourceUrl = ''; this.original = null; this.annotated = null;
    el('editor').hidden = true; document.body.classList.remove('editing');
    if (draft) this.onClose(draft);
  }
}

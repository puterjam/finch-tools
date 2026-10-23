/** Browser-level UI regression tests with a contract-checking Finch bridge. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.includes('..')) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(join(root, 'dist', pathname === '/' ? 'gallery.html' : pathname));
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(pathname)] || 'text/html');
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

await page.addInitScript(() => {
  const sizes = [[768, 1024], [1536, 1024], [1024, 1024], [1024, 1536], [1600, 900], [900, 1400]];
  const records = Array.from({ length: 16 }, (_, i) => ({
    id: `image-${i}`, filePath: `/gallery/picture-${i}.png`, name: `picture-${i}.png`,
    prompt: `A beautifully composed image ${i} with warm ambient light and a soft blue background. This deliberately long prompt must not occupy more than two lines.`,
    model: 'gpt-image-2.5-flare', quality: 'low', size: '1024x1024', format: 'png',
    width: sizes[i % sizes.length][0], height: sizes[i % sizes.length][1],
    sessionId: i % 2 ? 'session-2' : 'session-1', createdAt: Date.now() - i * 10000, note: '',
  }));
  const listeners = [];
  const state = { records, contexts: [], rejections: [], messages: [], previews: [], view: 'session', sessionId: 'session-1', imageDelay: 0, refuseInsert: false, failImages: false, canSend: true, sends: [], failSend: false };
  const emit = (message) => listeners.forEach((fn) => fn(message));
  const env = () => ({ view: state.view, sessionId: state.sessionId, locale: 'zh-CN', canSend: state.canSend });
  const snapshot = () => emit({ type: 'gallery', data: state.records, env: env() });
  state.failImages = location.search.includes('image-error');
  state.imageDelay = location.search.includes('slow-image') ? 500 : 0;
  window.__host = Object.assign(state, { emit, snapshot, env });
  window.finch = {
    onMessage(fn) { listeners.push(fn); return () => {}; },
    postMessage(message) {
      state.messages.push(message);
      if (message.type === 'requestGallery') setTimeout(snapshot, 0);
      if (message.type === 'requestImage') setTimeout(() => {
        if (state.failImages) return emit({ type: 'imageData', filePath: message.filePath, error: 'unreadable' });
        const record = records.find((r) => r.filePath === message.filePath);
        const canvas = document.createElement('canvas');
        canvas.width = record.width; canvas.height = record.height;
        const ctx = canvas.getContext('2d');
        const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
        g.addColorStop(0, '#d5e8f2'); g.addColorStop(1, '#e8c7ab'); ctx.fillStyle = g;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#638fa4'; ctx.beginPath();
        ctx.arc(canvas.width * .5, canvas.height * .48, canvas.width * .22, 0, Math.PI * 2); ctx.fill();
        emit({ type: 'imageData', filePath: message.filePath, dataUrl: canvas.toDataURL() });
      }, state.imageDelay);
      if (message.type === 'saveAnnotations') {
        const record = state.records.find((r) => r.id === message.id);
        record.annotations = message.annotations; record.note = message.note;
        setTimeout(() => emit({ type: 'annotationsSaved', id: message.id }), 0);
      }
      if (message.type === 'sendToSession') {
        state.sends.push(message);
        const reply = state.failSend
          ? { error: 'send-failed' }
          : { sessionId: 'sent-session', attached: 2 };
        setTimeout(() => emit({ type: 'annotationSendResult', id: message.id, requestId: message.requestId, ...reply }), 0);
      }
      if (message.type === 'deleteRecord') {
        state.records = state.records.filter((r) => r.id !== message.id);
        setTimeout(() => { emit({ type: 'deleteResult', id: message.id }); snapshot(); }, 0);
      }
    },
    composer: {
      addContexts(contexts) {
        if (!navigator.userActivation.isActive) return Promise.reject(new Error('user-gesture-required'));
        if (state.refuseInsert) return Promise.reject(new Error('host rejected insertion'));
        for (const item of contexts) {
          if (item.type === 'image-region' && item.regions.some((r) => [r.x, r.y, r.width, r.height].some((v) => v < 0 || v > 1))) {
            state.rejections.push('image-region requires normalized coordinates');
            return Promise.reject(new Error('image-region requires normalized coordinates'));
          }
          if (item.image && (!item.image.content || item.image.content.startsWith('data:'))) return Promise.reject(new Error('raw base64 required'));
        }
        state.contexts.push(...contexts);
        return Promise.resolve({ added: contexts.length });
      },
    },
    ui: { toast() { return Promise.resolve({}); }, confirm() { return Promise.resolve({ confirmed: true }); } },
    appView: { openPreview(path) { state.previews.push(path); return Promise.resolve({ id: '' }); } },
  };
});

try {
  await page.goto(origin);
  await runGalleryTests();
  await runEditorTests();
  await runFailureAndThemeTests();
  assert.deepEqual(pageErrors, [], 'No unhandled page errors');
  console.log('All browser UI checks passed.');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

async function settle() {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function runGalleryTests() {
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 8);
  assert.equal(await page.locator('#app input').count(), 0, 'Prompt search is removed');
  const heading = await page.locator('.header').boundingBox();
  const tabs = await page.locator('#tabs').boundingBox();
  assert(tabs.y >= heading.y + heading.height, 'Filters are below the title');
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 16);
  for (const width of [280, 360, 420, 700, 1000, 1600]) {
    await page.setViewportSize({ width, height: 850 });
    await settle();
    const layout = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.card')].map((e) => {
        const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      return { cards, columns: document.querySelectorAll('.column').length, scroll: document.documentElement.scrollWidth, width: innerWidth };
    });
    assert(layout.columns <= 5, `${width}px: at most five columns`);
    assert(layout.cards.every((r) => r.w <= 220.1 && r.w > 0), `${width}px: cards never exceed 220px`);
    assert(layout.scroll <= layout.width, `${width}px: no horizontal overflow`);
    for (let i = 0; i < layout.cards.length; i++) for (let j = i + 1; j < layout.cards.length; j++) {
      const a = layout.cards[i]; const b = layout.cards[j];
      assert(!(a.x < b.x + b.w - 1 && a.x + a.w > b.x + 1 && a.y < b.y + b.h - 1 && a.y + a.h > b.y + 1), 'Masonry cards do not overlap');
    }
    console.log(`ok UI: ${width}px gallery, ${layout.columns} columns, all cards <=220px`);
  }
  await page.setViewportSize({ width: 1200, height: 850 }); await settle();
  await page.mouse.move(1190, 10);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.card .prompt-overlay')).opacity === '0');
  await page.locator('.card').first().hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.card .prompt-overlay')).opacity === '1');
  const hover = await page.locator('.card').first().evaluate((card) => {
    const c = card.getBoundingClientRect(); const a = card.querySelector('.card-actions').getBoundingClientRect();
    const b = card.querySelector('.badges').getBoundingClientRect();
    return { lineClamp: getComputedStyle(card.querySelector('.prompt')).webkitLineClamp, actionsTop: a.top - c.top, actionsRight: c.right - a.right, badgeLeft: b.left - c.left };
  });
  assert.equal(hover.lineClamp, '2');
  assert(hover.actionsTop < 10 && hover.actionsRight < 10 && hover.badgeLeft < 10);
  const card = await page.locator('.card').first().boundingBox();
  await page.mouse.click(card.x + card.width / 2, card.y + card.height / 2);
  assert.equal(await page.evaluate(() => window.__host.previews.length), 1, 'Click opens the native preview');

  await page.evaluate(() => {
    window.__host.originalRecords = [...window.__host.records];
    window.__host.records = window.__host.records.slice(0, 1); window.__host.snapshot();
  });
  await settle();
  assert((await page.locator('.card').boundingBox()).width <= 220, 'A single card never expands to fill the row');
  await page.evaluate(() => { window.__host.records = window.__host.originalRecords; window.__host.snapshot(); });
  await settle();
  await page.waitForFunction(() => [...document.querySelectorAll('.card')].slice(0, 5).every((card) => card.querySelector('img').naturalWidth > 0 && !card.querySelector('.image-placeholder')));
  await page.screenshot({ path: join(root, 'node_modules/.ui-gallery-wide.png'), fullPage: true });
  console.log('ok UI: hover overlay, top-left metadata, top-right actions, native preview, single-card cap');
}

async function openEditor() {
  await page.locator('#app').waitFor({ state: 'visible' });
  await settle();
  await page.locator('.card').first().hover();
  await page.locator('.card').first().locator('[data-act="edit"]').click();
  await page.waitForFunction(() => !document.getElementById('imageSurface').hidden && !document.getElementById('send').disabled);
  await settle();
}

/** Dispatches a real pointer sequence on the image surface. */
async function drawStroke(from, to) {
  await page.evaluate(([a, b]) => {
    const surface = document.getElementById('imageSurface');
    const rect = surface.getBoundingClientRect();
    const init = (t) => ({ clientX: rect.left + rect.width * t[0], clientY: rect.top + rect.height * t[1], bubbles: true, pointerId: 11, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 });
    surface.dispatchEvent(new PointerEvent('pointerdown', init(a)));
    for (let i = 1; i <= 4; i++) {
      surface.dispatchEvent(new PointerEvent('pointermove', init([a[0] + (b[0] - a[0]) * (i / 4), a[1] + (b[1] - a[1]) * (i / 4)])));
    }
    surface.dispatchEvent(new PointerEvent('pointerup', init(b)));
  }, [from, to]);
  await settle();
}

async function runEditorTests() {
  await page.setViewportSize({ width: 360, height: 720 }); await settle();
  await openEditor();
  const bounds = await page.evaluate(() => {
    const r = document.getElementById('imageSurface').getBoundingClientRect();
    const tools = document.getElementById('toolbar').getBoundingClientRect();
    const stage = document.getElementById('stage').getBoundingClientRect();
    return { w: r.width, h: r.height, right: r.right, bottom: r.bottom, top: r.top, toolbarY: tools.y, toolbarBottom: tools.bottom, stageBottom: stage.bottom, scroll: document.documentElement.scrollWidth };
  });
  assert(bounds.w > 150 && bounds.h > 100 && bounds.right <= 360 && bounds.scroll <= 360, 'Editor image is usable inside a narrow Panel');
  assert(bounds.toolbarBottom <= bounds.stageBottom + 1 && bounds.toolbarBottom > bounds.stageBottom - 60, 'The toolbar floats at the bottom of the stage');
  assert.equal(await page.locator('#insertOriginal').count(), 0, 'Insert-original is gone');
  assert.equal(await page.locator('#editorError').count(), 0, 'No inline red error text remains');
  assert.equal(await page.locator('#commentList, .comment-row').count(), 0, 'Comments no longer live in a list under the image');

  await page.locator('#toolPen').click();
  await drawStroke([.2, .25], [.4, .5]);
  assert.equal(await page.locator('#inkLayer path').count(), 1, 'A stroke is drawn');
  // Reproduces the "sometimes a line vanishes" bug: losing capture mid-stroke
  // used to discard the line; it must survive.
  await page.evaluate(() => {
    const surface = document.getElementById('imageSurface');
    const rect = surface.getBoundingClientRect();
    const at = (x, y) => ({ clientX: rect.left + rect.width * x, clientY: rect.top + rect.height * y, bubbles: true, pointerId: 12, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 });
    surface.dispatchEvent(new PointerEvent('pointerdown', at(.6, .3)));
    surface.dispatchEvent(new PointerEvent('pointermove', at(.75, .45)));
    surface.dispatchEvent(new PointerEvent('lostpointercapture', at(.75, .45)));
  });
  await settle();
  assert.equal(await page.locator('#inkLayer path').count(), 2, 'A stroke interrupted by capture loss is kept, not discarded');

  await page.locator('#toolComment').click();
  let rect = await page.locator('#imageSurface').boundingBox();
  await page.mouse.click(rect.x + rect.width * .3, rect.y + rect.height * .4);
  await page.waitForFunction(() => !document.getElementById('commentPopover').hidden);
  assert(await page.evaluate(() => document.activeElement?.id === 'commentText'), 'The bubble focuses its input right away');
  await page.locator('#commentText').fill('把这里换成暖光');
  const popoverBefore = await page.locator('#commentPopover').boundingBox();
  const pin = await page.locator('.pin').first().boundingBox();
  await page.mouse.move(pin.x + pin.width / 2, pin.y + pin.height / 2);
  await page.mouse.down();
  await page.mouse.move(pin.x + pin.width / 2 + 90, pin.y + pin.height / 2 + 60, { steps: 8 });
  await page.mouse.up();
  await settle();
  const popoverAfter = await page.locator('#commentPopover').boundingBox();
  assert(Math.abs(popoverAfter.x - popoverBefore.x) > 20 && Math.abs(popoverAfter.y - popoverBefore.y) > 10, 'Dragging the pin moves its bubble, so the comment moved');

  rect = await page.locator('#imageSurface').boundingBox();
  await page.mouse.click(rect.x + rect.width * .7, rect.y + rect.height * .6);
  await page.locator('#commentText').fill('保留这个轮廓');
  await page.locator('#instruction').fill('保持构图');
  assert.equal(await page.locator('.pin').count(), 2);
  await page.screenshot({ path: join(root, 'node_modules/.ui-editor-panel.png') });
  await page.waitForFunction(() => !document.getElementById('send').disabled);
  assert.equal((await page.locator('#sendLabel').textContent()).trim(), '插入修改要求', 'A Composer scope offers attaching');
  await page.locator('#send').click();
  await page.waitForFunction(() => window.__host.contexts.length === 1);
  const context = await page.evaluate(() => window.__host.contexts[0]);
  assert.equal(context.type, 'annotation');
  assert.equal(context.image.mimeType, 'image/png');
  assert(context.image.content.length > 100 && !context.image.content.startsWith('data:'));
  assert(context.note.includes('把这里换成暖光') && context.note.includes('保留这个轮廓') && context.note.includes('保持构图'));
  assert(context.reminder.includes('/gallery/picture-0.png'), 'The source path is retained for reference_image_paths');
  const movedPercent = /（(\d+)%, (\d+)%）/.exec(context.note) ?? /\((\d+)%, (\d+)%\)/.exec(context.note);
  assert(movedPercent && Number(movedPercent[1]) > 40, `The dragged comment reports its new position (${movedPercent?.[1]}%)`);
  const marked = await page.evaluate(async (content) => {
    const image = new Image(); image.src = `data:image/png;base64,${content}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let redPixels = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 210 && pixels[i + 1] < 130 && pixels[i + 2] < 130) redPixels++;
    return redPixels;
  }, context.image.content);
  assert(marked > 100, 'The attached evidence contains actual red pen/pin pixels');
  await openEditor();
  assert.equal(await page.locator('.pin').count(), 2, 'Multiple comments survive reopening');
  assert.equal(await page.locator('#inkLayer path').count(), 2, 'Freehand strokes survive reopening');
  await page.evaluate(() => { window.__host.refuseInsert = true; });
  await page.locator('#send').click();
  await page.waitForFunction(() => !document.getElementById('notice').hidden);
  assert.equal(await page.locator('.pin').count(), 2, 'A rejected deliver does not lose the draft');
  await page.evaluate(() => { window.__host.refuseInsert = false; });
  await page.waitForFunction(() => !document.getElementById('send').disabled);
  await page.locator('#send').click();
  await page.waitForFunction(() => window.__host.contexts.length === 2);
  assert.equal(await page.evaluate(() => window.__host.contexts[1].image.name), 'picture-0-annotated.png', 'A retry re-attaches the same marked preview');
  console.log('ok UI: narrow Panel pen + floating bubble comments, pin dragging, capture-loss recovery, single deliver button');

  await openEditor();
  await page.locator('#toolPen').click();
  await drawStroke([.2, .7], [.6, .7]);
  assert.equal(await page.locator('#inkLayer path').count(), 3);
  await page.locator('#undo').click();
  assert.equal(await page.locator('#inkLayer path').count(), 2);
  await page.locator('#clear').click();
  await page.waitForFunction(() => document.querySelectorAll('.pin').length === 0);
  assert.equal(await page.locator('#inkLayer path').count(), 0);
  await page.locator('#back').click();
  await page.evaluate(() => {
    window.__host.view = 'appView'; window.__host.sessionId = '';
    window.__host.emit({ type: 'finch:env', ...window.__host.env() });
  });
  await settle();
  assert.equal(await page.locator('#tabs button').count(), 1, 'App View hides the session-only tab');

  // The App View has no Composer, so the same button sends into a chat instead.
  await openEditor();
  assert(await page.locator('#send').isVisible(), 'App View can still deliver the edit');
  assert.equal((await page.locator('#sendLabel').textContent()).trim(), '发送到新会话', 'The button switches meaning outside a Composer');
  assert(await page.locator('#scopeHint').isHidden(), 'No dead hint while sending is possible');
  await page.locator('#toolComment').click();
  rect = await page.locator('#imageSurface').boundingBox();
  await page.mouse.click(rect.x + rect.width * .3, rect.y + rect.height * .3);
  await page.locator('#commentText').fill('App View 评论');
  await page.locator('#instruction').fill('整体保持构图');
  await page.waitForFunction(() => !document.getElementById('send').disabled);
  await page.locator('#send').click();
  await page.waitForFunction(() => window.__host.sends.length === 1);
  const send = await page.evaluate(() => window.__host.sends[0]);
  assert.equal(send.type, 'sendToSession');
  assert(send.text.includes('/gallery/picture-0.png'), 'The sent text keeps the original path');
  assert(send.text.includes('App View 评论') && send.text.includes('整体保持构图'), 'Every comment and the instruction travel with the send');
  assert(send.text.includes('第 1 张是要修改的原图'), 'The attachment order is explained to the model');
  assert(send.evidence.length > 100 && !send.evidence.startsWith('data:'), 'The composed preview travels as raw base64');
  assert(!!send.idempotencyKey, 'Each attempt carries an idempotency key');
  await page.waitForFunction(() => document.getElementById('editor').hidden, null, { timeout: 5000 });
  console.log('ok UI: App View sends the composed edit into a chat with the original path');

  // A rejected send must keep the draft instead of losing the user's work.
  await page.evaluate(() => { window.__host.failSend = true; });
  await openEditor();
  assert.equal(await page.locator('.pin').count(), 1, 'The comment survived and was reopened');
  await page.locator('#send').click();
  await page.waitForFunction(() => !document.getElementById('notice').hidden);
  assert.equal(await page.locator('.pin').count(), 1, 'A failed send keeps the annotations');
  assert(!(await page.locator('#back').isHidden()));
  await page.evaluate(() => { window.__host.failSend = false; });
  await page.locator('#back').click();

  // Hosts without session support fall back to telling the user where to go.
  await page.evaluate(() => {
    window.__host.canSend = false; window.__host.emit({ type: 'finch:env', ...window.__host.env() });
  });
  await openEditor();
  assert(await page.locator('#send').isHidden(), 'No send button without host support');
  assert(await page.locator('#scopeHint').isVisible(), 'An actionable hint replaces the dead button');
  await page.locator('#back').click();
  await page.evaluate(() => {
    window.__host.canSend = true; window.__host.emit({ type: 'finch:env', ...window.__host.env() });
  });

  // Scope can change on the same live page without a reload (Home -> Session).
  await page.evaluate(() => {
    window.__host.view = 'home'; window.__host.emit({ type: 'finch:env', ...window.__host.env() });
  });
  await openEditor();
  assert(await page.locator('#send').isVisible());
  assert.equal((await page.locator('#sendLabel').textContent()).trim(), '插入修改要求', 'A Composer scope attaches instead of sending');
  await page.evaluate(() => {
    window.__host.view = 'session'; window.__host.sessionId = 'session-2';
    window.__host.emit({ type: 'finch:env', ...window.__host.env() });
  });
  assert(await page.locator('#send').isVisible());
  await page.locator('#back').click();
  console.log('ok UI: undo/clear, App View sending, retry after failure, and repeatable scope changes');
}

async function runFailureAndThemeTests() {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 1200, height: 850 }); await settle();
  await page.screenshot({ path: join(root, 'node_modules/.ui-gallery-dark.png') });
  // 360x420 is tall-image territory, where the capsule must overlap the picture.
  for (const [width, height] of [[280, 560], [420, 560], [1000, 560], [360, 420]]) {
    await page.setViewportSize({ width, height }); await settle();
    await openEditor();
    const geometry = await page.evaluate(() => {
      const image = document.getElementById('imageSurface').getBoundingClientRect();
      const toolbar = document.getElementById('toolbar').getBoundingClientRect();
      const stage = document.getElementById('stage').getBoundingClientRect();
      const editor = document.getElementById('editor').getBoundingClientRect();
      return {
        image: { x: image.x, y: image.y, right: image.right, bottom: image.bottom, width: image.width, height: image.height },
        toolbar: { y: toolbar.y, right: toolbar.right, bottom: toolbar.bottom },
        stage: { top: stage.top, bottom: stage.bottom, height: stage.height },
        editor: { width: editor.width, height: editor.height },
        scroll: document.documentElement.scrollWidth,
      };
    });
    assert(geometry.image.x >= 0 && geometry.image.right <= width && geometry.image.width > 0, `${width}px: image fits`);
    // The capsule floats: it reserves no space, so the picture is centred in the
    // whole stage rather than in a stage shortened by the toolbar.
    const imageCentre = geometry.image.y + geometry.image.height / 2;
    const stageCentre = geometry.stage.top + geometry.stage.height / 2;
    assert(Math.abs(imageCentre - stageCentre) <= 2, `${width}x${height}: the toolbar reserves no layout space`);
    assert(geometry.toolbar.bottom <= geometry.stage.bottom + 1 && geometry.toolbar.bottom > geometry.stage.bottom - 60, `${width}x${height}: the toolbar floats at the bottom of the stage`);
    assert(geometry.toolbar.right <= width, `${width}x${height}: the toolbar fits the width`);
    if (geometry.image.height >= geometry.stage.height - 2) {
      assert(geometry.toolbar.y < geometry.image.bottom, `${width}x${height}: a full-height image sits under the capsule`);
    }
    assert(geometry.scroll <= width && geometry.editor.width === width && geometry.editor.height === height);
    await page.locator('#back').click();
  }
  await page.setViewportSize({ width: 360, height: 720 });
  await page.goto(`${origin}/?slow-image`);
  await page.locator('.card').first().locator('[data-act="edit"]').click({ force: true });
  assert(await page.locator('#send').isDisabled(), 'Loading cannot submit stale image bytes');
  assert.equal(await page.evaluate(() => window.__host.contexts.length), 0, 'Loading never auto-attaches');
  await page.waitForFunction(() => !document.getElementById('send').disabled);
  await page.locator('#send').click();
  await page.waitForFunction(() => window.__host.contexts.length === 1);

  await page.goto(`${origin}/?image-error`);
  await page.locator('.card').first().locator('[data-act="edit"]').click({ force: true });
  await page.waitForFunction(() => document.getElementById('imageStatus').textContent.includes('失败'));
  assert(await page.locator('#send').isDisabled());
  await page.locator('#back').click();
  await page.evaluate(() => { window.__host.failImages = false; });
  await openEditor();
  await page.locator('#back').click();
  const before = await page.locator('.card').count();
  await page.locator('.card').first().locator('[data-act="remove"]').click({ force: true });
  await page.waitForFunction((n) => document.querySelectorAll('.card').length === n - 1, before);
  assert.equal(await page.evaluate(() => window.__host.messages.filter((m) => m.type === 'deleteRecord').at(-1).deleteFile), false);
  console.log('ok UI: dark theme, 280/420/1000px editor, slow/failed image retry, safe removal');
}

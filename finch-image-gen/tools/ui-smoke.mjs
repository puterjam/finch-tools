/** Browser-level UI regression tests with a contract-checking Finch bridge. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
/** The generated Lucide geometry, so an icon can be asserted by shape. */
const lucide = JSON.parse(readFileSync(join(root, 'src/lucide-icons.json'), 'utf8'));
/** Compare icon geometry only: the DOM re-serializes self-closing shapes. */
const flat = (markup) => [...String(markup).matchAll(/<(?:path|rect|circle|line|polyline|polygon|ellipse)\b([^>]*?)\/?>/g)]
  .map((match) => match[1].replace(/\s+/g, ''))
  .join('|');
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
  const state = { records, contexts: [], rejections: [], messages: [], previews: [], view: 'session', sessionId: 'session-1', imageDelay: 0, refuseInsert: false, failImages: false, canSend: true, sends: [], failSend: false, thumbs: new Map(), savedThumbs: [], imageVariants: [] };
  const emit = (message) => listeners.forEach((fn) => fn(message));
  const env = () => ({ view: state.view, sessionId: state.sessionId, locale: 'zh-CN', canSend: state.canSend });
  const snapshot = () => emit({ type: 'gallery', data: state.records, env: env() });
  state.failImages = location.search.includes('image-error');
  state.imageDelay = location.search.includes('slow-image') ? 500 : 0;
  // `?thumbs` arrives as a gallery whose thumbnails were kept on an earlier visit.
  if (location.search.includes('thumbs')) {
    const canvas = document.createElement('canvas');
    canvas.width = 16; canvas.height = 16;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#3b6ea5'; ctx.fillRect(0, 0, 16, 16);
    const kept = canvas.toDataURL('image/webp', .7);
    records.forEach((record) => state.thumbs.set(record.filePath, kept));
  }
  window.__host = Object.assign(state, { emit, snapshot, env });
  window.finch = {
    onMessage(fn) { listeners.push(fn); return () => {}; },
    postMessage(message) {
      state.messages.push(message);
      if (message.type === 'requestGallery') setTimeout(snapshot, 0);
      if (message.type === 'requestImage') setTimeout(() => {
        state.imageVariants.push(`${message.variant}:${message.filePath}`);
        if (state.failImages) return emit({ type: 'imageData', filePath: message.filePath, error: 'unreadable' });
        const kept = state.thumbs.get(message.filePath);
        if (message.variant === 'thumb' && kept) return emit({ type: 'imageData', filePath: message.filePath, variant: 'thumb', dataUrl: kept });
        // A card can be dropped again while its bytes are still in flight.
        const record = records.find((r) => r.filePath === message.filePath) ?? { width: 640, height: 480 };
        const canvas = document.createElement('canvas');
        canvas.width = record.width; canvas.height = record.height;
        const ctx = canvas.getContext('2d');
        const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
        g.addColorStop(0, '#d5e8f2'); g.addColorStop(1, '#e8c7ab'); ctx.fillStyle = g;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#638fa4'; ctx.beginPath();
        ctx.arc(canvas.width * .5, canvas.height * .48, canvas.width * .22, 0, Math.PI * 2); ctx.fill();
        emit({ type: 'imageData', filePath: message.filePath, variant: 'full', dataUrl: canvas.toDataURL() });
      }, state.imageDelay);
      if (message.type === 'saveThumb') {
        state.thumbs.set(message.filePath, message.dataUrl);
        state.savedThumbs.push(message.filePath);
      }
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
  await runLoadingTests();
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

  // Resizing must not reload or re-decode anything: every picture stays painted.
  await page.setViewportSize({ width: 1200, height: 850 }); await settle();
  await page.evaluate(() => {
    window.__adds = 0;
    window.__known = new Set(document.querySelectorAll('.card img'));
    window.__observer = new MutationObserver((records) => {
      records.forEach((record) => record.addedNodes.forEach((node) => { if (node.nodeType === 1) window.__adds += 1; }));
    });
    window.__observer.observe(document.getElementById('grid'), { childList: true, subtree: true });
    document.querySelector('.card img').__tag = 'keep';
  });
  for (const [width, height] of [[1180, 850], [1150, 840], [1200, 860], [1100, 820]]) {
    await page.setViewportSize({ width, height }); await settle();
  }
  // Same column count: the packing is untouched, so the grid is not rebuilt.
  assert.equal(await page.evaluate(() => window.__adds), 0, 'Resizing within the same column count rebuilds nothing');
  assert(await page.evaluate(() => { const img = document.querySelector('.card img'); return img.__tag === 'keep' && img.naturalWidth > 0; }), 'Pictures stay decoded while resizing');
  // Crossing a column boundary re-flows the columns, but must move the very same
  // elements — a fresh <img> would have to decode again and visibly flash.
  await page.setViewportSize({ width: 500, height: 850 }); await settle();
  const reuse = await page.evaluate(() => {
    const images = [...document.querySelectorAll('.card img')];
    return { total: images.length, reused: images.filter((img) => window.__known.has(img)).length, loaded: images.filter((img) => img.naturalWidth > 0).length };
  });
  assert.equal(reuse.reused, reuse.total, `A re-layout reuses every existing image element (${reuse.reused}/${reuse.total})`);
  assert(reuse.loaded > 0, 'A re-layout never blanks the picture');
  await page.evaluate(() => window.__observer.disconnect());
  await page.setViewportSize({ width: 1200, height: 850 }); await settle();
  console.log('ok UI: resizing never re-creates or reloads gallery images');
  await page.mouse.move(1190, 10);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.card .prompt-overlay')).opacity === '0');
  await page.locator('.card').first().hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.card .prompt-overlay')).opacity === '1');
  const hover = await page.locator('.card').first().evaluate((card) => {
    const c = card.getBoundingClientRect(); const a = card.querySelector('.card-actions').getBoundingClientRect();
    return { lineClamp: getComputedStyle(card.querySelector('.prompt')).webkitLineClamp, actionsTop: a.top - c.top, actionsRight: c.right - a.right };
  });
  assert.equal(hover.lineClamp, '2');
  assert(hover.actionsTop < 10 && hover.actionsRight < 10);
  assert.equal(await page.locator('.card .badges, .card .badge').count(), 0, 'Cards carry no format/size pills');

  // A Panel with a Composer of its own gets one extra hover action: hand the
  // picture straight to the input box, with no editing detour.
  const firstCard = page.locator('.card').first();
  await firstCard.hover();
  assert.equal(await firstCard.locator('.card-action').count(), 3, 'A session card offers insert, edit and remove');
  await firstCard.locator('[data-act="insert"]').click();
  await page.waitForFunction(() => window.__host.contexts.length === 1);
  const attached = await page.evaluate(() => window.__host.contexts[0]);
  assert.equal(attached.type, 'image-region', 'The picture is attached as an image, not a chip token');
  assert.equal(attached.name, 'picture-0.png', 'The attachment is named after the file');
  assert(attached.mimeType === 'image/png' && attached.content.length > 100 && !attached.content.startsWith('data:'), 'The attachment carries raw image bytes');
  assert(attached.note.includes('/gallery/picture-0.png'), 'The original path stays visible in the note');
  assert.equal(attached.regions.length, 0, 'A plain attach marks no regions');
  assert(await page.locator('#editor').isHidden(), 'Attaching never opens the editor');
  await page.screenshot({ path: join(root, 'node_modules/.ui-card-actions.png') });
  await page.evaluate(() => { window.__host.contexts.length = 0; });
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
  console.log('ok UI: hover overlay, top-right actions, native preview, single-card cap');
}

/** The gallery opens on the current session, so these tests ask for everything. */
async function showAll() {
  await page.locator('#tabs button').first().click();
  await settle();
}

async function runLoadingTests() {
  // Opening the library again must not re-read the originals: the grid asks for
  // the thumbnail the page kept last time and renders straight from it. A tall
  // window keeps most of the 16 records on screen, so the sample is meaningful.
  await page.setViewportSize({ width: 960, height: 1000 });
  await page.goto(`${origin}/?thumbs`);
  await showAll();
  await page.waitForFunction(() => window.__host.imageVariants.length >= 12);
  const kept = await page.evaluate(() => ({
    variants: window.__host.imageVariants,
    src: document.querySelector('.card img')?.getAttribute('src') ?? '',
  }));
  assert(kept.variants.every((entry) => entry.startsWith('thumb:')), `A kept thumbnail is fetched, not the original (${kept.variants.slice(0, 3).join(' ')})`);
  assert(kept.src.startsWith('data:image/webp;base64,'), 'The card renders the thumbnail bytes');

  // A picture seen for the first time is rendered from the original once, then
  // handed back as a thumbnail so the next visit is cheap.
  await page.goto(origin);
  await showAll();
  await page.waitForFunction(() => window.__host.savedThumbs.length >= 12);
  const saved = await page.evaluate(() => {
    const first = window.__host.savedThumbs[0];
    return { count: window.__host.savedThumbs.length, bytes: window.__host.thumbs.get(first).length };
  });
  assert(saved.count >= 12, `Every rendered card is kept as a thumbnail (${saved.count})`);
  assert(saved.bytes > 100 && saved.bytes < 400000, `A thumbnail stays small (${saved.bytes} bytes)`);
  assert(await page.evaluate(() => window.__host.messages.filter((m) => m.type === 'saveThumb').length) === saved.count, 'The thumbnail is sent to the extension, not just cached in the page');

  // A big library arrives one page at a time; a short window keeps one page
  // taller than the viewport so nothing is filled in ahead of the scroll.
  await page.setViewportSize({ width: 960, height: 600 });
  await page.evaluate(() => {
    window.__host.originalRecords = [...window.__host.records];
    window.__host.records = Array.from({ length: 45 }, (_, i) => ({
      ...window.__host.originalRecords[i % 16], id: `page-${i}`, filePath: `/gallery/page-${i}.png`, name: `page-${i}.png`,
    }));
    window.__host.snapshot();
  });
  await settle();
  assert.equal(await page.locator('.card').count(), 20, 'A page renders 20 cards');
  assert.equal((await page.locator('#count').textContent()).trim(), '共 45 张', 'The count still reports the whole library');
  const before = await page.evaluate(() => {
    const bar = document.getElementById('topbar');
    return { stuck: bar.classList.contains('stuck'), border: getComputedStyle(bar).borderBottomWidth };
  });
  assert(!before.stuck && before.border === '0px', `No divider before anything scrolls (${JSON.stringify(before)})`);

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await settle();
  assert.equal(await page.locator('.card').count(), 40, 'Reaching the bottom loads the next page');
  const bar = await page.evaluate(() => {
    const node = document.getElementById('topbar');
    return { top: Math.round(node.getBoundingClientRect().top), stuck: node.classList.contains('stuck'), border: getComputedStyle(node).borderBottomWidth };
  });
  assert.equal(bar.top, 0, 'The title and filters stay at the top while the grid scrolls');
  assert(bar.stuck && bar.border === '1px', `A divider appears once content passes under them (${JSON.stringify(bar)})`);
  await page.screenshot({ path: join(root, 'node_modules/.ui-sticky-bar.png') });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await settle();
  assert.equal(await page.locator('.card').count(), 45, 'The last page stops at the end of the library');

  await page.evaluate(() => {
    window.__host.records = window.__host.originalRecords;
    window.__host.snapshot();
    window.scrollTo(0, 0);
  });
  await settle();
  console.log('ok UI: thumbnails, paged loading and a sticky title with a divider');
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
  assert(bounds.w > 150 && bounds.h > 100 && bounds.right <= 360 && bounds.scroll <= 360, `Editor image is usable inside a narrow Panel (${Math.round(bounds.w)}×${Math.round(bounds.h)})`);
  assert(bounds.toolbarBottom <= bounds.stageBottom + 1 && bounds.toolbarBottom > bounds.stageBottom - 60, 'The toolbar floats at the bottom of the stage');
  assert.equal(await page.locator('#insertOriginal').count(), 0, 'Insert-original is gone');
  assert.equal(await page.locator('#editorError').count(), 0, 'No inline red error text remains');
  assert.equal(await page.locator('#commentList, .comment-row').count(), 0, 'Comments no longer live in a list under the image');

  // Tools in the order they are used: mark the picture, then take marks back.
  const tools = await page.evaluate(() => [...document.getElementById('toolbar').children].map((node) => node.id));
  assert.equal(tools.join(','), 'toolPen,toolComment,toolSize,toolDivider,undo,clear', `The size tool sits between the comment tool and the divider (${tools.join(',')})`);
  // A rubber is a tool that removes pixels; this button clears marks, so it must
  // not look like something that rubs out the picture.
  assert.equal(await page.locator('#clear').getAttribute('data-icon'), 'trash-2', 'Clearing marks is a delete, not an eraser');

  // The toolbar can change the output size too, with the same presets.
  await page.locator('#toolSize').click();
  await page.waitForFunction(() => !document.getElementById('sizeMenu').hidden);
  const sizeMenu = await page.evaluate(() => {
    const menu = document.getElementById('sizeMenu').getBoundingClientRect();
    const tool = document.getElementById('toolSize').getBoundingClientRect();
    const rows = [...document.querySelectorAll('#sizeMenuList .menu-row')];
    return {
      above: menu.bottom <= tool.top + 1,
      ratios: rows.map((row) => row.querySelector('.menu-ratio')?.textContent ?? ''),
      labels: rows.map((row) => row.textContent.trim()),
      checked: rows.filter((row) => row.getAttribute('aria-checked') === 'true').length,
    };
  });
  assert(sizeMenu.above, 'The size menu opens above its toolbar button');
  await page.screenshot({ path: join(root, 'node_modules/.ui-editor-size.png') });
  assert.equal(sizeMenu.ratios.join('|'), '1:1|3:4|9:16|4:3|16:9', `The size menu offers the aspect presets (${sizeMenu.ratios.join('|')})`);
  assert.equal(sizeMenu.checked, 0, 'No size is claimed before the request says one');
  // The size belongs to this edit: picking one writes it into the instructions,
  // the text that reaches the input box, instead of changing a global default.
  await page.locator('#sizeMenuList .menu-row').nth(4).click();
  await page.waitForFunction(() => document.getElementById('sizeMenu').hidden);
  assert.equal(await page.locator('#instruction').inputValue(), '输出尺寸：16:9（1280x720）', 'Picking a size writes it into the instructions');
  assert.equal(await page.evaluate(() => window.__host.messages.some((m) => m.type === 'setDefaultSize')), false, 'The gallery never writes the tool default');
  await page.locator('#instruction').fill('把天空换成黄昏');
  await page.locator('#toolSize').click();
  await page.waitForFunction(() => !document.getElementById('sizeMenu').hidden);
  await page.locator('#sizeMenuList .menu-row').nth(0).click();
  await page.waitForFunction(() => document.getElementById('sizeMenu').hidden);
  assert.equal(await page.locator('#instruction').inputValue(), '把天空换成黄昏\n输出尺寸：1:1（1024x1024）', 'A second pick replaces the size line and keeps the request');
  await page.locator('#toolSize').click();
  await page.waitForFunction(() => !document.getElementById('sizeMenu').hidden);
  const markedRow = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#sizeMenuList .menu-row')];
    return rows.find((row) => row.getAttribute('aria-checked') === 'true')?.textContent.trim() ?? '';
  });
  assert(markedRow.includes('1:1'), `The asked-for size is marked (${markedRow})`);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('sizeMenu').hidden);
  await page.locator('#instruction').fill('');

  // The field is a readable width with an explicit send button beside it.
  await page.setViewportSize({ width: 1000, height: 800 }); await settle();
  const composer = await page.evaluate(() => {
    const fieldEl = document.getElementById('instruction');
    fieldEl.focus();
    const field = fieldEl.getBoundingClientRect();
    const send = document.getElementById('send').getBoundingClientRect();
    const style = getComputedStyle(fieldEl);
    return {
      width: field.width, right: field.right, centreY: field.y + field.height / 2,
      sendLeft: send.left, sendCentreY: send.y + send.height / 2,
      outline: style.outlineStyle, outlineWidth: style.outlineWidth,
    };
  });
  assert(composer.width > 380 && composer.width <= 430.5, `The instruction field keeps a readable width (${Math.round(composer.width)}px)`);
  assert(composer.sendLeft > composer.right, 'An explicit send button sits to the right of the field');
  assert(Math.abs(composer.sendCentreY - composer.centreY) < 6, 'The button shares the field’s row');
  assert(composer.outline === 'none' || composer.outlineWidth === '0px', `A focused field shows one boundary, not two (outline ${composer.outline} ${composer.outlineWidth})`);
  await page.setViewportSize({ width: 360, height: 720 }); await settle();

  await page.locator('#toolPen').click();
  await drawStroke([.2, .25], [.4, .5]);
  assert.equal(await page.locator('#inkLayer path').count(), 1, 'A stroke is drawn');  // The frame is fitted by CSS, so the ink must still land in natural pixels.
  const ink = await page.evaluate(() => document.querySelector('#inkLayer path').getAttribute('d'));
  const first = /^M([\d.]+) ([\d.]+)/.exec(ink);
  assert(first && Math.abs(Number(first[1]) - 768 * .2) < 6 && Math.abs(Number(first[2]) - 1024 * .25) < 8, `A stroke maps to image coordinates (${ink.slice(0, 18)})`);
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
  assert.equal(await page.locator('#imageSurface').evaluate((node) => getComputedStyle(node).boxShadow), 'none', 'The picture frame has no shadow');

  await page.locator('#toolComment').click();
  let rect = await page.locator('#imageSurface').boundingBox();
  await page.mouse.click(rect.x + rect.width * .3, rect.y + rect.height * .4);
  await page.waitForFunction(() => !document.getElementById('commentPopover').hidden);
  assert(await page.evaluate(() => document.activeElement?.id === 'commentText'), 'The bubble focuses its input right away');
  // A selected pin is a soft halo, not a second hard ring around its border.
  const pinRing = await page.evaluate(() => { const style = getComputedStyle(document.querySelector('.pin')); return { outline: style.outlineStyle, outlineWidth: style.outlineWidth }; });
  assert(pinRing.outline === 'none' || pinRing.outlineWidth === '0px', `A selected pin shows one ring (outline ${pinRing.outline} ${pinRing.outlineWidth})`);
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
  assert.equal((await page.locator('#sendLabel').textContent()).trim(), '插入图片和说明', 'A Composer scope offers attaching the picture with its request');
  await page.locator('#send').click();
  await page.waitForFunction(() => window.__host.contexts.length === 1);
  const context = await page.evaluate(() => window.__host.contexts[0]);
  // The picture goes in as an image attachment, not an annotation token…
  assert.equal(context.type, 'image-region');
  assert.equal(context.mimeType, 'image/png');
  assert.equal(context.displayName, 'picture-0.png', 'The attachment still reads as the picture the user knows');
  assert(context.content.length > 100 && !context.content.startsWith('data:'));
  // …and the request travels with it, on screen: the note lists every comment
  // with its position, plus the instructions and the original path.
  assert(context.note.includes('把这里换成暖光') && context.note.includes('保留这个轮廓') && context.note.includes('保持构图'), 'Every comment and the instruction are in the visible note');
  assert(context.note.includes('/gallery/picture-0.png'), 'The source path is retained for reference_image_paths');
  const notePercent = /（(\d+)%, (\d+)%）/.exec(context.note) ?? /\((\d+)%, (\d+)%\)/.exec(context.note);
  assert(notePercent && Number(notePercent[1]) > 40, `The dragged comment reports its new position (${notePercent?.[1]}%)`);
  // Each pin is also a region, so the picture itself shows where each comment is.
  assert.equal(context.regions.length, 2, 'One region per comment');
  assert(context.regions.every((region) => ['x', 'y', 'width', 'height'].every((key) => region[key] >= 0 && region[key] <= 1)), `Regions stay normalized (${JSON.stringify(context.regions[0])})`);
  assert(context.regions.some((region) => region.note === '保留这个轮廓') && context.regions.some((region) => region.note === '把这里换成暖光'), 'Each region carries its own comment');
  assert.equal(await page.evaluate(() => window.__host.messages.filter((m) => m.type === 'stagePrompt').length), 0, 'Nothing is parked for a second click anymore');
  const marked = await page.evaluate(async (content) => {
    const image = new Image(); image.src = `data:image/png;base64,${content}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let redPixels = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 210 && pixels[i + 1] < 130 && pixels[i + 2] < 130) redPixels++;
    return redPixels;
  }, context.content);
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
  assert.equal(await page.evaluate(() => window.__host.contexts[1].name), 'picture-0-annotated.png', 'A retry re-attaches the same marked preview');
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

  // The App View browses: it has no Composer, so its cards hand the image over
  // to the Session that produced it instead of opening an editor here.
  assert.equal(await page.locator('.card-action[data-act="edit"]').count(), 0, 'The App View offers no editing entry');
  assert.equal(await page.locator('.card-action[data-act="insert"]').count(), 0, 'The App View has no input box to attach into');
  const adjustButtons = page.locator('.card-action[data-act="adjust"]');
  assert.equal(await adjustButtons.count(), 16, `Every card offers to adjust it in its session (${await adjustButtons.count()})`);
  assert.equal(await adjustButtons.first().getAttribute('aria-label'), '调整', 'The button reads 调整, not 编辑');
  // The action leaves this surface, so it is drawn as a jump, not a slider.
  assert.equal(flat(await adjustButtons.first().locator('svg').innerHTML()), flat(lucide['arrow-up-right']), 'Adjusting is drawn as a jump arrow');
  await page.locator('.card').first().hover();
  await page.screenshot({ path: join(root, 'node_modules/.ui-appview-adjust.png') });
  await adjustButtons.first().click();
  await page.waitForFunction(() => window.__host.messages.some((m) => m.type === 'adjustImage'));
  const adjust = await page.evaluate(() => window.__host.messages.filter((m) => m.type === 'adjustImage').at(-1));
  assert.equal(adjust.id, 'image-0', `Adjusting names the image the extension should open (${JSON.stringify(adjust)})`);
  assert(await page.locator('#editor').isHidden(), 'No editor opens in the App View');

  // An image that was never generated in a Session has nowhere to be adjusted.
  await page.evaluate(() => {
    const orphan = { ...window.__host.records[0], id: 'image-orphan', filePath: '/gallery/orphan.png', name: 'orphan.png', sessionId: '' };
    window.__host.records = [orphan, ...window.__host.records];
    window.__host.snapshot();
  });
  await settle();
  assert.equal(await page.locator('.card-action[data-act="adjust"]').count(), 16, 'The other cards still offer adjusting');
  assert.equal(await page.locator('.card[data-id="image-orphan"] .card-action').count(), 1, 'A card with no Session offers no dead button');
  await page.evaluate(() => {
    window.__host.records = window.__host.records.filter((r) => r.id !== 'image-orphan');
    window.__host.snapshot();
  });
  await settle();
  assert.equal(await page.locator('.card').count(), 16, 'The orphan card is dropped again');

  // The extension can also ask a Session panel to open the editor directly.
  await page.evaluate(() => {
    window.__host.view = 'session'; window.__host.sessionId = 'session-1';
    window.__host.emit({ type: 'finch:env', ...window.__host.env() });
    window.__host.emit({ type: 'editImage', id: 'image-2' });
  });
  await page.waitForFunction(() => !document.getElementById('editor').hidden);
  assert.equal(await page.locator('#editorTitle').textContent(), '编辑图片', 'A handed-over image opens in the session panel editor');
  await page.locator('#back').click();
  await settle();
  console.log('ok UI: the App View hands images over instead of editing them');

  // A Panel scope with no Composer of its own (the session container) still
  // sends the composed edit into a chat, so the editor stays reachable there.
  await page.evaluate(() => {
    window.__host.view = 'container'; window.__host.sessionId = '';
    window.__host.emit({ type: 'finch:env', ...window.__host.env() });
  });
  await settle();
  await openEditor();
  assert(await page.locator('#send').isVisible(), 'A Composer-less Panel scope can still deliver the edit');
  assert.equal((await page.locator('#sendLabel').textContent()).trim(), '发送到新会话', 'The button switches meaning outside a Composer');
  // The button swaps its icon with the scope, so the markup must follow too.
  assert.equal(flat(await page.locator('#sendIcon').innerHTML()), flat(lucide.send), 'The send button keeps its own icon');
  assert(await page.locator('#scopeHint').isHidden(), 'No dead hint while sending is possible');
  await page.locator('#toolComment').click();
  rect = await page.locator('#imageSurface').boundingBox();
  await page.mouse.click(rect.x + rect.width * .3, rect.y + rect.height * .3);
  await page.locator('#commentText').fill('容器评论');
  await page.locator('#instruction').fill('整体保持构图');
  await page.waitForFunction(() => !document.getElementById('send').disabled);
  await page.locator('#send').click();
  await page.waitForFunction(() => window.__host.sends.length === 1);
  const send = await page.evaluate(() => window.__host.sends[0]);
  assert.equal(send.type, 'sendToSession');
  assert(send.text.includes('/gallery/picture-0.png'), 'The sent text keeps the original path');
  assert(send.text.includes('容器评论') && send.text.includes('整体保持构图'), 'Every comment and the instruction travel with the send');
  assert(send.text.includes('第 1 张是要修改的原图'), 'The attachment order is explained to the model');
  assert(send.evidence.length > 100 && !send.evidence.startsWith('data:'), 'The composed preview travels as raw base64');
  assert(!!send.idempotencyKey, 'Each attempt carries an idempotency key');
  await page.waitForFunction(() => document.getElementById('editor').hidden, null, { timeout: 5000 });
  console.log('ok UI: a Composer-less Panel scope sends the composed edit into a chat with the original path');

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
  assert.equal((await page.locator('#sendLabel').textContent()).trim(), '插入图片和说明', 'A Composer scope attaches instead of sending');
  await page.evaluate(() => {
    window.__host.view = 'session'; window.__host.sessionId = 'session-2';
    window.__host.emit({ type: 'finch:env', ...window.__host.env() });
  });
  assert(await page.locator('#send').isVisible());
  await page.locator('#back').click();
  console.log('ok UI: undo/clear, Composer-less sending, retry after failure, and repeatable scope changes');
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
    // Native fitting: the frame keeps the picture's ratio instead of stretching.
    const ratio = geometry.image.width / geometry.image.height;
    assert(Math.abs(ratio - 768 / 1024) < .02, `${width}x${height}: the frame keeps the picture's aspect ratio (${ratio.toFixed(3)})`);
    assert(geometry.image.height <= geometry.stage.height + 1 && geometry.image.bottom <= geometry.stage.bottom + 1, `${width}x${height}: the frame stays inside the stage`);
    // The capsule floats: it reserves no space, so the picture is centred in the
    // whole stage rather than in a stage shortened by the toolbar.
    const imageCentre = geometry.image.y + geometry.image.height / 2;
    const stageCentre = geometry.stage.top + geometry.stage.height / 2;
    assert(Math.abs(imageCentre - stageCentre) <= 2, `${width}x${height}: the toolbar reserves no layout space`);
    assert(geometry.toolbar.bottom <= geometry.stage.bottom + 1 && geometry.toolbar.bottom > geometry.stage.bottom - 60, `${width}x${height}: the toolbar floats at the bottom of the stage`);
    assert(geometry.toolbar.right <= width, `${width}x${height}: the toolbar fits the width`);
    // The capsule is one row: a second line under the tools reads as broken,
    // especially when the row still has room left over.
    const capsule = await page.evaluate(() => {
      const bar = document.getElementById('toolbar');
      // Hidden tools (nothing to undo) have no box and must not count as a row.
      const tools = [...bar.querySelectorAll('.tool')].filter((tool) => tool.getBoundingClientRect().width > 0);
      const box = (node) => { const r = node.getBoundingClientRect(); return { t: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width) }; };
      return {
        height: Math.round(bar.getBoundingClientRect().height),
        width: Math.round(bar.getBoundingClientRect().width),
        tools: tools.map((tool) => `${tool.id}${JSON.stringify(box(tool))}`),
        rows: new Set(tools.map((tool) => Math.round(tool.getBoundingClientRect().top))).size,
      };
    });
    assert.equal(capsule.rows, 1, `${width}x${height}: every tool stays on one row (${JSON.stringify(capsule)})`);
    assert(capsule.height <= 44, `${width}x${height}: the capsule is a single row tall (${capsule.height}px)`);
    await page.locator('#toolSize').click();
    await page.waitForFunction(() => !document.getElementById('sizeMenu').hidden);
    const rows = await page.evaluate(() => {
      const menu = document.getElementById('sizeMenu').getBoundingClientRect();
      const boxes = [...document.querySelectorAll('#sizeMenuList .menu-row')].map((row) => Math.round(row.getBoundingClientRect().width));
      const ratios = [...document.querySelectorAll('#sizeMenuList .menu-ratio')].map((node) => Math.round(node.getBoundingClientRect().right));
      return { menu: Math.round(menu.width), boxes, ratios };
    });
    assert(new Set(rows.boxes).size === 1, `${width}x${height}: every menu row is the same width (${JSON.stringify(rows)})`);
    assert(new Set(rows.ratios).size === 1, `${width}x${height}: the ratios line up on the right (${JSON.stringify(rows.ratios)})`);
    assert(rows.boxes[0] <= rows.menu, `${width}x${height}: rows stay inside the menu (${JSON.stringify(rows)})`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('sizeMenu').hidden);
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

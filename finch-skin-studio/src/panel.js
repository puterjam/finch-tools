(function () {
  'use strict';
  var api = window.finch;

  // ── i18n ──────────────────────────────────────────────────────────────
  var DICT = {
    'en-US': {
      title: 'Skin Studio', bgHeading: 'Home Background', bgEmpty: 'No background image set',
      bgEmptyHint: 'Drag & drop an image here, or',
      choose: 'Choose image', clear: 'Clear', placement: 'Placement', fill: 'Fill', tile: 'Tile',
      tone: 'Brightness', skinsHeading: 'Skins', addCard: 'Save current skin',
      current: 'Current', deleteConfirmTitle: 'Delete this skin?',
      deleteConfirmMessage: 'This custom skin will be removed. This cannot be undone.',
      deleteConfirm: 'Delete', deleteCancel: 'Cancel', applied: 'Skin applied', removed: 'Skin removed',
      backgroundUpdated: 'Background updated', backgroundCleared: 'Background cleared',
      noCurrentSkin: 'No applied skin to save yet — apply a preset first.',
      dropInvalidType: 'Please drop an image file (PNG / JPEG / WebP / GIF / AVIF).',
      dropTooLarge: 'Image is too large (max 15MB).',
    },
    'zh-CN': {
      title: '换肤工坊', bgHeading: '首页背景', bgEmpty: '尚未设置背景图',
      bgEmptyHint: '拖拽图片到这里，或',
      choose: '选择图片', clear: '清除', placement: '铺放方式', fill: '铺满', tile: '平铺',
      tone: '明暗程度', skinsHeading: '配色皮肤', addCard: '保存当前皮肤',
      current: '使用中', deleteConfirmTitle: '删除这个皮肤？',
      deleteConfirmMessage: '这个自定义皮肤将被移除，此操作无法撤销。',
      deleteConfirm: '删除', deleteCancel: '取消', applied: '已应用皮肤', removed: '已删除皮肤',
      backgroundUpdated: '背景已更新', backgroundCleared: '背景已清除',
      noCurrentSkin: '还没有可保存的当前皮肤，请先应用一个预设。',
      dropInvalidType: '请拖拽图片文件（PNG / JPEG / WebP / GIF / AVIF）。',
      dropTooLarge: '图片过大（最多 15MB）。',
    },
  };
  DICT['zh-HK'] = DICT['zh-CN'];

  var locale = 'en-US';
  function t(key) { var d = DICT[locale] || DICT['en-US']; return d[key] || DICT['en-US'][key] || key; }

  function applyStaticI18n() {
    document.getElementById('t-title').textContent = t('title');
    document.getElementById('t-bg-heading').textContent = t('bgHeading');
    document.getElementById('t-bg-empty').textContent = t('bgEmpty');
    document.getElementById('t-bg-empty-hint').textContent = t('bgEmptyHint');
    document.getElementById('t-choose').textContent = t('choose');
    document.getElementById('t-clear').textContent = t('clear');
    document.getElementById('t-placement').textContent = t('placement');
    document.getElementById('t-fill').textContent = t('fill');
    document.getElementById('t-tile').textContent = t('tile');
    document.getElementById('t-tone').textContent = t('tone');
    document.getElementById('t-skins-heading').textContent = t('skinsHeading');
  }

  // ── Color helpers ─────────────────────────────────────────────────────
  var BASE_DEFAULTS = {
    light: { bgRoot: '#ffffff', bgMain: '#ffffff', bgSidebar: '#f5f5f7', bgElevated: '#ffffff', textPrimary: '#18181b', textSecondary: '#71717a', textTertiary: '#a1a1aa', accent: '#2563eb', accentDim: '#dbeafe', border: '#e4e4e7' },
    dark: { bgRoot: '#18181b', bgMain: '#1c1c1f', bgSidebar: '#141416', bgElevated: '#232326', textPrimary: '#f4f4f5', textSecondary: '#a1a1aa', textTertiary: '#71717a', accent: '#6366f1', accentDim: '#26264a', border: '#2b2b2f' },
  };
  function mergedColors(skin) {
    var defaults = BASE_DEFAULTS[skin.base] || BASE_DEFAULTS.light;
    return Object.assign({}, defaults, skin.colors || {});
  }

  function buildThumb(skin) {
    var c = mergedColors(skin);
    var thumb = document.createElement('div');
    thumb.className = 'thumb';
    thumb.style.background = c.bgMain;
    var side = document.createElement('div');
    side.className = 'side';
    side.style.background = c.bgSidebar;
    var main = document.createElement('div');
    main.className = 'main';
    var bar1 = document.createElement('div');
    bar1.className = 'bar w1';
    bar1.style.background = c.textSecondary;
    bar1.style.opacity = '0.55';
    var bar2 = document.createElement('div');
    bar2.className = 'bar w2';
    bar2.style.background = c.textTertiary;
    bar2.style.opacity = '0.55';
    var pill = document.createElement('div');
    pill.className = 'pill';
    pill.style.background = c.accent;
    main.appendChild(bar1);
    main.appendChild(bar2);
    main.appendChild(pill);
    thumb.appendChild(side);
    thumb.appendChild(main);
    return thumb;
  }

  // ── State ─────────────────────────────────────────────────────────────
  var state = { builtin: [], custom: [], background: { placement: 'fill', tone: 'balanced' }, lastAppliedId: undefined, loaded: false };

  function toFinchFileUrl(absolutePath) {
    return 'finch-file://local?path=' + encodeURIComponent(absolutePath);
  }

  function renderBackground() {
    var preview = document.getElementById('bg-preview');
    var img = document.getElementById('bg-image');
    var placeholder = document.getElementById('bg-placeholder');
    var btnClear = document.getElementById('btn-clear');
    var bg = state.background || {};
    preview.classList.toggle('tile', bg.placement === 'tile');
    if (bg.imagePath) {
      img.src = toFinchFileUrl(bg.imagePath);
      img.style.display = 'block';
      placeholder.style.display = 'none';
      btnClear.disabled = false;
    } else {
      img.style.display = 'none';
      placeholder.style.display = 'block';
      btnClear.disabled = true;
    }
    var segP = document.getElementById('seg-placement');
    Array.prototype.forEach.call(segP.querySelectorAll('button'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-value') === (bg.placement || 'fill'));
    });
    var segT = document.getElementById('seg-tone');
    Array.prototype.forEach.call(segT.querySelectorAll('button'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-value') === (bg.tone || 'balanced'));
    });
  }

  function computeColumns() {
    var grid = document.getElementById('skins-grid');
    var width = grid.clientWidth || window.innerWidth || 360;
    var cols = Math.floor(width / 168);
    if (cols < 2) cols = 2;
    if (cols > 4) cols = 4;
    grid.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
  }

  function makeSkinCard(skin, isCustom) {
    var card = document.createElement('div');
    card.className = 'skin-card' + (state.lastAppliedId === skin.id ? ' active' : '');
    card.appendChild(buildThumb(skin));
    var nameRow = document.createElement('div');
    nameRow.className = 'skin-name';
    var nameSpan = document.createElement('span');
    nameSpan.className = 'n';
    nameSpan.textContent = skin.name;
    nameRow.appendChild(nameSpan);
    if (isCustom) {
      var del = document.createElement('button');
      del.className = 'del-btn';
      del.type = 'button';
      del.textContent = '✕';
      del.title = t('deleteConfirm');
      del.addEventListener('click', function (ev) {
        ev.stopPropagation();
        confirmRemove(skin);
      });
      nameRow.appendChild(del);
    }
    card.appendChild(nameRow);
    if (state.lastAppliedId === skin.id) {
      var badge = document.createElement('div');
      badge.className = 'check-badge';
      badge.textContent = '✓';
      card.appendChild(badge);
    }
    card.addEventListener('click', function () {
      api.postMessage({ type: 'applySkin', id: skin.id });
    });
    return card;
  }

  function confirmRemove(skin) {
    api.ui.confirm({
      title: t('deleteConfirmTitle'),
      message: t('deleteConfirmMessage'),
      confirmLabel: t('deleteConfirm'),
      cancelLabel: t('deleteCancel'),
      variant: 'danger',
    }).then(function (res) {
      if (res && res.confirmed) {
        api.postMessage({ type: 'removeSkin', id: skin.id });
      }
    });
  }

  function renderSkins() {
    var grid = document.getElementById('skins-grid');
    grid.innerHTML = '';
    if (!state.loaded) {
      for (var i = 0; i < 4; i++) {
        var sk = document.createElement('div');
        sk.className = 'skeleton';
        var t1 = document.createElement('div');
        t1.className = 'thumb';
        var l1 = document.createElement('div');
        l1.className = 'sk-line';
        sk.appendChild(t1);
        sk.appendChild(l1);
        grid.appendChild(sk);
      }
      computeColumns();
      return;
    }
    state.builtin.forEach(function (skin) { grid.appendChild(makeSkinCard(skin, false)); });
    state.custom.forEach(function (skin) { grid.appendChild(makeSkinCard(skin, true)); });
    var addCard = document.createElement('button');
    addCard.type = 'button';
    addCard.className = 'add-card';
    addCard.innerHTML = '<span style="font-size:20px;line-height:1;">＋</span><span>' + t('addCard') + '</span>';
    addCard.addEventListener('click', function () {
      api.postMessage({ type: 'requestSaveCurrent' });
    });
    grid.appendChild(addCard);
    computeColumns();
  }

  // ── Toast ─────────────────────────────────────────────────────────────
  var toastTimer;
  function showToast(msg) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  // ── Wire up controls ──────────────────────────────────────────────────
  document.getElementById('btn-pick').addEventListener('click', function () {
    api.postMessage({ type: 'pickBackgroundImage' });
  });
  document.getElementById('btn-clear').addEventListener('click', function () {
    api.postMessage({ type: 'clearBackground' });
  });
  document.getElementById('seg-placement').addEventListener('click', function (ev) {
    var btn = ev.target.closest('button[data-value]');
    if (!btn) return;
    api.postMessage({ type: 'setBackgroundOptions', placement: btn.getAttribute('data-value') });
  });
  document.getElementById('seg-tone').addEventListener('click', function (ev) {
    var btn = ev.target.closest('button[data-value]');
    if (!btn) return;
    api.postMessage({ type: 'setBackgroundOptions', tone: btn.getAttribute('data-value') });
  });

  // ── Drag & drop background image ───────────────────────────────────────
  var MAX_DROPPED_IMAGE_BYTES = 15 * 1024 * 1024; // 15 MB, mirrors the backend limit
  var IMAGE_TYPE_RE = /^image\/(png|jpeg|jpg|webp|gif|avif)$/;
  var bgPreview = document.getElementById('bg-preview');
  var dragDepth = 0;

  function isFileDrag(ev) {
    var types = ev.dataTransfer && ev.dataTransfer.types;
    return !!types && Array.prototype.indexOf.call(types, 'Files') !== -1;
  }

  bgPreview.addEventListener('dragenter', function (ev) {
    if (!isFileDrag(ev)) return;
    ev.preventDefault();
    dragDepth++;
    bgPreview.classList.add('drag-over');
  });
  bgPreview.addEventListener('dragover', function (ev) {
    if (!isFileDrag(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
  });
  bgPreview.addEventListener('dragleave', function () {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) bgPreview.classList.remove('drag-over');
  });
  bgPreview.addEventListener('drop', function (ev) {
    ev.preventDefault();
    dragDepth = 0;
    bgPreview.classList.remove('drag-over');
    var files = ev.dataTransfer && ev.dataTransfer.files;
    if (!files || files.length === 0) return;
    var file = files[0];
    if (!IMAGE_TYPE_RE.test(file.type)) {
      showToast(t('dropInvalidType'));
      return;
    }
    if (file.size > MAX_DROPPED_IMAGE_BYTES) {
      showToast(t('dropTooLarge'));
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      api.postMessage({ type: 'dropBackgroundImage', dataUrl: String(reader.result || ''), name: file.name });
    };
    reader.onerror = function () {
      showToast(t('dropInvalidType'));
    };
    reader.readAsDataURL(file);
  });

  // Prevent an errant drop outside the preview box from navigating the whole
  // panel away to the dropped image (default browser behavior).
  document.addEventListener('dragover', function (ev) { if (isFileDrag(ev)) ev.preventDefault(); });
  document.addEventListener('drop', function (ev) { if (isFileDrag(ev)) ev.preventDefault(); });

  new ResizeObserver(function () { computeColumns(); }).observe(document.getElementById('skins-grid'));

  // ── Bridge messages ───────────────────────────────────────────────────
  api.onMessage(function (msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'finch:env') {
      if (msg.locale) { locale = msg.locale; applyStaticI18n(); renderBackground(); renderSkins(); }
      return;
    }
    if (msg.type === 'state') {
      if (msg.env && msg.env.locale) locale = msg.env.locale;
      state.builtin = msg.builtin || [];
      state.custom = msg.custom || [];
      state.background = msg.background || { placement: 'fill', tone: 'balanced' };
      state.lastAppliedId = msg.lastAppliedId;
      state.loaded = true;
      applyStaticI18n();
      renderBackground();
      renderSkins();
      return;
    }
    if (msg.type === 'error') {
      showToast(String(msg.message || ''));
      return;
    }
  });

  applyStaticI18n();
  renderBackground();
  renderSkins();
  api.postMessage({ type: 'requestState' });
})();

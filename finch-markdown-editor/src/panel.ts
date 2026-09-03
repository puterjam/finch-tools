// Transitional boundary: this module preserves the panel runtime while its UI domains are split incrementally.
// @ts-nocheck
(function () {
  'use strict';
  var api = window.finch;

  // Capture uncaught errors from any part of the panel so the host can log
  // them. Block-widget crashes (e.g. the table component) often leave the UI
  // blank but do not print to the user-visible Finch chat, making them hard
  // to diagnose without this bridge.
  function logPanelError(kind, info) {
    var msg = '[panel error] ' + kind + ': ' + String(info).slice(0, 4000);
    try { console.error(msg, info); } catch (_) {}
    if (api && api.postMessage) {
      try { api.postMessage({ type: 'clientLog', message: msg }); } catch (_) {}
    }
  }
  window.onerror = function (message, source, lineno, colno, error) {
    logPanelError('window.onerror', String(message) + ' at ' + source + ':' + lineno + ':' + colno + (error && error.stack ? '\n' + String(error.stack) : ''));
  };
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    var detail = reason && (reason.stack || reason.message || String(reason)) || 'unknown';
    logPanelError('unhandledrejection', detail);
  });
  // Diagnostic channel for the editor bundle (codemirror.js), which has no
  // host bridge of its own. Temporary: traces table widget teardown.
  window.__mdLog = function (message) {
    if (api && api.postMessage) {
      try { api.postMessage({ type: 'clientLog', message: String(message) }); } catch (_) {}
    }
  };

  // ---- i18n ----------------------------------------------------------
  // This page is a standalone static document (loaded into a host webview,
  // not a bundled app with its own build-time locale), so translation
  // happens at runtime: guess from navigator.language immediately (so the
  // very first paint isn't wrong-language), then reconcile against the
  // host's real locale once it arrives in the 'ready' handshake message
  // (ctx.i18n.locale, forwarded from index.ts). Only zh/non-zh is
  // distinguished — bm.md's own rendered article content is unaffected,
  // this only covers this panel's own chrome (labels/status/tooltips).
  var isZh = /^zh/i.test(navigator.language || '');
  var STR = {
    zh: {
      'meta.title': '公众号文章预览',
      'home.title': '写字',
      'home.tagline.withAssistant': '你与{name}一起编排 Markdown 文件',
      'home.tagline.default': '打开一个 Markdown 文件开始编辑与预览，或新建一篇文章。',
      'home.openFile': '打开文件',
      'home.newDoc': '新建文档',
      'home.recentLabel': '最近编辑',
      'home.hintScoped': '这个目录里还没有用编辑器打开过的 Markdown 文档。',
      'home.hintDefault': '打开一个 Markdown 文件，之后这里会列出最近编辑的文档。',
      'home.untitled': '未命名',
      'home.revealInFileManager': '在文件管理器中定位',
      'home.emptyDoc': '（空文档）',
      'home.cwdTitle': '在访达 / 文件资源管理器中打开：{path}',
      'home.cwdFallback': 'homePath（无 cwd 回退）',
      'home.today': '今天 {clock}',
      'home.yesterday': '昨天 {clock}',
      'appview.library': '资料库',
      'appview.libraryHint': '所有空间的最近文档',
      'appview.libraryWorkspace': '工作间文件',
      'appview.libraryOther': '其他',
      'appview.libraryReorder': '排序',
      'appview.libraryReorderDone': '已完成',
      'appview.rewrite': '改写',
      'appview.focus': '专注',
      'appview.openSession': '打开改写会话',
      'appview.rewriting': '已发起改写，会话正在处理并将直接写回文件。',
      'appview.continuing': '已发起续写，会话正在处理并将直接写回文件。',
      'appview.hintSpace': '按 space（空格）以启用 AI · 按 / 选择格式',
      'appview.hintSpaceCode': '按 space（空格）以启用 AI',
      'appview.rewriteDone': '改写已完成，文件内容已刷新。',
      'editor.ariaLabel': '写字编辑器',
      'actions.copyToWx': '复制到公众号',
      'actions.copyImg': '复制图片',
      'actions.exportImg': '导出图片（下载）',
      'actions.exportPdf': '导出 PDF',
      'actions.aiStyle': '让 AI 设计排版',
      'actions.toggle': '展开/收起',
      'popup.placeholder': '让 {name} 编辑',
      'popup.placeholderContinue': '让 {name} 从这里续写…',
      'popup.send': '发送',
      'confirm.cancel': '取消',
      'confirm.discard': '不保存',
      'confirm.save': '保存并返回',
      'confirm.message': '「{file}」还有未保存的改动，要保存后再返回首页吗？',
      'common.markdownDocDefault': 'Markdown 文档',
      'common.customStyleDefault': '自定义风格',
      'toolbar.home.tooltip': '返回首页',
      'toolbar.open.tooltipDefault': '打开 Markdown 文件',
      'toolbar.save.label': '保存',
      'toolbar.save.tooltipDefault': '保存（⌘/Ctrl+S）',
      'toolbar.save.tooltipDirty': '有未保存的改动（⌘/Ctrl+S）',
      'toolbar.save.labelSaved': '已保存',
      'toolbar.save.tooltipSaved': '已保存',
      'toolbar.annotate.label': '批注',
      'toolbar.annotate.tooltipOn': '批注已开启：选中文字可发起 AI 修改',
      'toolbar.annotate.tooltipOff': '开启批注：选中文字后可发起 AI 修改',
      'toolbar.needDoc': '请先打开文档',
      'toolbar.mode.label': '预览',
      'toolbar.mode.tooltipToPreview': '切换到预览',
      'toolbar.mode.tooltipToEdit': '切换到编辑',
      'toolbar.mode.tooltipRendering': '正在渲染预览…',
      'toolbar.style.tooltip': '排版风格',
      'toolbar.style.tooltipNeedsPreview': '请先切换到预览',
      'toolbar.style.customSlot': '自定义风格 {n} · {label}',
      'toolbar.style.customSlotEmpty': '自定义风格 {n}（空）',
      'toolbar.fontSize.tooltipPreview': '预览时不可更改字体',
      'toolbar.fontSize.tooltipEdit': '编辑器字体大小',
      'toolbar.fontSize.small': '小',
      'toolbar.fontSize.medium': '中',
      'toolbar.fontSize.large': '大',
      'toolbar.fontFamily.default': '默认（无衬线）',
      'toolbar.fontFamily.serif': '衬线体',
      'toolbar.comfort.read': '紧凑',
      'toolbar.comfort.write': '舒适',
      'toolbar.focus.tooltipOn': '专注已开启：非当前行半透明',
      'toolbar.focus.tooltipOff': '开启专注：非当前行半透明',
      'toolbar.more.reload': '重新渲染',
      'toolbar.more.reveal': '在文件管理器中定位',
      'toolbar.more.about': '关于渲染',
      'toolbar.more.tooltip': '更多',
      'annotate.lineUnknown': '（未能精确定位对应行号，请以下方引用文本为准）',
      'annotate.lineSingle': '第 {a} 行',
      'annotate.lineRange': '第 {a}–{b} 行',
      'annotate.lineCompactUnknown': '未定位',
      'annotate.requirementWith': '要求：{comment}',
      'annotate.requirementDefault': '让表达更清晰',
      'annotate.pathMissing': '（未关联本地文件，请先粘贴/保存全部内容）',
      'annotate.emptyLine': '（空行：请按批注要求在此处补充或续写内容）',
      'annotate.promptText': '请改写这段 Markdown 内容（位置：{lineLabel}），{requirement}：\n\n{text}\n\n先给出可直接替换的片段；我确认后，用针对这一段的局部替换写回源文件（{path}），不用重发全文。',
      'annotate.reminder': '仅给出改写建议，不要在未确认前直接写入源文件。回复用自然的说法（如“确认后我就改到文件里”），不要提工具名或动作名。【强制要求，不可省略】只要本回合给出了改写建议并等我确认，就必须在回复文本之后、本回合结束前调用一次 Session action=suggest，附上 1–3 个一键确认选项（如“就用这版”“用更短的那版”“再换个语气”）。只写完回复文字、不调用 suggest，视为任务未完成——“把方案写给用户看”和“让用户能一键确认”是同一个任务的两半，缺一不可，不要因为文字已给完就认为确认环节已经处理完毕。',
      'newdoc.needChat': '请在 Finch 对话中使用“新建文档”。',
      'newdoc.label': '新建 Markdown 文档',
      'newdoc.promptText': '我想新建一篇 Markdown 文档。请先根据我的要求确定标题、内容与一个尚不存在的绝对保存路径；信息不足时先问我。确认后把完整正文写入那个路径，并在编辑器中打开这篇新文档。',
      'newdoc.reminder': '只能新建文件，不要覆盖已有文件。回复用自然的说法，不要提工具名或动作名。【强制要求，不可省略】只要本回合需要我确认标题、方向或保存位置，就必须在回合结束前调用一次 Session action=suggest，给出 1–3 个一键选项，不要让我手打。光在文字里问问题而不调 suggest，视为这次询问没完成。',
      'newdoc.added': '已把新建文档引导加入输入框。',
      'aiStyle.label': '根据 {file} 设计风格',
      'aiStyle.note': 'AI 一键排版',
      'aiStyle.baseNoteCustom': '当前基础风格是 kami（自定义 CSS 叠加其上）',
      'aiStyle.baseNoteOther': '当前基础风格是 {style}',
      'aiStyle.pathMissing': '（未关联本地文件）',
      'aiStyle.promptText': '请为这篇公众号文章设计一套自定义排版 CSS。{baseNote}，你的 CSS 会叠加在基础风格之上。要求：只写普通 CSS 规则，选择器限定在 #bm-md 下的标签/结构（如 #bm-md h1、#bm-md p、#bm-md blockquote、#bm-md pre code、#bm-md a、#bm-md strong、#bm-md table 等），不要使用 class（bm.md 输出没有 class，只有内联样式），必要时用 !important 覆盖基础风格。可参考 bm.md 内置风格的设计语言：kami（暖色纸感）、bauhaus（几何撞色）、blueprint（技术蓝图网格）、botanical（清新绿意）、newsprint（报刊衬线）、retro（复古怀旧）、sketch（手绘风）、terminal（等宽暗色终端风）。文章路径：{path}。设计好后直接调用 set_style 应用（传 path="{path}"、css 和简短 label，不要传 slot——传 path 能让它准确找到这篇文档对应的预览窗口，即使我已经切换到别的界面），不需要先问我要覆盖哪个槽位——面板会自己弹出一个轻量的“保存为自定义风格”按钮，我看到效果后自己决定要不要固化。',
      'aiStyle.reminder': '不要在应用前先问我选哪个槽位——直接设计并调用 set_style（不传 slot）应用到预览即可，保存与否由我在面板上自己决定。回复用自然的说法，不要提工具名或动作名。',
      'aiStyle.requested': '已请求 AI 设计自定义排版。',
      'aiStyle.applied': 'AI 已设计好排版，效果已应用到预览。',
      'aiStyle.saveToSlot': '存为风格{n}',
      'aiStyle.appViewDesigning': 'AI 正在设计排版…',
      'aiStyle.appViewDone': '排版设计已完成。',
      'aiStyle.appViewFailed': '排版设计未完成。',
      'status.saved': '已保存。',
      'status.savedWithNewChanges': '已保存，编辑器中仍有新改动。',
      'status.saveFailed': '保存失败：{err}',
      'status.saving': '正在保存…',
      'status.noSourceFile': '未关联本地文件：点击工具栏「打开」重新选择一次即可关联并启用保存。',
      'status.pickerTimeout': '文件选择器长时间无响应，已切换为浏览器内选择器：请重新点击"打开"。',
      'status.externalUpdateSkipped': '检测到文件外部更新；为避免覆盖未保存内容，暂未载入。',
      'status.draftRestored': '已恢复上次未保存的编辑内容（与磁盘文件不同）。如需放弃，点击「打开」重新选择该文件并选择"放弃"。',
      'status.draftConflict': '检测到本地存有未保存草稿，但文件在别处已被修改保存；已加载最新文件内容，草稿仍保留在本地未丢弃。',
      'status.sourceMissing': '原文件已被移动或删除；当前内容仍保留在编辑器中，保存将在原路径重新创建文件。',
      'status.externalUpdateApplied': '检测到文件更新，已刷新。',
      'status.openingPicker': '正在打开文件选择器…',
      'status.opening': '正在打开…',
      'status.opened': '已打开 {file}。',
      'status.contentUpdated': '内容已更新。',
      'status.contentUpdatedLine': '已更新第 {line} 行。',
      'status.contentUpdatedLines': '已更新第 {from}–{to} 行。',
      'status.contentUpdatedSpots': '已更新 {count} 处，共 {lines} 行。',
      'status.pasteImageTimeout': '粘贴图片超时',
      'status.pasteImageFailed': '粘贴图片失败：{msg}',
      'status.clipboardPrepareTimeout': '准备公众号图片超时',
      'status.pleaseOpenArticle': '请先打开文章。',
      'status.copiedRich': '公众号富文本 HTML 已复制，可直接粘贴到公众号编辑器。',
      'status.copiedPlainOnly': '仅复制到纯文本，格式未能带上，请重试一次。',
      'status.copyFailed': '复制失败，请重试一次。',
      'status.richCopyFailed': '富文本复制失败：{err}',
      'status.clipboardUnsupported': '当前环境不支持复制图片，请改用「导出图片」。',
      'status.generatingImage': '正在生成图片…',
      'status.previewNotReady': '预览尚未就绪',
      'status.imageCopied': '图片已复制到剪贴板。',
      'status.copyImageFailed': '复制图片失败：{err}（可改用「导出图片」）',
      'status.exportImageFailedGeneric': '导出图片失败：预览尚未就绪。',
      'status.exportImageFailed': '导出图片失败：{err}',
      'status.generatingPdf': '正在生成 PDF…',
      'status.exportPdfFailedGeneric': '导出 PDF 失败：预览尚未就绪。',
      'status.exportPdfFailed': '导出 PDF 失败：{err}',
      'status.exported': '已导出：{path}',
      'status.annotateOn': '批注已开启：选中文字可发起 AI 修改。',
      'status.annotateOff': '批注已关闭。',
      'status.comfortWrite': '已切换为舒适模式（行距加宽）。',
      'status.comfortRead': '已切换为紧凑模式。',
      'status.focusOn': '专注已开启：非当前行半透明。',
      'status.focusOff': '专注已关闭。',
      'status.saveFailedNoReturn': '保存失败，未返回首页。',
      'status.rendererAboutPrefix': '渲染器：本机 bmmd CLI（',
      'status.rendererAboutSuffix': '，LGPL-3.0）。',
      'status.appliedStyleSlot': '已应用「{label}」。',
      'status.needCustomStyleFirst': '请先应用一个自定义/AI 设计的风格，再保存到槽位。',
      'status.savedToSlot': '已保存到槽位 {slot}：{label}',
      'status.serializeFailed': '无法序列化预览内容：{err}',
      'status.imageConversionFailed': '预览内容无法转成图片（可能含有无法跨域读取的外部图片）',
      'status.imageGenFailed': '生成图片数据失败',
      'status.clipboardPrepareFailedDefault': '准备公众号图片失败',
      'status.pasteImageFailedDefault': '粘贴图片失败',
      'status.savedAppliedToSlot': '{labelPrefix}已保存并应用到自定义风格 {slot}。',
    },
    en: {
      'meta.title': 'Article Preview',
      'home.title': 'Writing',
      'home.tagline.withAssistant': 'Write Markdown together with {name}',
      'home.tagline.default': 'Open a Markdown file to start editing and previewing, or create a new article.',
      'home.openFile': 'Open File',
      'home.newDoc': 'New Document',
      'home.recentLabel': 'Recent',
      'home.hintScoped': 'No Markdown documents have been opened from this folder yet.',
      'home.hintDefault': 'Open a Markdown file — recently edited documents will show up here.',
      'home.untitled': 'Untitled',
      'home.revealInFileManager': 'Show in file manager',
      'home.emptyDoc': '(Empty document)',
      'home.cwdTitle': 'Open in Finder / File Explorer: {path}',
      'home.cwdFallback': 'homePath (no-cwd fallback)',
      'home.today': 'Today {clock}',
      'home.yesterday': 'Yesterday {clock}',
      'appview.library': 'Library',
      'appview.libraryHint': 'Recent documents across all Spaces',
      'appview.libraryWorkspace': 'Workspace files',
      'appview.libraryOther': 'Other',
      'appview.libraryReorder': 'Reorder',
      'appview.libraryReorderDone': 'Done',
      'appview.rewrite': 'Rewrite',
      'appview.focus': 'Focus',
      'appview.openSession': 'Open rewrite session',
      'appview.rewriting': 'Rewrite started. The session will apply its revision directly to the file.',
      'appview.continuing': 'Continuation started. The session will write the new text directly to the file.',
      'appview.hintSpace': 'Press space for AI · / for formatting',
      'appview.hintSpaceCode': 'Press space for AI',
      'appview.rewriteDone': 'Rewrite complete. The document has refreshed.',
      'editor.ariaLabel': 'Writing editor',
      'actions.copyToWx': 'Copy for WeChat',
      'actions.copyImg': 'Copy image',
      'actions.exportImg': 'Export image (download)',
      'actions.exportPdf': 'Export PDF',
      'actions.aiStyle': 'Ask AI to design layout',
      'actions.toggle': 'Expand/collapse',
      'popup.placeholder': 'Let {name} edit',
      'popup.placeholderContinue': 'Let {name} continue writing from here…',
      'popup.send': 'Send',
      'confirm.cancel': 'Cancel',
      'confirm.discard': "Don't save",
      'confirm.save': 'Save and return',
      'confirm.message': '\u201c{file}\u201d has unsaved changes. Save before returning to Home?',
      'common.markdownDocDefault': 'Markdown document',
      'common.customStyleDefault': 'Custom style',
      'toolbar.home.tooltip': 'Back to Home',
      'toolbar.open.tooltipDefault': 'Open Markdown file',
      'toolbar.save.label': 'Save',
      'toolbar.save.tooltipDefault': 'Save (\u2318/Ctrl+S)',
      'toolbar.save.tooltipDirty': 'Unsaved changes (\u2318/Ctrl+S)',
      'toolbar.save.labelSaved': 'Saved',
      'toolbar.save.tooltipSaved': 'Saved',
      'toolbar.annotate.label': 'Annotate',
      'toolbar.annotate.tooltipOn': 'Annotate is on — select text to ask AI to revise it',
      'toolbar.annotate.tooltipOff': 'Turn on Annotate: select text to ask AI to revise it',
      'toolbar.needDoc': 'Open a document first',
      'toolbar.mode.label': 'Preview',
      'toolbar.mode.tooltipToPreview': 'Switch to preview',
      'toolbar.mode.tooltipToEdit': 'Switch to edit',
      'toolbar.mode.tooltipRendering': 'Rendering preview…',
      'toolbar.style.tooltip': 'Layout style',
      'toolbar.style.tooltipNeedsPreview': 'Switch to preview first',
      'toolbar.style.customSlot': 'Custom style {n} · {label}',
      'toolbar.style.customSlotEmpty': 'Custom style {n} (empty)',
      'toolbar.fontSize.tooltipPreview': "Font can't be changed while previewing",
      'toolbar.fontSize.tooltipEdit': 'Editor font size',
      'toolbar.fontSize.small': 'Small',
      'toolbar.fontSize.medium': 'Medium',
      'toolbar.fontSize.large': 'Large',
      'toolbar.fontFamily.default': 'Default (sans-serif)',
      'toolbar.fontFamily.serif': 'Serif',
      'toolbar.comfort.read': 'Compact',
      'toolbar.comfort.write': 'Comfortable',
      'toolbar.focus.tooltipOn': 'Focus mode is on — inactive lines are dimmed',
      'toolbar.focus.tooltipOff': 'Turn on focus mode: dim inactive lines',
      'toolbar.more.reload': 'Re-render',
      'toolbar.more.reveal': 'Show in file manager',
      'toolbar.more.about': 'About rendering',
      'toolbar.more.tooltip': 'More',
      'annotate.lineUnknown': "(Couldn't pinpoint the exact line — use the quoted text below as reference)",
      'annotate.lineSingle': 'Line {a}',
      'annotate.lineRange': 'Lines {a}\u2013{b}',
      'annotate.lineCompactUnknown': 'Unlocated',
      'annotate.requirementWith': 'Requirement: {comment}',
      'annotate.requirementDefault': 'make the wording clearer',
      'annotate.pathMissing': '(No local file linked — ask me to paste/save the full text first)',
      'annotate.emptyLine': '(Blank line — add or continue content here according to the annotation.)',
      'annotate.promptText': 'Please rewrite this Markdown passage (location: {lineLabel}), {requirement}:\n\n{text}\n\nGive a drop-in replacement snippet first; once I confirm, write it back to the source file ({path}) as a targeted local replacement, not a full resend of the document.',
      'annotate.reminder': "Only propose the rewrite — don't write to the source file before I confirm. Reply in natural language (e.g. “I'll put it into the file once you confirm”); never name the tool or its actions. [MANDATORY, not optional] Whenever this turn proposes a rewrite and is waiting on my confirmation, calling Session action=suggest with 1–3 one-tap confirmations (e.g. “Use this one”, “Use the shorter version”, “Try another tone”) is part of completing that same turn — writing the proposal text is only half the job. Do not treat the turn as done, and do not skip the call, just because the proposal text itself was already sent.",
      'newdoc.needChat': 'Use \u201cNew Document\u201d from the Finch chat instead.',
      'newdoc.label': 'New Markdown Document',
      'newdoc.promptText': 'I want to create a new Markdown document. First work out the title, content, and a not-yet-existing absolute save path from my request — ask me first if anything is missing. Once confirmed, write the full body to that path and open the new document in the editor.',
      'newdoc.reminder': 'Only create a new file; never overwrite an existing one. Reply in natural language and never name the tool or its actions. [MANDATORY, not optional] Whenever this turn ends still waiting on me to confirm a title, an angle, or a save location, it must call Session action=suggest with 1–3 one-tap options before the turn ends — asking the question in plain text is not enough on its own; skipping the call leaves the question unfinished.',
      'newdoc.added': 'Added the new-document prompt to the composer.',
      'aiStyle.label': 'Design a layout based on {file}',
      'aiStyle.note': 'One-click AI layout',
      'aiStyle.baseNoteCustom': 'The current base style is kami (your custom CSS layers on top of it)',
      'aiStyle.baseNoteOther': 'The current base style is {style}',
      'aiStyle.pathMissing': '(No local file linked)',
      'aiStyle.promptText': 'Please design a custom layout CSS for this WeChat article. {baseNote}, and your CSS will layer on top of the base style. Requirements: write plain CSS rules only, with selectors scoped to tags/structure under #bm-md (e.g. #bm-md h1, #bm-md p, #bm-md blockquote, #bm-md pre code, #bm-md a, #bm-md strong, #bm-md table); don\u2019t use classes (bm.md\u2019s output has no classes, only inline styles), and use !important where needed to override the base style. You can draw on bm.md\u2019s built-in style language: kami (warm paper feel), bauhaus (geometric color-blocking), blueprint (technical grid), botanical (fresh green), newsprint (editorial serif), retro (nostalgic), sketch (hand-drawn), terminal (monospace dark). Article path: {path}. Once it\u2019s ready, call set_style directly (pass path="{path}", css, and a short label, no slot \u2014 passing path lets it find the right preview panel for this document even if I\u2019ve switched away) \u2014 don\u2019t ask me which slot to use first; the panel will pop up a lightweight \u201csave as custom style\u201d button so I can decide after seeing the result.',
      'aiStyle.reminder': 'Don\u2019t ask which slot to use before applying \u2014 just design it and call set_style (without slot) to apply it to the preview; whether to save it is for me to decide from the panel. Reply in natural language and never name the tool or its actions.',
      'aiStyle.requested': 'Asked AI to design a custom layout.',
      'aiStyle.applied': 'AI designed a layout and applied it to the preview.',
      'aiStyle.saveToSlot': 'Save as style {n}',
      'aiStyle.appViewDesigning': 'AI is designing a layout…',
      'aiStyle.appViewDone': 'Layout design finished.',
      'aiStyle.appViewFailed': 'Layout design did not finish.',
      'status.saved': 'Saved.',
      'status.savedWithNewChanges': "Saved — but the editor already has newer changes.",
      'status.saveFailed': 'Save failed: {err}',
      'status.saving': 'Saving…',
      'status.noSourceFile': 'Not linked to a local file: click “Open” in the toolbar again to link it and enable saving.',
      'status.pickerTimeout': 'The file picker took too long to respond and switched to the in-browser picker — please click "Open" again.',
      'status.externalUpdateSkipped': 'Detected an external file update; not loaded yet to avoid overwriting unsaved changes.',
      'status.draftRestored': 'Restored your last unsaved edits (differs from the file on disk). To discard, click "Open" and pick this file again, then choose "Discard".',
      'status.draftConflict': 'A local unsaved draft exists, but the file was changed and saved elsewhere; loaded the latest file content — the draft is kept, not discarded.',
      'status.sourceMissing': 'The original file was moved or deleted; your content is still here — saving will recreate the file at its original path.',
      'status.externalUpdateApplied': 'Detected a file update and refreshed.',
      'status.openingPicker': 'Opening the file picker…',
      'status.opening': 'Opening…',
      'status.opened': 'Opened {file}.',
      'status.contentUpdated': 'Content updated.',
      'status.contentUpdatedLine': 'Updated line {line}.',
      'status.contentUpdatedLines': 'Updated lines {from}\u2013{to}.',
      'status.contentUpdatedSpots': 'Updated {count} spots, {lines} lines in total.',
      'status.pasteImageTimeout': 'Paste image timed out',
      'status.pasteImageFailed': 'Paste image failed: {msg}',
      'status.clipboardPrepareTimeout': 'Preparing WeChat images timed out',
      'status.pleaseOpenArticle': 'Open an article first.',
      'status.copiedRich': 'Rich HTML copied — paste it directly into the WeChat editor.',
      'status.copiedPlainOnly': "Only plain text was copied; formatting didn't come through — please try again.",
      'status.copyFailed': 'Copy failed — please try again.',
      'status.richCopyFailed': 'Rich-text copy failed: {err}',
      'status.clipboardUnsupported': 'Copying images isn\u2019t supported here — use \u201cExport Image\u201d instead.',
      'status.generatingImage': 'Generating image…',
      'status.previewNotReady': "Preview isn't ready yet",
      'status.imageCopied': 'Image copied to the clipboard.',
      'status.copyImageFailed': 'Copy image failed: {err} (try \u201cExport Image\u201d instead)',
      'status.exportImageFailedGeneric': "Export image failed: preview isn't ready yet.",
      'status.exportImageFailed': 'Export image failed: {err}',
      'status.generatingPdf': 'Generating PDF…',
      'status.exportPdfFailedGeneric': "Export PDF failed: preview isn't ready yet.",
      'status.exportPdfFailed': 'Export PDF failed: {err}',
      'status.exported': 'Exported: {path}',
      'status.annotateOn': 'Annotate is on — select text to ask AI to revise it.',
      'status.annotateOff': 'Annotate is off.',
      'status.comfortWrite': 'Comfortable mode is on — roomier line spacing.',
      'status.comfortRead': 'Compact mode is on.',
      'status.focusOn': 'Focus mode is on — inactive lines are dimmed.',
      'status.focusOff': 'Focus mode is off.',
      'status.saveFailedNoReturn': 'Save failed — staying on this document.',
      'status.rendererAboutPrefix': 'Renderer: local bmmd CLI (',
      'status.rendererAboutSuffix': ', LGPL-3.0).',
      'status.appliedStyleSlot': 'Applied \u201c{label}\u201d.',
      'status.needCustomStyleFirst': 'Apply a custom/AI-designed style first before saving it to a slot.',
      'status.savedToSlot': 'Saved to slot {slot}: {label}',
      'status.serializeFailed': 'Failed to serialize the preview content: {err}',
      'status.imageConversionFailed': "The preview couldn't be converted to an image (it may contain external images that can't be read cross-origin)",
      'status.imageGenFailed': 'Failed to generate image data',
      'status.clipboardPrepareFailedDefault': 'Failed to prepare WeChat images',
      'status.pasteImageFailedDefault': 'Paste image failed',
      'status.savedAppliedToSlot': '{labelPrefix}Saved and applied to custom style {slot}.',
    },
  };
  function t(key, vars) {
    var dict = isZh ? STR.zh : STR.en;
    var s = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key]
      : (Object.prototype.hasOwnProperty.call(STR.en, key) ? STR.en[key] : key);
    if (vars) {
      for (var k in vars) {
        if (Object.prototype.hasOwnProperty.call(vars, k)) s = s.split('{' + k + '}').join(String(vars[k]));
      }
    }
    return s;
  }
  function applyStaticI18n(root) {
    var scope = root || document;
    document.documentElement.lang = isZh ? 'zh-CN' : 'en';
    document.title = t('meta.title');
    Array.prototype.forEach.call(scope.querySelectorAll('[data-i18n]'), function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    Array.prototype.forEach.call(scope.querySelectorAll('[data-i18n-title]'), function (el) {
      el.title = t(el.getAttribute('data-i18n-title'));
    });
    // The floating preview action bar (WeChat copy/export buttons) renders
    // its own styled tooltip bubble in CSS from `data-tooltip` (see
    // `.actions button[data-tooltip]::after`). Those buttons must NOT also
    // carry a native `title` attribute, or hovering shows both the custom
    // bubble and the browser's plain OS tooltip at once. `aria-label` keeps
    // them accessible without reintroducing a `title`.
    Array.prototype.forEach.call(scope.querySelectorAll('[data-i18n-tooltip]'), function (el) {
      var text = t(el.getAttribute('data-i18n-tooltip'));
      el.setAttribute('data-tooltip', text);
      el.setAttribute('aria-label', text);
    });
    Array.prototype.forEach.call(scope.querySelectorAll('[data-i18n-aria]'), function (el) {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
    });
  }

  var empty = document.getElementById('empty');
  var emptyNew = document.getElementById('emptyNew');
  var emptyOpen = document.getElementById('emptyOpen');
  var homeRecent = document.getElementById('homeRecent');
  var homeGrid = document.getElementById('homeGrid');
  var homeHint = document.getElementById('homeHint');
  // Last documents payload rendered into the Home grid. Each category's
  // directory now travels with the documents themselves (`scopePath`), so a
  // redraw triggered by late-arriving display state (e.g. homeDir, which
  // only affects "~" abbreviation) can replay from here instead of waiting
  // on another host round-trip — mirrors libraryDocumentsCache below.
  var homeDocumentsCache = [];
  var homeTagline = document.getElementById('homeTagline');
  var editPane = document.getElementById('editPane');
  var previewPane = document.getElementById('previewPane');
  var previewResizer = document.getElementById('previewResizer');
  var editor = document.getElementById('editor');
  var frame = document.getElementById('article');
  var statusEl = document.getElementById('status');
  var popup = document.getElementById('popup');
  var popupInput = document.getElementById('popupInput');
  var popupSend = document.getElementById('popupSend');
  var popupShortcut = document.getElementById('popupShortcut');
  var actions = document.getElementById('actions');
  var actCopyWx = document.getElementById('actCopyWx');
  var actCopyImg = document.getElementById('actCopyImg');
  var actSaveImg = document.getElementById('actSaveImg');
  var actSavePdf = document.getElementById('actSavePdf');
  var actAiStyle = document.getElementById('actAiStyle');
  var actToggle = document.getElementById('actToggle');
  var confirmOverlay = document.getElementById('confirmOverlay');
  var confirmMessage = document.getElementById('confirmMessage');
  var confirmCancel = document.getElementById('confirmCancel');
  var confirmDiscard = document.getElementById('confirmDiscard');
  var confirmSave = document.getElementById('confirmSave');
  var appToolbar = document.getElementById('appToolbar');
  var appHome = document.getElementById('appHome');
  var appLibrary = document.getElementById('appLibrary');
  var appOpen = document.getElementById('appOpen');
  var appSave = document.getElementById('appSave');
  var appPreview = document.getElementById('appPreview');
  var appStyle = document.getElementById('appStyle');
  var appStyleMenu = document.getElementById('appStyleMenu');
  var appFocus = document.getElementById('appFocus');
  var appFont = document.getElementById('appFont');
  var appFontMenu = document.getElementById('appFontMenu');
  var appMore = document.getElementById('appMore');
  var appMoreMenu = document.getElementById('appMoreMenu');
  var libraryDrawer = document.getElementById('libraryDrawer');
  var libraryBackdrop = document.getElementById('libraryBackdrop');
  var libraryClose = document.getElementById('libraryClose');
  var libraryReorder = document.getElementById('libraryReorder');
  var libraryReorderFooter = document.getElementById('libraryReorderFooter');
  var libraryReorderDone = document.getElementById('libraryReorderDone');
  var libraryGroups = document.getElementById('libraryGroups');
  var LIBRARY_GROUP_STATE_KEY = 'md-editor-library-groups-v1';
  var libraryGroupOrder = [];
  var libraryCollapsedGroups = {};
  var libraryDragging = null;
  var libraryDragOpenState = null;
  // Reorder mode: the drawer collapses every group to a flat draggable
  // header row (no per-document rows, no expand/collapse) so dragging is
  // the only interaction — entered/exited via the header toggle button,
  // never auto-triggered by an ordinary drag from the normal browsing view.
  var libraryReorderMode = false;
  // Last documents payload rendered into the drawer, so toggling reorder
  // mode on/off can redraw locally without waiting on another host round-trip.
  var libraryDocumentsCache = [];
  // Custom pointer-driven drag state, replacing the browser's native HTML5
  // drag-and-drop (whose default translucent "screenshot" ghost can't be
  // restyled). `null` when idle; `active` flips true only past a small
  // movement threshold so a plain click still toggles the group.
  var libraryDragPointer = null;
  // pointerup fires (and nulls libraryDragPointer) before the browser's
  // trailing `click` event on the same interaction — so click-suppression
  // needs its own flag that outlives the pointer state, not a read of it.
  var librarySuppressNextClick = false;

  var isAppView = false;
  var appViewInitialized = false;
  var previewVisible = true;
  // Whether an App View AI-style design Session is currently running for
  // this document — drives the wand icon's loading spinner. Restored from
  // the host on panelReady if the panel was destroyed/rebound mid-flight.
  var styleSessionActive = false;
  var liveRenderTimer = 0;
  var pickFileSupported = false; // set from the backend 'ready' message
  var annotationsEnabled = true; // see below — reconciled with focusMode once it's loaded
  var mode = 'edit';          // 'edit' | 'preview'
  var style = 'kami';
  var customCss = '';
  var customStyleLabel = ''; // label of the currently-applied AI/custom CSS, if any
  // 3 reusable custom-style slots, persisted host-side (global — shared by
  // every document/panel, not per-session) so a style designed for one
  // article can be reapplied to the next without asking AI to redesign it.
  // Populated from the 'ready' message; kept in sync via 'styleSlots'.
  var styleSlots = [null, null, null];
  // Editor-only preferences. The font stacks are system-first: no webfont
  // downloads, while macOS/Windows/Linux each get a native matching face.
  var EDITOR_FONTS = {
    songti: 'Songti SC, STSong, SimSun, Noto Serif CJK SC, serif',
    rounded: 'PingFang SC, Microsoft YaHei, Noto Sans CJK SC, sans-serif'
  };
  var editorFontSize = 14;
  var editorFont = 'rounded';
  // Comfortable mode: roomier line spacing while composing. Default off
  // (compact mode keeps the tighter 2px/1.7rem layout).
  var comfortWriting = false;
  // Focus mode ("专注"): dims every line except the cursor's own line.
  var focusMode = false;
  try {
    // Only the three menu tiers are valid; anything else (missing, corrupt,
    // or from an older tier set) falls back to the default 14px tier.
    var savedFontSize = Number(localStorage.getItem('md-editor-font-size'));
    if (savedFontSize === 14 || savedFontSize === 16 || savedFontSize === 18) editorFontSize = savedFontSize;
    var savedEditorFont = localStorage.getItem('md-editor-font-family');
    if (EDITOR_FONTS[savedEditorFont]) editorFont = savedEditorFont;
    else if (savedEditorFont) localStorage.removeItem('md-editor-font-family');
    comfortWriting = localStorage.getItem('md-editor-comfort-writing') === '1';
    focusMode = localStorage.getItem('md-editor-focus-mode') === '1';
    var savedLibraryGroups = JSON.parse(localStorage.getItem(LIBRARY_GROUP_STATE_KEY) || '{}');
    if (Array.isArray(savedLibraryGroups.order)) libraryGroupOrder = savedLibraryGroups.order.filter(function (id) { return typeof id === 'string'; });
    if (savedLibraryGroups.collapsed && typeof savedLibraryGroups.collapsed === 'object') libraryCollapsedGroups = savedLibraryGroups.collapsed;
  } catch (e) {}
  // On by default: selecting text opens the rewrite popup right away, no
  // extra "开启批注" click first. The toolbar toggle still exists so a
  // reader who doesn't want that popup while just browsing can turn it off.
  // Focus mode (possibly restored from localStorage above) fights annotate
  // for the same attention, so a session that starts in focus mode starts
  // with annotate off too — same mutual exclusivity toggleFocusMode enforces
  // afterward, just applied to the restored initial state as well.
  annotationsEnabled = !focusMode;
  var markdown = '';
  var name = '';
  var fileName = '';
  var sourcePath = '';
  var savedMarkdown = null;   // last markdown value confirmed written to disk
  var html = '';
  var frameReady = false;
  var renderId = 0;
  var renderingPreview = false;
  var saveId = 0;
  var pendingSaveContents = {};
  // Resolvers for callers that need to *await* a save round-trip (the
  // unsaved-changes confirm below) rather than fire-and-forget like the
  // Save button / Cmd+S. Keyed by the same saveId as pendingSaveContents.
  var pendingSaveResolvers = {};
  var pasteImageId = 0;
  var pendingPasteImages = {};
  var clipboardImageId = 0;
  var pendingClipboardImages = {};
  var savedFlashTimer = 0;
  var fileHandle = null;
  var lastModified = 0;
  var watchTimer = 0;
  var watchBusy = false;
  var selection = { text: '', mode: 'replace' };

  var statusHideTimer = 0;
  function setStatus(text, isError) {
    if (statusHideTimer) { clearTimeout(statusHideTimer); statusHideTimer = 0; }
    statusEl.textContent = text || '';
    statusEl.className = 'status' + (isError ? ' error' : '');
    // Auto-clear after 5s so a stale "已保存"/error message doesn't linger
    // in the footer forever; an empty message needs no timer at all.
    if (text) statusHideTimer = setTimeout(function () {
      statusHideTimer = 0;
      statusEl.textContent = '';
      statusEl.className = 'status';
    }, 5000);
  }

  function showRendererAbout() {
    if (statusHideTimer) { clearTimeout(statusHideTimer); statusHideTimer = 0; }
    statusEl.replaceChildren(document.createTextNode(t('status.rendererAboutPrefix')));
    var link = document.createElement('a');
    link.href = 'https://bm.md/';
    link.textContent = 'bm.md';
    link.title = 'https://bm.md/';
    link.addEventListener('click', function (event) {
      event.preventDefault();
      if (api && api.postMessage) api.postMessage({ type: 'openLink', url: 'https://bm.md/' });
    });
    statusEl.append(link, document.createTextNode(t('status.rendererAboutSuffix')));
    statusEl.className = 'status';
    statusHideTimer = setTimeout(function () {
      statusHideTimer = 0;
      statusEl.textContent = '';
      statusEl.className = 'status';
    }, 5000);
  }

  function hasDocument() { return !!markdown || !!sourcePath; }

  if (emptyNew) emptyNew.addEventListener('click', async function () {
    if (!api || !api.composer) {
      setStatus(t('newdoc.needChat'), true);
      return;
    }
    try {
      await api.composer.addContexts([{
        type: 'annotation',
        label: t('newdoc.label'),
        promptText: t('newdoc.promptText'),
        reminder: t('newdoc.reminder'),
      }]);
      setStatus(t('newdoc.added'));
    } catch (e) {
      setStatus(String(e), true);
    }
  });

  if (emptyOpen) emptyOpen.addEventListener('click', function () { openFile(); });

  // ── Home: recent documents ────────────────────────────────────────────
  // The working directory arrives with the platform's own `finch:env` push;
  // the backend scopes its recent-file list to whatever we hand back, so a
  // panel in another Space never shows this Space's documents.
  var envCwd = '';
  var envSessionId = '';
  var envSpaceId = '';
  // Some Home views arrive without cwd/session. The backend resolves those
  // against the persisted ordinary-chat homePath on its side, so empty
  // envCwd must not block the request. Only "no `finch:env` yet" should,
  // which this separate flag tracks instead of overloading envCwd.
  var envReceived = false;
  var recentRequested = false;
  var assistantName = '';
  var homeDir = '';

  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, function (ch) {
      return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&quot;';
    });
  }

  function updateHomeTagline() {
    if (!homeTagline) return;
    homeTagline.textContent = assistantName
      ? t('home.tagline.withAssistant', { name: assistantName })
      : t('home.tagline.default');
  }

  // "让 AI 编辑" placeholder becomes "让 <assistant name> 编辑"
  // once the real assistant name arrives — same withAssistant/default split
  // as the tagline above, so the popup never claims to be a generic "AI"
  // when it's actually this session's named assistant. Fallback "Finch"
  // mirrors the backend's own getAssistantName() default, so even the
  // pre-handshake flash never says "AI".
  function updatePopupPlaceholder() {
    if (!popupInput) return;
    popupInput.placeholder = selection.mode === 'continue'
      ? t('popup.placeholderContinue', { name: assistantName || 'Finch' })
      : t('popup.placeholder', { name: assistantName || 'Finch' });
  }

  // OS-friendly display only — the raw absolute path is still what's sent
  // to the backend for the "reveal in file manager" click. homeDir arrives
  // with the platform's own separator (Windows: "C:\Users\name", so check
  // both '/' and '\\' — a plain '/'-only check would never match there and
  // Windows paths would simply show in full, unabbreviated, which is fine).
  function formatFriendlyPath(absPath) {
    if (!absPath) return '';
    if (homeDir && absPath === homeDir) return '~';
    if (homeDir && (absPath.indexOf(homeDir + '/') === 0 || absPath.indexOf(homeDir + '\\') === 0)) {
      return '~' + absPath.slice(homeDir.length);
    }
    return absPath;
  }

  // Manual front-truncation ("…/end/of/path") instead of CSS text-overflow
  // (which trims the end, hiding the most useful — innermost — folder name).
  // Character-count based rather than pixel-measured: good enough for a
  // secondary label, and the CSS ellipsis on .home-group-cwd still backstops
  // any panel narrower than this budget assumes.
  function truncateFriendlyPath(text) {
    var MAX = 46;
    if (!text || text.length <= MAX) return text;
    var sep = text.indexOf('/') === -1 && text.indexOf('\\') !== -1 ? '\\' : '/';
    var tail = text.slice(-(MAX - 1));
    var sepIdx = tail.indexOf(sep);
    if (sepIdx > 0 && sepIdx < 10) tail = tail.slice(sepIdx);
    return '…' + tail;
  }

  // Each category header renders its own directory from the documents'
  // `scopePath`, so there is no single cwd element to update anymore. This
  // just replays the cached list — needed because `homeDir` (which decides
  // whether a path abbreviates to "~/…") can arrive after the first render.
  function renderHomeCwd() {
    renderRecentDocuments(homeDocumentsCache);
  }

  function formatDocTime(ts) {
    var date = new Date(ts);
    if (!ts || isNaN(date.getTime())) return '';
    var now = new Date();
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    var clock = pad(date.getHours()) + ':' + pad(date.getMinutes());
    var sameDay = date.toDateString() === now.toDateString();
    if (sameDay) return t('home.today', { clock: clock });
    var yesterday = new Date(now.getTime() - 86400000);
    if (date.toDateString() === yesterday.toDateString()) return t('home.yesterday', { clock: clock });
    if (date.getFullYear() === now.getFullYear()) return pad(date.getMonth() + 1) + '-' + pad(date.getDate());
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  function requestRecentDocuments() {
    if (!api || !api.postMessage || !envReceived) return;
    recentRequested = true;
    api.postMessage({ type: 'requestRecentDocuments', cwd: envCwd, sessionId: envSessionId, spaceId: envSpaceId });
  }

  // One `.doc-card` button for a single recent document — shared by every
  // group's sub-grid below.
  function renderDocCardHtml(doc) {
    doc = doc || {};
    var docPath = doc.relativePath || doc.fileName || '';
    return '<button class="doc-card" type="button" data-path="' + escapeHtml(doc.path || '') + '" title="' + escapeHtml(doc.path || '') + '">'
      + '<span class="doc-reveal" data-reveal-path="' + escapeHtml(doc.path || '') + '" role="button" tabindex="0" title="' + escapeHtml(t('home.revealInFileManager')) + '" aria-label="' + escapeHtml(t('home.revealInFileManager')) + '">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>'
      + '</span>'
      + '<div class="doc-preview">' + escapeHtml(doc.preview || t('home.emptyDoc')) + '</div>'
      + '<div class="doc-foot">'
      + '<div class="doc-title">' + escapeHtml(doc.title || doc.fileName || t('home.untitled')) + '</div>'
      + '<div class="doc-sub"><span class="doc-path" data-full-path="' + escapeHtml(docPath) + '">' + escapeHtml(docPath) + '</span>'
      + '<span class="doc-time">' + escapeHtml(formatDocTime(doc.modifiedAt)) + '</span></div>'
      + '</div></button>';
  }

  function renderRecentDocuments(documents) {
    if (!homeGrid || !homeRecent || !homeHint) return;
    var list = Array.isArray(documents) ? documents : [];
    homeDocumentsCache = list;
    if (list.length === 0) {
      homeRecent.hidden = true;
      homeHint.hidden = false;
      homeHint.textContent = envCwd
        ? t('home.hintScoped')
        : t('home.hintDefault');
      return;
    }
    // Group and order exactly like the Library drawer, so Home is a
    // read-only preview of the same Space/workspace/other categorization
    // the user arranged there. Every category always gets its own header
    // row (label + count on the left, the click-to-reveal cwd path on the
    // right) with a divider above it — cwd used to live once next to the
    // overall "最近编辑" title, but now rides along with each category.
    var groups = groupDocumentsForDisplay(list);
    homeGrid.innerHTML = groups.map(function (group) {
      var cards = group.documents.map(renderDocCardHtml).join('');
      // Each category shows ITS OWN root directory, not the Session cwd —
      // in AppView the list spans several Spaces at once, so a single shared
      // cwd would be wrong for every group but one.
      var cwdHtml = group.scopePath
        ? '<button type="button" class="home-group-cwd" data-cwd-path="' + escapeHtml(group.scopePath) + '"'
          + ' title="' + escapeHtml(t('home.cwdTitle', { path: group.scopePath })) + '">'
          + escapeHtml(truncateFriendlyPath(formatFriendlyPath(group.scopePath))) + '</button>'
        : '';
      var header = '<div class="home-group-title"><span class="home-group-label">' + escapeHtml(group.label)
        + '<span class="home-group-count">' + group.documents.length + '</span></span>' + cwdHtml + '</div>';
      return '<div class="home-group">' + header + '<div class="home-grid">' + cards + '</div></div>';
    }).join('');
    homeRecent.hidden = false;
    homeHint.hidden = true;
    // Layout needs to settle (grid columns, card width) before scrollWidth
    // measurements below are meaningful.
    requestAnimationFrame(function () { elideFrontAll(homeGrid); });
  }

  // Front-truncates every `[data-full-path]` element inside `root` down to
  // "…" + as much of the tail as fits — a real per-element measurement
  // rather than the CSS direction:rtl trick, which doesn't reliably keep
  // the ellipsis pinned to the front for plain LTR path text (see the CSS
  // comment on .doc-path). Binary search on character count keeps this to
  // O(log n) DOM writes per element instead of trimming one char at a time.
  function elideFrontAll(root) {
    var ELLIPSIS = '\u2026';
    var nodes = root.querySelectorAll('[data-full-path]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var full = el.getAttribute('data-full-path') || '';
      el.textContent = full;
      if (!full || el.scrollWidth <= el.clientWidth + 1) continue;
      var lo = 0, hi = full.length, best = 0;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        el.textContent = mid > 0 ? ELLIPSIS + full.slice(full.length - mid) : ELLIPSIS;
        if (el.scrollWidth <= el.clientWidth + 1) { best = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      el.textContent = best > 0 ? ELLIPSIS + full.slice(full.length - best) : ELLIPSIS;
    }
  }

  function saveLibraryGroupState() {
    try { localStorage.setItem(LIBRARY_GROUP_STATE_KEY, JSON.stringify({ order: libraryGroupOrder, collapsed: libraryCollapsedGroups })); } catch (e) {}
  }

  // Shared by both the Library drawer and the Home "recent documents" grid
  // so the two views always agree on which document belongs to which group
  // and in what order — Home simply renders the same grouping read-only,
  // it never has its own opinion about ordering.
  function groupDocumentsForDisplay(documents) {
    var groups = {};
    (Array.isArray(documents) ? documents : []).forEach(function (doc) {
      // Space labels are supplied by the backend from SpaceSummary.name —
      // never infer them from the bound directory. Workspace and external
      // labels localize here in the currently active UI language.
      var kind = doc.scopeKind || 'external';
      var label = kind === 'workspace' ? t('appview.libraryWorkspace')
        : kind === 'external' ? t('appview.libraryOther')
          : (doc.scopeLabel || doc.spaceName || t('appview.libraryOther'));
      var groupId = kind === 'space' ? 'space:' + (doc.spaceId || label)
        : kind === 'workspace' ? 'workspace' : 'external';
      if (!groups[groupId]) groups[groupId] = { id: groupId, kind: kind, label: label, scopePath: '', documents: [] };
      // Every document in a Space/workspace group shares one root directory,
      // so the first one carrying it defines the group's path. The "external"
      // bucket is deliberately left blank: it's a mixed bag of unrelated
      // folders, so there is no single meaningful directory to show.
      if (kind !== 'external' && !groups[groupId].scopePath && doc.scopePath) groups[groupId].scopePath = doc.scopePath;
      groups[groupId].documents.push(doc);
    });
    return Object.keys(groups).map(function (key) { return groups[key]; }).sort(function (a, b) {
      // True external files remain fixed at the bottom. Space/workspace
      // groups follow the user's persisted drag order, then default to the
      // deterministic Space → workspace ordering for newly seen groups.
      if (a.kind === 'external' || b.kind === 'external') return a.kind === b.kind ? 0 : a.kind === 'external' ? 1 : -1;
      var orderA = libraryGroupOrder.indexOf(a.id);
      var orderB = libraryGroupOrder.indexOf(b.id);
      if (orderA >= 0 || orderB >= 0) return (orderA < 0 ? 9999 : orderA) - (orderB < 0 ? 9999 : orderB);
      var ranks = { space: 0, workspace: 1 };
      var rankDiff = ranks[a.kind] - ranks[b.kind];
      return rankDiff || a.label.localeCompare(b.label);
    });
  }

  function renderLibraryDocuments(documents) {
    if (!libraryGroups) return;
    libraryDocumentsCache = Array.isArray(documents) ? documents : [];
    var ordered = groupDocumentsForDisplay(libraryDocumentsCache);
    if (libraryReorderMode) { renderLibraryReorderList(ordered); return; }
    libraryGroups.innerHTML = ordered.map(function (group) {
      var rows = group.documents.map(function (doc) {
        var docPath = doc.relativePath || doc.fileName || '';
        return '<button class="library-row" type="button" data-path="' + escapeHtml(doc.path || '') + '">'
          + '<span class="library-row-main">'
          + '<strong>' + escapeHtml(doc.title || doc.fileName || t('home.untitled')) + '</strong>'
          + '<span class="library-row-meta"><span class="library-row-path" title="' + escapeHtml(docPath) + '">' + escapeHtml(docPath) + '</span>'
          + '<time>' + escapeHtml(formatDocTime(doc.modifiedAt)) + '</time></span>'
          + '</span></button>';
      }).join('');
      var draggable = group.kind !== 'external';
      var open = !libraryCollapsedGroups[group.id];
      return '<details class="library-group" data-library-group-id="' + escapeHtml(group.id) + '"'
        + (draggable ? ' data-draggable="true"' : '') + (open ? ' open' : '') + '><summary><span class="library-group-title">' + escapeHtml(group.label) + '</span>'
        + '<span class="library-group-count">' + group.documents.length + '</span></summary>'
        + '<div class="library-items">' + rows + '</div></details>';
    }).join('') || '<p class="home-hint">' + escapeHtml(t('home.hintDefault')) + '</p>';
  }

  // Flat, header-only variant used while reorder mode is active: one row
  // per group (no expand/collapse, no document rows), so the whole row is
  // both the label and the drag handle. "Other" stays fixed at the bottom
  // and un-draggable, matching the normal view's behavior.
  function renderLibraryReorderList(ordered) {
    libraryGroups.innerHTML = ordered.map(function (group) {
      var draggable = group.kind !== 'external';
      return '<div class="library-group library-group-reorder" data-library-group-id="' + escapeHtml(group.id) + '"'
        + (draggable ? ' data-draggable="true"' : '') + '>'
        + '<span class="library-reorder-handle" aria-hidden="true">' + (draggable ? '⋮⋮' : '') + '</span>'
        + '<span class="library-group-title">' + escapeHtml(group.label) + '</span>'
        + '<span class="library-group-count">' + group.documents.length + '</span></div>';
    }).join('') || '<p class="home-hint">' + escapeHtml(t('home.hintDefault')) + '</p>';
  }

  function setLibraryReorderMode(on) {
    libraryReorderMode = !!on;
    if (libraryReorder) libraryReorder.classList.toggle('active', libraryReorderMode);
    if (libraryReorderFooter) libraryReorderFooter.hidden = !libraryReorderMode;
    // Re-render from the cached payload — no need to round-trip the host
    // just to switch between the two presentations of the same data.
    renderLibraryDocuments(libraryDocumentsCache);
  }

  function setLibraryOpen(open) {
    if (!libraryDrawer || !libraryBackdrop) return;
    libraryDrawer.classList.toggle('open', !!open);
    libraryDrawer.setAttribute('aria-hidden', open ? 'false' : 'true');
    libraryBackdrop.hidden = !open;
    if (open) requestRecentDocuments();
    // Always leave reorder mode behind when the drawer closes, so the next
    // time it opens it starts back in the normal browsing view.
    else if (libraryReorderMode) setLibraryReorderMode(false);
  }

  function finishLibraryDrag() {
    if (!libraryDragging || !libraryGroups) return;
    libraryDragging.classList.remove('dragging');
    Array.prototype.forEach.call(libraryGroups.querySelectorAll('.library-group.drag-over'), function (group) { group.classList.remove('drag-over'); });
    // Store only movable group ids: Other always remains a fixed final group.
    libraryGroupOrder = Array.prototype.map.call(libraryGroups.querySelectorAll('.library-group[data-draggable="true"]'), function (group) {
      return group.getAttribute('data-library-group-id');
    }).filter(Boolean);
    // Home reads the very same `libraryGroupOrder`, so it has to be redrawn
    // now — otherwise the new order only appears after the next host push,
    // and closing the drawer would reveal a stale Home ordering.
    renderRecentDocuments(homeDocumentsCache);
    var openState = libraryDragOpenState || {};
    Array.prototype.forEach.call(libraryGroups.querySelectorAll('.library-group'), function (group) {
      var id = group.getAttribute('data-library-group-id');
      if (id in openState) group.open = !!openState[id];
    });
    libraryDragging = null;
    // details `toggle` can be queued by the browser; keep the snapshot live
    // through this task so temporary collapsing never overwrites saved state.
    setTimeout(function () { libraryDragOpenState = null; saveLibraryGroupState(); }, 0);
  }

  // ---- Library group reordering: custom pointer-driven ghost -----------
  //
  // A plain `draggable="true"` + native dragstart/dragover/drop would work,
  // but the browser paints its own translucent "screenshot" ghost of the
  // dragged element that can't be restyled or suppressed. Tracking pointer
  // events by hand instead lets the drag preview be a purpose-built floating
  // clone (own shadow/scale/rotation), matching the rest of the UI.
  function cleanupLibraryDragGhost() {
    if (libraryDragPointer && libraryDragPointer.ghost && libraryDragPointer.ghost.parentNode) {
      libraryDragPointer.ghost.parentNode.removeChild(libraryDragPointer.ghost);
    }
  }

  function positionLibraryDragGhost(clientX, clientY) {
    var state = libraryDragPointer;
    if (!state || !state.ghost) return;
    state.ghost.style.left = (clientX - state.offsetX) + 'px';
    state.ghost.style.top = (clientY - state.offsetY) + 'px';
  }

  function activateLibraryDrag(group) {
    var state = libraryDragPointer;
    if (!state || state.active) return;
    state.active = true;
    libraryDragging = group;
    libraryDragOpenState = {};
    // Reorder-mode rows are already flat header-only <div>s with nothing to
    // collapse — this open/close snapshot-and-collapse dance only applies
    // to the normal <details> browsing view.
    if (!libraryReorderMode) {
      Array.prototype.forEach.call(libraryGroups.querySelectorAll('.library-group'), function (item) {
        var id = item.getAttribute('data-library-group-id');
        if (id) libraryDragOpenState[id] = !!item.open;
        item.open = false;
      });
    }
    group.classList.add('dragging');
    // The clone is built *after* collapsing above, so it mirrors the
    // compact row height actually being dragged, not the (possibly
    // expanded) pre-drag one.
    var rect = group.getBoundingClientRect();
    var ghost = group.cloneNode(true);
    ghost.classList.add('library-drag-ghost');
    ghost.classList.remove('dragging');
    ghost.style.width = rect.width + 'px';
    state.ghost = ghost;
    state.offsetX = state.startX - rect.left;
    state.offsetY = state.startY - rect.top;
    document.body.appendChild(ghost);
    positionLibraryDragGhost(state.startX, state.startY);
  }

  function updateLibraryDragTarget(clientX, clientY) {
    if (!libraryDragging) return;
    // Ghost is pointer-events:none, so elementFromPoint sees through it to
    // whatever row is actually underneath the cursor.
    var el = document.elementFromPoint(clientX, clientY);
    var target = el && el.closest ? el.closest('.library-group[data-draggable="true"]') : null;
    Array.prototype.forEach.call(libraryGroups.querySelectorAll('.library-group.drag-over'), function (item) { item.classList.remove('drag-over'); });
    if (!target || target === libraryDragging) return;
    target.classList.add('drag-over');
    var after = clientY > target.getBoundingClientRect().top + target.offsetHeight / 2;
    libraryGroups.insertBefore(libraryDragging, after ? target.nextSibling : target);
  }

  function endLibraryDragPointer() {
    var state = libraryDragPointer;
    if (!state) return;
    if (state.active) {
      cleanupLibraryDragGhost();
      finishLibraryDrag();
      librarySuppressNextClick = true;
      setTimeout(function () { librarySuppressNextClick = false; }, 0);
    }
    libraryDragPointer = null;
  }

  if (appLibrary) appLibrary.addEventListener('click', function () { setLibraryOpen(true); });
  if (libraryClose) libraryClose.addEventListener('click', function () { setLibraryOpen(false); });
  if (libraryBackdrop) libraryBackdrop.addEventListener('click', function () { setLibraryOpen(false); });
  if (libraryReorder) libraryReorder.addEventListener('click', function () { setLibraryReorderMode(!libraryReorderMode); });
  if (libraryReorderDone) libraryReorderDone.addEventListener('click', function () { setLibraryReorderMode(false); });
  if (libraryGroups) libraryGroups.addEventListener('click', function (event) {
    var row = event.target && event.target.closest ? event.target.closest('.library-row') : null;
    var docPath = row && row.getAttribute('data-path');
    if (!docPath || !api || !api.postMessage) return;
    setLibraryOpen(false);
    loadingFromHome = true;
    setStatus(t('status.opening'));
    api.postMessage({ type: 'loadPath', path: docPath });
  });
  if (libraryGroups) {
    // Persist ordinary expand/collapse choices. During a drag all groups are
    // briefly collapsed for a clean reorder target, but that temporary state
    // is deliberately ignored and restored from libraryDragOpenState.
    libraryGroups.addEventListener('toggle', function (event) {
      var group = event.target;
      if (!group || !group.matches || !group.matches('.library-group')) return;
      if (libraryDragOpenState) return;
      var id = group.getAttribute('data-library-group-id');
      if (!id) return;
      libraryCollapsedGroups[id] = !group.open;
      saveLibraryGroupState();
    }, true);
    // Suppress the <summary> toggle click that a pointerdown+move sequence
    // would otherwise also fire once the pointer is released — a real drag
    // shouldn't also flip the group open/closed.
    libraryGroups.addEventListener('click', function (event) {
      if (!librarySuppressNextClick) return;
      var summary = event.target && event.target.closest ? event.target.closest('.library-group summary') : null;
      if (!summary) return;
      event.preventDefault();
      event.stopPropagation();
    }, true);
    libraryGroups.addEventListener('pointerdown', function (event) {
      if (event.button !== 0) return;
      // Reordering is exclusive to reorder mode. In the normal browsing view
      // a group header is purely an expand/collapse control, so no drag may
      // start from it — otherwise an ordinary click-and-wobble on a title
      // silently rearranges the user's categories.
      if (!libraryReorderMode) return;
      // Reorder-mode rows have no <summary>: the whole flat row is the handle.
      var group = event.target && event.target.closest ? event.target.closest('.library-group[data-draggable="true"]') : null;
      if (!group) return;
      libraryDragPointer = { group: group, startX: event.clientX, startY: event.clientY, active: false, ghost: null, offsetX: 0, offsetY: 0 };
    });
    window.addEventListener('pointermove', function (event) {
      var state = libraryDragPointer;
      if (!state) return;
      if (!state.active) {
        // A small tolerance before committing to a drag: keeps quick clicks
        // (open/close) from ever spawning a ghost.
        if (Math.abs(event.clientX - state.startX) < 4 && Math.abs(event.clientY - state.startY) < 4) return;
        activateLibraryDrag(state.group);
      }
      event.preventDefault();
      positionLibraryDragGhost(event.clientX, event.clientY);
      updateLibraryDragTarget(event.clientX, event.clientY);
    });
    window.addEventListener('pointerup', function () { endLibraryDragPointer(); });
    window.addEventListener('pointercancel', function () { endLibraryDragPointer(); });
  }

  // Set while a Home-card click is in flight, so the `document` reply below
  // can turn "正在打开…" into a completion message instead of leaving it
  // to linger (or getting silently swallowed by the "isFirst" branch, which
  // otherwise prints nothing at all for the very first document a panel loads).
  var loadingFromHome = false;

  if (homeGrid) homeGrid.addEventListener('click', function (event) {
    if (!api || !api.postMessage) return;
    // Delegated: `.home-group-cwd` buttons are re-created on every render
    // (one per category), so there's no single fixed DOM node to bind to
    // like the old top-of-section cwd button had.
    var cwdBtn = event.target && event.target.closest ? event.target.closest('.home-group-cwd') : null;
    if (cwdBtn) {
      var cwdPath = cwdBtn.getAttribute('data-cwd-path') || '';
      if (cwdPath) api.postMessage({ type: 'openPath', path: cwdPath });
      return;
    }
    var reveal = event.target && event.target.closest ? event.target.closest('.doc-reveal') : null;
    if (reveal) {
      event.preventDefault();
      event.stopPropagation();
      var revealPath = reveal.getAttribute('data-reveal-path') || '';
      if (revealPath) api.postMessage({ type: 'openPath', path: revealPath });
      return;
    }
    var card = event.target && event.target.closest ? event.target.closest('.doc-card') : null;
    if (!card) return;
    var docPath = card.getAttribute('data-path') || '';
    if (!docPath) return;
    loadingFromHome = true;
    setStatus(t('status.opening'));
    api.postMessage({ type: 'loadPath', path: docPath });
  });
  // The reveal control is keyboard-focusable (role="button" tabindex="0")
  // since it's nested inside the card's own <button>; Enter/Space need their
  // own handler because a non-<button> element doesn't get native activation.
  if (homeGrid) homeGrid.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    var reveal = event.target && event.target.closest ? event.target.closest('.doc-reveal') : null;
    if (!reveal || !api || !api.postMessage) return;
    event.preventDefault();
    event.stopPropagation();
    var revealPath = reveal.getAttribute('data-reveal-path') || '';
    if (revealPath) api.postMessage({ type: 'openPath', path: revealPath });
  });

  function updateEmptyState() {
    empty.hidden = hasDocument();
    document.body.classList.toggle('has-document', hasDocument());
    if (actions) actions.hidden = !html;
    // Refresh whenever the home page comes back into view: mtimes change while
    // a document is open, and a file may have been created since last render.
    if (!empty.hidden && envReceived) requestRecentDocuments();
  }

  function showPane() {
    editPane.classList.toggle('active', isAppView ? hasDocument() : mode === 'edit');
    previewPane.classList.toggle('active', isAppView ? hasDocument() : mode === 'preview');
    if ((isAppView || mode === 'edit') && cm) requestAnimationFrame(function () { cm.layout(); });
  }

  function setPanelTitle(title) {
    if (!api || !api.panel || !api.panel.setTitle) return;
    api.panel.setTitle(title || t('home.title')).catch(function () {});
  }

  // 8 built-in presets, then a separator, then the 3 reusable AI-managed
  // slots. The AI-custom entry itself was removed from this menu — AI now
  // asks which slot to overwrite before calling set_style, so users only
  // need this menu to pick a preset or reapply a saved slot.
  function buildStyleMenuItems() {
    var items = [
      { id: 'style:kami', label: 'Kami' },
      { id: 'style:bauhaus', label: 'Bauhaus' },
      { id: 'style:blueprint', label: 'Blueprint' },
      { id: 'style:botanical', label: 'Botanical' },
      { id: 'style:newsprint', label: 'Newsprint' },
      { id: 'style:retro', label: 'Retro' },
      { id: 'style:sketch', label: 'Sketch' },
      { id: 'style:terminal', label: 'Terminal' },
      { id: 'style-sep', label: '', separator: true },
    ];
    // Same "unsaved custom style" affordance as App View's menu (see
    // renderAppMenus) — a style landed via set_style without a slot (or the
    // user is mid-tweak) shouldn't be recoverable only through the transient
    // 12s status-bar prompt.
    var isUnsavedCustom = style === 'custom' && !!customCss && !styleSlots.some(function (s) { return s && s.css === customCss; });
    if (isUnsavedCustom) {
      for (var j = 0; j < 3; j++) items.push({ id: 'style:slot-save:' + j, label: t('aiStyle.saveToSlot', { n: j + 1 }) });
      items.push({ id: 'style-save-sep', label: '', separator: true });
    }
    for (var i = 0; i < 3; i++) {
      var slot = styleSlots[i];
      items.push(slot
        ? { id: 'style:slot-use:' + i, label: t('toolbar.style.customSlot', { n: i + 1, label: slot.label }) }
        : { id: 'style:slot-use:' + i, label: t('toolbar.style.customSlotEmpty', { n: i + 1 }), disabled: true });
    }
    return items;
  }

  // The whole toolbar is rebuilt and pushed as one array (rather than patching
  // single items) so icon/label/disabled/checked states never drift out of
  // sync with each other, and so `ext:` icon ids are always resolved fresh
  // against the already-registered icon pack instead of racing it.
  function buildToolbar() {
    var saveIcon = 'ext:markdown-editor-icons/save';
    var saveLabel = t('toolbar.save.label'), saveTooltip = t('toolbar.save.tooltipDefault');
    if (dirty) {
      // No extra "•" glyph — an enabled/highlighted save button already
      // signals "there's something to save" without adding visual noise.
      saveLabel = t('toolbar.save.label');
      saveTooltip = t('toolbar.save.tooltipDirty');
    } else if (savedFlash) {
      saveIcon = 'ext:markdown-editor-icons/save-check';
      saveLabel = t('toolbar.save.labelSaved');
      saveTooltip = t('toolbar.save.tooltipSaved');
    }
    var hasDoc = hasDocument();
    return [
      {
        // Always available — a one-click way back to the recent-documents
        // launch page, regardless of what's currently open.
        id: 'home', icon: 'house', tooltip: t('toolbar.home.tooltip'),
      },
      {
        // Icon-only: the open action is unambiguous from the folder icon,
        // and dropping the label keeps this crowded toolbar's left edge compact.
        id: 'open', icon: 'ext:markdown-editor-icons/folder-open',
        tooltip: sourcePath || fileName || t('toolbar.open.tooltipDefault'), disabled: nativePickPending,
      },
      { id: 'save', icon: saveIcon, label: saveLabel, tooltip: saveTooltip, disabled: !dirty },
      { type: 'separator' },
      {
        // Label stays "预览" no matter which mode is active — the swatch
        // icon plus `checked` already communicate on/off; flipping the word
        // itself between "预览"/"编辑" read as ambiguous ("is this the mode
        // I'm in, or the one I'm switching to?").
        id: 'mode', icon: renderingPreview ? 'ext:markdown-editor-icons/hourglass' : 'ext:markdown-editor-icons/swatch-book',
        label: t('toolbar.mode.label'), tooltip: hasDoc ? (renderingPreview ? t('toolbar.mode.tooltipRendering') : mode === 'edit' ? t('toolbar.mode.tooltipToPreview') : t('toolbar.mode.tooltipToEdit')) : t('toolbar.needDoc'),
        checked: mode === 'preview', disabled: !hasDoc,
      },
      {
        type: 'menu', id: 'style', icon: 'palette', tooltip: mode === 'preview' ? t('toolbar.style.tooltip') : t('toolbar.style.tooltipNeedsPreview'),
        disabled: mode !== 'preview',
        items: buildStyleMenuItems(),
      },
      { type: 'spacer' },
      // NOTE: copy/export/AI-layout deliberately do NOT live here. A host
      // toolbar click reaches this page as a postMessage, which carries no
      // user activation, so clipboard writes and composer.addContexts() were
      // both being rejected ("This action requires a user gesture") until
      // the user first clicked somewhere in the page. Those actions now sit
      // in the in-page floating bar over the preview (see `.actions` above),
      // where a click is a real user gesture and they succeed on first try.
      {
        // Focus mode ("专注"): dims every line except the cursor's own, a
        // checked toggle like annotate. Editing-only; preview has no lines.
        // Icon-only like `open` — the tooltip explains what it does.
        id: 'focus', icon: 'ext:markdown-editor-icons/feather',
        tooltip: hasDoc ? (focusMode ? t('toolbar.focus.tooltipOn') : t('toolbar.focus.tooltipOff')) : t('toolbar.needDoc'),
        checked: focusMode, disabled: !hasDoc || mode === 'preview',
      },
      {
        type: 'menu', id: 'font-size', icon: 'ext:markdown-editor-icons/type',
        tooltip: !hasDoc ? t('toolbar.needDoc') : mode === 'preview' ? t('toolbar.fontSize.tooltipPreview') : t('toolbar.fontSize.tooltipEdit'),
        disabled: !hasDoc || mode === 'preview',
        items: [
          { id: 'comfort:read', label: t('toolbar.comfort.read'), checked: !comfortWriting },
          { id: 'comfort:write', label: t('toolbar.comfort.write'), checked: comfortWriting },
          { id: 'font-comfort-sep', label: '', separator: true },
          { id: 'font-size:14', label: t('toolbar.fontSize.small'), checked: editorFontSize === 14 },
          { id: 'font-size:16', label: t('toolbar.fontSize.medium'), checked: editorFontSize === 16 },
          { id: 'font-size:18', label: t('toolbar.fontSize.large'), checked: editorFontSize === 18 },
          { id: 'font-sep', label: '', separator: true },
          { id: 'font-family:rounded', label: t('toolbar.fontFamily.default'), checked: editorFont === 'rounded' },
          { id: 'font-family:songti', label: t('toolbar.fontFamily.serif'), checked: editorFont === 'songti' },
        ],
      },
      {
        type: 'menu', id: 'more', icon: 'settings',
        items: [
          { id: 'reload', label: t('toolbar.more.reload'), disabled: mode !== 'preview' },
          { id: 'reveal', label: t('toolbar.more.reveal'), disabled: !hasDoc },
          { id: 'more-sep', label: '', separator: true },
          { id: 'about', label: t('toolbar.more.about') },
        ],
      },
    ];
  }

  function appMenuButton(id, label, checked) {
    return '<button type="button" data-app-action="' + id + '"' + (checked ? ' class="checked"' : '') + '><span>' + label + '</span>' + (checked ? '<span>✓</span>' : '') + '</button>';
  }

  function renderAppMenus() {
    if (appStyleMenu) {
      var presets = ['kami', 'bauhaus', 'blueprint', 'botanical', 'newsprint', 'retro', 'sketch', 'terminal'];
      var markup = presets.map(function (name) { return appMenuButton('style:' + name, name[0].toUpperCase() + name.slice(1), style === name); }).join('') + '<hr>';
      // A currently-applied custom style (e.g. AI-designed, or one the user
      // is still tweaking) that hasn't been saved to any of the 3 reusable
      // slots yet — offer a durable way to save it here, not just the
      // transient 12s status-bar prompt right after set_style lands. This
      // is App View's only Style-menu path for it since there's no
      // Composer/annotation flow to hand a "save this" request off to.
      var isUnsavedCustom = style === 'custom' && !!customCss && !styleSlots.some(function (s) { return s && s.css === customCss; });
      if (isUnsavedCustom) {
        markup += [0, 1, 2].map(function (i) { return appMenuButton('style:slot-save:' + i, t('aiStyle.saveToSlot', { n: i + 1 }), false); }).join('') + '<hr>';
      }
      for (var i = 0; i < 3; i++) {
        var slot = styleSlots[i];
        markup += slot ? appMenuButton('style:slot-use:' + i, t('toolbar.style.customSlot', { n: i + 1, label: slot.label }), style === 'custom' && customCss === slot.css) : appMenuButton('style:slot-use:' + i, t('toolbar.style.customSlotEmpty', { n: i + 1 }), false);
      }
      appStyleMenu.innerHTML = markup;
    }
    if (appFontMenu) appFontMenu.innerHTML = appMenuButton('comfort:read', t('toolbar.comfort.read'), !comfortWriting)
      + appMenuButton('comfort:write', t('toolbar.comfort.write'), comfortWriting) + '<hr>'
      + appMenuButton('font-size:14', t('toolbar.fontSize.small'), editorFontSize === 14)
      + appMenuButton('font-size:16', t('toolbar.fontSize.medium'), editorFontSize === 16)
      + appMenuButton('font-size:18', t('toolbar.fontSize.large'), editorFontSize === 18) + '<hr>'
      + appMenuButton('font-family:rounded', t('toolbar.fontFamily.default'), editorFont === 'rounded')
      + appMenuButton('font-family:songti', t('toolbar.fontFamily.serif'), editorFont === 'songti');
    if (appMoreMenu) appMoreMenu.innerHTML = appMenuButton('reload', t('toolbar.more.reload'), false)
      + appMenuButton('reveal', t('toolbar.more.reveal'), false) + '<hr>' + appMenuButton('about', t('toolbar.more.about'), false);
  }

  function syncAppToolbar() {
    if (!isAppView) return;
    var hasDoc = hasDocument();
    if (appSave) {
      appSave.disabled = !dirty;
      appSave.classList.toggle('dirty', dirty);
      var saveTooltip = savedFlash ? 'toolbar.save.tooltipSaved' : dirty ? 'toolbar.save.tooltipDirty' : 'toolbar.save.tooltipDefault';
      appSave.setAttribute('data-tooltip', t(saveTooltip));
      var icSave = appSave.querySelector('.ic-save');
      var icCheck = appSave.querySelector('.ic-save-check');
      if (icSave) icSave.hidden = savedFlash;
      if (icCheck) icCheck.hidden = !savedFlash;
    }
    if (appFocus) { appFocus.disabled = !hasDoc; appFocus.classList.toggle('checked', focusMode); }
    if (appPreview) { appPreview.disabled = !hasDoc; appPreview.classList.toggle('checked', previewVisible); }
    if (appOpen) appOpen.disabled = nativePickPending;
    if (appStyle) {
      // Style only affects the rendered preview — disable it while the
      // preview pane itself is toggled off (App View's `previewVisible`,
      // distinct from the sidebar's edit/preview `mode`), same idea as the
      // sidebar toolbar disabling style when mode !== 'preview'.
      appStyle.disabled = !hasDoc || !previewVisible;
      appStyle.setAttribute('data-tooltip', t(previewVisible ? 'toolbar.style.tooltip' : 'toolbar.style.tooltipNeedsPreview'));
    }
    if (appFont) appFont.disabled = !hasDoc;
    renderAppMenus();
  }

  function syncToolbar() {
    if (isAppView) syncAppToolbar();
    else if (api) api.postMessage({ type: 'setToolbar', toolbar: buildToolbar() });
  }

  function setMode(next) {
    closePopup();
    if (isAppView) { mode = 'edit'; showPane(); render(); syncToolbar(); return; }
    mode = next;
    showPane();
    syncToolbar();
    if (mode === 'preview') render();
  }

  // ---- CodeMirror 6 Markdown editor ----

  // Bridges a pasted image File to the host, which writes it under this
  // mini tool's own storage dir and replies with a `finch-file://` URL to
  // insert. Round-trips through the same requestId/pending-map pattern as
  // saveMarkdown above, since postMessage has no built-in request/response.
  function pasteImageToHost(file) {
    if (!api || !api.postMessage) return Promise.reject(new Error('No host bridge.'));
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var dataUrl = typeof reader.result === 'string' ? reader.result : '';
        var comma = dataUrl.indexOf(',');
        var base64 = comma >= 0 ? dataUrl.slice(comma + 1) : '';
        if (!base64) { reject(new Error('Could not read pasted image.')); return; }
        var id = ++pasteImageId;
        pendingPasteImages[id] = { resolve: resolve, reject: reject };
        setTimeout(function () {
          if (pendingPasteImages[id]) { delete pendingPasteImages[id]; reject(new Error(t('status.pasteImageTimeout'))); }
        }, 15000);
        api.postMessage({ type: 'pasteImage', data: base64, mimeType: file.type, requestId: id });
      };
      reader.onerror = function () { reject(new Error('Could not read pasted image.')); };
      reader.readAsDataURL(file);
    });
  }

  var cm = window.MarkdownCodeMirror.create({
    parent: editor,
    value: markdown,
    onChange: function (value) {
      markdown = value;
      closePopup();
      updateEmptyState();
      setDirty(true);
      scheduleDraftSave();
      scheduleLivePreview();
    },
    onOpenLink: function (url) {
      if (api && api.postMessage) api.postMessage({ type: 'openLink', url: url });
    },
    onOpenImage: function (url) {
      if (!api || !api.postMessage) return;
      // Match Finch Delivery's preview message: pass the decoded absolute path
      // directly to the host for local Finch files, rather than asking it to
      // parse the custom URL a second time.
      try {
        var parsedImageUrl = new URL(url);
        if (parsedImageUrl.protocol === 'finch-file:' && parsedImageUrl.hostname === 'local') {
          var imagePath = parsedImageUrl.searchParams.get('path');
          if (imagePath) { api.postMessage({ type: 'openImage', path: imagePath }); return; }
        }
      } catch (_) {}
      api.postMessage({ type: 'openImage', url: url });
    },
    onPasteImage: pasteImageToHost,
    onAiHintTrigger: openAiPromptBar,
  });
  cm.setFontSize(editorFontSize);
  cm.setFontFamily(EDITOR_FONTS[editorFont]);
  cm.setComfortWriting(comfortWriting);
  cm.setFocusMode(focusMode);
  cm.scrollDOM.addEventListener('scroll', closePopup);

  // ---- Markdown <-> bm.md rendering ----

  function activeCustomCss() { return style === 'custom' ? customCss : ''; }

  function scheduleLivePreview() {
    if (!isAppView) return;
    if (liveRenderTimer) clearTimeout(liveRenderTimer);
    liveRenderTimer = setTimeout(function () { liveRenderTimer = 0; render(); }, 420);
  }

  function render() {
    if (!markdown || !api) return;
    var id = ++renderId;
    renderingPreview = true;
    syncToolbar();
    api.postMessage({
      type: 'renderBm',
      markdown: markdown,
      markdownStyle: style === 'custom' ? 'kami' : style,
      customCss: activeCustomCss(),
      requestId: id,
    });
  }

  function captureScroll() {
    var d = frame.contentDocument, e = d && d.scrollingElement;
    if (!e) return null;
    return { top: e.scrollTop };
  }

  function restoreScroll(saved) {
    var d = frame.contentDocument, e = d && d.scrollingElement;
    if (!saved || !e) return;
    e.scrollTop = Math.min(saved.top, Math.max(0, e.scrollHeight - e.clientHeight));
  }

  // The <iframe id="article"> box itself already carries the correct
  // theme-matched background (var(--card) in the CSS above, resolved for
  // whatever skin/light/dark mode Finch is currently in). Read that back
  // with getComputedStyle so the iframe's OWN document — which is what
  // actually paints once its content loads — uses the identical color
  // instead of the browser's default opaque-white canvas. This keeps short
  // articles from showing a plain white strip below the themed content.
  function articleBg() {
    try { return getComputedStyle(frame).backgroundColor || ''; } catch (e) { return ''; }
  }

  function showHtml(next) {
    var previous = captureScroll();
    var d = frame.contentDocument;
    html = next;
    var bg = articleBg();
    if (frameReady && d && d.body) {
      d.body.innerHTML = html;
      if (bg) d.body.style.background = bg;
      restoreScroll(previous);
      bindPreviewSelection();
      return;
    }
    // Only reset the iframe's own html/body box model here. bm.md already
    // inlines its own spacing (e.g. "padding: 2em 1.75em") and background
    // directly onto the #bm-md section — do NOT override those, or the
    // article loses its official top padding/background and looks flush
    // against the frame edge.
    frame.srcdoc = '<!doctype html><meta charset="utf-8"><base target="_blank">' +
      '<style>html,body{margin:0!important;padding:0!important;min-height:100%}' +
      'body{background:' + (bg || 'transparent') + '}' +
      // bm.md's own inline style on #bm-md never sets a height, so a short
      // article's background only covers its own content and the rest of
      // the frame falls back to the body background set above. That's fine
      // inside this iframe (body already carries the matching color), but
      // it means the "所见即所得" canvas/PDF export and the raw #bm-md
      // outerHTML used for copy would both crop right at the last line —
      // no full-bleed backdrop the way the actual WeChat article does once
      // published. Forcing #bm-md to at least fill the viewport keeps its
      // own background (not just the iframe's) reaching all the way down.
      '#bm-md{min-height:100dvh}</style>' +
      '<body>' + html;
  }

  function lineRangeForOffsets(text, start, end) {
    return { start: text.slice(0, start).split('\n').length, end: text.slice(0, end).split('\n').length };
  }

  function normalizeMappedText(text, sourceMap) {
    var normalized = '', map = [];
    for (var i = 0; i < text.length; i++) {
      if (/\s/.test(text[i])) {
        if (normalized && normalized[normalized.length - 1] !== ' ') {
          normalized += ' ';
          map.push(sourceMap[i]);
        }
      } else {
        normalized += text[i];
        map.push(sourceMap[i]);
      }
    }
    if (normalized.endsWith(' ')) { normalized = normalized.slice(0, -1); map.pop(); }
    return { text: normalized, map: map };
  }

  // Build an approximation of bm.md's visible text while retaining a map
  // back to source offsets. Markdown markers and link destinations disappear
  // in preview, which is why a direct substring search alone misses lines.
  function projectRenderedMarkdown(source) {
    var text = '', map = [];
    function append(char, offset) { text += char; map.push(offset); }
    for (var i = 0; i < source.length;) {
      var lineStart = i === 0 || source[i - 1] === '\n';
      if (lineStart) {
        var fence = /^[ \t]*(?:```|~~~)[^\n]*/.exec(source.slice(i));
        if (fence) { i += fence[0].length; continue; }
        var prefix = /^[ \t]*(?:#{1,6}|>+|[-+*]|\d+[.)])[ \t]+/.exec(source.slice(i));
        if (prefix) { i += prefix[0].length; continue; }
      }
      var link = /^!?\[([^\]]*)\]\((?:\\.|[^)])*\)/.exec(source.slice(i));
      if (link) {
        var labelOffset = i + link[0].indexOf('[') + 1;
        for (var j = 0; j < link[1].length; j++) {
          if (!/[*_~`]/.test(link[1][j])) append(link[1][j], labelOffset + j);
        }
        i += link[0].length;
        continue;
      }
      var htmlTag = /^<[^>]+>/.exec(source.slice(i));
      if (htmlTag) { i += htmlTag[0].length; continue; }
      if (source[i] === '\\' && i + 1 < source.length) {
        append(source[i + 1], i + 1);
        i += 2;
        continue;
      }
      if (/[*_~`]/.test(source[i])) { i++; continue; }
      append(source[i], i);
      i++;
    }
    return normalizeMappedText(text, map);
  }

  function findRenderedSourceRange(source, renderedText) {
    var direct = source.indexOf(renderedText);
    if (direct >= 0) return { start: direct, end: direct + renderedText.length };
    var projected = projectRenderedMarkdown(source);
    var needle = renderedText.replace(/\s+/g, ' ').trim();
    var index = projected.text.indexOf(needle);
    if (index >= 0) {
      return { start: projected.map[index], end: projected.map[index + needle.length - 1] + 1 };
    }
    if (needle.length >= 12) {
      var first = needle.slice(0, 6);
      var last = needle.slice(-6);
      var firstIndex = projected.text.indexOf(first);
      var lastIndex = projected.text.indexOf(last, Math.max(0, firstIndex + first.length));
      if (firstIndex >= 0 && lastIndex >= firstIndex) {
        return { start: projected.map[firstIndex], end: projected.map[lastIndex + last.length - 1] + 1 };
      }
    }
    return null;
  }

  function pathFileName(value) {
    return String(value || '').split(/[\\/]/).pop() || '';
  }

  function bindPreviewSelection() {
    var d = frame.contentDocument;
    if (!d || d.__bound) return;
    d.__bound = true;
    function picked() {
      if (!annotationsEnabled) return;
      var w = frame.contentWindow;
      var s = w.getSelection();
      var text = s.toString().trim();
      if (!text || !s.rangeCount) return;
      var range = s.getRangeAt(0);
      var rects = Array.from(range.getClientRects());
      var frameRect = frame.getBoundingClientRect();
      var boxes = rects.map(function (r) {
        return { top: frameRect.top + r.top, left: frameRect.left + r.left, width: r.width, height: r.height };
      });
      // First and last client rect are the selection's first and last line
      // boxes, which is exactly the pair the popup anchors to (above the
      // start, or below the end when there's no room above). The bounding
      // box would collapse a multi-line selection into one rectangle and
      // lose the start line's own left edge.
      var firstRect = rects[0] || range.getBoundingClientRect();
      var lastRect = rects[rects.length - 1] || firstRect;
      var sourceRange = findRenderedSourceRange(markdown, text);
      var lines = sourceRange ? lineRangeForOffsets(markdown, sourceRange.start, sourceRange.end) : null;
      scheduleOpenPopup(text, {
        startTop: frameRect.top + firstRect.top,
        startLeft: frameRect.left + firstRect.left,
        endBottom: frameRect.top + lastRect.bottom,
        endLeft: frameRect.left + lastRect.left,
      }, boxes, lines, 'preview');
    }
    d.addEventListener('mouseup', picked);
    d.addEventListener('mousedown', function () { cancelScheduledPopup(); closePopup(); });
    d.addEventListener('keyup', picked);
    // The preview lives in an iframe, so its keyboard events do not bubble to
    // the panel document. Capture Cmd+P / Ctrl+P here too, preventing the
    // browser's print dialog and returning to the editor from preview.
    d.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        setMode('edit');
      }
    });
    d.addEventListener('scroll', function () { cancelScheduledPopup(); closePopup(); }, true);
    frame.contentWindow.addEventListener('scroll', function () { cancelScheduledPopup(); closePopup(); });
  }

  frame.onload = function () { frameReady = true; bindPreviewSelection(); };

  // ---- Selection popup (editor + preview share this) ----
  // top/bottom describe the selection's bounding box in viewport coordinates;
  // the popup prefers sitting above the selection, and drops below it when
  // there isn't enough room above (near the top of the panel).

  var popupDelayTimer = 0;
  var fakeSelBoxes = [];

  // Selection popups appear after a short delay so a still-in-progress drag
  // selection doesn't flash the popup at every intermediate position.
  //
  // `anchor` describes where the popup should sit, in viewport coordinates:
  //   startTop/startLeft — top-left of the selection's FIRST line
  //   endBottom/endLeft  — bottom-left of the selection's LAST line
  //   width              — optional fixed width (the inline prompt bar)
  //   focus              — whether to take keyboard focus on open
  function scheduleOpenPopup(text, anchor, boxes, lines, origin) {
    cancelScheduledPopup();
    popupDelayTimer = setTimeout(function () {
      openPopup(text, anchor, boxes, lines, origin);
    }, 300);
  }

  function cancelScheduledPopup() {
    if (popupDelayTimer) { clearTimeout(popupDelayTimer); popupDelayTimer = 0; }
  }

  function openPopup(text, anchor, boxes, lines, origin, popupMode) {
    selection.text = text;
    selection.lines = lines || null;
    selection.origin = origin || '';
    selection.mode = popupMode || 'replace';
    updatePopupPlaceholder();
    popup.classList.remove('hidden');
    popup.classList.toggle('popup-bar', !!(anchor && anchor.width));
    popupInput.value = '';
    showFakeSelection(boxes);
    requestAnimationFrame(function () {
      positionPopup(anchor);
      // A selection popup deliberately does NOT steal focus: it would drop
      // the editor's own selection highlight and put the caret somewhere
      // the reader didn't ask for. Click into it to start typing. The
      // inline prompt bar is the opposite — it only exists because the
      // writer just pressed a key to summon it, so it focuses itself.
      if (anchor && anchor.focus) popupInput.focus();
    });
  }

  // Preferred position is directly above the START of the selection, so the
  // popup never covers the text it is about to rewrite. When the selection
  // starts too close to the top of the window there is no room there, and
  // it drops below the END of the selection instead — still clear of the
  // selected text, just on the other side of it.
  function positionPopup(anchor) {
    var margin = 8;
    var gap = 10;
    var a = anchor || {};
    // AppView's 48px toolbar sits fixed at the top of the same viewport
    // these coordinates are measured in; without accounting for it, a
    // selection near the top of the document places the popup right under
    // (or behind) the toolbar instead of below the top of the actual
    // editing surface.
    var topMargin = isAppView ? margin + 48 : margin;
    // The inline prompt bar replaces the blank line it was summoned on:
    // fixed width, sitting exactly where that line is, so it reads as the
    // line turning into an input rather than as a popup floating over it.
    popup.style.width = a.width ? a.width + 'px' : '';
    if (a.width) {
      popup.style.left = Math.max(margin, a.startLeft || 0) + 'px';
      popup.style.top = Math.max(topMargin, Math.min(a.startTop || 0,
        window.innerHeight - (popup.offsetHeight || 44) - margin)) + 'px';
      return;
    }
    var w = popup.offsetWidth || 300;
    var h = popup.offsetHeight || 44;
    var above = (a.startTop || 0) - gap - h;
    var fitsAbove = above >= topMargin;
    var y = fitsAbove ? above : (a.endBottom || 0) + gap;
    var x = fitsAbove ? (a.startLeft || 0) : (a.endLeft != null ? a.endLeft : a.startLeft || 0);
    popup.style.left = Math.max(margin, Math.min(x, window.innerWidth - w - margin)) + 'px';
    popup.style.top = Math.max(topMargin, Math.min(y, window.innerHeight - h - margin)) + 'px';
  }

  // iframe selection highlighting disappears when focus moves to the popup.
  // Preview selections therefore use temporary fixed boxes. CodeMirror draws
  // its own persistent selection layer and does not use this fallback.
  function showFakeSelection(boxes) {
    clearFakeSelection();
    (boxes || []).forEach(function (b) {
      var el = document.createElement('div');
      el.className = 'fake-sel';
      el.style.top = b.top + 'px';
      el.style.left = b.left + 'px';
      el.style.width = b.width + 'px';
      el.style.height = b.height + 'px';
      document.body.appendChild(el);
      fakeSelBoxes.push(el);
    });
  }

  function clearFakeSelection() {
    fakeSelBoxes.forEach(function (el) { el.remove(); });
    fakeSelBoxes = [];
  }

  // ---- Rewrite-popup focus shortcut: Cmd+Control+E / Ctrl+Alt+E ----
  //
  // macOS keeps Command and Control as two distinct modifier keys, so its
  // idiomatic 2-modifier chord is Cmd+Ctrl. Windows and Linux only have one
  // "Ctrl", so the equivalent 2-modifier chord there is Ctrl+Alt — using
  // plain Ctrl+E alone would collide with the browser/OS's own bindings
  // (address-bar search, etc.) on those platforms.
  var uaPlatform = (navigator.platform || navigator.userAgent || '');
  var isMacPlatform = /Mac|iPhone|iPod|iPad/.test(uaPlatform);

  function isRewriteFocusShortcut(e) {
    if (String(e.key).toLowerCase() !== 'e') return false;
    if (e.shiftKey) return false;
    return isMacPlatform
      ? (e.metaKey && e.ctrlKey && !e.altKey)
      : (e.ctrlKey && e.altKey && !e.metaKey);
  }

  // Each OS's own shortest customary notation: macOS shows bare symbols
  // with no separators (⌘⌃E), Windows/Linux spell modifier names joined
  // with "+" (Ctrl+Alt+E) since they have no single-glyph convention for
  // Alt/Ctrl the way macOS does for Cmd/Ctrl.
  (function renderPopupShortcutHint() {
    if (!popupShortcut) return;
    var keys = isMacPlatform ? ['⌘', '⌃', 'E'] : ['Ctrl', 'Alt', 'E'];
    var sep = isMacPlatform ? '' : '+';
    popupShortcut.innerHTML = keys.map(function (k) {
      return '<kbd>' + k + '</kbd>';
    }).join(sep ? '<span class="popup-shortcut-sep">' + sep + '</span>' : '');
  })();

  function closePopup(restoreEditorFocus) {
    var shouldRestore = restoreEditorFocus === true && selection.origin === 'editor' && mode === 'edit';
    cancelScheduledPopup();
    popup.classList.add('hidden');
    popup.classList.remove('popup-bar');
    popup.classList.remove('focused');
    popup.style.width = '';
    selection.text = '';
    selection.lines = null;
    selection.origin = '';
    selection.mode = 'replace';
    clearFakeSelection();
    if (shouldRestore) requestAnimationFrame(function () { cm.focus(); });
  }

  popupSend.onclick = submitAnnotation;
  popupInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') submitAnnotation();
    if (e.key === 'Escape') closePopup(true);
  });
  // Shortcut hint and Send button occupy the same slot and never show at
  // once: unfocused, there's nothing to send yet, so the hint tells you
  // how to jump in; focused, the hint has done its job and Send takes
  // over. `.focused` is a plain class rather than `:focus-within` because
  // `blur` needs its own check — moving focus to the Send button itself
  // (a click) must not count as leaving the input.
  popupInput.addEventListener('focus', function () { popup.classList.add('focused'); });
  popupInput.addEventListener('blur', function () {
    requestAnimationFrame(function () {
      if (document.activeElement !== popupSend) popup.classList.remove('focused');
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !popup.classList.contains('hidden')) closePopup(true);
  });
  // Cmd+Control+E (mac) / Ctrl+Alt+E (Windows & Linux) jumps straight into
  // the rewrite popup's input without a click — it only does something
  // while the popup is already open (selecting text opens it by default
  // now, see annotationsEnabled), so this is purely a "start typing faster"
  // shortcut, not a way to summon the popup out of nowhere.
  document.addEventListener('keydown', function (e) {
    if (!isRewriteFocusShortcut(e)) return;
    if (popup.classList.contains('hidden')) return;
    e.preventDefault();
    popupInput.focus();
    popupInput.select();
  });
  // Clicking anywhere outside the popup cancels the pending/open popup and
  // drops the fake selection highlight. The editor and toolbar are part of
  // this same top document so a single listener covers them; the preview
  // iframe is a separate browsing context and gets its own mousedown
  // listener in bindPreviewSelection().
  document.addEventListener('mousedown', function (e) {
    if (popup.contains(e.target)) return;
    cancelScheduledPopup();
    closePopup();
  });
  window.addEventListener('resize', closePopup);

  function lineLabel() {
    if (!selection.lines) return t('annotate.lineUnknown');
    var a = selection.lines.start, b = selection.lines.end;
    return a === b ? t('annotate.lineSingle', { a: a }) : t('annotate.lineRange', { a: a, b: b });
  }

  function lineLabelCompact() {
    if (!selection.lines) return t('annotate.lineCompactUnknown');
    return selection.lines.start + '-' + selection.lines.end;
  }

  async function submitAnnotation() {
    var comment = popupInput.value.trim();
    var isContinue = selection.mode === 'continue';
    var isLineAnnotation = selection.mode === 'annotate-line';
    // Continue mode (AppView) and blank-line annotation mode (AppPanel)
    // intentionally have no selected text — their line number is the target.
    if ((!selection.text && !isContinue && !isLineAnnotation) || !api) return;
    // The prompt tells the AI it can read/overwrite the file at `sourcePath`
    // directly — but if there are unsaved edits, disk still has the old
    // content: the AI would read stale context (or, if it applies a
    // full-document rewrite based on that stale read, would clobber the
    // very edits the user hasn't saved yet). Flush to disk first whenever
    // there's somewhere to save to, so the file the AI reads always matches
    // what's on screen. A brand new unsaved document (no sourcePath) has
    // nowhere to save to yet — the prompt already says so via
    // `annotate.pathMissing` — so there's nothing to flush in that case.
    if (dirty && sourcePath) {
      var saved = await saveNowAndWait();
      if (!saved) {
        setStatus(t('status.saveFailedNoReturn'), true);
        return;
      }
    }
    if (isAppView) {
      if (!sourcePath || !api.postMessage) { setStatus(t('status.noSourceFile'), true); return; }
      api.postMessage({
        type: 'requestRewrite', path: sourcePath, selectedText: selection.text,
        requirement: comment, startLine: selection.lines && selection.lines.start,
        endLine: selection.lines && selection.lines.end,
        rewriteMode: isContinue ? 'continue' : 'replace',
      });
      closePopup(true);
      setStatus(isContinue ? t('appview.continuing') : t('appview.rewriting'));
      return;
    }
    if (!api.composer || (!selection.text && !isLineAnnotation)) { closePopup(true); return; }
    try {
      await api.composer.addContexts([{
        type: 'annotation',
        label: (fileName || 'Markdown') + ':' + lineLabelCompact(),
        note: comment || undefined,
        promptText: t('annotate.promptText', {
          lineLabel: lineLabel(),
          requirement: comment ? t('annotate.requirementWith', { comment: comment }) : t('annotate.requirementDefault'),
          text: selection.text || t('annotate.emptyLine'),
          path: sourcePath || t('annotate.pathMissing'),
        }),
        reminder: t('annotate.reminder'),
      }]);
      closePopup(true);
      setStatus(t('annotate.added'));
    } catch (e) {
      setStatus(String(e), true);
    }
  }

  // ---- Editor selection ----

  // Shared by the drag-selection path (gated on the "改写" toggle) and the
  // AppView right-click path (an explicit action, so it works regardless of
  // that toggle).
  function offerEditorSelectionNow() {
    var picked = cm.getSelection();
    if (!picked) return false;
    var text = picked.text.trim();
    if (!text) return false;
    var lines = lineRangeForOffsets(cm.getValue(), picked.start, picked.end);
    scheduleOpenPopup(text, {
      startTop: picked.startRect.top,
      startLeft: picked.startRect.left,
      endBottom: picked.rect.bottom,
      endLeft: picked.rect.left,
    }, null, lines, 'editor');
    return true;
  }

  function offerEditorSelection() {
    if (!annotationsEnabled) return;
    offerEditorSelectionNow();
  }

  // ---- Blank-line AI prompt bar -----------------------------------------
  //
  // Both shells expose this visible Space affordance. AppView treats the
  // blank line as a continue-writing target; AppPanel instead turns it into
  // a Composer annotation context — no rewrite session is started there.
  function openAiPromptBar(info) {
    if (!hasDocument() || !info) return false;
    cancelScheduledPopup();
    // Span the editor's text column rather than the whole pane so the bar
    // lines up with the writing it will extend. `.cm-line` is the reading
    // column (50rem capped at 88%, centered), which is narrower than
    // `.cm-content` — measuring the content element would start the bar out
    // in the left margin, visibly off from the text it continues.
    var column = editor.querySelector('.cm-line') || editor.querySelector('.cm-content');
    var box = (column || editor).getBoundingClientRect();
    openPopup('', {
      startTop: info.rect.top,
      startLeft: box.left,
      width: Math.max(240, box.width),
      focus: true,
    }, null, { start: info.line, end: info.line }, 'editor', isAppView ? 'continue' : 'annotate-line');
    return true;
  }

  editor.addEventListener('mouseup', offerEditorSelection);
  editor.addEventListener('keyup', function (e) {
    if (e.shiftKey) offerEditorSelection();
  });

  // ---- Save to disk: prefer the File System Access handle (works even when the
  // host process can't expose an absolute path), fall back to the backend write
  // when we have a real sourcePath, otherwise tell the user how to connect one.
  // Saving is explicit (Save button / Cmd|Ctrl+S) rather than automatic, so the
  // user is always in control of what's actually on disk. ----

  var dirty = false;
  // Per-file delivery revision assigned by the host. It prevents a late
  // watcher/reconnect snapshot from overwriting a newer AI write already on
  // screen; reset when switching to a different source path.
  var documentRevision = 0;
  // Latest remote revision withheld because the user has newer local edits.
  // It remains on disk; this object lets the conflict chooser adopt it or
  // deliberately keep local work with the correct remote baseline.
  var pendingExternalDocument = null;
  var conflictDialogOpen = false;
  var savedFlash = false; // true for ~3s right after a successful save, drives the save-check icon

  // ---- Unsaved-draft recovery: mirror edits to a backend sidecar file so a
  // crash, an accidental "Open" over unsaved work, or just closing without
  // saving never actually loses anything — reopening the same path resumes
  // from here instead of the last save.
  //
  // This used to debounce the send itself (~1.2s after typing stopped) and
  // then try to force-flush on blur/pagehide/visibilitychange when the tab
  // looked like it might be closing. That was unreliable in practice: a
  // Cmd/Ctrl+W on an already-focused panel tears it down directly without
  // reliably running page-lifecycle JS first, so the "flush on the way out"
  // half of that plan couldn't be counted on — losing whatever was typed in
  // the last debounce window.
  //
  // So instead: every keystroke posts immediately, with no client-side
  // delay at all — by the time this call returns, the latest content has
  // already left the panel. The *disk write* is debounced on the backend
  // instead (see `scheduleDraftWrite` in index.ts), where the timer lives
  // in the long-running extension host rather than in this page, so it
  // keeps ticking (and still writes) even if the panel is destroyed a
  // moment later. The host also flushes immediately on panel disposal, so
  // real teardown never has to wait out any debounce either.
  var draftPathSaved = ''; // path the last-sent draft belongs to, so a document switch can't cross-write it
  var draftLastSent = null; // content of the most recent saveDraft actually posted, to skip redundant re-sends

  function postDraftSave(path) {
    draftPathSaved = path;
    draftLastSent = markdown;
    // `base` = the last disk-confirmed content, so the backend can record
    // a baseline and detect if the file changes elsewhere before we reopen.
    api.postMessage({ type: 'saveDraft', path: path, markdown: markdown, base: savedMarkdown });
  }

  function scheduleDraftSave() {
    if (!sourcePath || !api || !api.postMessage) return;
    if (draftPathSaved === sourcePath && draftLastSent === markdown) return; // nothing actually changed
    postDraftSave(sourcePath);
  }

  // No-op now that there's no client-side timer to cancel — kept as a named
  // call so the "we're done editing this document" call sites (save
  // success, reset to home, document switch) still read as intentional and
  // reset the dedupe state below them, without every call site needing to
  // know the send is already synchronous.
  function cancelDraftSave() {
    draftPathSaved = '';
    draftLastSent = null;
  }

  function discardDraftFor(path) {
    cancelDraftSave();
    if (path && api && api.postMessage) api.postMessage({ type: 'discardDraft', path: path });
  }

  function setDirty(next, justSaved) {
    dirty = next;
    if (savedFlashTimer) { clearTimeout(savedFlashTimer); savedFlashTimer = 0; }
    savedFlash = !dirty && !!justSaved;
    syncToolbar();
    if (!dirty && justSaved) {
      savedFlashTimer = setTimeout(function () {
        savedFlashTimer = 0;
        if (!dirty) { savedFlash = false; syncToolbar(); }
      }, 3000);
    }
  }

  async function writeToDisk(content) {
    // Never let an ordinary Save silently overwrite an AI version that was
    // withheld for local edits. Resolve the conflict first; the user can
    // save again after deliberately choosing to retain local content.
    if (pendingExternalDocument) {
      void resolvePendingExternalDocument();
      setStatus('请先处理 AI 写回与本地编辑的冲突。', true);
      return false;
    }
    if (fileHandle && fileHandle.createWritable) {
      try {
        var writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
        lastModified = (await fileHandle.getFile()).lastModified;
        savedMarkdown = content;
        setDirty(markdown !== content, markdown === content);
        setStatus(markdown === content ? t('status.saved') : t('status.savedWithNewChanges'));
        cancelDraftSave();
        return true;
      } catch (e) {
        setStatus(t('status.saveFailed', { err: String(e) }), true);
        return false;
      }
    }
    if (sourcePath) {
      var id = ++saveId;
      setStatus(t('status.saving'));
      pendingSaveContents[id] = content;
      api.postMessage({ type: 'saveMarkdown', path: sourcePath, markdown: content, requestId: id });
      // The actual result arrives later as a 'savedMarkdown' (or 'error')
      // message; resolve this promise then so awaiters (e.g. the unsaved-
      // changes confirm) see the real outcome instead of an optimistic true.
      return new Promise(function (resolve) { pendingSaveResolvers[id] = resolve; });
    }
    setStatus(t('status.noSourceFile'), true);
    return false;
  }

  document.addEventListener('keydown', function (e) {
    var mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      saveNow();
      return;
    }
    // Reserve Cmd+P / Ctrl+P for Markdown preview rather than browser print.
    if (mod && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
      setMode(mode === 'edit' ? 'preview' : 'edit');
    }
  });

  // ---- Open / watch source file ----

  function stopWatching() {
    if (watchTimer) { clearInterval(watchTimer); watchTimer = 0; }
    fileHandle = null;
  }

  // Line range touched by the most recent in-place external revision, so the
  // status line can say *what* moved instead of just "content updated".
  var lastExternalChange = null;

  function applyDocument(nextMarkdown, nextName, nextPath, force, diskBaseline) {
    // Deliberately does NOT check cm.hasFocus(): unsaved local edits must
    // never be silently clobbered by an external update, whether or not the
    // editor happens to have DOM focus at that instant (e.g. the panel was
    // blurred mid-edit). The user's own uncommitted work always wins here;
    // the (still-running) draft mirror already backs it up on disk either way.
    if (!force && dirty && savedMarkdown !== null && nextMarkdown !== savedMarkdown) {
      pendingExternalDocument = { markdown: nextMarkdown, name: nextName, path: nextPath, diskBaseline: diskBaseline };
      setStatus(t('status.externalUpdateSkipped'), true);
      void resolvePendingExternalDocument();
      return false;
    }
    // Is this a revision of the document already on screen (an AI apply, or
    // an external save), rather than a switch to a different file? Must be
    // decided before `sourcePath` is reassigned below.
    var revisesOpenDocument = savedMarkdown !== null && (!nextPath || !sourcePath || nextPath === sourcePath);
    // A document opened from Home always starts with the rewrite popup
    // available on selection — mirrors the true default above; only
    // resetToHome() (no document open) turns it off, and only an explicit
    // toolbar toggle should keep it off once a document is on screen.
    if (!revisesOpenDocument) annotationsEnabled = true;
    markdown = nextMarkdown;
    name = nextName;
    if (nextPath) sourcePath = nextPath;
    fileName = pathFileName(nextPath || sourcePath) || nextName || 'Markdown';
    // `savedMarkdown` must track the file's real *on-disk* content, not
    // necessarily what's being displayed — when a restored draft differs
    // from disk (`diskBaseline` provided and != nextMarkdown), keeping
    // `savedMarkdown` at the draft's own text would poison the next draft
    // mirror's baseline hash: it'd be recorded against a draft that was
    // never actually on disk, so a later reopen would see the *true* disk
    // content sitting unchanged at the real baseline and wrongly report
    // an external-edit conflict that never happened.
    savedMarkdown = typeof diskBaseline === 'string' ? diskBaseline : markdown;
    // Patching only the changed span keeps the scroll offset and the caret
    // where the user left them, and flashes the rewritten lines. A fresh
    // document still gets the plain full replacement.
    lastExternalChange = revisesOpenDocument ? cm.applyExternalValue(markdown) : null;
    if (!lastExternalChange) cm.setValue(markdown);
    setDirty(false); // also rebuilds+syncs the whole toolbar, picking up the new sourcePath/fileName below
    setPanelTitle(fileName);
    updateEmptyState();
    showPane();
    if (isAppView || mode === 'preview') render();
    return true;
  }

  async function resolvePendingExternalDocument() {
    if (conflictDialogOpen || !pendingExternalDocument || !dirty) return;
    var remote = pendingExternalDocument;
    var base = savedMarkdown;
    // The two one-sided cases are genuine automatic merges: no text exists
    // on the other side that could be lost. Concurrent edits need a choice.
    if (markdown === base) {
      pendingExternalDocument = null;
      applyDocument(remote.markdown, remote.name, remote.path, true, remote.diskBaseline);
      return;
    }
    if (remote.markdown === base) { pendingExternalDocument = null; return; }
    conflictDialogOpen = true;
    var choice = await askExternalConflict();
    conflictDialogOpen = false;
    // A newer watcher push may have replaced this pending revision while the
    // dialog was open; only resolve the snapshot the user was asked about.
    if (pendingExternalDocument !== remote) return;
    if (choice === 'later') {
      setStatus('AI 写回已保留在磁盘；可继续编辑后再处理。');
      return;
    }
    pendingExternalDocument = null;
    if (choice === 'remote') {
      // The local draft is already mirrored, but accepting AI means it must
      // not silently resurrect on the next reopen.
      discardDraftFor(sourcePath);
      applyDocument(remote.markdown, remote.name, remote.path, true, remote.diskBaseline);
      return;
    }
    if (choice === 'local') {
      // Keep editing local text, but advance its disk baseline to the AI
      // version. A future explicit Save is then an intentional overwrite,
      // not a stale draft that pretends the old base is still current.
      savedMarkdown = typeof remote.diskBaseline === 'string' ? remote.diskBaseline : remote.markdown;
      scheduleDraftSave();
      setStatus('已保留本地编辑；AI 写回版本仍在磁盘上。');
    }
  }

  async function loadFile(f) {
    name = f.name;
    lastModified = f.lastModified;
    if (typeof f.path === 'string' && f.path) {
      sourcePath = f.path;
      if (api) api.postMessage({ type: 'watchPath', path: sourcePath });
    } else {
      sourcePath = '';
    }
    // Land in the editor, not the rendered preview — opening a file is about
    // reading/editing it, the user switches to preview explicitly when ready.
    applyDocument(await f.text(), name, sourcePath, true);
  }

  function watchFile() {
    if (!fileHandle) return;
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = setInterval(async function () {
      if (watchBusy || !fileHandle) return;
      watchBusy = true;
      try {
        var next = await fileHandle.getFile();
        if (next.lastModified !== lastModified) {
          lastModified = next.lastModified;
          var text = await next.text();
          if (text !== savedMarkdown && applyDocument(text, name, sourcePath)) {
            setStatus(t('status.externalUpdateApplied'));
          }
        }
      } catch (e) { /* ignore */ }
      watchBusy = false;
    }, 800);
  }

  var nativePickPending = false;
  var nativePickTimer = 0;

  function clearNativePickTimer() {
    if (nativePickTimer) { clearTimeout(nativePickTimer); nativePickTimer = 0; }
  }

  // The Open button is disabled for as long as `nativePickPending` is true
  // (see buildToolbar), so the user cannot click their way out of a hung
  // native request the way they normally could — the click itself is what's
  // blocked. If the backend's reply is ever lost (observed after repeatedly
  // switching Sessions while this panel is open, which can make a postMessage
  // back to this panel fail silently mid-transition), the button would
  // otherwise stay disabled forever with no way to recover. This timer is a
  // pure safety net: it does not touch any real native dialog (the backend
  // itself deliberately has no timeout on ctx.ui.pickFile(), see 'requestOpen'
  // in index.ts) — it only un-sticks *this panel's own UI state* so the next
  // click can try again.
  function armNativePickTimer() {
    clearNativePickTimer();
    nativePickTimer = setTimeout(function () {
      nativePickTimer = 0;
      if (!nativePickPending) return;
      nativePickPending = false;
      pickFileSupported = false; // stop trusting a bridge that just went silent this session
      syncToolbar();
      setStatus(t('status.pickerTimeout'), true);
    }, 20000);
  }

  // Picking a *different* file to open would otherwise silently replace
  // whatever's currently in the buffer — this is the same "unsaved work"
  // hazard as the Home button, just reached from a different toolbar item,
  // so it gets the same confirm-first treatment.
  async function openFile() {
    if (dirty) {
      var choice = await askUnsavedConfirm(t('confirm.message', { file: fileName || t('common.markdownDocDefault') }));
      if (choice === 'cancel') return;
      if (choice === 'save') {
        var saved = await saveNowAndWait();
        if (!saved) { setStatus(t('status.saveFailedNoReturn'), true); return; }
      } else if (choice === 'discard') {
        discardDraftFor(sourcePath);
      }
    }
    stopWatching();
    if (pickFileSupported && api && api.postMessage) {
      if (nativePickPending) {
        // A previous native request is still hanging (host round-trip stuck).
        // Don't stack another one silently — this click is a fresh, real user
        // gesture, so use it to open the reliable in-page/browser picker
        // immediately instead of leaving the button looking unresponsive.
        clearNativePickTimer();
        pickFileSupported = false;
        nativePickPending = false;
        syncToolbar();
        await openFileBrowserFallback();
        return;
      }
      // Native Finch file picker: browses the current Space/workspace directory
      // tree with real absolute paths, no Electron `File.path` shim needed.
      nativePickPending = true;
      armNativePickTimer();
      syncToolbar();
      setStatus(t('status.openingPicker'));
      api.postMessage({ type: 'requestOpen' });
      return;
    }
    await openFileBrowserFallback();
  }

  async function openFileBrowserFallback() {
    if ('showOpenFilePicker' in window) {
      try {
        var handles = await window.showOpenFilePicker({
          types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown'] } }],
          multiple: false,
        });
        fileHandle = handles[0];
        await loadFile(await fileHandle.getFile());
        watchFile();
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,.markdown,text/markdown';
    input.onchange = function () {
      var f = input.files && input.files[0];
      if (f) loadFile(f).catch(function (e) { setStatus(String(e), true); });
    };
    input.click();
  }

  // ---- Copy HTML / manual save ----

  // Toolbar buttons are host-chrome UI: the click reaches this panel only
  // through a postMessage round-trip, and by the time it does the panel's own
  // document has often lost focus. The async Clipboard API refuses to write
  // ("Document is not focused") in that state. Reclaim focus first, and if the
  // async API still won't cooperate, fall back to the older selection-based
  // execCommand('copy').
  //
  // Both paths deliberately stay in the TOP document, never the preview
  // <iframe>: the iframe is `sandbox="allow-same-origin"` with no
  // `allow-scripts`, and some hosts silently refuse focus()/execCommand
  // targeted at a sandboxed same-origin document even when called from the
  // (unsandboxed) parent — which was the actual cause of "复制到公众号"
  // failing intermittently. Copying an equivalent holder element in the top
  // document sidesteps that entirely.
  function focusCopySurface() {
    window.focus();
    document.body.tabIndex = -1;
    try { document.body.focus({ preventScroll: true }); } catch (e) { document.body.focus(); }
  }

  // Poll for document focus for a short while instead of a single
  // best-effort attempt: the 'finch:menu' click reaches us via a postMessage
  // round-trip from the host toolbar, and on some platforms the webview
  // hasn't actually regained input focus yet by the time that message
  // arrives — a single focus() + two rAFs isn't always enough. Re-attempt a
  // few times with short waits; this costs at most ~250ms and is invisible
  // to the user, but meaningfully reduces spurious "剪贴板不可用" failures.
  async function waitForCopyFocus(maxAttempts) {
    for (var i = 0; i < maxAttempts; i++) {
      focusCopySurface();
      await new Promise(function (resolve) {
        requestAnimationFrame(function () { requestAnimationFrame(resolve); });
      });
      if (document.hasFocus()) return true;
      await new Promise(function (resolve) { setTimeout(resolve, 40); });
    }
    return document.hasFocus();
  }

  // Ask the host to turn only its own finch-file image assets into data:
  // URLs. The saved Markdown and preview HTML retain finch-file URLs; this
  // expanded representation exists solely in the outbound clipboard payload,
  // where WeChat has no way to resolve Finch's private local protocol.
  function prepareClipboardHtml(sourceHtml) {
    var urls = Array.from(new Set(sourceHtml.match(/finch-file:\/\/local\?path=[^\s)"']+/g) || []));
    if (!urls.length || !api || !api.postMessage) return Promise.resolve(sourceHtml);
    return new Promise(function (resolve, reject) {
      var id = ++clipboardImageId;
      pendingClipboardImages[id] = { resolve: resolve, reject: reject, sourceHtml: sourceHtml };
      setTimeout(function () {
        if (pendingClipboardImages[id]) { delete pendingClipboardImages[id]; reject(new Error(t('status.clipboardPrepareTimeout'))); }
      }, 15000);
      api.postMessage({ type: 'readClipboardImages', urls: urls, requestId: id });
    });
  }

  // bmmd can leave an empty <p> directly before/after an image <figure>.
  // The WeChat editor normalizes it to
  // `<p><span leaf><br class="ProseMirror-trailingBreak"></span></p>`, which
  // becomes a visible blank line above/below the pasted image. Remove ONLY
  // those adjacent empty paragraphs from the clipboard copy. Do not touch
  // the figure's own margins or its figcaption — both are intentional article
  // formatting, including the automatic "Pasted image" caption.
  function compactClipboardImageLayout(clipboardHtml) {
    var doc = new DOMParser().parseFromString(clipboardHtml, 'text/html');
    function isEmptyParagraph(node) {
      return node && node.tagName === 'P' && !node.textContent.trim() && !node.querySelector('img,video,iframe,table');
    }
    Array.from(doc.querySelectorAll('figure.figure-image')).forEach(function (figure) {
      var before = figure.previousElementSibling;
      var after = figure.nextElementSibling;
      if (isEmptyParagraph(before)) before.remove();
      if (isEmptyParagraph(after)) after.remove();
    });
    return doc.body.innerHTML;
  }

  async function copyRichText(htmlValue, plainStr) {
    // Fast path for the in-page action bar: the click already happened in
    // this document, so focus is real and the write can go straight out.
    // Burning ~250ms in the focus poll below would only risk the transient
    // user-activation window for no benefit.
    if (!document.hasFocus()) await waitForCopyFocus(5);
    // `text/html` deliberately receives a Promise<Blob>: clipboard.write()
    // itself starts immediately while the in-page click's user activation is
    // fresh, while its promise concurrently waits for the host to read and
    // embed local image assets. Awaiting that host round-trip *before* write
    // would make Chromium reject the clipboard request as no longer gestural.
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      try {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': Promise.resolve(htmlValue).then(function (value) { return new Blob([value], { type: 'text/html' }); }),
          'text/plain': new Blob([plainStr], { type: 'text/plain' }),
        })]);
        return 'rich';
      } catch (e) { /* fall through to the legacy path below */ }
    }
    var htmlStr = await Promise.resolve(htmlValue);
    if (copyRichTextLegacy(htmlStr)) return 'rich';
    // Both rich-text paths failed (most likely: the webview never actually
    // regained real input focus, which both APIs require). Rather than
    // surfacing a hard failure, degrade to a plain-text copy so the user
    // still gets *something* usable on the clipboard.
    if (copyPlainTextLegacy(plainStr)) return 'plain';
    return 'none';
  }

  function copyRichTextLegacy(htmlStr) {
    var holder = document.createElement('div');
    holder.contentEditable = 'true';
    holder.style.position = 'fixed';
    holder.style.left = '-9999px';
    holder.style.top = '0';
    holder.innerHTML = htmlStr;
    document.body.appendChild(holder);
    var range = document.createRange();
    range.selectNodeContents(holder);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    sel.removeAllRanges();
    holder.remove();
    return ok;
  }

  function copyPlainTextLegacy(plainStr) {
    var ta = document.createElement('textarea');
    ta.value = plainStr;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  // A previous attempt here walked the live iframe DOM and rewrote every
  // element's font-family/color/background-color from computed values,
  // plus converted top-level children's vertical margins into padding to
  // avoid perceived "gaps" — all based on a theory that WeChat's paste
  // cleaner drops the #bm-md root's own style attribute. Actual DevTools
  // inspection of the pasted result proved that theory wrong: the pasted
  // <section id="bm-md" style="...background-color...padding...font-
  // family..."> keeps its full inline style completely intact. The
  // flattening pass was therefore not just unnecessary but actively
  // harmful — e.g. it force-added the container's vertical margin as
  // *padding* onto every direct child including <hr>, which already had
  // its own explicit background-color; padding on an <hr> paints INSIDE
  // that background, so a 1px divider line turned into a tall solid
  // block, which read as "the divider disappeared". Match bm.md's own
  // "复制到公众号" behavior exactly for all ordinary content. The only
  // intentional exception is local pasted images: Finch's private
  // `finch-file:` protocol cannot exist outside Finch, so their `src` is
  // converted into a data URL in the clipboard-only copy (see
  // prepareClipboardHtml); preview/source remain untouched.
  async function copyHtml() {
    if (!html) { setStatus(t('status.pleaseOpenArticle'), true); return; }
    try {
      var plain = frame.contentDocument && frame.contentDocument.body
        ? frame.contentDocument.body.innerText
        : html.replace(/<[^>]+>/g, '');
      var result = await copyRichText(prepareClipboardHtml(html), plain);
      if (result === 'none') {
        // One more attempt after a longer settle: covers the case where
        // the webview genuinely hadn't regained input focus yet on the
        // first try (e.g. right after switching sessions/tabs).
        await new Promise(function (resolve) { setTimeout(resolve, 200); });
        result = await copyRichText(prepareClipboardHtml(html), plain);
      }
      if (result === 'rich') setStatus(t('status.copiedRich'));
      else if (result === 'plain') setStatus(t('status.copiedPlainOnly'), true);
      else setStatus(t('status.copyFailed'), true);
    } catch (e) {
      setStatus(t('status.richCopyFailed', { err: String(e) }), true);
    } finally {
      if (mode === 'edit') requestAnimationFrame(function () { cm.focus(); });
    }
  }

  // ---- Export (copy/download image, download PDF) ----
  //
  // There's no headless-render or html2canvas-style library bundled here, so
  // this hand-rolls the same trick browsers themselves use for that purpose:
  // serialize the *live rendered* #bm-md node (already fully styled — same
  // DOM `copyHtml()` no longer needs to touch) into an SVG <foreignObject>,
  // rasterize that through an <img>, then draw it onto a <canvas>. Because
  // the source is the live iframe DOM rather than the static `html` string,
  // this captures it pixel-for-pixel identical to what's on screen —
  // genuinely "所见即所得" — with no separate style-flattening pass to get
  // subtly wrong.
  function articleSize() {
    if (!frameReady || !frame.contentDocument) return null;
    var root = frame.contentDocument.querySelector('#bm-md');
    if (!root) return null;
    var rect = root.getBoundingClientRect();
    return {
      root: root,
      width: Math.ceil(rect.width || root.scrollWidth),
      height: Math.ceil(rect.height || root.scrollHeight),
    };
  }

  function renderArticleCanvas() {
    var info = articleSize();
    if (!info || !info.width || !info.height) return Promise.resolve(null);
    var scale = 2; // fixed 2x for crisp copy/export regardless of display DPR

    // An <img> pointed at an SVG data URL parses that SVG as XML, so the
    // markup inside <foreignObject> has to be well-formed XHTML. The HTML
    // serializer behind `.outerHTML` happily emits void elements as `<br>`
    // or `<img …>` with no self-closing slash, which is valid HTML but
    // fatal XML — the parse aborts and the <img> fires `error`, which is
    // exactly why copying/downloading the image silently failed. Serialize
    // through XMLSerializer instead so every tag is properly closed.
    var clone = info.root.cloneNode(true);
    // The live node gets `min-height:100dvh` from the preview stylesheet,
    // which does not travel with the clone (no stylesheet inside the SVG)
    // — restore the measured height inline so the exported image keeps the
    // same full-bleed background the preview shows.
    clone.style.minHeight = info.height + 'px';
    clone.style.margin = '0';
    clone.style.boxSizing = 'border-box';
    var serialized;
    try {
      serialized = new XMLSerializer().serializeToString(clone);
    } catch (e) {
      return Promise.reject(new Error(t('status.serializeFailed', { err: String(e) })));
    }
    var svgMarkup = '<svg xmlns="http://www.w3.org/2000/svg" width="' + info.width + '" height="' + info.height + '">' +
      '<foreignObject x="0" y="0" width="' + info.width + '" height="' + info.height + '">' +
      serialized +
      '</foreignObject></svg>';
    var svgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgMarkup);
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.decoding = 'sync';
      img.onload = function () {
        try {
          var canvas = document.createElement('canvas');
          canvas.width = Math.round(info.width * scale);
          canvas.height = Math.round(info.height * scale);
          var ctx2d = canvas.getContext('2d');
          ctx2d.scale(scale, scale);
          // foreignObject content is transparent where the article doesn't
          // paint; fill with the article's own background first so JPEG
          // (which has no alpha) never turns those pixels black.
          var bg = '';
          try { bg = frame.contentWindow.getComputedStyle(info.root).backgroundColor; } catch (e2) { bg = ''; }
          if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
            ctx2d.fillStyle = bg;
            ctx2d.fillRect(0, 0, info.width, info.height);
          }
          ctx2d.drawImage(img, 0, 0, info.width, info.height);
          resolve({ canvas: canvas, cssWidth: info.width, cssHeight: info.height });
        } catch (e) { reject(e); }
      };
      img.onerror = function () {
        reject(new Error(t('status.imageConversionFailed')));
      };
      img.src = svgUrl;
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob); else reject(new Error(t('status.imageGenFailed')));
      }, type, quality);
    });
  }

  function bytesToBase64(bytes) {
    var binary = '';
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  async function copyImage() {
    if (!html) { setStatus(t('status.pleaseOpenArticle'), true); return; }
    if (!window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) {
      setStatus(t('status.clipboardUnsupported'), true);
      return;
    }
    setStatus(t('status.generatingImage'));
    // Hand ClipboardItem a *pending promise* rather than a finished Blob, so
    // clipboard.write() is invoked immediately while the click's transient
    // user activation is still fresh; the rasterization then resolves into
    // it. Awaiting the blob first would spend that activation on rendering
    // and can get the write rejected on slower/longer articles.
    var blobPromise = renderArticleCanvas().then(function (made) {
      if (!made) throw new Error(t('status.previewNotReady'));
      return canvasToBlob(made.canvas, 'image/png');
    });
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
      setStatus(t('status.imageCopied'));
      return;
    } catch (e) {
      // Some builds reject a promise-valued ClipboardItem — retry once with
      // the resolved Blob before giving up.
      try {
        var blob = await blobPromise;
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        setStatus(t('status.imageCopied'));
        return;
      } catch (e2) {
        setStatus(t('status.copyImageFailed', { err: e2 && e2.message ? e2.message : String(e2) }), true);
      }
    }
  }

  async function exportImage() {
    if (!html) { setStatus(t('status.pleaseOpenArticle'), true); return; }
    try {
      setStatus(t('status.generatingImage'));
      var made = await renderArticleCanvas();
      if (!made) { setStatus(t('status.exportImageFailedGeneric'), true); return; }
      var blob = await canvasToBlob(made.canvas, 'image/png');
      var buf = await blob.arrayBuffer();
      var base64 = bytesToBase64(new Uint8Array(buf));
      if (api && api.postMessage) {
        api.postMessage({ type: 'exportFile', data: base64, ext: 'png', path: sourcePath, fileName: fileName, markdown: markdown });
      }
    } catch (e) {
      setStatus(t('status.exportImageFailed', { err: String(e) }), true);
    }
  }

  // Minimal single-page, single-image PDF, hand-built without any PDF
  // library: a JPEG can be embedded byte-for-byte as a /DCTDecode image
  // XObject stream, so no re-encoding is needed beyond what canvas.toBlob
  // already produced. Page size is the article's CSS pixel size converted
  // to points (1px = 0.75pt @ 96dpi); the image itself keeps its full
  // (2x-scaled) pixel resolution for sharpness.
  function pad10(n) {
    var s = String(n);
    while (s.length < 10) s = '0' + s;
    return s;
  }

  function strToBytes(str) {
    var bytes = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
    return bytes;
  }

  function concatBytes(parts) {
    var total = 0;
    for (var i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Uint8Array(total);
    var offset = 0;
    for (var i = 0; i < parts.length; i++) { out.set(parts[i], offset); offset += parts[i].length; }
    return out;
  }

  function buildSingleImagePdf(jpegBytes, imgW, imgH, pageW, pageH) {
    var header = strToBytes('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    var parts = [header];
    var offsets = [0];
    var pos = header.length;
    function addObj(bytesArr) {
      offsets.push(pos);
      parts.push(bytesArr);
      pos += bytesArr.length;
    }
    addObj(strToBytes('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'));
    addObj(strToBytes('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'));
    addObj(strToBytes('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pageW.toFixed(2) + ' ' + pageH.toFixed(2) + '] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n'));
    var imgHeader = strToBytes('4 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + imgW + ' /Height ' + imgH + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpegBytes.length + ' >>\nstream\n');
    var imgFooter = strToBytes('\nendstream\nendobj\n');
    addObj(concatBytes([imgHeader, jpegBytes, imgFooter]));
    var contentStream = 'q ' + pageW.toFixed(2) + ' 0 0 ' + pageH.toFixed(2) + ' 0 0 cm /Im0 Do Q';
    var csBytes = strToBytes(contentStream);
    addObj(concatBytes([strToBytes('5 0 obj\n<< /Length ' + csBytes.length + ' >>\nstream\n'), csBytes, strToBytes('\nendstream\nendobj\n')]));
    var xrefStart = pos;
    var xrefLines = ['xref\n0 6\n0000000000 65535 f \n'];
    for (var i = 1; i <= 5; i++) xrefLines.push(pad10(offsets[i]) + ' 00000 n \n');
    var trailer = 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xrefStart + '\n%%EOF';
    parts.push(strToBytes(xrefLines.join('') + trailer));
    return concatBytes(parts);
  }

  async function exportPdf() {
    if (!html) { setStatus(t('status.pleaseOpenArticle'), true); return; }
    try {
      setStatus(t('status.generatingPdf'));
      var made = await renderArticleCanvas();
      if (!made) { setStatus(t('status.exportPdfFailedGeneric'), true); return; }
      var blob = await canvasToBlob(made.canvas, 'image/jpeg', 0.92);
      var buf = await blob.arrayBuffer();
      var jpegBytes = new Uint8Array(buf);
      var pageW = made.cssWidth * 0.75;
      var pageH = made.cssHeight * 0.75;
      var pdfBytes = buildSingleImagePdf(jpegBytes, made.canvas.width, made.canvas.height, pageW, pageH);
      var base64 = bytesToBase64(pdfBytes);
      if (api && api.postMessage) {
        api.postMessage({ type: 'exportFile', data: base64, ext: 'pdf', path: sourcePath, fileName: fileName, markdown: markdown });
      }
    } catch (e) {
      setStatus(t('status.exportPdfFailed', { err: String(e) }), true);
    }
  }

  // Bound directly to real clicks in this document — the whole point of
  // moving these out of the host toolbar. `preventDefault` keeps the button
  // from stealing the selection/focus the clipboard path relies on.
  function bindAction(el, fn) {
    if (!el) return;
    el.addEventListener('click', function (ev) {
      ev.preventDefault();
      if (el.disabled) return;
      el.disabled = true;
      Promise.resolve()
        .then(fn)
        .catch(function (e) { setStatus(String(e), true); })
        .then(function () { el.disabled = false; });
    });
  }

  bindAction(actCopyWx, copyHtml);
  bindAction(actCopyImg, copyImage);
  bindAction(actSaveImg, exportImage);
  bindAction(actSavePdf, exportPdf);
  bindAction(actAiStyle, askAiStyle);

  // Collapse state persists across reopens (per browser profile, not per
  // document) via localStorage — a purely cosmetic preference, so falling
  // back to "expanded" on any storage error is fine.
  var ACTIONS_COLLAPSE_KEY = 'md-editor-actions-collapsed';
  (function initActionsCollapse() {
    var collapsed = false;
    try { collapsed = localStorage.getItem(ACTIONS_COLLAPSE_KEY) === '1'; } catch (e) { /* ignore */ }
    if (actions) actions.classList.toggle('collapsed', collapsed);
  })();
  if (actToggle) {
    actToggle.addEventListener('click', function (ev) {
      ev.preventDefault();
      var collapsed = actions.classList.toggle('collapsed');
      try { localStorage.setItem(ACTIONS_COLLAPSE_KEY, collapsed ? '1' : '0'); } catch (e) { /* ignore */ }
    });
  }

  function saveNow() {
    writeToDisk(markdown);
  }

  function setStyleSessionLoading(active) {
    styleSessionActive = active;
    if (!actAiStyle) return;
    actAiStyle.classList.toggle('loading', active);
    actAiStyle.disabled = active;
    var icon = actAiStyle.querySelector('.ic-ai-style');
    var spinner = actAiStyle.querySelector('.ic-ai-style-loading');
    if (icon) icon.hidden = active;
    if (spinner) spinner.hidden = !active;
  }

  // AppView has no chat Composer to hand this off to (see finch:env's `view`
  // doc), so api.composer is never set there — route it through a small
  // dedicated Agent Session instead, same pattern as continue/rewrite.
  function askAiStyleAppView() {
    if (!markdown || !sourcePath || !api || !api.postMessage) { setStatus(t('status.pleaseOpenArticle'), true); return; }
    api.postMessage({ type: 'requestStyleSession', path: sourcePath, baseStyle: style });
    setStyleSessionLoading(true);
    setStatus(t('aiStyle.appViewDesigning'));
  }

  async function askAiStyle() {
    if (!markdown) { setStatus(t('status.pleaseOpenArticle'), true); return; }
    // The Bridge always exposes an `api.composer` object, even in App View —
    // it just throws "This Bridge API is not available in an App View" the
    // moment addContexts() is actually called there. So the presence check
    // alone doesn't catch it; check isAppView up front, and still fall back
    // to the Session-based flow below if the call throws for any reason.
    if (isAppView || !api || !api.composer) { askAiStyleAppView(); return; }
    var baseNote = style === 'custom' ? t('aiStyle.baseNoteCustom') : t('aiStyle.baseNoteOther', { style: style });
    try {
      await api.composer.addContexts([{
        type: 'annotation',
        label: t('aiStyle.label', { file: fileName || t('common.markdownDocDefault') }),
        note: t('aiStyle.note'),
        promptText: t('aiStyle.promptText', {
          baseNote: baseNote,
          path: sourcePath || t('aiStyle.pathMissing'),
        }),
        reminder: t('aiStyle.reminder'),
      }]);
      setStatus(t('aiStyle.requested'));
    } catch (e) {
      askAiStyleAppView();
    }
  }

  // ---- Toolbar (finch:menu) ----

  function writingPreferencesPayload() {
    return {
      fontSize: editorFontSize,
      fontFamily: editorFont,
      comfortWriting: comfortWriting,
      style: style,
      customCss: style === 'custom' ? customCss : '',
      customStyleLabel: style === 'custom' ? customStyleLabel : '',
    };
  }

  // The extension host owns the durable copy so these choices survive a
  // WebView replacement, not just this page's localStorage lifetime.
  function persistWritingPreferences() {
    if (api && api.postMessage) api.postMessage({ type: 'saveWritingPreferences', preferences: writingPreferencesPayload() });
  }

  function applyWritingPreferences(preferences) {
    if (!preferences || typeof preferences !== 'object') return false;
    if (preferences.fontSize === 14 || preferences.fontSize === 16 || preferences.fontSize === 18) editorFontSize = preferences.fontSize;
    if (EDITOR_FONTS[preferences.fontFamily]) editorFont = preferences.fontFamily;
    comfortWriting = preferences.comfortWriting === true;
    if (preferences.style === 'custom' && typeof preferences.customCss === 'string' && preferences.customCss) {
      style = 'custom';
      customCss = preferences.customCss;
      customStyleLabel = typeof preferences.customStyleLabel === 'string' ? preferences.customStyleLabel : '';
    } else if (['kami', 'bauhaus', 'blueprint', 'botanical', 'newsprint', 'retro', 'sketch', 'terminal'].indexOf(preferences.style) !== -1) {
      style = preferences.style;
      customCss = '';
      customStyleLabel = '';
    }
    cm.setFontSize(editorFontSize);
    cm.setFontFamily(EDITOR_FONTS[editorFont]);
    cm.setComfortWriting(comfortWriting);
    return true;
  }

  function setStyle(next) {
    style = next;
    persistWritingPreferences();
    if (isAppView || mode === 'preview') render();
    syncToolbar();
  }

  function setEditorFontSize(size) {
    if (size !== 14 && size !== 16 && size !== 18) return;
    editorFontSize = size;
    cm.setFontSize(size);
    try { localStorage.setItem('md-editor-font-size', String(size)); } catch (e) {}
    persistWritingPreferences();
    syncToolbar();
  }

  function setEditorFont(font) {
    if (!EDITOR_FONTS[font]) return;
    editorFont = font;
    cm.setFontFamily(EDITOR_FONTS[font]);
    try { localStorage.setItem('md-editor-font-family', font); } catch (e) {}
    persistWritingPreferences();
    syncToolbar();
  }

  function setComfortWriting(on) {
    comfortWriting = !!on;
    cm.setComfortWriting(comfortWriting);
    try { localStorage.setItem('md-editor-comfort-writing', comfortWriting ? '1' : '0'); } catch (e) {}
    persistWritingPreferences();
    syncToolbar();
    setStatus(comfortWriting ? t('status.comfortWrite') : t('status.comfortRead'));
  }

  function toggleFocusMode() {
    focusMode = !focusMode;
    // Selection-triggered rewrite has no on/off toggle anymore (it's
    // always on), but it still needs the whole doc readable to pick
    // passages, while focus deliberately dims everything else — so
    // turning focus on still forces the popup closed and annotate off.
    if (focusMode && annotationsEnabled) {
      annotationsEnabled = false;
      closePopup();
    } else if (!focusMode && !annotationsEnabled) {
      // Leaving focus mode restores the (now toggle-less, always-on)
      // selection popup — there's no button left to turn it back on.
      annotationsEnabled = true;
    }
    cm.setFocusMode(focusMode);
    try { localStorage.setItem('md-editor-focus-mode', focusMode ? '1' : '0'); } catch (e) {}
    syncToolbar();
    setStatus(focusMode ? t('status.focusOn') : t('status.focusOff'));
  }

  // Simple 3-way confirm ("保存并返回" / "不保存" / "取消") resolved as
  // 'save' | 'discard' | 'cancel'. Backdrop click and Escape both count as
  // cancel — staying put is the safe default when in doubt.
  var confirmResolve = null;
  function closeConfirm(result) {
    confirmOverlay.hidden = true;
    var resolve = confirmResolve;
    confirmResolve = null;
    if (resolve) resolve(result);
  }
  function askUnsavedConfirm(message) {
    return new Promise(function (resolve) {
      confirmResolve = resolve;
      confirmMessage.textContent = message;
      confirmOverlay.hidden = false;
      confirmSave.focus();
    });
  }
  async function askExternalConflict() {
    // Reuse the in-page confirmation card, but make each result explicit:
    // escape/cancel preserves the safest state (local text remains untouched).
    confirmMessage.textContent = 'AI 已写回文件，但你也有未保存编辑。请选择保留本地内容或采用 AI 版本。';
    confirmCancel.textContent = '稍后处理';
    confirmDiscard.textContent = '保留本地';
    confirmSave.textContent = '采用 AI 版本';
    var choice = await new Promise(function (resolve) {
      confirmResolve = resolve;
      confirmOverlay.hidden = false;
      confirmSave.focus();
    });
    applyStaticI18n(confirmOverlay);
    return choice === 'save' ? 'remote' : choice === 'discard' ? 'local' : 'later';
  }
  if (confirmCancel) confirmCancel.addEventListener('click', function () { closeConfirm('cancel'); });
  if (confirmDiscard) confirmDiscard.addEventListener('click', function () { closeConfirm('discard'); });
  if (confirmSave) confirmSave.addEventListener('click', function () { closeConfirm('save'); });
  if (confirmOverlay) confirmOverlay.addEventListener('click', function (e) { if (e.target === confirmOverlay) closeConfirm('cancel'); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && confirmResolve) closeConfirm('cancel');
  });

  // Waits for a save round-trip to finish (unlike the fire-and-forget
  // saveNow()/Cmd+S path) so callers can safely navigate away afterward.
  async function saveNowAndWait() {
    return await writeToDisk(markdown);
  }

  // Actually resets the in-page document state (not the file on disk) and
  // tells the backend to stop watching it, then shows the launch page again.
  function resetToHome() {
    stopWatching();
    cancelDraftSave();
    closePopup();
    markdown = '';
    name = '';
    fileName = '';
    sourcePath = '';
    savedMarkdown = null;
    html = '';
    annotationsEnabled = false;
    mode = 'edit';
    if (cm) cm.setValue('');
    setPanelTitle(t('home.title'));
    showHtml('');
    if (api && api.postMessage) api.postMessage({ type: 'goHome' });
    updateEmptyState();
    showPane();
    // Home has no document at all, so it can never be "dirty" — without
    // this, a discard-then-return-home leaves the stale `dirty=true` from
    // the just-abandoned document behind, which both keeps the Home Save
    // icon lit and makes the *next* goHome()/openFile() wrongly re-prompt
    // "unsaved changes?" for a document that no longer exists. setDirty()
    // already calls syncToolbar() internally.
    setDirty(false);
    setStatus('');
  }

  // Manual "back to home" navigation. If there are unsaved edits, ask first —
  // deliberately a plain in-page overlay (see .confirm-overlay CSS comment)
  // rather than window.finch.ui.confirm(), since the "home" toolbar button is
  // the only way to trigger this and it arrives here without a real user
  // gesture the Bridge dialog could rely on.
  async function goHome() {
    if (dirty) {
      var choice = await askUnsavedConfirm(t('confirm.message', { file: fileName || t('common.markdownDocDefault') }));
      if (choice === 'cancel') return;
      // The user has committed to leaving (save-then-leave or discard-then-
      // leave) — tell the backend to stop watching *before* the save write
      // below, not after. Otherwise our own writeFile() triggers its own
      // fs.watch tick, which can race resetToHome() and push the just-saved
      // document straight back onto a panel that already reset to Home.
      if (api && api.postMessage) api.postMessage({ type: 'goHome' });
      if (choice === 'save') {
        var saved = await saveNowAndWait();
        if (!saved) { setStatus(t('status.saveFailedNoReturn'), true); return; }
      } else if (choice === 'discard') {
        // The user explicitly threw these edits away — don't let the draft
        // ghost-reappear next time this file is opened.
        discardDraftFor(sourcePath);
      }
    }
    resetToHome();
  }

  function handleMenu(itemId) {
    if (api && api.postMessage) api.postMessage({ type: 'clientLog', message: 'finch:menu received, itemId=' + itemId });
    if (itemId === 'home') { goHome(); return; }
    if (itemId === 'open') { openFile(); return; }
    if (itemId === 'mode') { setMode(mode === 'edit' ? 'preview' : 'edit'); return; }
    if (itemId === 'save') { saveNow(); return; }
    if (itemId === 'reload') { render(); return; }
    if (itemId === 'reveal') { if (sourcePath && api && api.postMessage) api.postMessage({ type: 'openPath', path: sourcePath }); return; }
    if (itemId && itemId.indexOf('font-size:') === 0) { setEditorFontSize(Number(itemId.slice('font-size:'.length))); return; }
    if (itemId && itemId.indexOf('font-family:') === 0) { setEditorFont(itemId.slice('font-family:'.length)); return; }
    if (itemId === 'comfort:read') { setComfortWriting(false); return; }
    if (itemId === 'comfort:write') { setComfortWriting(true); return; }
    if (itemId === 'focus') { toggleFocusMode(); return; }
    if (itemId === 'about') { showRendererAbout(); return; }
    // These two must be checked before the generic 'style:' fallback below,
    // since both also start with the literal prefix "style:".
    if (itemId && itemId.indexOf('style:slot-use:') === 0) { applyStyleSlot(+itemId.slice('style:slot-use:'.length)); return; }
    if (itemId && itemId.indexOf('style:slot-save:') === 0) { saveStyleSlot(+itemId.slice('style:slot-save:'.length)); return; }
    if (itemId && itemId.indexOf('style:') === 0) { setStyle(itemId.slice(6)); return; }
  }

  function closeAppMenus() {
    [appStyleMenu, appFontMenu, appMoreMenu].forEach(function (menu) { if (menu) menu.hidden = true; });
  }
  function toggleAppMenu(menu) {
    if (!menu) return;
    var open = menu.hidden;
    closeAppMenus();
    menu.hidden = !open;
  }
  function bindAppMenu(trigger, menu) {
    if (trigger) trigger.addEventListener('click', function (event) { event.stopPropagation(); toggleAppMenu(menu); });
    if (menu) menu.addEventListener('click', function (event) {
      var target = event.target && event.target.closest ? event.target.closest('[data-app-action]') : null;
      var action = target && target.getAttribute('data-app-action');
      if (!action) return;
      handleMenu(action);
      closeAppMenus();
    });
  }
  if (appHome) appHome.addEventListener('click', goHome);
  if (appOpen) appOpen.addEventListener('click', openFile);
  if (appSave) appSave.addEventListener('click', saveNow);
  if (appFocus) appFocus.addEventListener('click', toggleFocusMode);
  if (appPreview) appPreview.addEventListener('click', function () {
    previewVisible = !previewVisible;
    document.body.classList.toggle('preview-hidden', !previewVisible);
    syncToolbar();
    if (previewVisible) requestAnimationFrame(function () { cm.layout(); render(); });
  });
  bindAppMenu(appStyle, appStyleMenu);
  bindAppMenu(appFont, appFontMenu);
  bindAppMenu(appMore, appMoreMenu);
  document.addEventListener('click', closeAppMenus);

  // Drag-to-resize the AppView preview column. Preview is clamped to
  // [370px, 560px], default 480px — a fixed range reads more predictably
  // while dragging than a fraction of the stage width. The CSS variable
  // drives the grid column (its own fallback mirrors PREVIEW_DEFAULT_WIDTH).
  var PREVIEW_MIN_WIDTH = 370;
  var PREVIEW_MAX_WIDTH = 560;
  var PREVIEW_DEFAULT_WIDTH = 480;
  if (previewResizer) {
    previewResizer.addEventListener('mousedown', function (event) {
      event.preventDefault();
      var stage = previewResizer.parentElement;
      if (!stage) return;
      var startX = event.clientX;
      var startW = previewPane ? previewPane.getBoundingClientRect().width : PREVIEW_DEFAULT_WIDTH;
      previewResizer.classList.add('active');
      // The preview pane's own iframe would otherwise swallow mousemove
      // once the cursor crosses into it (it has its own document/window),
      // breaking the drag mid-gesture. A transparent full-viewport overlay
      // above everything (including the iframe) keeps every move event on
      // this listener until mouseup.
      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:col-resize;';
      document.body.appendChild(overlay);
      function clampedWidth(previewW) {
        return Math.max(PREVIEW_MIN_WIDTH, Math.min(PREVIEW_MAX_WIDTH, previewW));
      }
      function onMove(e) {
        // Dragging right shrinks the (right-hand) preview pane; dragging
        // left grows it — so the preview width moves opposite to delta.
        var delta = e.clientX - startX;
        stage.style.setProperty('--preview-width', clampedWidth(startW - delta) + 'px');
      }
      function onUp() {
        previewResizer.classList.remove('active');
        overlay.remove();
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }
  window.addEventListener('resize', function () {
    if (!isAppView) return;
    var stage = previewResizer && previewResizer.parentElement;
    if (!stage) return;
    var currentW = parseFloat(getComputedStyle(stage).getPropertyValue('--preview-width')) || PREVIEW_DEFAULT_WIDTH;
    if (currentW > PREVIEW_MAX_WIDTH || currentW < PREVIEW_MIN_WIDTH) {
      stage.style.setProperty('--preview-width', Math.max(PREVIEW_MIN_WIDTH, Math.min(PREVIEW_MAX_WIDTH, currentW)) + 'px');
    }
  });

  function applyStyleSlot(index) {
    var slot = styleSlots[index];
    if (!slot) return;
    customCss = slot.css;
    customStyleLabel = slot.label;
    style = 'custom';
    persistWritingPreferences();
    setStatus(t('status.appliedStyleSlot', { label: slot.label }));
    if (mode === 'preview') render(); else setMode('preview');
    syncToolbar();
  }

  function saveStyleSlot(index) {
    if (style !== 'custom' || !customCss) {
      setStatus(t('status.needCustomStyleFirst'), true);
      return;
    }
    var label = customStyleLabel || t('common.customStyleDefault');
    if (api && api.postMessage) {
      api.postMessage({ type: 'saveStyleSlot', slot: index, css: customCss, label: label, path: sourcePath });
    }
  }

  // Light, non-blocking confirmation for "should this AI-designed layout be
  // kept?" — three inline one-tap buttons in the status bar instead of a
  // modal dialog. Clicking one reuses saveStyleSlot(); the host's resulting
  // 'styleSlots' reply already renders its own confirmation text, and the
  // whole thing quietly expires like any other status message if ignored.
  function promptSaveStyleSlot() {
    if (statusHideTimer) { clearTimeout(statusHideTimer); statusHideTimer = 0; }
    statusEl.replaceChildren(document.createTextNode(t('aiStyle.applied') + ' '));
    statusEl.className = 'status status-style-prompt';
    for (var i = 0; i < 3; i++) {
      (function (index) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'status-inline-btn';
        btn.textContent = t('aiStyle.saveToSlot', { n: index + 1 });
        var existing = styleSlots[index];
        if (existing) btn.title = existing.label;
        btn.addEventListener('click', function () { saveStyleSlot(index); });
        statusEl.appendChild(btn);
      })(i);
    }
    statusHideTimer = setTimeout(function () {
      statusHideTimer = 0;
      statusEl.replaceChildren();
      statusEl.className = 'status';
    }, 12000);
  }

  // ---- Backend messages ----

  if (api && api.onMessage) {
    api.onMessage(function (m) {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'ready') {
        pickFileSupported = !!m.pickFileSupported;
        styleSlots = Array.isArray(m.styleSlots) ? m.styleSlots : [null, null, null];
        if (applyWritingPreferences(m.writingPreferences)) {
          if (isAppView && hasDocument()) render();
        } else {
          // One-time migration from the earlier WebView-local cache.
          persistWritingPreferences();
        }
        // Reconcile the navigator.language guess (used for the very first,
        // synchronous paint) against the host's real locale (ctx.i18n.locale,
        // forwarded from index.ts). Only re-render if it actually flips zh/en
        // — this arrives early enough that the recent-documents grid and
        // toolbar haven't rendered with the wrong language yet in practice.
        if (typeof m.locale === 'string' && m.locale) {
          var nextIsZh = /^zh/i.test(m.locale);
          if (nextIsZh !== isZh) { isZh = nextIsZh; applyStaticI18n(); updatePopupPlaceholder(); }
        }
        if (m.assistantName) { assistantName = m.assistantName; updatePopupPlaceholder(); }
        updateHomeTagline();
        if (m.homeDir) { homeDir = m.homeDir; renderHomeCwd(); }
        syncToolbar();
        return;
      }
      if (m.type === 'styleSlots') {
        styleSlots = Array.isArray(m.styleSlots) ? m.styleSlots : [null, null, null];
        if (typeof m.savedSlot === 'number' && styleSlots[m.savedSlot]) {
          setStatus(t('status.savedToSlot', { slot: m.savedSlot + 1, label: styleSlots[m.savedSlot].label }));
        }
        syncToolbar();
        return;
      }
      if (m.type === 'clipboardImages') {
        var pendingClipboard = pendingClipboardImages[m.requestId];
        if (pendingClipboard) {
          delete pendingClipboardImages[m.requestId];
          var clipboardHtml = pendingClipboard.sourceHtml;
          var imageUrls = m.images && typeof m.images === 'object' ? m.images : {};
          Object.keys(imageUrls).forEach(function (originalUrl) {
            if (typeof imageUrls[originalUrl] === 'string') clipboardHtml = clipboardHtml.split(originalUrl).join(imageUrls[originalUrl]);
          });
          pendingClipboard.resolve(compactClipboardImageLayout(clipboardHtml));
        }
        return;
      }
      if (m.type === 'clipboardImagesError') {
        var pendingClipboardErr = pendingClipboardImages[m.requestId];
        if (pendingClipboardErr) { delete pendingClipboardImages[m.requestId]; pendingClipboardErr.reject(new Error(m.message || t('status.clipboardPrepareFailedDefault'))); }
        return;
      }
      if (m.type === 'pastedImage') {
        var pendingPaste = pendingPasteImages[m.requestId];
        if (pendingPaste) { delete pendingPasteImages[m.requestId]; pendingPaste.resolve(m.url); }
        return;
      }
      if (m.type === 'pasteImageError') {
        var pendingPasteErr = pendingPasteImages[m.requestId];
        if (pendingPasteErr) { delete pendingPasteImages[m.requestId]; pendingPasteErr.reject(new Error(m.message || t('status.pasteImageFailedDefault'))); }
        setStatus(t('status.pasteImageFailed', { msg: m.message || '' }));
        return;
      }
      if (m.type === 'finch:env') {
        isAppView = m.view === 'appView';
        if (isAppView && !appViewInitialized) {
          // AppView starts as a writing surface; preview is opt-in.
          appViewInitialized = true;
          previewVisible = false;
          document.body.classList.add('preview-hidden');
        }
        document.body.classList.toggle('app-view', isAppView);
        if (appToolbar) appToolbar.hidden = !isAppView;
        // Both AppView and AppPanel expose the blank-line affordance. In
        // AppPanel, Space opens a Composer annotation input rather than a
        // rewrite session. Fenced-code rows use the short AI-only variant.
        cm.setAiHint(t('appview.hintSpace'), t('appview.hintSpaceCode'));
        var incomingCwd = m.cwd || '';
        var incomingSessionId = m.sessionId || '';
        var incomingSpaceId = m.spaceId || '';
        if (incomingCwd !== envCwd || incomingSessionId !== envSessionId || incomingSpaceId !== envSpaceId || !envReceived) {
          envCwd = incomingCwd;
          envSessionId = incomingSessionId;
          envSpaceId = incomingSpaceId;
          envReceived = true;
          renderRecentDocuments([]);
        }
        showPane();
        syncToolbar();
        if (isAppView && hasDocument()) render();
        if (!empty.hidden || isAppView) requestRecentDocuments();
        return;
      }
      if (m.type === 'recentDocuments') {
        if (!m.library && (m.cwd || '') !== envCwd) return;
        renderRecentDocuments(m.documents);
        if (m.library) renderLibraryDocuments(m.documents);
        return;
      }
      if (m.type === 'status') { setStatus(m.message); return; }
      if (m.type === 'rewriteSessionStarted') {
        cm.setAiWorkingLines(Number(m.startLine) || 0, Number(m.endLine) || 0);
        setStatus(m.rewriteMode === 'continue' ? t('appview.continuing') : t('appview.rewriting'));
        return;
      }
      if (m.type === 'rewriteSessionFinished') { cm.setAiWorkingLines(0, 0); setStatus(t('appview.rewriteDone')); return; }
      if (m.type === 'rewriteSessionFailed') { cm.setAiWorkingLines(0, 0); setStatus(m.message || 'Rewrite failed.', true); return; }
      if (m.type === 'styleSessionStarted') { setStyleSessionLoading(true); setStatus(t('aiStyle.appViewDesigning')); return; }
      if (m.type === 'styleSessionFinished') { setStyleSessionLoading(false); setStatus(m.message || t('aiStyle.appViewDone')); return; }
      if (m.type === 'styleSessionFailed') { setStyleSessionLoading(false); setStatus(m.message || t('aiStyle.appViewFailed'), true); return; }
      if (m.type === 'lastFileUnavailable') { return; }
      if (m.type === 'finch:menu') { handleMenu(m.itemId); return; }
      if (m.type === 'document') {
        var openedFromPicker = nativePickPending;
        nativePickPending = false;
        clearNativePickTimer();
        var incoming = m.markdown || '';
        var incomingPath = m.path || '';
        var incomingRevision = Number(m.revision) || 0;
        // A delayed snapshot for the same file must never undo a newer host
        // delivery that the editor already accepted.
        if (incomingPath && incomingPath === sourcePath && incomingRevision && incomingRevision <= documentRevision) return;
        // A different absolute path means this is a genuine "switch to
        // another document" push (e.g. the AI just created/opened a second
        // file while this panel already had one loaded) — not an echo of our
        // own save, and not an external edit of the file we're currently
        // looking at, so neither of the two guards below should apply to it.
        var isDifferentDocument = !!incomingPath && !!sourcePath && incomingPath !== sourcePath;
        if (!isDifferentDocument && incoming === savedMarkdown) {
          if (incomingRevision) documentRevision = Math.max(documentRevision, incomingRevision);
          syncToolbar();
          return;
        } // echo of our own save
        var isFirst = savedMarkdown === null;
        var wasLoadingFromHome = loadingFromHome;
        loadingFromHome = false;
        var applied = applyDocument(incoming, m.title || t('common.markdownDocDefault'), m.path || sourcePath, openedFromPicker || isFirst || isDifferentDocument, m.diskMarkdown);
        if (!applied) { syncToolbar(); return; } // still clear the "open" button's pending/disabled state
        documentRevision = incomingRevision || (isDifferentDocument ? 0 : documentRevision);
        if (m.draftRestored) {
          // The buffer we just loaded is an unsaved draft, not what's on
          // disk — keep it marked dirty so Save (or the draft-mirror timer)
          // stays active, and say so briefly instead of pretending nothing
          // happened. No blocking prompt: it's just the user's own last edit.
          setDirty(true);
          setStatus(t('status.draftRestored'));
        } else if (m.draftConflict) {
          // A draft existed, but the file was saved elsewhere (another
          // editor, an AI apply) after that draft was taken — loading the
          // draft over that would silently discard someone else's confirmed
          // save, and loading disk over the draft without saying anything
          // would silently discard the user's own edit. Load disk (the only
          // version anyone else can see) and say so plainly instead of
          // guessing; the stale draft file itself is left alone on disk.
          setStatus(t('status.draftConflict'), true);
        } else if (wasLoadingFromHome) {
          setStatus(t('status.opened', { file: fileName }));
        } else if (!isFirst) {
          var touched = lastExternalChange;
          if (touched && touched.hunks > 1) {
            setStatus(t('status.contentUpdatedSpots', { count: touched.hunks, lines: touched.changedLines }));
          } else if (touched && touched.fromLine === touched.toLine) {
            setStatus(t('status.contentUpdatedLine', { line: touched.fromLine }));
          } else if (touched) {
            setStatus(t('status.contentUpdatedLines', { from: touched.fromLine, to: touched.toLine }));
          } else {
            setStatus(t('status.contentUpdated'));
          }
        }
        return;
      }
      if (m.type === 'sourceMissing') {
        if (m.path && m.path === sourcePath) setStatus(t('status.sourceMissing'), true);
        return;
      }
      if (m.type === 'bmRendered') {
        if (m.requestId !== renderId) return;
        showHtml(m.html || '');
        updateEmptyState();
        renderingPreview = false;
        syncToolbar(); // `html` just became available (or changed) — refresh the copy menu's disabled state
        setStatus('');
        return;
      }
      if (m.type === 'savedMarkdown') {
        var savedContent = pendingSaveContents[m.requestId];
        delete pendingSaveContents[m.requestId];
        var saveResolve = pendingSaveResolvers[m.requestId];
        delete pendingSaveResolvers[m.requestId];
        if (m.requestId !== saveId || typeof savedContent !== 'string') {
          if (saveResolve) saveResolve(false);
          return;
        }
        savedMarkdown = savedContent;
        setDirty(markdown !== savedContent, markdown === savedContent);
        setStatus(markdown === savedContent ? t('status.saved') : t('status.savedWithNewChanges'));
        if (saveResolve) saveResolve(true);
        return;
      }
      if (m.type === 'customStyleSet') {
        customCss = m.css || '';
        customStyleLabel = m.label || t('common.customStyleDefault');
        style = 'custom';
        persistWritingPreferences();
        if (typeof m.savedSlot === 'number') {
          styleSlots = Array.isArray(m.styleSlots) ? m.styleSlots : styleSlots;
          setStatus(t('status.savedAppliedToSlot', {
            labelPrefix: m.label ? m.label + ' · ' : '',
            slot: m.savedSlot + 1,
          }));
        } else {
          // Applied straight to the preview without being asked which slot
          // to overwrite (the AI-style flow no longer forces that upfront) —
          // offer a light one-tap way to keep it instead of a heavy dialog.
          promptSaveStyleSlot();
        }
        if (mode === 'preview') render(); else setMode('preview');
        syncToolbar();
        return;
      }
      if (m.type === 'exported') { setStatus(t('status.exported', { path: m.path })); return; }
      if (m.type === 'watchStarted') { return; }
      if (m.type === 'pickCancelled') {
        // User closed the native picker without choosing a file — clear the
        // pending guard so the next click opens a fresh picker normally
        // instead of assuming this request is still hanging.
        nativePickPending = false;
        clearNativePickTimer();
        syncToolbar();
        setStatus('');
        return;
      }
      if (m.type === 'error') {
        loadingFromHome = false; // don't let a stale flag mislabel the next unrelated document push
        // A save failure surfaces here (no matching 'savedMarkdown' will ever
        // arrive for that requestId) — resolve any awaiter as failed so the
        // unsaved-changes confirm doesn't hang forever waiting on it.
        Object.keys(pendingSaveResolvers).forEach(function (id) {
          var resolve = pendingSaveResolvers[id];
          delete pendingSaveResolvers[id];
          if (resolve) resolve(false);
        });
        // A `fallback` error means the native picker timed out or errored on the
        // backend. We cannot silently re-trigger the OS file dialog here — Chromium
        // only allows showOpenFilePicker()/<input>.click() inside a real, still-fresh
        // user gesture, and this message arrives asynchronously well after the click
        // that started it. So just stop trusting the native path for the rest of this
        // session; the next "Open article" click (a fresh gesture) uses the reliable
        // in-page picker directly instead of hanging again.
        nativePickPending = false;
        clearNativePickTimer();
        if (m.fallback) pickFileSupported = false;
        // renderBm failures arrive through the same error channel; never
        // leave the preview button stuck on the hourglass after one.
        renderingPreview = false;
        syncToolbar();
        setStatus(m.message, true);
        return;
      }
    });
  }

  // The host's own initial `ready` push (sent right when the panel is created,
  // from `onDidOpenPanel`) races against this guest page loading and attaching
  // the `api.onMessage` listener above — it can be sent before we're listening
  // and silently lost, permanently leaving `pickFileSupported` at its default
  // `false`. So instead of only relying on that push, we ask for it ourselves
  // once we're actually ready to receive the answer; by construction that
  // request can't be sent before our own listener exists.
  if (api && api.postMessage) api.postMessage({ type: 'panelReady' });

  // Remember-last-file: if nothing has loaded shortly after opening (no tool
  // call, no restored payload), ask the backend for the last successfully
  // opened path so the user doesn't have to reopen it by hand every time.
  setTimeout(function () {
    if (!hasDocument() && api && api.postMessage) api.postMessage({ type: 'requestLastFile' });
    // `finch:env` normally lands before this; the retry covers a page rebind
    // that missed the push, so Home still fills in its recent documents.
    if (!recentRequested) requestRecentDocuments();
  }, 400);

  applyStaticI18n();
  updateHomeTagline();
  updatePopupPlaceholder();
  updateEmptyState();
  showPane();
})();

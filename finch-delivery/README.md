# 产物库 · Artifacts

一个安静运行在后台的小工具：AI 每次帮你生成一份文档或图片，它就悄悄记一笔账，让你随时找得到、看得到、跳得回去。

## 这是什么

聊着聊着，AI 可能已经帮你写了好几份 Markdown 报告、导出过 PDF、画过几张图……但这些文件散落在不同的会话里，过几天想找出来往往要翻半天聊天记录。

**产物库** 做的事情很简单：只要 AI 生成的是"能读的文档"——Markdown、Word、PPT、PDF、Excel、网页、图片——它就会自动帮你登记一条记录，包括标题、简介、生成时间、以及是在哪个会话里产出的。你不需要做任何操作，登记是全自动的。

> 代码、配置文件（`.ts`、`.py`、`.json` 等）不算在内——产物库只关心你会打开来看、会分享给别人的"成品文件"。

## 在哪里能看到它

装好之后，你会在三个地方看到它：

- **左侧栏「产物库」入口**：点开是一个独立页面，汇总你在所有会话里产出过的全部文件，随时可以逛一逛、找旧文件。
- **右侧「产物库」面板**：在某个具体会话里，从面板菜单打开它，看到的默认是"当前会话"这次对话产出了什么。
- **侧边栏「生成文件」提示行**：某个会话一旦有文件产出，聊天侧边栏会自动出现一行摘要，比如「生成文件 · 3个MD」「生成文件 · 5个文件」，点一下就直接打开面板。

三处入口用的是同一个图标（一个小书架 📚），风格是统一的。

## 怎么用

打开面板或页面后，顶部有一排筛选标签：

- **全部** — 所有会话产出的全部文件
- **当前会话**（只在右侧面板里出现）— 只看这次对话产出的文件
- **图片** — 只看生成的图片
- **文件** — 只看文档类文件（图片以外的都算）

卡片按时间从新到旧排列。Markdown 文件的卡片上会直接显示一段文字预览（标题+正文摘要），其他类型显示对应的格式图标。

- **点击卡片** → 用 Finch 自带的文件预览直接打开，不用等下载
- **悬浮时右上角会出现几个小按钮**：
  - ✎ 添加批注 — 把这份文件作为引用插入当前对话的输入框，方便接着跟 AI 讨论它（只在右侧面板里出现，见下）
  - ↗ 跳转到这份文件是在哪个会话里生成的
  - ✕ 删除这条记录——会先弹出确认弹窗，里面还有一个「同时从磁盘删除该文件」的勾选框，**默认不勾选**；勾上再确认才会真的删掉磁盘上的原文件，且不可恢复，请谨慎使用

「添加批注」只在右侧面板打开时才会出现——因为它要把文件插入*当前对话*的输入框，而左侧栏的独立页面不属于任何一个具体会话，没有输入框可以插。

界面语言跟随 Finch 本身的中英文设置自动切换，深色/浅色皮肤也会自动适配，不需要额外设置。

## 常见问题

**会不会把我的代码文件也记录进去？**
不会。这个工具只登记 AI 明确产出的文档/图片类"交付物"，源代码、配置文件从一开始就被排除在外。

**删除记录会不会把文件本身也删掉？**
默认不会——删除只清掉"记录"（一条索引），不碰磁盘上的原始文件。如果你在删除弹窗里主动勾选了「同时从磁盘删除该文件」，才会真的把源文件也删掉，而且是永久删除、无法恢复，请谨慎操作。

**数据存在哪里？会联网吗？**
所有记录都存在本地（Finch 的扩展私有存储里），不联网。为了支持"同时从磁盘删除文件"这个可选功能，这个工具持有本地文件的读写权限，但只有你在删除弹窗里主动勾选时才会触发真正的磁盘删除操作，其余时候不会主动读写你的磁盘。

## 支持的文件类型

| 类型 | 扩展名 |
|---|---|
| Markdown | `.md`、`.markdown` |
| Word | `.doc`、`.docx` |
| PowerPoint | `.ppt`、`.pptx` |
| PDF | `.pdf` |
| Excel | `.xls`、`.xlsx`、`.csv` |
| 网页 | `.html`、`.htm` |
| 图片 | `.png`、`.jpg`、`.jpeg`、`.gif`、`.webp`、`.svg`、`.bmp` |

---

# Library · Artifacts (English)

A quiet little assistant that keeps a running tally of every document the AI hands you — so you never have to go digging through old chats to find it again.

## What it does

While you're chatting, the AI might write you a Markdown report, export a PDF, or generate a few images along the way. All of that tends to scatter across different sessions, and a few days later it's genuinely hard to find.

**Artifacts** solves this by automatically logging every "readable" file the AI produces — Markdown, Word, PowerPoint, PDF, Excel, web pages, images — along with its title, a short description, when it was created, and which session it came from. There's nothing for you to do; the logging happens on its own.

> Source code and config files (`.ts`, `.py`, `.json`, etc.) don't count — Artifacts only tracks finished files you'd actually open or share.

## Where you'll find it

Once installed, it shows up in three places:

- **"Artifacts" entry in the left sidebar** — a standalone page listing everything the AI has ever produced for you, across every session.
- **"Artifacts" panel on the right** — open it from inside a specific session to see what that conversation has produced.
- **A "Generated Files" row in the session sidebar** — appears automatically once a session has produced anything, e.g. "Generated Files · 3 MD" or "Generated Files · 5 files" — click it to jump straight into the panel.

All three entry points share the same icon (a little bookshelf 📚) for a consistent look.

## How to use it

At the top of the page/panel, there's a row of filter tabs:

- **All** — everything, from every session
- **Current Session** (only shown in the right-side panel) — just this conversation's output
- **Images** — generated images only
- **Files** — everything else (documents, not images)

Cards are sorted newest first. Markdown files show a live text preview (heading + a snippet of the body) right on the card; other types show a plain type badge instead.

- **Click a card** → opens it in Finch's native file preview, no extra download step
- **Hover a card** to reveal a few small buttons in the corner:
  - ✎ add an annotation — inserts a reference to this file into the current conversation's Composer, so you can keep discussing it with the AI (only shown in the right-side panel, see below)
  - ↗ jump to the session where it was created
  - ✕ remove this record — a confirmation dialog pops up first, with an "Also delete the file from disk" checkbox that is **unchecked by default**; only checking it and confirming actually deletes the original file, and that deletion is permanent

"Add annotation" only appears when opened as the right-side panel — it inserts into *that conversation's* Composer draft, and the standalone left-sidebar page isn't tied to any single session, so there's no draft to insert into.

The UI language follows Finch's own language setting, and it adapts to light/dark skins automatically — nothing to configure.

## FAQ

**Will it also log my source code?**
No. Only document/image-type deliverables the AI explicitly produces get logged — source and config files are excluded by design.

**If I delete a record, does it delete the actual file too?**
Not by default — deleting only removes the index entry, not the file on disk. If you explicitly check "Also delete the file from disk" in the delete dialog, the original file is permanently removed too — that action cannot be undone, so use it carefully.

**Where's the data stored? Does it need internet access?**
Everything is stored locally in the extension's own private storage — no network access. To support the optional "delete from disk" action, this tool holds local read/write file permission, but it only touches your disk when you explicitly check that box in the delete dialog; otherwise it never reads or writes files on its own.

## Supported file types

| Type | Extensions |
|---|---|
| Markdown | `.md`, `.markdown` |
| Word | `.doc`, `.docx` |
| PowerPoint | `.ppt`, `.pptx` |
| PDF | `.pdf` |
| Excel | `.xls`, `.xlsx`, `.csv` |
| Web | `.html`, `.htm` |
| Image | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp` |

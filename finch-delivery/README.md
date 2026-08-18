# finch-delivery

Track and browse deliverables produced by the AI — Markdown, Word, PowerPoint, PDF, Excel, web pages, and images — all in one place.

## What it does

When the AI assistant creates a document for you (a Markdown report, a Word document, a PDF, a spreadsheet, a web page, or an image), it automatically logs the file as a **deliverable**. You can then browse all deliverables across every session in a visual card gallery.

- **Automatic logging** — the AI calls the delivery tool whenever it produces a document-type file
- **Card gallery** — each deliverable appears as a rounded card with file type badge, title, description, and timestamp
- **Markdown previews** — `.md` files show a text thumbnail right on the card; click to expand the full preview
- **Session filtering** — switch between "Current Session" and "All Sessions" with a tap
- **Jump to session** — click the arrow icon on any card to open the session where the file was created
- **Right sidebar integration** — a Delivery row in the sidebar shows the latest deliverable count; click to open the gallery panel

Code files (`.ts`, `.js`, `.py`, etc.) are **not** tracked — only document-type deliverables.

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

## How to use

1. Ask the AI to create a document (e.g., "write a report in Markdown" or "generate a PDF")
2. The AI automatically logs it as a deliverable
3. Open the **Deliveries** panel from the right sidebar `+` menu, or click the Delivery row
4. Browse, preview, and jump back to the originating session

---

# finch-delivery（中文）

记录和浏览 AI 生成的交付物 —— Markdown、Word、PowerPoint、PDF、Excel、网页和图片，集中管理。

## 功能

当 AI 助手为你创建文档（Markdown 报告、Word 文档、PDF、表格、网页或图片）时，它会自动将文件登记为**交付物**。你可以在卡片画廊中浏览所有会话的交付物。

- **自动登记** — AI 生成文档类文件时自动调用交付记录工具
- **卡片画廊** — 每个交付物以圆角卡片展示，包含文件类型徽标、标题、描述和时间
- **Markdown 预览** — `.md` 文件在卡片上显示文字缩略，点击展开全文预览
- **会话筛选** — 一键切换「当前会话」和「全部会话」
- **跳转到会话** — 点击卡片上的箭头图标，跳转到创建该文件的会话
- **右侧边栏集成** — 侧边栏的 Delivery 行显示最新交付物数量，点击打开画廊面板

代码文件（`.ts`、`.js`、`.py` 等）**不会**被记录，只追踪文档类交付物。

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

## 使用方式

1. 让 AI 创建文档（例如"写一份 Markdown 报告"或"生成一个 PDF"）
2. AI 自动将其登记为交付物
3. 从右侧边栏 `+` 菜单打开 **Deliveries** 面板，或点击 Delivery 行
4. 浏览、预览，并跳回原始会话

# AnyDoc for Finch

Read Word, Excel, PowerPoint, OpenDocument, RTF, EPUB, CSV and PDF files as clean Markdown — without leaving the conversation.

Finch can already read text, code and simple PDFs. Everything else — the contract someone sent as `.docx`, the survey results in `.xlsx`, the deck in `.pptx` — used to mean writing a throwaway conversion script every single time. AnyDoc closes that gap.

## What it feels like

> **You:** 帮我看看 `~/Downloads/合作协议.docx` 里的付款条款
>
> **Finch:** *(reads the document, answers)* 付款分三期……

> **You:** 这份问卷结果 `raw data.xlsx` 有多少人选了「前端开发」？
>
> **Finch:** *(pages through the sheet)* 76 人，占 21.59%……

No conversion step, no temp files, no "please convert this to text first".

## Supported formats

| Kind | Extensions |
|---|---|
| Word | `.doc` `.docm` `.docx` `.dot` `.dotx` `.odt` `.rtf` |
| Spreadsheet | `.xls` `.xlsm` `.xlsx` `.ods` `.csv` `.tsv` |
| Slides | `.ppt` `.pptm` `.pptx` `.odp` |
| Other | `.pdf` `.epub` |

Headings, tables (including merged cells), lists, footnotes, links and speaker notes all survive the conversion.

## Built for long documents

A 300-page report or a spreadsheet with 150,000 characters would swamp any conversation. AnyDoc handles this in two ways:

- **`outline` first.** Ask for the structure — headings with line numbers, plus size stats — before reading anything. On a document with no headings it tells you that honestly, and describes the shape instead.
- **Then read in pages.** Every read is bounded by both a line count and a character budget, and tells Finch exactly where to continue. Wide spreadsheet rows hit the character budget long before the line limit, so the budget is what actually protects the conversation.

Documents are converted once and reused, so an outline followed by five paged reads costs one conversion.

## Installation

```bash
npx @finchtoys/minitools add finch-anydoc
```

Then enable **AnyDoc** in the Finch Toolcase.

**First run downloads a document engine (~7 MB).** AnyDoc is powered by [anydoc](https://github.com/firecrawl/anydoc), a native engine that is a different binary on every platform. Rather than shipping every platform's copy, AnyDoc fetches the one your machine needs on the first document you open, verifies it against the npm registry checksum, and caches it. Every later document opens instantly.

The cached engine lives in AnyDoc's own data directory, `~/.finch/extension-data/anydoc/engine/`. Deleting it is safe — the next document you open downloads it again. Updating or removing AnyDoc never touches it.

You do not need Rust, Node.js or Python installed. The engine is a prebuilt binary and Finch supplies the runtime that loads it.

| Platform | Status |
|---|---|
| macOS, Apple Silicon and Intel | works out of the box |
| Linux x64 / arm64, glibc and musl | works out of the box |
| Windows x64 | needs the [Microsoft Visual C++ 2015-2022 Redistributable](https://aka.ms/vs/17/release/vc_redist.x64.exe), which most machines already have |
| Windows on ARM | not supported — upstream publishes no build for it |

On Windows, AnyDoc checks for the Visual C++ runtime before downloading anything and links you straight to the installer if it is missing, rather than failing later with an unhelpful DLL error.

## Limits

- **Scanned PDFs need OCR.** A PDF that is just photos of pages has no text to extract. AnyDoc says so clearly instead of returning an empty document.
- **Password-protected files** cannot be opened.
- **Plain text, Markdown, JSON and code** are not AnyDoc's job — Finch's built-in reader is better at those, and AnyDoc will point you back to it.
- **Images inside documents** appear as their alt text; the pictures themselves are not extracted.

## Credits

Document conversion is powered by [anydoc](https://github.com/firecrawl/anydoc) from Firecrawl (MIT).

## License

MIT

---

# AnyDoc 文档阅读

把 Word、Excel、PPT、OpenDocument、RTF、EPUB、CSV 和 PDF 读成干净的 Markdown，全程不用离开对话。

Finch 本来就能读文本、代码和简单 PDF，但别人发来的 `.docx` 合同、`.xlsx` 问卷结果、`.pptx` 提案，过去每次都得临时写一段转换脚本。AnyDoc 就是来补这块空缺的。

## 用起来是什么样

> **你：** 帮我看看 `~/Downloads/合作协议.docx` 里的付款条款
>
> **Finch：** *（读完文档，直接回答）* 付款分三期……

> **你：** 这份问卷结果 `raw data.xlsx` 有多少人选了「前端开发」？
>
> **Finch：** *（翻页读表）* 76 人，占 21.59%……

没有转换步骤，没有临时文件，也不用先跟它说「你先把这个转成文本」。

## 支持的格式

| 类型 | 扩展名 |
|---|---|
| 文档 | `.doc` `.docm` `.docx` `.dot` `.dotx` `.odt` `.rtf` |
| 表格 | `.xls` `.xlsm` `.xlsx` `.ods` `.csv` `.tsv` |
| 演示 | `.ppt` `.pptm` `.pptx` `.odp` |
| 其他 | `.pdf` `.epub` |

标题层级、表格（含合并单元格）、列表、脚注、链接和演讲者备注都会保留下来。

## 为长文档设计

一份 300 页的报告，或者一个 15 万字符的表格，直接塞进对话会瞬间撑爆上下文。AnyDoc 用两步来解决：

- **先看大纲。** 先要结构——带行号的标题列表和体量统计，不读正文。如果文档本身没有标题，它会如实告诉你，并改为描述文档的形态。
- **再分页读。** 每次读取同时受行数和字符预算两重限制，并明确告诉 Finch 下一页从哪一行继续。宽表格的一行往往就有几百字符，真正起保护作用的是字符预算。

同一份文档只转换一次并复用，所以「一次大纲 + 五次翻页」只有一次转换开销。

## 安装

```bash
npx @finchtoys/minitools add finch-anydoc
```

然后在 Finch 工具箱里启用 **AnyDoc**。

**首次使用会下载约 7 MB 的文档引擎。** AnyDoc 基于 [anydoc](https://github.com/firecrawl/anydoc)，它是原生引擎，每个平台的二进制都不一样。与其把所有平台的版本都塞进安装包，AnyDoc 选择在你第一次打开文档时按需下载当前平台所需的那一个，用 npm registry 的校验和验证后缓存下来。之后每次打开文档都是瞬时的。

缓存的引擎存在 AnyDoc 自己的数据目录 `~/.finch/extension-data/anydoc/engine/`。直接删掉也没关系，下次打开文档会重新下载；更新或卸载 AnyDoc 都不会动它。

你**不需要**安装 Rust、Node.js 或 Python。引擎是预编译二进制，加载它的运行时由 Finch 自己提供。

| 平台 | 状态 |
|---|---|
| macOS（Apple Silicon 与 Intel） | 开箱即用 |
| Linux x64 / arm64（glibc 与 musl） | 开箱即用 |
| Windows x64 | 需要 [Microsoft Visual C++ 2015-2022 运行库](https://aka.ms/vs/17/release/vc_redist.x64.exe)，绝大多数机器已经装过 |
| Windows on ARM | 不支持 —— 上游没有提供该平台的构建 |

在 Windows 上，AnyDoc 会在下载任何东西之前先检查 Visual C++ 运行库，缺失时直接给出安装包链接，而不是等到后面报一句看不懂的 DLL 错误。

## 已知限制

- **扫描版 PDF 需要 OCR。** 整页都是图片的 PDF 本身没有可提取的文字。AnyDoc 会明确说明，而不是返回一份空文档。
- **加密文档**无法打开。
- **纯文本、Markdown、JSON 和代码**不归 AnyDoc 管——Finch 内置的读取工具更合适，AnyDoc 会提示你换回去。
- **文档内嵌图片**只以替代文字的形式出现，不会导出图片本身。

## 致谢

文档转换由 Firecrawl 的 [anydoc](https://github.com/firecrawl/anydoc)（MIT）驱动。

## 许可证

MIT

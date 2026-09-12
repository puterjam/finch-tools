# OCR

Recognize text in images and screenshots — fully offline, no API key, no image ever leaves your machine.

## What it does

Ask the assistant to read text out of a screenshot, a receipt photo, a scanned page, or any image URL, and it will use the `ocr_read_image` tool to do it locally. The first time you use it on a machine, it downloads a small, platform-specific OCR engine (a one-time download of a few tens of MB); every call after that runs completely offline.

Typical requests:

- "识别这张截图里的文字" / "What does this receipt say?"
- "Pull the text out of `~/Desktop/invoice.png`"
- "Find the bounding boxes of the text in this image" (detection only, no recognition)

## Why local, offline OCR

- **Privacy** — your images are never uploaded to a cloud OCR API or an AI vision model.
- **No API key, no bill** — nothing to configure, no per-image cost.
- **Works offline** — after the one-time engine download, recognition needs no network at all.

## Platform support

| Platform | Supported |
|---|---|
| macOS (Apple Silicon) | ✅ |
| macOS (Intel) | ❌ not yet — no upstream build for darwin x64 |
| Linux x64 / arm64 | ✅ |
| Windows x64 | ✅ |

On macOS, the engine binary is ad-hoc signed (not Apple-notarized); the tool automatically clears the Gatekeeper quarantine flag after downloading it, so you should not need to approve anything manually.

## How it works

This mini tool wraps the [ppu-paddle-ocr](https://github.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr) project's **standalone binary** distribution — a self-contained executable released for each OS/architecture, with the ONNX Runtime and OCR models bundled in. On first use it:

1. Detects your OS/architecture.
2. Downloads the matching binary from the project's GitHub Releases and verifies its sha256 checksum.
3. Caches it under this mini tool's private storage directory.
4. Clears the macOS quarantine flag if needed.

From then on, every `recognize`/`detect` call simply spawns the cached binary as a local subprocess — no network access required unless you point it at an `http(s)` image URL.

## Tool reference

`ocr_read_image`

| Field | Description |
|---|---|
| `action` | `recognize` (default) · `detect` · `status` · `clear_cache` |
| `path` | Local image path or an `http(s)` image URL. Required for `recognize`/`detect`. |
| `json` | Return the full structured result (text, boxes, confidence) instead of plain text. |
| `model` | Optional model preset override, e.g. `v6-small`, `v5-en-mobile`, `v5-thai-mobile`. |
| `min_confidence` | Optional confidence filter (0–1). |

## Notes

- Engine version is pinned deliberately in this mini tool; it is not always "latest" from upstream.
- `clear_cache` removes both the cached engine binary and the engine's own OCR model cache, forcing a clean re-download next time.
- This mini tool needs `network` (to fetch the engine/model once, or an image URL), `shell` (to run the engine binary) and `filesystem` (to read the image you point it at and write the cached engine) permissions.

---

# OCR 文字识别

识别图片和截图里的文字 —— 完全离线运行，不需要 API Key，图片也不会离开你的电脑。

## 能做什么

直接让助手读一张截图、一张小票照片、一份扫描件，或者一个图片链接里的文字，它会调用 `ocr_read_image` 工具本地完成识别。第一次在这台机器上使用时，会下载一个体积不大的、按你系统定制的 OCR 引擎（一次性下载几十 MB）；之后每次调用都完全离线运行。

常见用法：

- "识别这张截图里的文字"
- "帮我读一下 `~/Desktop/发票.png` 里写了什么"
- "找出这张图里文字的位置"（只做检测，不识别内容）

## 为什么用本地离线 OCR

- **隐私**：图片不会上传到任何云端 OCR 接口或 AI 视觉模型。
- **零配置零成本**：不需要申请 API Key，也没有按张计费。
- **离线可用**：一次性下载引擎后，识别过程完全不联网。

## 平台支持

| 平台 | 是否支持 |
|---|---|
| macOS（Apple 芯片） | ✅ |
| macOS（Intel） | ❌ 暂不支持——上游还没有 darwin x64 构建 |
| Linux x64 / arm64 | ✅ |
| Windows x64 | ✅ |

macOS 上引擎二进制是 ad-hoc 签名（未经 Apple 公证），工具下载完成后会自动清除 Gatekeeper 的隔离属性，正常情况下不需要你手动放行。

## 实现原理

这个小程序封装了 [ppu-paddle-ocr](https://github.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr) 项目发布的**独立二进制**版本——一个按操作系统/架构分别打包、自带 ONNX Runtime 和 OCR 模型的可执行文件。首次使用时会：

1. 探测当前系统与架构；
2. 从项目的 GitHub Releases 下载对应二进制，并校验其 sha256 摘要；
3. 缓存到本小程序的私有存储目录；
4. 如有需要，清除 macOS 的隔离属性。

之后每次 `recognize`/`detect` 调用，都只是把缓存好的二进制当作本地子进程启动——除非你传入的是 `http(s)` 图片链接，否则完全不需要联网。

## 工具说明

`ocr_read_image`

| 字段 | 说明 |
|---|---|
| `action` | `recognize`（默认）· `detect` · `status` · `clear_cache` |
| `path` | 本地图片路径或 `http(s)` 图片链接，`recognize`/`detect` 必填 |
| `json` | 返回完整结构化结果（文字、检测框、置信度），而非纯文本 |
| `model` | 可选的模型预设，如 `v6-small`、`v5-en-mobile`、`v5-thai-mobile` |
| `min_confidence` | 可选的置信度过滤（0–1） |

## 备注

- 引擎版本在小程序里是刻意锁定的，不会永远跟随上游"最新版"。
- `clear_cache` 会同时清掉已缓存的引擎二进制和引擎自身的 OCR 模型缓存，下次调用会重新完整下载。
- 本小程序需要 `network`（首次下载引擎/模型，或识别图片链接）、`shell`（运行引擎二进制）与 `filesystem`（读取你指定的图片、写入缓存的引擎）权限。

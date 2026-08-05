# Tencent Docs for Finch

Create, read, search and edit Tencent Docs (docs.qq.com) online documents right from your Finch conversations — no copy-pasting, no browser tab switching.

## What you can do

- **Create documents** — smart docs (beautiful, Markdown-compatible), Word, Excel, PPT, mind maps, flowcharts, smart sheets and forms. Just describe what you want; Finch picks the right doc type and writes the content.
- **Read & search** — open any of your Tencent Docs by link or keyword search and read its full content inline.
- **Edit** — insert and update content in Word docs, Excel sheets, smart sheets and PPT slides with the right editor for each format.
- **Manage files** — rename, move, copy, delete, share and organize docs into folders and knowledge spaces.
- **Clip web pages** — drop a URL into the conversation and Finch saves it as a smart doc automatically.
- **OCR** — turn screenshots and images into editable Word docs or Excel sheets.

## How to get started

1. Install the mini tool and enable it in the Toolbox (it also needs the **MCP Client** mini tool).
2. Run `tdocs_auth` (or click the Tencent Docs button in the composer toolbar → **Sign in to Tencent Docs**).
3. Open the authorization link in your browser, sign in with QQ or WeChat, then confirm. Your token is stored securely in the system keychain.
4. Done — now just ask: *"创建一份本周工作周报"*, *"把这篇 Markdown 保存到我的腾讯文档"*, *"搜一下我以前的 2025 年终总结"*, *"把表格里前 10 行加粗并设置筛选"*…

> 💡 Four services share the single login: general docs (smart docs, mind maps, flowcharts, smart sheets, file management), PPT (`slide-mcp`), Word (`doc-mcp`) and Excel (`sheet-mcp`). Finch routes to the right one automatically.

## Re-authorizing

Tokens expire eventually. When a call fails with an auth error, run `tdocs_status` to check the connection, then `tdocs_auth` → `start` to sign in again. You can also paste a token manually with `tdocs_auth` → `set_token` (get one at [docs.qq.com/scenario/open-claw.html](https://docs.qq.com/scenario/open-claw.html)).

## Notes

- Requires a Tencent Docs account; some operations need a VIP plan or credits (the tools will tell you).
- Your documents stay on Tencent Docs — this mini tool only connects to the official MCP endpoints with your own token.

---

# 腾讯文档 for Finch

直接在 Finch 对话里创建、读取、搜索和编辑腾讯文档（docs.qq.com）在线文档——不用复制粘贴，不用来回切浏览器。

## 能做什么

- **创建文档** — 智能文档（排版美观、兼容 Markdown）、Word、Excel、PPT、思维导图、流程图、智能表格、收集表。描述需求即可，Finch 自动选对文档类型并写入内容。
- **读取与搜索** — 通过链接或关键词搜索打开任意腾讯文档，直接内联阅读全文。
- **编辑** — 用各品类专属编辑器增改 Word、Excel、智能表格和 PPT 内容。
- **文件管理** — 重命名、移动、复制、删除、分享，整理到文件夹和知识库空间。
- **网页剪藏** — 把网址丢进对话，自动保存为智能文档。
- **OCR 识别** — 截图、图片一键转成可编辑的 Word 或 Excel。

## 快速开始

1. 安装小工具并在工具箱启用（同时需要 **MCP 客户端** 扩展）。
2. 运行 `tdocs_auth`（或点击输入框工具栏的腾讯文档按钮 → **登录腾讯文档**）。
3. 在浏览器打开授权链接，用 QQ 或微信扫码登录，回来确认即可。Token 安全存入系统钥匙串。
4. 完成——直接说："创建一份本周工作周报"、"把这篇 Markdown 保存到我的腾讯文档"、"搜一下我以前的 2025 年终总结"、"把表格前 10 行加粗并加筛选"……

> 💡 一次登录四个服务共用：通用文档（智能文档、思维导图、流程图、智能表格、文件管理）、PPT（slide-mcp）、Word（doc-mcp）、Excel（sheet-mcp），Finch 自动路由到正确服务。

## 重新授权

Token 会过期。当调用返回鉴权错误时，先运行 `tdocs_status` 查看连接状态，再运行 `tdocs_auth`（action=start）重新登录；也可以在 [docs.qq.com/scenario/open-claw.html](https://docs.qq.com/scenario/open-claw.html) 获取 Token 后，用 `tdocs_auth`（action=set_token）手动粘贴。

## 注意事项

- 需要腾讯文档账号；部分操作需要 VIP 或积分（工具会给出提示）。
- 文档始终留在腾讯文档云端——本小工具只用你的 Token 连接官方 MCP 端点。

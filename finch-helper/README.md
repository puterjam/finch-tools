# Finch Help

A Finch mini tool that answers questions about **Finch usage, features and mini tool development** from the official Finch documentation.

Ask "how do I create a scheduled task?", "what is a session container?", or "how do I publish a mini tool?" — the assistant retrieves the relevant excerpts from the official docs knowledge base and answers with sources.

## How it works

- **Finch Help assistant (session container)** — after enabling the mini tool, open the **Finch Help** container in Finch and start a chat. The assistant is bound to the `finch-expert` agent profile: it searches the knowledge base for every question, answers from the retrieved docs, and cites the source pages. The container home offers starter prompt cards (mini tool development, memory, session containers, automation).
- **`finch_help_search` tool** — available in any Finch conversation too. When you ask something about Finch, the assistant can call it to pull relevant documentation excerpts before answering.

## Knowledge base

The knowledge base is a snapshot of the official Finch website docs (`docs/` and `Changelog/` pages, zh + en) **plus the `finch-mini-tool-creator` skill docs** (`SKILL.md` + `reference/*.md`, en, for API-level development detail), chunked at section level and bundled into the package at build time (`src/kb.json`). Retrieval is a zero-dependency BM25-style keyword search with a CJK-aware tokenizer (Chinese bigrams + English words), so it works fully offline.

### Updating the knowledge base

The source lives in the finch-website repository (`~/Workspace/aeolus/finch-website/pages`) plus the finch-mini-tool-creator skill (`~/Workspace/aeolus/finch/skills/finch-mini-tool-creator`). When the docs change:

```bash
npm run kb     # regenerates src/kb.json from the website pages + skill docs
npm run build  # rebuilds the bundle with the new knowledge base
```

`src/kb.json` is committed so the package can be built without the website checkout.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # esbuild bundle -> dist/index.js
npx @finchtoys/minitools doctor .   # manifest validation

# local smoke test via tarball (never `minitools add <dir>`)
npm run build
npm pack --pack-destination /tmp
npx @finchtoys/minitools remove finch-helper
npx @finchtoys/minitools add /tmp/finch-helper-<version>.tgz
```

---

# Finch 助手

一个 Finch 小程序：基于官方 Finch 文档，回答关于 **Finch 用法、功能与小程序开发** 的问题。

问"怎么创建定时任务？"、"什么是会话容器？"、"怎么发布小程序？"——助手会先从官方文档知识库检索相关内容，再带来源地回答。

## 工作原理

- **Finch 助手（会话容器）**——启用小程序后，在 Finch 里打开 **Finch 助手** 容器发起对话。该容器绑定了 `finch-expert` 角色：每个问题都会先检索知识库，再基于检索到的文档回答并注明来源页面。容器首页提供引导卡片（小程序开发、记忆机制、会话容器、定时自动化）。
- **`finch_help_search` 工具**——在任意 Finch 对话中也可用。当你问 Finch 相关问题时，助手会调用它检索相关文档片段再作答。

## 知识库

知识库是官方 Finch 网站文档（`docs/` 与 `Changelog/` 页面，中英双语）**以及 `finch-mini-tool-creator` skill 文档**（`SKILL.md` + `reference/*.md`，英文，补充 API 级开发细节）的快照，按章节分块后在构建时打包进发布物（`src/kb.json`）。检索为零依赖的 BM25 风格关键词检索，带 CJK 感知分词（中文 bigram + 英文单词），完全离线运行。

### 更新知识库

数据源在 finch-website 仓库（`~/Workspace/aeolus/finch-website/pages`）以及 finch-mini-tool-creator skill（`~/Workspace/aeolus/finch/skills/finch-mini-tool-creator`）。文档更新后：

```bash
npm run kb     # 从网站页面与 skill 文档重新生成 src/kb.json
npm run build  # 用新知识库重新构建
```

`src/kb.json` 已提交进仓库，因此不需要网站检出也能构建发布。

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # esbuild bundle -> dist/index.js
npx @finchtoys/minitools doctor .   # manifest 校验

# 本地冒烟测试走 tarball（不要用 `minitools add <目录>`）
npm run build
npm pack --pack-destination /tmp
npx @finchtoys/minitools remove finch-helper
npx @finchtoys/minitools add /tmp/finch-helper-<version>.tgz
```

# CLI Bridge

Pair the [`finch` command-line tool](https://github.com/puterjam/finch-tools/tree/main/finch-cli) with this Finch app, so a terminal can create and drive Finch Sessions, watch live events, and answer permission cards — even when you're not looking at the Finch window.

## What it does

- Starts a small HTTP server that only listens on `127.0.0.1` — nothing on your network can reach it.
- The first time a terminal runs `finch login`, Finch shows a native "Allow / Deny" prompt with the terminal's name and a one-time code. Nothing connects until you approve it.
- Once paired, the CLI can:
  - Check Finch's status and list your Spaces.
  - Create a Session (in a Space, or a plain chat) and send it messages.
  - Wait for a turn to finish, cancel a running turn, and stream events live.
  - See and answer permission / question / form cards that are blocking a Session — handy for approving something from your phone over SSH.
- Every paired terminal shows up under **CLI Bridge → 设置/settings button** with a "Revoke access" action, so you can see and cut off access at any time.

This mini tool has no Agent tools and does not read any files on disk — it is purely a control-plane bridge between the CLI and Finch's own Session APIs.

## Setup

1. Install and enable **CLI Bridge** in Finch.
2. Install the `finch` CLI: `npm i -g finch-cli` (see that package for the full command reference).
3. Run `finch login` in a terminal. Approve the prompt that appears in Finch.
4. Run `finch status`, `finch session create`, etc.

## Security notes

- The bridge only binds to loopback and checks the `Host` header on every request, so a webpage or a machine on your network cannot reach it.
- Tokens are stored hashed (SHA-256) in Finch's secure secret storage; the raw token is only ever shown once, at pairing time, and lives in the CLI's local credential file.
- Revoking a client here immediately invalidates its token — the next request it makes returns `401`.
- The bridge never auto-approves a permission card. Destructive operations can still only be approved by you, inside Finch.

Full protocol spec (HTTP endpoints, pairing flow, event streaming): see [`docs/finch-cli-design.md`](https://github.com/puterjam/finch-tools/blob/main/docs/finch-cli-design.md) in this repo.

---

# CLI 桥接

把 [`finch` 命令行工具](https://github.com/puterjam/finch-tools/tree/main/finch-cli) 与这个 Finch 应用配对，让你在终端里就能创建/驱动 Finch 会话、实时查看事件、应答权限卡——哪怕你此刻根本没有盯着 Finch 窗口。

## 它做什么

- 起一个只监听 `127.0.0.1` 的本地 HTTP 服务，网络上的任何其它设备都连不进来。
- 终端第一次运行 `finch login` 时，Finch 会弹出原生的"允许 / 拒绝"确认框，显示终端名称和一次性验证码。你不点允许，什么都不会连上。
- 配对成功后，CLI 可以：
  - 查看 Finch 状态、列出你的 Space。
  - 创建会话（放进某个 Space，或普通对话）并发消息。
  - 等待一轮对话结束、取消正在运行的对话、实时接收事件流。
  - 查看并应答正在卡住某个会话的权限卡/提问卡/表单卡——比如你人在外面，通过 SSH 在手机上远程批准一次操作。
- 每个已配对的终端都会出现在**CLI 桥接的设置菜单**里，带一个"撤销授权"按钮，随时可以查看和收回权限。

这个小程序不注册任何 Agent 工具，也不读取磁盘上的任何文件——它纯粹是 CLI 和 Finch 自身会话能力之间的一层控制面桥接。

## 使用步骤

1. 在 Finch 里安装并启用 **CLI 桥接**。
2. 安装 `finch` 命令行工具：`npm i -g finch-cli`（完整命令说明见该包）。
3. 在终端里运行 `finch login`，在 Finch 里点击弹出的确认框。
4. 运行 `finch status`、`finch session create` 等命令。

## 安全说明

- 桥接只绑定 loopback，并且每个请求都会校验 `Host` 头，网页或局域网内其它设备都碰不到它。
- Token 以哈希（SHA-256）形式存进 Finch 的系统安全存储；明文只在配对那一刻出现一次，之后只活在 CLI 本地的凭证文件里。
- 在这里撤销某个终端会立即让它的 token 失效，下一次请求就会收到 `401`。
- 桥接从不自动批准权限卡，危险操作依然只能由你亲自在 Finch 里批准。

完整协议规格（HTTP 接口、配对流程、事件流）见仓库根目录的 [`docs/finch-cli-design.md`](https://github.com/puterjam/finch-tools/blob/main/docs/finch-cli-design.md)。

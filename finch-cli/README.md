# finch-cli

A `finch` command for your terminal that drives a running [Finch](https://finchwork.app/) app: create and message Sessions, wait for a turn to finish, stream live events, and answer permission cards — all without touching the Finch window.

It talks to the [`finch-cli-bridge`](https://github.com/puterjam/finch-tools/tree/main/finch-cli-bridge) mini tool over a local, token-paired HTTP connection. See [`docs/finch-cli-design.md`](https://github.com/puterjam/finch-tools/blob/main/docs/finch-cli-design.md) for the full protocol.

## Install

```bash
npm i -g finch-cli
```

Or run it ad-hoc with `npx finch-cli <command>`.

You also need the **CLI Bridge** mini tool installed and enabled inside Finch — that's the counterpart running inside the app.

## Getting started

```bash
finch login     # approve the pairing prompt that appears in Finch
finch status     # confirm it's working
finch space list
```

## Commands

```
finch login                          Pair this terminal with a running Finch app
finch logout                         Revoke this terminal's pairing
finch whoami                         Show the current pairing identity
finch status                         Finch app version/platform + status snapshot
finch space list                     List your Spaces

finch session list [--include-archived]
finch session create [--space <id>] [--title <t>] [--message <text>] [--background]
finch session get <sessionId>
finch session send <sessionId> --message <text> [--wait] [--timeout <sec>] [--idempotency-key <key>]
finch session wait <sessionId> <turnId> [--timeout <sec>]
finch session cancel <sessionId> <turnId>
finch session events <sessionId> [--after <n>] [--limit <n>]
finch session watch <sessionId>      Stream live events (SSE)
finch session waits <sessionId>      List pending permission/question/form cards
finch session respond <sessionId> <requestId> --allow|--deny
finch session respond <sessionId> <requestId> --answer "header=value" [--answer ...]
finch session respond <sessionId> <requestId> --form key=value [--form ...]

finch open <sessionId>               Bring Finch to the front on this Session
finch watch                          Stream Finch's global notification feed
```

Sessions created by this CLI have no dedicated container (the bridge declares none) — pass `--space <spaceId>` (see `finch space list`) to place a Session in a Space, or omit it for a plain chat conversation.

### Example: fire off a task and wait for the answer

```bash
finch session create --space "$(finch space list | head -1 | cut -d' ' -f1)" --title "CLI job"
finch session send <sessionId> --message "Summarize today's commits" --wait --timeout 120
```

### Example: approve a permission card from anywhere (e.g. over SSH)

```bash
finch session waits <sessionId>
finch session respond <sessionId> <requestId> --allow
```

Destructive/irreversible operations can still only be approved inside the Finch window — the bridge deliberately does not let a CLI rubber-stamp those.

## Security

- Nothing works until you approve a pairing request inside Finch — see `finch-cli-bridge`'s README for details.
- Credentials are stored at `~/.finch-cli/credentials.json`, mode `600`, and never leave your machine.
- `finch logout` revokes the token both locally and on the bridge.

---

# finch-cli（中文）

在终端里敲 `finch` 命令，驱动一个正在运行的 [Finch](https://finchwork.app/) 应用：创建和给会话发消息、等待一轮对话结束、实时接收事件流、应答权限卡——全程不用碰 Finch 窗口。

它通过本机、需要一次性配对确认的 HTTP 连接，跟 [`finch-cli-bridge`](https://github.com/puterjam/finch-tools/tree/main/finch-cli-bridge) 小程序对接。完整协议见 [`docs/finch-cli-design.md`](https://github.com/puterjam/finch-tools/blob/main/docs/finch-cli-design.md)。

## 安装

```bash
npm i -g finch-cli
```

或者直接 `npx finch-cli <command>` 临时用一次。

同时你需要在 Finch 里安装并启用 **CLI 桥接** 小程序——那是运行在 App 里的另一半。

## 快速开始

```bash
finch login     # 在 Finch 里点击弹出的配对确认框
finch status     # 确认连上了
finch space list
```

## 命令一览

（命令与参数保持英文，与上文一致，方便脚本复制粘贴。）

## 安全说明

- 在 Finch 里点击"允许"之前，任何请求都不会通过——详见 `finch-cli-bridge` 的 README。
- 凭证存放在 `~/.finch-cli/credentials.json`，权限 `600`，只留在本机。
- `finch logout` 会同时让本地和服务端的 token 失效。

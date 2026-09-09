# Finch CLI · 架构设计与对接协议

> **状态：v0.1.0 已实现并本地冒烟验证通过。** 四项架构决策均已按推荐方案确认：两包拆分、弹窗人工点头配对、`permissions.network: true`、v1 命令范围见 §5。

> 目标：让终端里的 `finch` 命令能够驱动运行中的 Finch 桌面应用——创建/驱动 Session、查看状态、在你不在电脑前时应答权限卡——同时不违反小程序沙箱与最小权限原则。

## 1. 总体架构：两个包，一条本地协议

```
外部终端                          Finch 桌面应用（Electron 进程）
┌─────────────┐   本地 HTTP/SSE   ┌───────────────────────────┐
│  finch-cli  │ ───────────────▶ │  finch-cli-bridge 小程序    │
│ （全局 npm  │ ◀─────────────── │  onStartup 启动，持有一个    │
│  bin: finch）│   127.0.0.1:PORT │  仅监听 loopback 的 HTTP 服务│
└─────────────┘                  │  内部转调 ctx.sessions /    │
                                  │  ctx.spaces / ctx.status 等 │
                                  └───────────────────────────┘
```

拆成两个独立 npm 包，职责分开、发布方式也不同：

| 包 | 目录 | 发布方式 | 角色 |
|---|---|---|---|
| **finch-cli-bridge** | `finch-cli-bridge/` | `npx @finchtoys/minitools add`（走本仓库现有约定） | 装进 Finch 的小程序本体：起本地服务、做配对鉴权、把请求转成 `ctx.*` 调用 |
| **finch-cli** | `finch-cli/` | 普通 npm 发布，`npm i -g finch-cli` 或 `npx finch-cli`，带 `bin` 字段 | 用户实际敲的 `finch` 命令行程序，纯 Node，零 Finch 内部依赖，只认本文档定义的 HTTP 协议 |

这样 CLI 本身可以被任何人在任何目录下 `npm i -g` 安装，不需要理解小程序机制；小程序那侧则严格遵守本仓库"权限最小化 / 运行时零依赖打包"的约定。

## 2. 为什么是"本地 HTTP + 配对令牌"，而不是别的方案

小程序运行在 Finch 的扩展宿主里，本质是 Node 代码，`activationEvents` 目前只有 `onStartup`，也就是**只要 Finch 在跑，小程序就在跑**——这天然适合常驻一个本地服务，不需要额外的"唤醒"机制。

对比过的方案：

- **文件轮询邮箱**（CLI 写命令文件，小程序 `fs.watch` 轮询）：延迟高、没有天然的请求-响应语义，`session.send()` 这种需要拿到 `turnId` 再 `waitForTurn()` 的操作实现起来很别扭。放弃。
- **Unix Domain Socket**：比 TCP loopback 更封闭（天然只有本机同用户可连），但 Windows 支持要用命名管道，跨平台实现分叉两套代码。协议层面收益不大，先不做，列为可选加固项（见 §5）。
- **本地 HTTP(S) + Bearer Token，仅绑定 127.0.0.1**：实现简单、跨平台一致、能直接复用 `ctx.sessions` 现成的请求-响应/等待语义，流式数据用 SSE（`text/event-stream`）解决，不需要引入 `ws` 依赖。**采用此方案。**

`permissions.network` 语义是"是否允许发起网络请求"，主要针对小程序主动对外 `fetch`。开一个只监听 loopback 的服务器本质是不同的能力（接受本机连接，不对外发任何请求），但为了让 Toolcase 的启用确认弹窗把"这个小程序会开放一个本地接口"如实告知用户，**仍然申请 `permissions.network: true`**，并在小程序描述里说明用途。这是一个可以讨论的判断，见 §6 待确认项。

## 3. 配对（Pairing）与鉴权

不能让本机任意进程免认证就调用 Finch 的 Session 能力，所以第一次连接必须走一次**用户在 Finch 窗口里点头确认**的配对流程，类似 `gh auth login` 的 device flow：

```
finch login
  │
  ├─▶ 1. 读取 ~/.finch/extension-data/finch-cli-bridge/endpoint.json
  │      拿到 { port, pid, startedAt }（明文、不含密钥，纯用于发现服务）
  │
  ├─▶ 2. POST /pair/request { clientName, clientId, scopes }
  │      桥接小程序调用 ctx.ui.showModalDialog() 在 Finch 里弹出：
  │      "终端 <clientName> 请求连接 Finch · 授权码 482-193 · 允许 / 拒绝"
  │
  ├─▶ 3. CLI 轮询 GET /pair/status/:pairingId（或直接长轮询挂起）
  │
  └─▶ 4. 用户点"允许"后，服务端生成一次性 opaque token，
         仅在这一次 status 响应里下发一次，随后从内存清除明文。
         CLI 写入 ~/.finch-cli/credentials.json（权限 600）。
```

要点：

- **Token 只在客户端和请求头里以明文出现，服务端只存哈希**（`ctx.secrets` 里存 `sha256(token)` + 元信息，key 走 `permissions.secrets: ["cli.token.*"]`）。
- 配对码 2 分钟过期；`/pair/request` 有基础限流，防止刷屏式弹窗骚扰。
- 小程序的统一设置菜单（`ctx.settingsMenu`）里列出所有已配对客户端（名称、配对时间、最近使用时间），支持单个撤销——这是用户唯一能"看见并收回"CLI 权限的地方。
- `finch logout` 调 `POST /pair/revoke` 自我注销；也可以在设置菜单里被动撤销，下次 CLI 请求会收到 `401 unauthorized`，需要重新 `finch login`。
- 所有非 `/healthz`、`/pair/*` 的请求必须带 `Authorization: Bearer <token>`；同时校验 `Host` 头必须是 `127.0.0.1:<port>` 或 `localhost:<port>`，防 DNS rebinding。

## 4. HTTP 协议规格

Base URL 从 `~/.finch/extension-data/finch-cli-bridge/endpoint.json` 读取，形如 `http://127.0.0.1:<port>`。`Content-Type: application/json; charset=utf-8`。

错误统一信封：

```json
{ "error": { "code": "unauthorized", "message": "token invalid or revoked" } }
```

`code` 取值：`unauthorized` `forbidden` `not_found` `invalid_request` `rate_limited` `upstream_timeout` `internal_error`。

| Method | Path | 鉴权 | 说明 | 对应 ctx API |
|---|---|---|---|---|
| GET | `/healthz` | 否 | 存活探针，返回 `{ ok, version, appVersion, pid }` | — |
| POST | `/pair/request` | 否 | 发起配对，触发弹窗 | `ctx.ui.showModalDialog` |
| GET | `/pair/status/:pairingId` | 否 | 轮询配对结果，`approved` 时一次性下发 token | — |
| POST | `/pair/revoke` | 是 | 撤销当前 token | — |
| GET | `/whoami` | 是 | 当前客户端身份/权限范围 | — |
| GET | `/status` | 是 | 应用版本、平台、助手名、未读会话 | `ctx.app.getInfo` / `ctx.status.get` |
| GET | `/spaces` | 是 | 列出 Space | `ctx.spaces.list` |
| GET | `/sessions` | 是 | 列出本小程序拥有的 Session | `ctx.sessions.list` |
| POST | `/sessions` | 是 | 创建 Session（`space.spaceId` 或都不传=普通对话，可带 `initialMessage`；此桥接未声明任何 `sessionContainers`，不支持 `containerId`） | `ctx.sessions.create` |
| GET | `/sessions/:id` | 是 | 单个 Session 详情 | `ctx.sessions.get` |
| POST | `/sessions/:id/messages` | 是 | 发消息；`wait:true` 时服务端阻塞到终态再返回 | `ctx.sessions.send` + `waitForTurn` |
| POST | `/sessions/:id/turns/:turnId/wait` | 是 | 等待指定 turn 终态 | `ctx.sessions.waitForTurn` |
| POST | `/sessions/:id/turns/:turnId/cancel` | 是 | 取消指定 turn | `ctx.sessions.cancelTurn` |
| GET | `/sessions/:id/events?after&limit` | 是 | 历史事件分页 | `ctx.sessions.listEvents` |
| GET | `/sessions/:id/events?stream=1` | 是 | SSE 实时事件流 | `ctx.sessions.onDidReceiveEvent` |
| GET | `/sessions/:id/waits` | 是 | 当前挂起的等待卡 | `ctx.sessions.listWaits` |
| GET | `/sessions/:id/waits/next?timeoutMs` | 是 | 长轮询下一张等待卡 | `ctx.sessions.waitForWait` |
| POST | `/sessions/:id/waits/:requestId/respond` | 是 | 应答权限卡/问题卡/表单卡 | `ctx.sessions.respondToWait` |
| POST | `/navigation/open-session` | 是 | 把 Finch 窗口切到指定 Session | `ctx.navigation.openSession` |
| GET | `/notifications/watch`（SSE） | 是 | 全局通知事件流 | `ctx.notifications.onDidPost` |

Session 相关能力完整覆盖 `reference/session.md` 里现成的请求-响应 + 等待卡语义，`respondToWait` 严格转发 `kind`，服务端不做任何"自动批准"逻辑——危险权限卡依然只能由用户在 Finch 窗口里亲自批准（`ctx.sessions.respondToWait` 的硬规则本来就这样限制）。

## 5. CLI 命令面（v1）

```
finch login                                   # 配对并保存 token
finch logout                                  # 撤销并清除本地 token
finch whoami                                   # 查看当前配对身份
finch status                                   # 应用版本/平台/未读会话
finch space list

finch session list [--include-archived]
finch session create [--space <id>] [--title <t>] [--message <text>] [--background]
finch session get <sessionId>
finch session send <sessionId> --message <text> [--wait] [--timeout 60]
finch session wait <sessionId> <turnId> [--timeout 60]
finch session cancel <sessionId> <turnId>
finch session events <sessionId> [--after <seq>] [--limit 100]
finch session watch <sessionId>               # SSE 实时打印到终端
finch session waits <sessionId>
finch session respond <sessionId> <requestId> --allow|--deny
finch session respond <sessionId> <requestId> --answer "标题=选项"
finch session respond <sessionId> <requestId> --form key=value [key=value ...]

finch open <sessionId>                        # 把 Finch 窗口切到该 Session
finch watch                                   # 全局通知事件流
```

**v1 有意不做**：

- 不代理 shell 执行——CLI 本身就在用户自己的终端里，没有必要绕一圈回 Finch 执行命令，这也是桥接小程序 `permissions.shell: false` 的原因。
- 不接触用户在 Finch 里的"普通 Composer 会话"——`ctx.sessions` 天然只能读写本小程序创建的 Session，这是平台强约束，不是我们能放开的。
- 不订阅全量 Agent 事件（`agentEvents:"full"`）——跨所有 Session 的完整对话内容属于高敏感信息，v1 先不申请这项权限。

## 6. 决策记录

1. **两包拆分**——已确认：`finch-cli-bridge`（小程序，走本仓库发布流程）+ `finch-cli`（普通 npm 全局 CLI 包，`npm i -g finch-cli`，`bin: finch`）。
2. **配对方式**——已确认：CLI 发起 → Finch 弹窗人工点头 → 一次性下发 token。
3. **`permissions.network: true`**——已确认申请，manifest 描述里如实说明用途。
4. **v1 命令范围**——已确认为 §5 列出的范围；待办、成果库、Memory 检索留到后续版本。

## 7. 实现落地时的小调整

- `finch-cli-bridge` 未声明任何 `contributes.sessionContainers`，所以 `/sessions` 不支持 `containerId`——CLI 创建的 Session 只能走 `space` 放置或普通对话（无容器也无 Space）。设计初稿里的 `finch session create --container <id>` 因此从命令面里去掉，改为只保留 `--space`。
- 撤销授权走小程序统一设置菜单（`ctx.settingsMenu`），每个已配对客户端一行 + 一个「撤销授权」按钮，图标是运行时注册的 Lucide `unlink-2` SVG（内置图标里没有合适的『断开连接』语义）。
- `finch-cli-bridge` 本地打包冒烟测试通过：`npm run build && npm pack` → `npx @finchtoys/minitools add <tarball>`，`npx @finchtoys/minitools doctor .` 无错误。

# FinchChan

Turn Finch's activity into a small, visible companion on a M5Stack StackChan (M5CoreS3) over your home LAN.

FinchChan sends only a finite pet state—never prompts, chat messages, tool inputs, paths, or tool results. It is an MVP bridge for the matching StackChan firmware.

## What you can do

- Automatically reflect Finch activity: `idle`, `thinking`, `working`, `waiting`, `happy`, and `error`.
- Pair one or more StackChan devices with a short-lived code.
- Send a short visible message or select a state from Finch.
- Revoke a paired device at any time.

## Install

Build and install the packed tarball (recommended for local testing):

```sh
npm install
npm run build
npm pack --pack-destination /tmp
npx @finchtoys/minitools add /tmp/finch-chan-0.1.0.tgz
```

Enable **FinchChan** in Toolcase. The bridge listens on `ws://0.0.0.0:8267`; find your Mac's LAN IP and use `ws://<mac-lan-ip>:8267` in the StackChan firmware.

## Pair a StackChan

1. Ensure Finch and the M5CoreS3 are on the same trusted LAN.
2. Ask Finch to call `finchchan_control` with `action=pair` and the StackChan's `device_id`.
3. The response contains a code valid for two minutes.
4. The device connects, sends `hello`, then sends `pair` with its id and code.
5. Finch returns a device token once. Firmware must persist that token and use `auth` on later connections.

Tokens are stored only in Finch secure storage. Non-sensitive device details (id, name, last seen, last acknowledged state) are stored separately in ordinary extension storage.

## Control API

Use one Agent tool: `finchchan_control`.

| Action | Required input | Result |
| --- | --- | --- |
| `status` | — | Bridge port, current state, known devices |
| `pair` | `device_id` | Two-minute pairing code |
| `say` | `text` | Sends up to 120 visible characters |
| `state` | `state` | Sets a finite pet state |
| `unpair` | `device_id` | Revokes the token and closes the connection |

The Composer bird button offers shortcuts, and the FinchChan settings menu lists paired devices with an unpair action.

## WebSocket protocol v1

All frames are JSON. The server accepts only this small protocol:

```jsonc
// Device -> Finch immediately after connection
{ "type": "hello", "protocol": 1, "deviceId": "m5cores3-abc", "name": "Desk bird", "firmware": "0.1.0" }
// Finch -> device
{ "type": "hello", "protocol": 1, "paired": false }

// Initial pairing, after the user created a code
{ "type": "pair", "deviceId": "m5cores3-abc", "code": "A1B2C3" }
// Token is sent only once; firmware persists it
{ "type": "paired", "token": "…" }

// Later connections
{ "type": "auth", "deviceId": "m5cores3-abc", "token": "…" }
{ "type": "auth", "ok": true }

// Finch -> authenticated device
{ "type": "command", "id": "uuid", "action": "state", "state": "thinking" }
{ "type": "command", "id": "uuid", "action": "say", "text": "Ready" }
// Device -> Finch (optional acknowledgement)
{ "type": "ack", "id": "uuid", "state": "thinking" }
{ "type": "ping" }
{ "type": "pong" }
```

Invalid frames receive `{ "type": "error", "code": "…" }`. The server does not accept arbitrary commands from devices. State broadcasts are deduplicated; repeated `idle` updates are throttled.

## Development and verification

```sh
npm run typecheck
npm run build
npm test
npm run doctor
```

`npm test` loads the bundled file and validates the public finite-state protocol helpers. Test on a trusted LAN only: WebSocket traffic is plaintext, while pairing tokens limit which devices receive commands.

---

# FinchChan（中文）

让 Finch 的活动状态通过家庭局域网变成 M5Stack StackChan（M5CoreS3）上的一只可见小宠物。

FinchChan 只发送有限的宠物状态，**绝不发送**提示词、对话正文、工具参数、文件路径或工具结果。这是配套 StackChan 固件使用的 MVP 桥接小程序。

## 可以做什么

- 自动映射 Finch 活动：`idle`、`thinking`、`working`、`waiting`、`happy`、`error`。
- 用短时配对码连接一个或多个 StackChan。
- 从 Finch 发送一段短显示文字，或手动设置宠物状态。
- 随时取消某台设备的配对。

## 安装

建议本地测试时先打包再安装：

```sh
npm install
npm run build
npm pack --pack-destination /tmp
npx @finchtoys/minitools add /tmp/finch-chan-0.1.0.tgz
```

在 Toolcase 启用 **FinchChan**。服务监听 `ws://0.0.0.0:8267`，同时监听 UDP `8266` 响应设备广播，
所以固件里**不用填 Mac 的局域网 IP**：宠物开机自己就会找到这台电脑（详见 `firmware/README.md` 的「配网」一章）。

## 配对流程

1. 确认 Finch 和 M5CoreS3 处于同一个可信局域网（宠物会广播找到本机，无需填 IP）。
2. 让 Finch 调用 `finchchan_control`，使用 `action=pair` 和 StackChan 的 `device_id`。
3. 获取两分钟有效的配对码。
4. 设备连接后发送 `hello`，再带设备 id 与配对码发送 `pair`。
5. Finch 仅返回一次设备 token。固件需要持久化它，并在之后重连时发送 `auth`。

Token 只保存于 Finch 的系统安全存储；设备 id、名称、最近在线时间和最近确认状态等非敏感信息保存于普通小程序存储。

## 控制方式

唯一的 Agent 工具是 `finchchan_control`：

| action | 必填输入 | 作用 |
| --- | --- | --- |
| `status` | — | 查看服务端口、当前状态与已知设备 |
| `pair` | `device_id` | 创建两分钟有效的配对码 |
| `say` | `text` | 向已连接设备发送最多 120 字符 |
| `state` | `state` | 设置有限宠物状态 |
| `unpair` | `device_id` | 撤销 token 并断开设备 |

Composer 的小鸟按钮提供快捷入口；FinchChan 设置菜单会列出设备并允许取消配对。

## 协议和验证

完整 v1 WebSocket JSON 协议见上方英文说明。无效帧会收到 `{ "type": "error", "code": "…" }`。服务器不会执行设备发来的任意命令；状态广播去重，重复 `idle` 会节流。

开发验证：

```sh
npm run typecheck
npm run build
npm test
npm run doctor
```

只应在可信局域网使用：WebSocket 流量本身未加密，但只有持有配对 token 的设备能接收控制指令。

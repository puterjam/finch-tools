# FinchChan 调研与实施方案

> 目标：让 M5Stack StackChan（M5CoreS3）成为 Finch 的实体宠物。FinchChan 小程序观察 Finch Agent 状态并通知硬件；Arduino 固件在设备上渲染 Petdex 动画、表达提醒、驱动灯光与安全的头部动作。
>
> 调研日期：2026-09-16

> [!NOTE]
> 本文是动手前的方案调研，**保留原样**。实现过程中有几处刻意偏离，以
> [`finch-chan/README.md`](finch-chan/README.md) 与
> [`finch-chan/firmware/README.md`](finch-chan/firmware/README.md) 为准：
>
> - **表情改为纯矢量绘制**（移植自用户自己的 muspi 项目，只用白色眼睛）。原计划的
>   Petdex RGB565 图集 + LittleFS 资源管线整个去掉：不再需要离线转码工具、
>   不需要烧写资源，也就不受图集许可牵制。
> - 固件目录就是 `finch-chan/firmware/`（不是文中的 `firmware/FinchChan/`）。
> - **配网**：热点 + captive portal，凭证存 NVS；不依赖编译期 SSID。
> - **桥接地址靠 UDP 广播自动发现**，不写死 Mac 的 IP。
> - **配对不用输入配对码**：Finch 发起后设备上弹确认卡片即可；配对码只留给串口。
> - 通知音由小程序侧合成/导入 PCM 后推给设备，固件不内置音频。

## 结论

**可行，建议拆为两个独立交付物：**

1. `finch-chan/`：Finch 小程序（TypeScript），维护配对、WebSocket 服务、Finch 事件归一化与设备状态。
2. `finch-chan/firmware/FinchChan/`：Arduino 固件，基于 StackChan-BSP，负责配网、长连接、Petdex 帧渲染、音效/LED/舵机表现。

首版使用 **设备主动连接 Mac 局域网 WebSocket 服务**：

```text
Finch Agent events/status/notifications
              │
              ▼
FinchChan mini tool
  ├─ 状态仲裁、去重、节流
  ├─ Pairing registry + device token
  └─ WebSocket server :32123
              ▲
              │ Wi‑Fi STA / WebSocket
              ▼
StackChan firmware
  ├─ WsTransport + reconnect
  ├─ command queue + state machine
  ├─ Petdex RGB565 renderer
  └─ StackChan-BSP: display / Motion / RGB / touch
```

这比 HTTP 轮询更即时、比 BLE 日常连接更简单；BLE 只在二期考虑用于首次配网。StackChan-BSP 不负责网络、音频资源或动画 UI，应只作为机身硬件抽象层复用。

## 已核实的基础能力

### StackChan / CoreS3

- CoreS3 为 ESP32-S3，双核 240 MHz、16 MB Flash、8 MB PSRAM、Wi‑Fi/BLE、320×240 触摸显示屏、microSD、1 W 扬声器与双麦克风。
- StackChan 机身有两个反馈舵机、12 个 RGB LED、三段触摸、电池监测和 NFC。
- BSP 的 `M5StackChan.begin()` 初始化机身；主循环必须调用 `M5StackChan.update()`。
- `M5StackChan.Display()` 返回 `LGFX_Device`，可直接用于 M5GFX 绘制；`Motion` 可驱动两轴舵机；另有 RGB、触摸、电量 API。
- BSP 本身**没有** Wi‑Fi / HTTP / WebSocket / BLE 封装、Petdex 动画解析、文件资源系统或 OTA 资源管理；这些由 FinchChan 固件自行实现。
- 官方 CI 当前以 `esp32:esp32@3.3.11`、`M5Unified` 和 `M5StackChan-BSP` 编译全部 Arduino 示例；首版锁定这组经过实机验证的版本。

舵机约束：yaw 范围为 `-1280..1280`（0.1°），pitch 为 `0..900`；官方建议 Y 轴常规动作只用 5–85°。网络命令**不得**携带原始角度或 PWM，只能选择固件白名单中的动作。

### Finch Pet 可复用的设计

`finch-pet` 是可工作的 Finch 小程序参考，不应成为 FinchChan 的运行时依赖。

可复用的部分：

- `ctx.events.onAgentEvent()`、`ctx.status.onDidChange()`、`ctx.notifications.onDidPost()` 三路输入与聚合状态兜底。
- Petdex 固定图集：**8 列 × 至少 9 行**，基准单帧 192×208；每行需要扫描有效帧，因末尾格可能是透明帧。
- 九态语义：`idle`、`running-right`、`running-left`、`waving`、`jumping`、`failed`、`waiting`、`running`、`review`。
- `loop` / `once` / `freeze` 播放模式、短暂状态自动回退、等待状态最高优先级的仲裁策略。
- 中英文 i18n key 的组织方式，以及 `runtime.phrases` 的语义分类。

不要复用：桌面 Canvas 窗口、Webview 画廊、MCP 宠物管理、Flappy Bird 和其音频资源。代码虽然是 MIT，但 Petdex 图集仍应按原作者许可处理；首发内置原创 FinchChan 角色，Petdex 仅提供用户主动导入。

## FinchChan 小程序设计

### 权限与边界

`finch-chan` 只申请实际需要的权限：

```json
{
  "permissions": {
    "network": true,
    "agentEvents": "sanitized",
    "secrets": ["devices.*"]
  }
}
```

实际 manifest 字段以当前 Mini Tool API 为准：Finch Pet 未申请 `agentEvents: full` 也能依据事件种类驱动宠物。FinchChan 不应读取、保存或发送 prompt、Assistant 正文、工具参数、文件路径和 Wi‑Fi 密码。配对 token 存 `ctx.secrets`，设备在线/偏好等非敏感状态存 `ctx.storage`。

小程序只注册一个常驻工具：

```text
finchchan_control
  status    查看设备、延迟、电量和当前状态
  pair      创建一次性配对码
  say       让指定设备显示短句
  state     手动播放受限宠物状态
  unpair    撤销设备授权
```

再提供一个 Composer action / Settings Menu，以及单个 Panel：显示设备在线状态、配对码、局域网 endpoint 和最近错误。`ws` 应作为构建期依赖由 esbuild bundle 到 `dist/index.js`，npm 包的运行时 `dependencies` 保持为空。

### 状态归一化与节流

优先级：`waiting` > `failed/review` 短暂反馈 > `running` > 本地触摸 > `idle`。

| Finch 输入 | 硬件表现 | 默认时长 |
|---|---|---:|
| user | `jumping` + 轻点头 | 800 ms |
| thinking | 当前会话 `waiting`，后台 `running` | 持续 |
| assistant_text / tool_use | `running` | 持续 |
| permission_request | `waiting` + “需要确认” | 持续 |
| result / background-done | `review` + 成功 LED | 4 s |
| retryable error | `waiting` | 持续 |
| final error | `failed` + 警示 LED | 5 s |
| interrupted | `idle` | 立即 |

只在**语义状态变化**时发送；同类事件做 100–300 ms debounce；完成、错误和高优先级通知可抢占循环动画。设备重连或发送 `ready` 后，小程序必须立即下发当前聚合状态快照，因为 Agent events 是 best-effort 而非可靠事件流。

### 协议 v1

所有业务帧为 UTF-8 JSON，最大 2 KB，未知字段忽略，未知类型回 `unsupported_type`。每条命令有 `id`，设备对同一 `id` 只执行一次。

```json
{
  "v": 1,
  "type": "pet.state",
  "id": "evt_01J...",
  "seq": 1042,
  "payload": {
    "state": "running",
    "mode": "loop",
    "ttlMs": 15000,
    "presentation": {
      "motion": "nod",
      "led": "#7357ff",
      "sound": "none"
    }
  }
}
```

设备上线：

```json
{
  "v": 1,
  "type": "hello",
  "id": "hello_01J...",
  "deviceId": "finchchan-a1b2c3",
  "payload": {
    "firmware": "0.1.0",
    "capabilities": ["petdex-rgb565", "led", "servo", "audio"],
    "bootId": "boot-..."
  }
}
```

回执：`ack { refId, accepted, queueDepth }`；运行状态：`status { state, animation, batteryPct, rssi, lastError }`；每 20 秒 `ping/pong`。普通状态若未在 `ttlMs` 前执行就丢弃；`done/error/waiting` 可覆盖可中断的动画。

## 固件设计（Arduino）

```text
firmware/FinchChan/
  FinchChan.ino                 # setup / loop / task startup
  src/
    app_state.{h,cpp}           # 宠物优先级、TTL、去重
    transport.{h,cpp}           # Wi‑Fi, WS, pairing, heartbeat, retry
    protocol.{h,cpp}            # JSON schema validation, envelopes
    renderer.{h,cpp}            # RGB565 frame draw + speech overlay
    motion_director.{h,cpp}     # 安全动作白名单
    feedback.{h,cpp}            # RGB / beep / battery mapping
    provision.{h,cpp}           # SoftAP captive portal
    asset_store.{h,cpp}         # LittleFS / microSD abstraction
  data/pets/finchchan/          # 转换后的宠物资源
  tools/petdex-convert.mjs      # 图集离线转码工具
```

建议 Arduino 依赖：`M5StackChan-BSP`、`M5Unified`、`WebSocketsClient`、`ArduinoJson`。所有网络回调只校验并投递 `PetCommand` 到有界 FreeRTOS 队列；渲染、音频和 `M5StackChan.Motion` 在主任务/专用任务执行，不能在 WebSocket 回调里阻塞。

### Petdex 资源管线

原始 Petdex 图集典型尺寸为 1536×1872 RGBA，解码约 11.5 MB，不能在 ESP32 运行时处理 WebP。构建期转换：

1. 读取 PNG/WebP 图集，按 8×9 切片，扫描每行有效帧。
2. 缩放为 **96×104**（必要时加透明背景），转换为 RGB565。
3. 每个状态写为连续二进制帧文件，并生成 `pet.json`：帧数、FPS、每帧偏移、CRC32。
4. 固件预分配一个 96×104 的 PSRAM buffer（约 20 KB），逐帧读取、`pushImage()` 输出。

72 帧 RGB565 约 1.44 MB，适合分配给 LittleFS 的 16 MB Flash 或放到 microSD。首版推荐 LittleFS 内置原创宠物，同时保留 microSD 资产适配层；图集导入、网络下载和 OTA 资源包放二期。

### 设备状态机与配网

```text
BOOT → WIFI_CONNECTING → WS_CONNECTING → ONLINE_IDLE
                   │              │             │
                   ▼              ▼             ▼
              PROVISIONING     BACKOFF      ANIMATING
```

- 未配网或长按机身触摸区 5 秒：进入 `PROVISIONING`，临时 SoftAP / Captive Portal 收集 Wi‑Fi、Mac endpoint 与一次性配对码；10 分钟超时关闭。
- `pair` 工具产生单次、10 分钟有效的 10 位配对码。设备加入 WLAN 后用该码连接；服务端验证成功后生成 256-bit device token，设备 NVS 保存、Finch Keychain 保存。
- 正常连接在 WS handshake 使用 `Authorization: Bearer <device-token>`；失败使用指数退避（1, 2, 4, 8, 16, 30 秒 + 抖动）。
- MVP 仅允许可信家庭 LAN。发布版升级到 WSS（本地 CA / public-key pinning）；没有 TLS 时可增加 HMAC + nonce 防伪造和重放，但它**不防窃听**。
- 初版手工填写/显示 Mac 的 LAN IP；二期加入 mDNS 的 `finchchan.local` 服务发现，避免 DHCP 换址。

## 开发顺序与验收

### P0：链路 PoC（先完成）

1. 新建 `finch-chan` 小程序骨架，使用 mock WebSocket client 测试 `onAgentEvent → state` 映射。
2. Arduino sketch：连 Wi‑Fi、连接固定 WebSocket 地址、显示 `idle/running/review` 三种内建矢量表情。
3. 建立 `hello/welcome/pet.state/ack/ping` 协议测试，验证 Mac 防火墙、休眠、切网和重连。
4. 接入 `M5StackChan.Motion`、RGB 和触摸；所有动作经固定白名单与 Y 轴限位。

**P0 验收**：在 Finch 中发起一次工具调用，StackChan 500 ms 内进入工作状态；结果出现后播放完成动画；断网与 Finch 重启后自行回到在线状态。

### P1：可用产品

- Panel 配对流程、一次性设备 token、在线/电量/错误显示。
- 完整九态、原创 8×9 Petdex 兼容图集、RGB565 转换工具。
- i18n（`en-US` / `zh-CN`）、短句提醒、LED 和安全的点头/挥手动作。
- 单元测试：协议 schema、TTL、去重、优先级；固件串口模拟器测试乱序与重发。

### P2：增强

- mDNS、WSS、OTA（固件与资源分区分开）、microSD 宠物包。
- BLE Unified Provisioning + PoP；多宠物、多设备；用户触摸事件回传 Finch。
- 语音/TTS：先短 WAV 提示音，后置网络流和语音识别。

## 主要风险

1. **Mac 可达性**：防火墙、睡眠和 IP 变化是首要集成风险；P0 必须先验证。
2. **资源与帧率**：禁用设备端 WebP/GIF 解码，RGB565 离线转码、固定 buffer、局部重绘。
3. **机械安全**：任何远程输入不得直控角度/速度；动作只能来自固件白名单。
4. **事件可靠性**：不能单靠离散 Agent events；需 status snapshot、心跳、重连同步。
5. **隐私**：只传状态枚举与本地化短提示，禁止传对话/文件/密钥；token 不进日志。
6. **许可证**：StackChan-BSP 和 Finch Pet 代码均为 MIT；第三方 Petdex 图集与 Flappy Bird 资源不随之获得再分发权。

## 一手参考

- [StackChan-BSP](https://github.com/m5stack/StackChan-BSP)：BSP、`M5StackChan.h`、Servo/RGB/Touch 示例，MIT。
- [M5Stack StackChan 文档](https://docs.m5stack.com/en/StackChan)：CoreS3、机身外设、Arduino/PlatformIO/ESP-IDF 支持。
- [StackChan Arduino Servo 文档](https://docs.m5stack.com/en/arduino/stackchan/servo)：动作 API、角度与 Y 轴安全范围。
- [Finch Pet](https://github.com/Kassell/finch-pet)：Petdex 格式、`runtime-status.ts`、事件状态机与 i18n 参考，MIT。
- [Espressif Unified Provisioning](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/provisioning/provisioning.html)：SoftAP/BLE、安全配网与 PoP。

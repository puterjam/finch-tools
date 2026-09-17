# FinchChan 固件烧录指南

给**使用者**看的：怎么准备编译环境、怎么把固件刷进 StackChan。
想改代码、看内部实现，请转 [`firmware/README.md`](firmware/README.md)。

---

## 1. 需要什么

**硬件**

- M5Stack **CoreS3** + **StackChan** 底座（带舵机头和顶部触摸盖）
- 一根**能传数据**的 USB-C 线（只能充电的线会让电脑认不到串口）
- 电脑：macOS / Windows / Linux 都行

**软件**

- [Arduino CLI](https://arduino.github.io/arduino-cli/) 或 **Arduino IDE 2.x**（自带一份 arduino-cli）
- ESP32 工具链不用自己装，装 core 的时候会一起下来（约 400 MB，第一次慢一点）

---

## 2. 准备环境（一次就好）

### 2.1 装 Arduino CLI

```sh
# macOS
brew install arduino-cli
# Windows: winget install ArduinoSA.CLI   （或从官网下载解压）
# 验证
arduino-cli version
```

> 只想用 Arduino IDE 也行：`tools/build.sh` 和 `tools/flash-all.sh` 会自动去找 IDE 里自带的那份
> arduino-cli（macOS 路径：`/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli`），
> 也可以用 `ARDUINO_CLI=/path/to/arduino-cli` 指定。

### 2.2 装平台（M5Stack 的 ESP32 core）

```sh
arduino-cli config init          # 第一次用才需要
arduino-cli config add board_manager.additional_urls \
  https://static-cdn.m5stack.com/resource/arduino/package_m5stack_index.json
arduino-cli core update-index
arduino-cli core install m5stack:esp32@3.3.9
```

> ⚠️ 版本要 **3.3.9**，和 `firmware/sketch.yaml` 里记的一致。

### 2.3 装库（版本要对上）

```sh
arduino-cli lib install "M5Unified@0.2.20"
arduino-cli lib install "ArduinoWebsockets@0.5.4"
arduino-cli lib install "ArduinoJson@7.4.3"
arduino-cli lib install "M5StackChan@1.0.1"
```

> ⚠️ **M5Unified 必须是 0.2.20**。0.2.21 及以后和 StackChan BSP 1.0.1 不兼容，
> 编译能过但跑起来舵机会乱抽。M5GFX / M5HAL / M5Utility 是它的依赖，会自动装上。
>
> `firmware/sketch.yaml` 记录了这套版本，理论上可以 `arduino-cli compile --profile m5stack-cores3 firmware`
> 让 CLI 自动拉齐；实测拉平台那步会报 `platform not found`，所以推荐按上面手动装。

### 2.4 本地配置（可选）

```sh
cd finch-chan/firmware
cp config.h.example config.h
```

`config.h` 是**本地文件、不进 git**（里面可能放你的 WiFi 密码之类）。常改的几项：

| 宏 | 默认 | 说明 |
| --- | --- | --- |
| `FINCHCHAN_AP_PASSWORD` | `""` | 配网热点的密码。留空 = 开放热点，配网最省事 |
| `FINCHCHAN_FIRMWARE_VERSION` | `0.3.0` | 版本号，编译产物按它命名 |
| `FINCHCHAN_WS_HOST` | `""` | 写死桥接地址。一般不用留空，设备会 UDP 广播自动找电脑 |
| `FINCHCHAN_DISCOVERY_PORT` | `8266` | 自动发现的广播端口 |
| `FINCHCHAN_MOTION_TRACE` | `0` | 改成 1 会逐帧打印头部动作，只用于调动作 |

---

## 3. 编译

```sh
cd finch-chan
bash tools/build.sh
```

产物都会落到 **`firmware/release/`**，文件名带版本号，好区分：

```
firmware/release/
  finchchan-0.3.0.bin         1.9 MB   应用镜像 —— 平时升级刷这个（偏移 0x10000）
  finchchan-0.3.0-full.bin     16 MB   整机镜像 —— 含 bootloader + 分区表（偏移 0x0），救砖/换芯片用
  finchchan-0.3.0.txt                  清单：版本、库版本、大小、SHA256、烧录命令
  finchchan-0.3.0.elf         25 MB    调试符号（只有加 --elf 才生成）
```

- 版本号取自 `firmware/config.h` 的 `FINCHCHAN_FIRMWARE_VERSION`
- `bash tools/build.sh --no-full` 不生成 16 MB 整机镜像（省磁盘）
- `bash tools/build.sh --elf` 额外保留调试符号（串口崩了要 `addr2line` 的时候用）

编译成功会打印占用情况，正常长这样：

```
Sketch uses 2027555 bytes (64%) of program storage space. Maximum is 3145728 bytes.
Global variables use 71760 bytes (21%) of dynamic memory, leaving 255920 bytes for local variables.
```

> `firmware/release/` 不进 git（`.gitignore` 里挡着），是本地归档。

---

## 4. 刷进设备

### 方式 A：一条命令（推荐）

```sh
cd finch-chan
bash tools/flash-all.sh                       # 自动挑 /dev/cu.usbmodem*
bash tools/flash-all.sh /dev/cu.usbmodem11101 # 或手动指定串口
```

脚本做两件事：编译 → 通过 USB 上传。

**刷之前：**

1. 让设备进**下载模式**：按住侧面的 **RST** 键不放 → 插上 USB → 松开
2. **关掉串口监视器**（串口被占用时上传一定失败）

macOS 上看串口：`ls /dev/cu.usbmodem*`

### 方式 B：用编译好的 release 镜像

适合不想装整套工具链、或者要重复刷同一版本：

```sh
# 应用镜像（常规升级）
esptool --chip esp32s3 --port /dev/cu.usbmodem11101 write_flash 0x10000 finchchan-0.3.0.bin

# 整机镜像（设备变砖 / 换了芯片）
esptool --chip esp32s3 --port /dev/cu.usbmodem11101 write_flash 0x0 finchchan-0.3.0-full.bin
```

> 地址说明：ESP32-S3 的 bootloader 在 `0x0`、分区表在 `0x8000`、应用在 `0x10000`。
> `full` 镜像把前两段都含进去了，所以从 `0x0` 刷；单独刷应用镜像时从 `0x10000` 刷。

### 方式 C：M5Burner / 网页刷机工具

把 `finchchan-<ver>-full.bin` 拖进 M5Burner，或用
[esptool-js](https://espressif.github.io/esptool-js/)（地址填 `0x0`）—— 适合在没有 Arduino 环境的电脑上刷。

---

## 5. 刷完怎么用起来

**第一步：配网**（新设备或换了 WiFi 才需要）

1. 设备开机后自己开一个热点，名字是 **`FinchChan-XXXX`**（XXXX 是它 MAC 的后四位）
2. 手机连上这个热点，通常会自动跳出配网页；没跳就浏览器打开 **`192.168.4.1`**
3. 选你家/公司的 WiFi、填密码、保存 → 设备重启并连上
4. 连不上会自动退回配网模式，可以重来

> 以后要换 WiFi：Finch 设置菜单 →「重新配网」，或者串口里敲 `wifi-reset`。

**第二步：和 Finch 配对**

1. 电脑和设备连**同一个 WiFi**（桥接用的是局域网 WebSocket，不经过公网）
2. Finch 里打开 **设置 → FinchChan → 设备那一行点「配对」**（FinchChan 小程序需要先启用）
3. 设备屏幕上会弹出「确认 / 取消」，按一下**确认**即可（不需要输配对码）

**第三步：看状态**

串口监视器（115200）：

```sh
arduino-cli monitor -p /dev/cu.usbmodem11101 --config baudrate=115200
```

敲 `status` 回车，能看到：

```
[finchchan] wifi=connected ip=192.168.1.23 ssid=PJHome rssi=-52
[finchchan] bridge=192.168.1.5:8267 relay=connected paired=yes
[finchchan] music=off gain=mid beat=on
```

日常可用的快捷操作：

| 操作 | 效果 |
| --- | --- |
| 短按设备 **PWR** 键 | 开/关律动模式（麦克风频谱 + 跟拍点头） |
| 拍一下头 / 摸顶盖 | 亲昵反应（爱心眼 + 摇头），睡着时会唤醒 |
| 点卡片上的按钮 | 直接作答（允许 / 拒绝 / 去回复），答完卡片才收起 |
| **点表情或空白处**（有卡片时） | **跳去 Finch 打开这张卡片所属的会话**，先看清到底在问什么；卡片会留着，回来再答或干脆在桌面端答 |
| 点屏幕 / 顶盖前区 | 有等待卡片时=同意；有未读时=打开会话；睡着时=唤醒 |
| 顶盖中区（有卡片时） | 等于卡片上的「去回复」：同样跳去对应会话 |
| 串口 `status` / `pair <code>` / `wifi-reset` | 查状态 / 手动配对 / 清 WiFi 重配 |

---

## 6. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 找不到串口 | 换一根**能传数据**的 USB 线；确认在下载模式（按住 RST 插 USB）；`ls /dev/cu.usbmodem*` |
| 上传报 `port is busy` / 超时 | 串口监视器没关，或别的程序占着串口 |
| 编译报 M5Unified / StackChan 相关错误 | 库版本不对，确认 M5Unified 是 **0.2.20** |
| 编译报 `platform not found` | 没装 M5Stack 的 core，或没加 `board_manager.additional_urls`（见 2.2） |
| 屏幕一直白/黑，没有表情 | 先看串口有没有 `FinchChan x.y.z booting`；没有就是程序没起来 → 刷一次 `-full.bin` |
| 头一直往下垂、软塌塌 | 老固件的问题，0.2.1 起已修（关掉了 BSP 的自动松力）；升级固件即可 |
| 频谱一直是平的 | 麦克风没起来（串口 `[audio] mic NOT available`），或灵敏度太低 → 设置菜单里调「收音灵敏度」 |
| 提示音不出声 / 爆音 | 在设置菜单里把「律动模式」开关一次（让扬声器重装 I2S）；串口应出现 `[audio] speaker re-init` |
| 设备连不上桥接 | 确认电脑和设备**同一个 WiFi**；串口 `status` 看 `relay=connected`；访客网络/AP 隔离会挡住 UDP 广播 |
| 电量图标读不到 | 没接电池或 PMIC 读不出时为「－」；串口会有 `[power] battery=` 日志 |
| 想彻底重置 | 串口 `wifi-reset`（清 WiFi 凭证并重启进配网）；配对关系在 Finch 侧取消 |

---

## 7. 从零再来一遍

```sh
arduino-cli cache clean            # 可选：清掉编译缓存
cd finch-chan
bash tools/build.sh                # 编译 + 归档到 firmware/release/
bash tools/flash-all.sh            # 刷进去
```

---

## 附：版本与依赖一览

| 项 | 版本 |
| --- | --- |
| 开发板 | M5Stack CoreS3 + StackChan 底座 |
| FQBN | `m5stack:esp32:m5stack_cores3` |
| 平台（core） | `m5stack:esp32` **3.3.9** |
| M5Unified | **0.2.20**（必须，别升级） |
| M5StackChan（BSP） | 1.0.1 |
| ArduinoWebsockets | 0.5.4 |
| ArduinoJson | 7.x（本机 7.4.3；`sketch.yaml` 里钉的是 7.0.4，都能编译） |
| 串口波特率 | 115200 |

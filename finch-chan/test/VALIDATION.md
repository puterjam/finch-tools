# FinchChan 验收与硬件诊断

## 当前诊断结论（2026-09-16）

- 串口 `/dev/cu.usbmodem13201` 存在，权限为 `crw-rw-rw-`；USB 枚举为 **Espressif USB JTAG/serial debug unit**（VID `0x303a`）。
- `arduino-cli` 未加入 shell `PATH`，但 Arduino IDE 内置可执行文件存在：
  `/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli`。
- 内置 CLI：`arduino-cli 1.5.1`；已安装 `m5stack:esp32 3.3.9`，目标 FQBN 已确认：`m5stack:esp32:m5stack_cores3`。
- 设备侧库已安装于 `/Users/puterjam/Documents/Arduino/libraries/`：`M5Unified`、`M5GFX`、`M5StackChan`，另有 M5Utility/M5HAL 等依赖库。
- 未发现 PlatformIO 环境。ESP 工具可见于 `~/Library/Arduino15/packages/m5stack/tools/esptool_py/5.3.0/esptool`。
- 本次只读诊断；没有连接、擦除、编译或上传设备。

## 资源转换验收

转换器：`tools/petdex-to-rgb565.mjs`，零 npm 依赖，Node.js 内置 `zlib` 解码 PNG。

```sh
node tools/petdex-to-rgb565.mjs <sheet.png> <output-dir> [states.json]
node --test test/petdex-to-rgb565.test.mjs
```

输入为非交错、8-bit RGB/RGBA PNG，尺寸必须可被 **8×9** 整除。每个格子按最近邻缩放为 96×104，连续输出 `pet.rgb565`（RGB565 little-endian）；输出 `pet.json` 包含：`state`、`frames`、`fps`、字节 `offset`、`bytes`、全资源 `crc32`。单帧恒为 `96 × 104 × 2 = 19968` bytes。

状态配置例：

```json
{"states":[{"state":"idle","row":0,"startCol":0,"frames":4,"fps":6}]}
```

`row` / `startCol` 均从 0 开始；未提供配置时，转换器导出每一行的全部八帧，状态名为 `row-0` 至 `row-8`。`test/fixtures/sample-config.json` 是可直接复用的映射示例。单测以确定性的生成 PNG fixture 覆盖状态裁剪、RGB565LE 像素、offset、CRC32 和非法网格拒绝。

## 构建与上传链路（人工执行）

从项目根目录运行，使用绝对 CLI 路径避免 PATH 问题：

```sh
CLI='/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli'
"$CLI" compile --fqbn m5stack:esp32:m5stack_cores3 firmware
"$CLI" upload --fqbn m5stack:esp32:m5stack_cores3 --port /dev/cu.usbmodem13201 firmware
```

上传前应关闭 Arduino IDE Serial Monitor、`screen` 或其他占用该端口的进程。若设备重启导致节点变化，先执行：

```sh
"$CLI" board list
```

然后替换 `--port`。上传是外部、可改变设备的操作，需在设备连接稳定、固件目录准备完成后由操作者明确执行。

## 端到端验收清单

1. 使用实际 Petdex PNG 与状态配置运行转换器；检查 `pet.json.crc32`、状态帧数及每个 `offset` 均为 19,968 的倍数。
2. 将 `pet.rgb565` / `pet.json` 放到固件约定的数据位置，并让固件按 `offset` 读取帧；屏幕应显示 96×104 图像且红/绿/蓝无字节序颠倒。
3. 以 `m5stack:esp32:m5stack_cores3` 编译固件；编译日志不得有缺失 M5StackChan/M5Unified 头文件。
4. 在用户授权后上传到 `/dev/cu.usbmodem13201`；确认启动日志和屏幕基础 idle 状态。
5. 启动小程序 WebSocket 服务，确认 M5CoreS3 接入同一局域网并连到服务器。
6. 依次发送约定状态（至少 idle、thinking、working、error）；确认设备在一个 fps 周期内切换对应帧组，断连时回退 idle 或固件定义的安全状态。
7. 断开 Wi-Fi/服务端后恢复网络；确认设备能重连且不会卡死或持续显示半帧。

## 已知限制

- PNG 解码器刻意只支持 Petdex 常见的非交错 8-bit RGB/RGBA；调色板、16-bit 和 Adam7 PNG 会明确报错，应先用图像工具转为 RGBA PNG。
- 仓库在本任务开始时没有 `finch-chan` 目录及固件源；因此无法做真实固件编译或上传验证。工具测试已通过，但步骤 2–7 需在固件和小程序实现合并后执行。

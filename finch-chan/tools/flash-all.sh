#!/usr/bin/env bash
# 编译并上传 FinchChan 固件。
#
# 用法: bash tools/flash-all.sh [串口]
# 先把 StackChan 切到下载模式（按住 RST → 插 USB → 松开）。
set -euo pipefail

PORT="${1:-}"
if [ -z "$PORT" ] || [ ! -e "$PORT" ]; then
  # 串口号会随 USB 口/重启变化（如 13201 → 11101），自动挑第一个 usbmodem 设备。
  PORT="$(ls /dev/cu.usbmodem* 2>/dev/null | head -1)"
fi
if [ -z "$PORT" ]; then
  echo "没有找到 /dev/cu.usbmodem* 设备，请确认开发板已连接并进入下载模式。"
  exit 1
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARDUINO_CLI="/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli"
FQBN="m5stack:esp32:m5stack_cores3"

cd "$ROOT"

echo "==> 编译并上传固件到 $PORT"
"$ARDUINO_CLI" compile --fqbn "$FQBN" -u -p "$PORT" firmware

echo "完成。表情、气泡、LED 动效与等待卡片都会随固件一起生效（无额外资源需要烧写）。"

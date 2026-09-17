#!/usr/bin/env bash
# 编译 FinchChan 固件，并把产物按版本归档到 firmware/release/。
#
# 用法:
#   bash tools/build.sh              # 编译当前源码
#   bash tools/build.sh --no-full    # 不生成 16MB 整机镜像（省磁盘）
#   bash tools/build.sh --elf        # 额外保留 25MB 调试符号（排查崩溃时用 addr2line）
#
# 产物（VERSION 取自 firmware/config.h 的 FINCHCHAN_FIRMWARE_VERSION）:
#   firmware/release/finchchan-<ver>.bin        应用镜像，常规升级刷这个（16 进制 0x10000）
#   firmware/release/finchchan-<ver>-full.bin   整机镜像，含 bootloader + 分区表（0x0）
#   firmware/release/finchchan-<ver>.txt        版本 / 库版本 / 大小 / SHA256 / 烧录命令
#   firmware/release/finchchan-<ver>.elf        调试符号（仅 --elf）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKETCH="$ROOT/firmware"
RELEASE="$SKETCH/release"
FQBN="m5stack:esp32:m5stack_cores3"
FULL=1
ELF=0

for arg in "$@"; do
  case "$arg" in
    --no-full) FULL=0 ;;
    --elf) ELF=1 ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数: $arg" >&2; exit 1 ;;
  esac
done

# arduino-cli：优先 $ARDUINO_CLI，其次 PATH，最后用 Arduino IDE 自带的那个。
if [ -z "${ARDUINO_CLI:-}" ]; then
  if command -v arduino-cli >/dev/null 2>&1; then
    ARDUINO_CLI="$(command -v arduino-cli)"
  else
    ARDUINO_CLI="/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli"
  fi
fi
if [ ! -x "$ARDUINO_CLI" ]; then
  echo "找不到 arduino-cli。装一个，或用 ARDUINO_CLI=/path/to/arduino-cli 指定。" >&2
  exit 1
fi

# 版本号：config.h 是本地文件（不进 git），缺了就退回 config.h.example。
# 用 awk 取第三个字段：BSD sed 不支持 \+
VERSION=""
for header in "$SKETCH/config.h" "$SKETCH/config.h.example"; do
  if [ -f "$header" ]; then
    VERSION="$(awk '/^#define[ \t]+FINCHCHAN_FIRMWARE_VERSION/ { gsub(/"/, "", $3); print $3; exit }' "$header")"
    [ -n "$VERSION" ] && break
  fi
done
if [ -z "$VERSION" ]; then
  echo "读不到 FINCHCHAN_FIRMWARE_VERSION（看 firmware/config.h 或 config.h.example）" >&2
  exit 1
fi

NAME="finchchan-$VERSION"
BUILD="$RELEASE/.build"
rm -rf "$BUILD"
mkdir -p "$RELEASE" "$BUILD"

echo "==> 编译 $NAME  ($FQBN)"
"$ARDUINO_CLI" compile --fqbn "$FQBN" --output-dir "$BUILD" "$SKETCH"

cp "$BUILD/firmware.ino.bin" "$RELEASE/$NAME.bin"
[ "$ELF" = "1" ] && cp "$BUILD/firmware.ino.elf" "$RELEASE/$NAME.elf"
if [ "$FULL" = "1" ] && [ -f "$BUILD/firmware.ino.merged.bin" ]; then
  cp "$BUILD/firmware.ino.merged.bin" "$RELEASE/$NAME-full.bin"
fi

# 一份可读的清单：出问题时把版本、库版本、哈希贴出来就够定位了。
{
  echo "FinchChan firmware $VERSION"
  echo "built-at: $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "fqbn: $FQBN"
  echo "arduino-cli: $("$ARDUINO_CLI" version)"
  echo "libs:"
  "$ARDUINO_CLI" lib list 2>/dev/null | awk '$1 ~ /^(M5Unified|M5GFX|M5HAL|M5Utility|ArduinoWebsockets|ArduinoJson|M5StackChan)$/ {printf "  %s %s\n", $1, $2}'
  echo "artifacts:"
  (cd "$RELEASE" && for file in "$NAME.bin" "$NAME-full.bin" "$NAME.elf"; do
    [ -f "$file" ] && shasum -a 256 "$file" | sed 's/^/  /'
  done)
  echo "sizes:"
  (cd "$RELEASE" && for file in "$NAME.bin" "$NAME-full.bin" "$NAME.elf"; do
    [ -f "$file" ] && printf '  %-34s %s bytes\n' "$file" "$(wc -c < "$file" | tr -d ' ')"
  done)
  echo
  echo "flash (app only):   esptool --chip esp32s3 write_flash 0x10000 $NAME.bin"
  echo "flash (full image): esptool --chip esp32s3 write_flash 0x0 $NAME-full.bin"
  echo "or just: bash tools/flash-all.sh [port]"
} > "$RELEASE/$NAME.txt"

rm -rf "$BUILD"

echo "==> 已归档到 firmware/release/："
(cd "$RELEASE" && ls -1sh "$NAME"*.bin "$NAME".elf 2>/dev/null | sed 's/^/    /')

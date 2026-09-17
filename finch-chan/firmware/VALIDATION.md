# FinchChan firmware validation

Date: 2026-09-16

## Build verification: passed

The firmware compiled successfully for `m5stack:esp32:m5stack_cores3`.

- Flash: **1,324,903 bytes / 3,145,728 bytes (42%)**.
- RAM: **71,472 bytes / 327,680 bytes (21%)**.
- Toolchain: M5Stack ESP32 core 3.3.9.
- Libraries: M5StackChan 1.0.1, M5Unified 0.2.20, M5GFX 0.2.29, ArduinoWebsockets 0.5.4, ArduinoJson 7.4.3.
- `M5Unified 0.2.21+` is deliberately excluded because its IO expander API is incompatible with StackChan-BSP 1.0.1.
- On Apple Silicon, the bundled x86_64 Arduino `ctags` executable was retained as `ctags.x86_64` and replaced with a symlink to Homebrew `universal-ctags` for local compilation.

## Static verification: passed

- `firmware.ino` is a same-named Arduino CLI entry file; all implementation files in `src/` are compiled exactly once.
- The WebSocket protocol uses v1 `hello`, `pair`/`auth`, and authenticated `command` frames. Device tokens are stored in ESP32 NVS.
- `CommandQueue` is fixed-size (eight entries) and is the only callback-to-loop handoff.
- Petdex assets are optional LittleFS files (`pet.json`, `pet.rgb565`); the vector face remains a fallback.
- `config.h` is ignored by Git. It contains local Wi-Fi and pairing values only.

## Not performed

- No upload was attempted.
- The serial device `/dev/cu.usbmodem13201` was not opened.
- Real Wi-Fi pairing, LittleFS asset upload, motion, LEDs, and display behavior still require physical-device smoke testing.

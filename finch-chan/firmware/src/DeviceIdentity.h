#pragma once

#include <Arduino.h>

#include "config.h"

/**
 * 设备身份（id / 热点名 / 显示名）。
 *
 * 都从芯片 MAC 低 16 位派生，所以：
 *   - 同一台设备每次开机一致，不同设备不会撞；
 *   - 不需要在 config.h 里手工维护（FINCHCHAN_DEVICE_ID 留空即可自动生成）。
 * 例子：finchchan-A3F1、热点 FinchChan-A3F1。
 */
inline const char* finchchanMacSuffix() {
  static char suffix[5] = {};
  if (!suffix[0]) {
    snprintf(suffix, sizeof(suffix), "%04X", static_cast<uint16_t>(ESP.getEfuseMac() & 0xFFFF));
  }
  return suffix;
}

/** 设备 id：`finchchan-XXXX`；config.h 里填了 FINCHCHAN_DEVICE_ID 时以它为准（调试用）。 */
inline const char* finchchanDeviceId() {
  static char id[40] = {};
  if (!id[0]) {
    if (strlen(FINCHCHAN_DEVICE_ID)) {
      strlcpy(id, FINCHCHAN_DEVICE_ID, sizeof(id));
    } else {
      snprintf(id, sizeof(id), "finchchan-%s", finchchanMacSuffix());
    }
  }
  return id;
}

/** 配网热点名：`FinchChan-XXXX`。 */
inline const char* finchchanApName() {
  static char name[24] = {};
  if (!name[0]) {
    snprintf(name, sizeof(name), "FinchChan-%s", finchchanMacSuffix());
  }
  return name;
}

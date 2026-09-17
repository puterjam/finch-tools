#include "StackChanRuntime.h"

#include <WiFi.h>

void StackChanRuntime::begin() {
  M5StackChan.begin();
  /*
   * BSP 默认开着「静止 200ms 就松开舵机扭矩」（servo.h: _auto_torque_release_enabled = true）。
   * 扭矩一松，头就会在重力下自己掉下去——睡着、发呆时看到的“突然位移”就是它。
   * 桌面宠物不需要省这点电，直接关掉并保持扭矩；否则任何静止姿态都是假的。
   */
  M5StackChan.Motion.setAutoTorqueReleaseEnabled(false);
  M5StackChan.Motion.setTorqueEnabled(true);
  Serial.println("[motion] auto torque release disabled, torque held");
}

void StackChanRuntime::update() {
  M5StackChan.update();
}

void StackChanRuntime::setPowerSave(bool enabled, bool deep) {
  const bool nextDeep = enabled && deep;
  if (enabled == powerSave_ && nextDeep == deepSave_) return;
  powerSave_ = enabled;
  deepSave_ = nextDeep;
  if (enabled) {
    // modem sleep：仍能收到 WS 消息（延迟略增），但射频大部分时间在睡。
    WiFi.setSleep(true);
    M5.Power.setLed(0);   // 熄掉电源 LED
    if (nextDeep) setCpuFrequencyMhz(80);   // 熄屏时几乎不渲染，降频很安全
  } else {
    if (deepSave_) setCpuFrequencyMhz(240);
    WiFi.setSleep(false);   // 醒来后要低延迟：命令、气泡、卡片都靠它
    M5.Power.setLed(255);
  }
  Serial.printf("[power] save=%d deep=%d cpu=%uMHz\n", enabled ? 1 : 0, nextDeep ? 1 : 0,
                static_cast<unsigned>(getCpuFrequencyMhz()));
}

#pragma once
#include <M5StackChan.h>

// Keeps StackChan-BSP's lifecycle alive while FinchChan renders its own vector face.
// The renderer intentionally avoids WebP/Petdex image assets.
class StackChanRuntime {
 public:
  void begin();
  void update();
  /**
   * 待机降功耗。
   * `enabled` 时开 WiFi modem sleep + 熄电源 LED（连接不断，只是响应略慢）；
   * `deep` 额外把 CPU 降到 80MHz（只在熄屏后用，那时几乎不渲染）。
   * 唤醒时传 false，立即恢复全速与低延迟。
   */
  void setPowerSave(bool enabled, bool deep = false);

 private:
  bool powerSave_ = false;
  bool deepSave_ = false;
};

#include "LedRing.h"

#include <M5StackChan.h>
#include "config.h"

LedRing::Effect LedRing::effectFor(PetState state) {
#if !FINCHCHAN_LED_EFFECTS
  (void)state;
  return {0, 0, 0, Pattern::Off, 1000, 0};
#else
  switch (state) {
    // Task running: blue, gently fading up and down.
    case PetState::Thinking: return {40, 110, 255, Pattern::Breathe, 2600, 40};
    case PetState::Working: return {40, 110, 255, Pattern::Breathe, 1500, 60};
    // Waiting on the user: red breathing so it reads as "needs attention".
    case PetState::Waiting: return {255, 45, 45, Pattern::Breathe, 2200, 30};
    // Unread / finished work: green breathing.
    case PetState::Success: return {30, 205, 95, Pattern::Breathe, 3200, 130};
    case PetState::Error: return {255, 40, 40, Pattern::Blink, 900, 0};
    case PetState::Speaking: return {255, 150, 40, Pattern::Steady, 1000, 0};
    // Sleeping and idle stay dark: nothing is running and nothing is unread.
    case PetState::Sleeping: return {0, 0, 0, Pattern::Off, 1000, 0};
    default: return {0, 0, 0, Pattern::Off, 1000, 0};
  }
#endif
}

uint8_t LedRing::factorFor(const Effect& effect, uint32_t phase) {
  switch (effect.pattern) {
    case Pattern::Steady:
      return 255;
    case Pattern::Breathe: {
      const uint32_t half = effect.periodMs / 2;
      const uint32_t travel = phase < half ? phase : effect.periodMs - phase;
      const uint32_t span = 255 - effect.floorLevel;
      return static_cast<uint8_t>(effect.floorLevel + span * travel / half);
    }
    case Pattern::Blink:
      return phase < effect.periodMs / 4 ? 255 : 0;
    default:
      return 0;
  }
}

void LedRing::apply(uint8_t level, const Effect& effect) {
  const uint8_t red = static_cast<uint8_t>(static_cast<uint16_t>(effect.red) * level / 255);
  const uint8_t green = static_cast<uint8_t>(static_cast<uint16_t>(effect.green) * level / 255);
  const uint8_t blue = static_cast<uint8_t>(static_cast<uint16_t>(effect.blue) * level / 255);
  for (uint8_t index = 0; index < FINCHCHAN_RGB_COUNT; ++index) {
    M5StackChan.setRgbColor(index, red, green, blue);
  }
  M5StackChan.refreshRgb();
}

void LedRing::begin() {
  startedAt_ = millis();
  started_ = true;
  apply(FINCHCHAN_LED_BRIGHTNESS, effect_);
  lastLevel_ = FINCHCHAN_LED_BRIGHTNESS;
}

void LedRing::setState(PetState state) {
  const Effect next = effectFor(state);
  const bool changed = next.pattern != effect_.pattern || next.red != effect_.red ||
                       next.green != effect_.green || next.blue != effect_.blue;
  effect_ = next;
  if (changed) {
    startedAt_ = millis();
    lastLevel_ = -1;  // force the next update to repaint
  }
}

void LedRing::update(uint32_t now) {
  if (!started_) return;
  const uint32_t period = effect_.periodMs ? effect_.periodMs : 1000;
  const uint32_t phase = (now - startedAt_) % period;
  const uint8_t factor = factorFor(effect_, phase);
  uint8_t level = static_cast<uint8_t>(static_cast<uint16_t>(FINCHCHAN_LED_BRIGHTNESS) * factor / 255);
  /* 亮度量化：呼吸是连续斜坡，不量化的话亮度几乎每帧都在变，
   * `apply()` 会**每帧**写一次 12 颗灯 + refresh —— 实测这一项每帧 6ms
   * （38fps 下占了近四分之一帧时间，工作状态呼吸灯一亮就掉帧）。
   * 量化后写入频率从每帧一次降到每秒 10~20 次。
   * 步长按满档 255 取，所以实际档数 = FINCHCHAN_LED_BRIGHTNESS / 8；
   * 默认 90 时是 11 档（一个 2 秒呼吸周期内每档停留约 180ms，
   * 每次只变 9/255 ≈ 3.5% 亮度，环境灯上看不出来）。
   * 万一以后把亮度调到很低（比如 ≤32）觉得台阶明显，把步长改成相对值
   * （max(2, FINCHCHAN_LED_BRIGHTNESS / 16)）即可。 */
  constexpr uint8_t kLevelStep = 8;
  const uint16_t quantized =
      static_cast<uint16_t>(static_cast<uint16_t>(level) + kLevelStep / 2) / kLevelStep * kLevelStep;
  level = quantized > 255 ? 255 : static_cast<uint8_t>(quantized);   // 四舍五入，保留 255 满档
  // Only repaint when the brightness actually steps; SPI writes are not free.
  if (level == lastLevel_) return;
  lastLevel_ = level;
  apply(level, effect_);
}

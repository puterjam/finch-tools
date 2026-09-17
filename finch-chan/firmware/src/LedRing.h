#pragma once

#include <Arduino.h>
#include "Protocol.h"

/**
 * Drives StackChan's 12 RGB LEDs from the current Finch state.
 *
 * The table below is intentionally small and finite: every state maps to one
 * colour plus one bounded animation, so the pet can never be asked to display
 * arbitrary patterns over the network.
 *
 * State mapping requested for daily use:
 *   working / thinking -> blue, slowly fading in and out
 *   waiting            -> red, slow breathing
 *   success (unread)   -> green breathing
 *   idle               -> LEDs off (nothing unread)
 */
class LedRing {
 public:
  void begin();
  void setState(PetState state);
  void update(uint32_t now);

 private:
  enum class Pattern : uint8_t { Off, Steady, Breathe, Blink };

  struct Effect {
    uint8_t red;
    uint8_t green;
    uint8_t blue;
    Pattern pattern;
    uint16_t periodMs;
    uint8_t floorLevel;  // lowest brightness of a breath cycle, 0-255
  };

  static Effect effectFor(PetState state);
  static uint8_t factorFor(const Effect& effect, uint32_t phase);
  void apply(uint8_t level, const Effect& effect);

  Effect effect_ = effectFor(PetState::Idle);
  uint32_t startedAt_ = 0;
  int16_t lastLevel_ = -1;
  bool started_ = false;
};

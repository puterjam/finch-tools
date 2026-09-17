#pragma once
#include "Protocol.h"

// Single producer (WebSocket callback), single consumer (Arduino loop). Interrupt-free
// callbacks make this fixed-size queue safer than dynamic String/vector allocation.
class CommandQueue {
 public:
  bool push(const PetCommand& command);
  bool pop(PetCommand& command);
  uint8_t dropped() const { return dropped_; }

 private:
  static constexpr uint8_t kCapacity = 8;
  PetCommand items_[kCapacity];
  volatile uint8_t head_ = 0;
  volatile uint8_t tail_ = 0;
  volatile uint8_t dropped_ = 0;
};

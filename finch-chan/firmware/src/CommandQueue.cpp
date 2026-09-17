#include "CommandQueue.h"

bool CommandQueue::push(const PetCommand& command) {
  const uint8_t next = (head_ + 1) % kCapacity;
  if (next == tail_) {
    if (dropped_ != 255) ++dropped_;
    return false;
  }
  items_[head_] = command;
  head_ = next;
  return true;
}

bool CommandQueue::pop(PetCommand& command) {
  if (tail_ == head_) return false;
  command = items_[tail_];
  tail_ = (tail_ + 1) % kCapacity;
  return true;
}

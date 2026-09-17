#include "Protocol.h"
#include <string.h>

PetState parsePetState(const char* value) {
  if (!value) return PetState::Idle;
  if (!strcmp(value, "thinking")) return PetState::Thinking;
  if (!strcmp(value, "working") || !strcmp(value, "running")) return PetState::Working;
  if (!strcmp(value, "success") || !strcmp(value, "happy") || !strcmp(value, "done") || !strcmp(value, "review")) return PetState::Success;
  if (!strcmp(value, "error") || !strcmp(value, "failed")) return PetState::Error;
  if (!strcmp(value, "sleeping")) return PetState::Sleeping;
  if (!strcmp(value, "waiting")) return PetState::Waiting;
  if (!strcmp(value, "speaking") || !strcmp(value, "say")) return PetState::Speaking;
  return PetState::Idle;
}

const char* petStateName(PetState state) {
  static const char* names[] = {"idle", "thinking", "working", "success", "error", "sleeping", "speaking", "waiting"};
  return names[static_cast<uint8_t>(state)];
}

// Names deliberately overlap Petdex/Finch state vocabulary; the renderer is asset-free.
const char* petExpression(PetState state) {
  switch (state) {
    case PetState::Thinking: return "thinking";
    case PetState::Working: return "focused";
    case PetState::Success: return "happy";
    case PetState::Error: return "sad";
    case PetState::Sleeping: return "sleepy";
    case PetState::Speaking: return "talking";
    case PetState::Waiting: return "waiting";
    default: return "neutral";
  }
}

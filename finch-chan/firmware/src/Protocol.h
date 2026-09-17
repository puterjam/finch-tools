#pragma once

#include <Arduino.h>

enum class PetState : uint8_t { Idle, Thinking, Working, Success, Error, Sleeping, Speaking, Waiting };

/** 设备端最多展示的选项个数，与 PetRenderer 的上限保持一致。 */
constexpr uint8_t kPetPromptOptions = 3;

/** 一条等待用户处理的请求（权限卡 / 提问卡 / 表单卡的精简投影）。 */
struct PetPrompt {
  struct Option {
    char id[24] = {};
    char label[40] = {};
    bool destructive = false;
  };

  char id[40] = {};
  char kind[16] = {};
  char title[161] = {};
  uint8_t optionCount = 0;
  Option options[kPetPromptOptions] = {};
};

struct PetCommand {
  enum class Type : uint8_t { State, Say, Ping, Prompt, PromptClear, WifiReset } type;
  PetState state = PetState::Idle;
  char text[97] = {};
  char bubble[65] = {};
  char id[40] = {};
  uint32_t sequence = 0;
  PetPrompt prompt = {};
};

PetState parsePetState(const char* value);
const char* petStateName(PetState state);
const char* petExpression(PetState state);

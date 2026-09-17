#include "WebSocketRelay.h"

#include "Log.h"
#include <ArduinoJson.h>
#include <Preferences.h>
#include <WiFi.h>

#include "DeviceIdentity.h"

using namespace websockets;

namespace {
/**
 * ack 里回报的状态名要翻译成**协议词汇**。
 *
 * `petStateName()` 用的是设备内部的名字（success / sleeping / speaking），
 * 而小程序只认 idle|thinking|working|waiting|happy|error；名字对不上时整条 ack
 * 会被判成 bad_message（串口里就能看到 `[relay] server error: bad_message`）。
 * 所以：
 *   Success  → happy（协议里"有未读/完成"叫 happy）
 *   Sleeping / Speaking → 不带（设备本地的子状态，小程序没有对应概念；state 是可选字段）
 */
const char* ackStateName(PetState state) {
  switch (state) {
    case PetState::Idle: return "idle";
    case PetState::Thinking: return "thinking";
    case PetState::Working: return "working";
    case PetState::Waiting: return "waiting";
    case PetState::Success: return "happy";
    case PetState::Error: return "error";
    default: return nullptr;
  }
}
}  // namespace

void WebSocketRelay::begin() {
  loadToken();
  loadPairCode();
  // 默认用编译期兜底地址；一旦 UDP 发现到桥接，setEndpoint() 会换掉它。
  if (!host_[0]) {
    strlcpy(host_, FINCHCHAN_WS_HOST, sizeof(host_));
    port_ = FINCHCHAN_WS_PORT;
  }
  client_.onMessage([this](WebsocketsMessage message) { onMessage(message); });
  client_.onEvent([this](WebsocketsEvent event, String) {
    if (event == WebsocketsEvent::ConnectionOpened) {
      connected_ = true;
      reconnectDelay_ = FINCHCHAN_RECONNECT_MIN_MS;
      sendHello();
    } else if (event == WebsocketsEvent::ConnectionClosed) {
      connected_ = false;
      nextConnectAt_ = millis() + reconnectDelay_;
      reconnectDelay_ = min(reconnectDelay_ * 2UL, FINCHCHAN_RECONNECT_MAX_MS);
    }
  });
}

/** 换桥接地址（UDP 发现到之后调用）。地址没变就什么都不做。 */
void WebSocketRelay::setEndpoint(const char* host, uint16_t port) {
  if (!host || !*host) return;
  if (!strcmp(host, host_) && port == port_) return;
  strlcpy(host_, host, sizeof(host_));
  port_ = port;
  FC_LOG(1, "[relay] endpoint -> ws://%s:%u\n", host_, static_cast<unsigned>(port_));
  // 已经在连旧地址：断掉立刻重连新地址。
  if (connected_) client_.close();
  connected_ = false;
  nextConnectAt_ = millis() + 200;
  reconnectDelay_ = FINCHCHAN_RECONNECT_MIN_MS;
}

void WebSocketRelay::connect() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (!host_[0]) {
    // 还没发现桥接、也没有兜底地址：晚点再试。
    nextConnectAt_ = millis() + 3000;
    return;
  }
  String endpoint = "ws://";
  endpoint += host_;
  endpoint += ':';
  endpoint += String(port_);
  endpoint += FINCHCHAN_WS_PATH;
  if (!client_.connect(endpoint)) {
    connected_ = false;
    nextConnectAt_ = millis() + reconnectDelay_;
    reconnectDelay_ = min(reconnectDelay_ * 2UL, FINCHCHAN_RECONNECT_MAX_MS);
  }
}

void WebSocketRelay::update(uint32_t now) {
  if (!connected_ && now >= nextConnectAt_) connect();
  if (connected_) client_.poll();
  if (connected_ && now - lastStatusAt_ > 15000UL) sendStatus();
}

void WebSocketRelay::onMessage(WebsocketsMessage message) {
  // 二进制帧 = 小程序推过来的提示音（不走 JSON，省 base64 与解析开销）。
  if (message.isBinary()) {
    handleSoundFrame(message);
    return;
  }
  StaticJsonDocument<1024> doc;
  if (deserializeJson(doc, message.data())) return;
  const char* type = doc["type"] | "";

  if (!strcmp(type, "hello")) {
    const bool serverKnowsUs = doc["paired"] | false;
    // 服务器告诉我们「Finch 侧已经开了配对窗口」：这时才该弹确认卡片。
    if (doc["pairing"] | false) {
      pairOffered_ = true;
      FC_LOGLN(1, "[relay] Finch has an open pairing window for this device");
    }
    if (serverKnowsUs && token_[0]) {
      sendAuth();
    } else if (!serverKnowsUs) {
      // 未配对：有配对码（串口输入过）就发出去，否则在串口里提示怎么做。
      if (pairCode_[0]) {
        sendPair();
      } else {
        FC_LOGLN(1, "[relay] not paired: run finchchan_control action=\"pair\", then send \"pair <code>\" over serial");
      }
    } else {
      // 服务端认为已配对，但本机没有 token（刷了 NVS / 换过机）。
      FC_LOGLN(1, "[relay] server expects a token but none is stored: unpair the device in Finch, then pair again");
    }
    return;
  }
  if (!strcmp(type, "paired")) {
    const char* token = doc["token"] | "";
    if (strlen(token)) {
      persistToken(token);
      paired_ = true;
      clearPairCode();   // 配对码是一次性的，用过就清
      FC_LOGLN(1, "[relay] paired, token stored in NVS");
      sendSettings();    // 让小程序设置菜单立刻拿到当前状态
    }
    return;
  }
  if (!strcmp(type, "auth")) {
    paired_ = true;
    sendSettings();
    return;
  }
  if (!strcmp(type, "pair_offer")) {
    pairOffered_ = true;
    FC_LOGLN(1, "[relay] pairing offered by Finch");
    return;
  }
  if (!strcmp(type, "error")) {
    const char* code = doc["code"] | "";
    FC_LOG(1, "[relay] server error: %s\n", code);
    if (!strcmp(code, "pairing_not_started") || !strcmp(code, "pairing_denied")) pairError_ = true;
    if (!strcmp(code, "unauthorized")) {
      // 服务端不认识我们的 token（多半是用户刚取消配对）：清掉，回到未配对。
      clearToken();
      paired_ = false;
      FC_LOGLN(1, "[relay] token rejected: cleared, waiting for a new pairing offer");
    }
    return;
  }
  if (!strcmp(type, "pong")) return;

  PetCommand command;
  command.sequence = doc["seq"] | ++sequence_;
  strlcpy(command.id, doc["id"] | "", sizeof(command.id));
  if (!strcmp(type, "command")) {
    const char* action = doc["action"] | "";
    if (!strcmp(action, "state")) {
      command.type = PetCommand::Type::State;
      command.state = parsePetState(doc["state"] | "idle");
      strlcpy(command.bubble, doc["bubble"] | "", sizeof(command.bubble));
    } else if (!strcmp(action, "say")) {
      command.type = PetCommand::Type::Say;
      command.state = PetState::Speaking;
      strlcpy(command.text, doc["text"] | "", sizeof(command.text));
    } else if (!strcmp(action, "prompt")) {
      // 等待卡片：只接收标题与选项文本，绝不接收工具参数等敏感字段。
      command.type = PetCommand::Type::Prompt;
      strlcpy(command.prompt.id, doc["id"] | "", sizeof(command.prompt.id));
      strlcpy(command.prompt.kind, doc["kind"] | "", sizeof(command.prompt.kind));
      strlcpy(command.prompt.title, doc["title"] | "", sizeof(command.prompt.title));
      JsonArrayConst options = doc["options"].as<JsonArrayConst>();
      for (JsonObjectConst option : options) {
        if (command.prompt.optionCount >= kPetPromptOptions) break;
        PetPrompt::Option& target = command.prompt.options[command.prompt.optionCount];
        strlcpy(target.id, option["id"] | "", sizeof(target.id));
        strlcpy(target.label, option["label"] | "", sizeof(target.label));
        target.destructive = option["destructive"] | false;
        ++command.prompt.optionCount;
      }
      if (!command.prompt.optionCount) return;  // 没有选项就不显示卡片
      FC_LOG(1, "prompt %s kind=%s options=%u title=%s\n", command.prompt.id, command.prompt.kind,
                    command.prompt.optionCount, command.prompt.title);
    } else if (!strcmp(action, "prompt_clear")) {
      command.type = PetCommand::Type::PromptClear;
      strlcpy(command.id, doc["id"] | "", sizeof(command.id));
    } else if (!strcmp(action, "wifi-reset")) {
      // 重新配网：设备清掉 NVS 里的 WiFi 凭证并重启进配网模式。
      command.type = PetCommand::Type::WifiReset;
    } else if (!strcmp(action, "settings")) {
      // 功能设置：三个字段都可选，只改传了的那些（越界值在这里夹住）。
      command.type = PetCommand::Type::Settings;
      if (doc.containsKey("music")) command.settingMusic = doc["music"].as<bool>() ? 1 : 0;
      if (doc.containsKey("gain")) {
        const int gain = doc["gain"].as<int>();
        command.settingGain = static_cast<int8_t>(gain < 0 ? 0 : gain > 2 ? 2 : gain);
      }
      if (doc.containsKey("beat")) command.settingBeat = doc["beat"].as<bool>() ? 1 : 0;
      if (command.settingMusic < 0 && command.settingGain < 0 && command.settingBeat < 0) return;   // 三个都没给就忽略
    } else return;
  } else if (!strcmp(type, "ping")) {
    command.type = PetCommand::Type::Ping;
  } else return;

  if (queue_.push(command)) sendAck(command);
}

void WebSocketRelay::loadToken() {
  Preferences prefs;
  prefs.begin("finchchan", true);
  const String token = prefs.getString("token", "");
  prefs.end();
  strlcpy(token_, token.c_str(), sizeof(token_));
}

void WebSocketRelay::persistToken(const char* token) {
  strlcpy(token_, token, sizeof(token_));
  Preferences prefs;
  prefs.begin("finchchan", false);
  prefs.putString("token", token_);
  prefs.end();
}

void WebSocketRelay::notifyTap(const char* requestId) {
  if (!connected_) return;
  StaticJsonDocument<160> doc;
  doc["type"] = "tap";
  doc["action"] = "open_conversation";
  if (requestId && *requestId) doc["id"] = requestId;
  doc["deviceId"] = finchchanDeviceId();
  sendJson(doc);
}

void WebSocketRelay::sendAnswer(const char* requestId, const char* optionId) {
  if (!connected_) return;
  StaticJsonDocument<192> doc;
  doc["type"] = "answer";
  doc["id"] = requestId;
  doc["optionId"] = optionId;
  doc["deviceId"] = finchchanDeviceId();
  sendJson(doc);
}

/**
 * 提示音帧格式（小程序端 audio.ts 生成）：
 *   byte 0   : 'A' 魔数
 *   byte 1   : 版本 = 1
 *   byte 2   : slot（0=未读 1=需要处理 2=出错）
 *   byte 3   : 格式（1 = PCM16 单声道）
 *   byte 4-7 : 采样率（uint32 LE）
 *   byte 8-11: 采样点数（uint32 LE）
 *   byte 12-15: 保留
 *   之后：PCM16 数据
 */
void WebSocketRelay::handleSoundFrame(const WebsocketsMessage& message) {
  if (!soundBank_) return;
  const WSString& raw = message.rawData();
  constexpr size_t kHeader = 16;
  if (raw.size() <= kHeader || raw[0] != 'A' || raw[1] != 1) return;
  const uint8_t slot = static_cast<uint8_t>(raw[2]);
  const uint8_t format = static_cast<uint8_t>(raw[3]);
  if (format != 1 || slot >= AudioVisualizer::kSoundSlots) return;
  uint32_t sampleRate = 0;
  uint32_t sampleCount = 0;
  memcpy(&sampleRate, raw.data() + 4, sizeof(sampleRate));
  memcpy(&sampleCount, raw.data() + 8, sizeof(sampleCount));
  const size_t payloadSamples = (raw.size() - kHeader) / sizeof(int16_t);
  if (sampleCount == 0 || sampleCount > payloadSamples) sampleCount = payloadSamples;
  soundBank_->acceptSound(slot, sampleRate ? sampleRate : 16000, sampleCount,
                          reinterpret_cast<const int16_t*>(raw.data() + kHeader));
}

void WebSocketRelay::sendJson(JsonDocument& doc) {
  if (!connected_) return;
  String payload;
  serializeJson(doc, payload);
  client_.send(payload);
}

void WebSocketRelay::sendHello() {
  StaticJsonDocument<256> doc;
  doc["type"] = "hello";
  doc["protocol"] = 1;
  doc["deviceId"] = finchchanDeviceId();
  doc["name"] = finchchanDeviceId();   // 不再叫 StackChan：设备名就用 id
  // 芯片 MAC 低 16 位：桥接靠它识别“同一台硬件换了 id”，自动清掉旧记录。
  doc["chip"] = finchchanMacSuffix();
  doc["firmware"] = FINCHCHAN_FIRMWARE_VERSION;
  String payload;
  serializeJson(doc, payload);
  client_.send(payload);
}

/** 设备屏幕上按了「确认」：不带配对码直接请求配对（Finch 侧必须已开配对窗口）。 */
void WebSocketRelay::submitPairConfirm() {
  if (!connected_) {
    FC_LOGLN(1, "[relay] cannot pair: bridge is not connected");
    return;
  }
  StaticJsonDocument<192> doc;
  doc["type"] = "pair";
  doc["deviceId"] = finchchanDeviceId();
  String payload;
  serializeJson(doc, payload);
  client_.send(payload);
  FC_LOGLN(1, "[relay] pairing confirmed on device, request sent");
}

void WebSocketRelay::sendPair() {
  if (!pairCode_[0]) return;
  StaticJsonDocument<192> doc;
  doc["type"] = "pair";
  doc["deviceId"] = finchchanDeviceId();
  doc["code"] = pairCode_;
  String payload;
  serializeJson(doc, payload);
  client_.send(payload);
}

/**
 * 串口输入配对码。
 * 配对码只在几分钟内有效，而设备没有键盘，所以走串口：
 *   pair C039CD
 * 归一化（去空格、转大写）后存 NVS，连着就直接发。
 */
void WebSocketRelay::submitPairCode(const char* code) {
  char normalized[16] = {};
  size_t out = 0;
  if (code) {
    for (size_t index = 0; code[index] && out < sizeof(normalized) - 1; ++index) {
      const char ch = code[index];
      if (ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n') continue;
      normalized[out++] = (ch >= 'a' && ch <= 'z') ? static_cast<char>(ch - 'a' + 'A') : ch;
    }
  }
  if (!normalized[0]) {
    FC_LOGLN(1, "[relay] usage: pair <code>   (code from finchchan_control action=\"pair\")");
    return;
  }
  strlcpy(pairCode_, normalized, sizeof(pairCode_));
  savePairCode();
  FC_LOG(1, "[relay] pairing code stored: %s\n", pairCode_);
  if (connected_) {
    sendPair();
    FC_LOGLN(1, "[relay] pairing request sent");
  } else {
    FC_LOGLN(1, "[relay] not connected yet: the code will be sent as soon as the bridge is reachable");
  }
}

void WebSocketRelay::clearToken() {
  token_[0] = '\0';
  Preferences prefs;
  prefs.begin("finchchan", false);
  prefs.remove("token");
  prefs.end();
}

void WebSocketRelay::loadPairCode() {
  Preferences prefs;
  prefs.begin("finchchan", true);
  const String code = prefs.getString("pairCode", "");
  prefs.end();
  strlcpy(pairCode_, code.c_str(), sizeof(pairCode_));
  // 编译期的码只当首次烧写的种子（和 WiFi 凭证一个思路）。
  if (!pairCode_[0] && strlen(FINCHCHAN_PAIR_CODE)) {
    strlcpy(pairCode_, FINCHCHAN_PAIR_CODE, sizeof(pairCode_));
    savePairCode();
  }
  if (pairCode_[0]) FC_LOG(1, "[relay] pending pairing code: %s\n", pairCode_);
}

void WebSocketRelay::savePairCode() {
  Preferences prefs;
  prefs.begin("finchchan", false);
  prefs.putString("pairCode", pairCode_);
  prefs.end();
}

void WebSocketRelay::clearPairCode() {
  pairCode_[0] = '\0';
  Preferences prefs;
  prefs.begin("finchchan", false);
  prefs.remove("pairCode");
  prefs.end();
}

void WebSocketRelay::sendAuth() {
  StaticJsonDocument<192> doc;
  doc["type"] = "auth";
  doc["deviceId"] = finchchanDeviceId();
  doc["token"] = token_;
  String payload;
  serializeJson(doc, payload);
  client_.send(payload);
}

void WebSocketRelay::sendAck(const PetCommand& command) {
  if (!connected_) return;
  StaticJsonDocument<128> doc;
  doc["type"] = "ack";
  if (command.id[0]) doc["id"] = command.id;
  // 状态名要说小程序那边的词汇：固件的 Success 在协议里叫 happy。
  // sleeping / speaking 是设备本地的子状态，小程序不认识，就不带（state 本来就是可选字段）。
  if (const char* name = ackStateName(command.state)) doc["state"] = name;
  String payload;
  serializeJson(doc, payload);
  client_.send(payload);
}

void WebSocketRelay::sendStatus() {
  if (!connected_) return;
  lastStatusAt_ = millis();
  StaticJsonDocument<192> doc;
  doc["type"] = "status";
  doc["deviceId"] = finchchanDeviceId();
  doc["wifi"] = WiFi.RSSI();
  doc["uptimeMs"] = millis();
  doc["freeHeap"] = ESP.getFreeHeap();
  String payload;
  serializeJson(doc, payload);
  client_.send(payload);
}

/**
 * 记录并上报功能设置。设备是唯一真源：小程序改、按 PWR 键都走这里；
 * 重连后（auth / paired）会再自动上报一次，所以设置菜单一打开就是当前状态。
 */
void WebSocketRelay::reportSettings(bool music, uint8_t gain, bool beat) {
  settingMusic_ = music;
  settingGain_ = gain > 2 ? 2 : gain;
  settingBeat_ = beat;
  if (connected_) sendSettings();
}

void WebSocketRelay::sendSettings() {
  if (!connected_) return;
  StaticJsonDocument<192> doc;
  doc["type"] = "settings";
  doc["deviceId"] = finchchanDeviceId();
  doc["music"] = settingMusic_;
  doc["gain"] = settingGain_;
  doc["beat"] = settingBeat_;
  String payload;
  serializeJson(doc, payload);
  client_.send(payload);
}

#include <Arduino.h>
#include <M5Unified.h>
#include <WiFi.h>
#include "config.h"
#include "Log.h"
#include "CommandQueue.h"
#include "HostDiscovery.h"
#include "PetRenderer.h"
#include "StackChanRuntime.h"
#include "WebSocketRelay.h"
#include "WifiProvisioning.h"

namespace {
CommandQueue queue;
PetRenderer pet;
StackChanRuntime stackChan;
WebSocketRelay relay(queue);
WifiProvisioning provisioning;
HostDiscovery discovery;

/**
 * 设备端的配对卡片 id。它不来自 Finch，而是设备自己弹的：
 * 设备没键盘，所以配对不再靠输入配对码，而是复用卡片 UI——“确认 / 取消”。
 */
constexpr const char* kPairPromptId = "pair";
/** 用户按过「确认」的时间：等回包的这段时间别再重复弹卡片。 */
uint32_t pairRequestedAt = 0;
/** 配对失败的提示要显示到什么时候。 */
uint32_t pairErrorUntil = 0;
/** 用户按了「取消」或配对结束：本次邀请作废，回到正常表情。 */
bool pairOfferActive = false;

/** 简单的串口命令：status 看状态，wifi-reset 清凭证重新配网。 */
void handleSerialCommands() {
  static String line;
  while (Serial.available()) {
    const char ch = static_cast<char>(Serial.read());
    if (ch == '\r') continue;
    if (ch != '\n') {
      if (line.length() < 48) line += ch;
      continue;
    }
    line.trim();
    if (line == "status") {
      const char* phase = "?";
      switch (provisioning.phase()) {
        case WifiProvisioning::Phase::Idle: phase = "idle"; break;
        case WifiProvisioning::Phase::Connecting: phase = "connecting"; break;
        case WifiProvisioning::Phase::Portal: phase = "portal"; break;
        case WifiProvisioning::Phase::Connected: phase = "connected"; break;
      }
      FC_LOG(1, "[finchchan] wifi=%s ip=%s ssid=%s rssi=%d\n", phase, provisioning.localIp(),
                    provisioning.ssid(), provisioning.connected() ? static_cast<int>(WiFi.RSSI()) : 0);
      FC_LOG(1, "[finchchan] bridge=%s:%u relay=%s paired=%s\n", discovery.host(), static_cast<unsigned>(discovery.port()),
                    relay.connected() ? "connected" : "offline", relay.paired() ? "yes" : "no");
      FC_LOG(1, "[finchchan] music=%s gain=%s beat=%s\n", pet.musicMode() ? "on" : "off",
                    pet.micGainLevel() == 0 ? "low" : pet.micGainLevel() == 1 ? "mid" : "high",
                    pet.beatDance() ? "on" : "off");
    } else if (line == "pair") {
      relay.submitPairCode(nullptr);   // 打印用法
    } else if (line.startsWith("pair ")) {
      relay.submitPairCode(line.substring(5).c_str());
    } else if (line == "wifi-reset") {
      FC_LOGLN(1, "[finchchan] clearing wifi credentials and restarting into portal...");
      provisioning.forgetCredentials();   // 不会返回：内部 ESP.restart()
    } else if (line.length()) {
      FC_LOGLN(1, "[finchchan] commands: status | pair <code> | wifi-reset");
    }
    line = "";
  }
}

void processCommands() {
  PetCommand command;
  while (queue.pop(command)) {
    switch (command.type) {
      case PetCommand::Type::State: pet.setState(command.state, nullptr, command.bubble); break;
      case PetCommand::Type::Say: pet.setState(PetState::Speaking, command.text); break;
      case PetCommand::Type::Prompt: {
        PetRenderer::PromptOption options[kMaxPromptOptions];
        const uint8_t count = command.prompt.optionCount < kMaxPromptOptions ? command.prompt.optionCount : kMaxPromptOptions;
        for (uint8_t index = 0; index < count; ++index) {
          strlcpy(options[index].id, command.prompt.options[index].id, sizeof(options[index].id));
          strlcpy(options[index].label, command.prompt.options[index].label, sizeof(options[index].label));
          options[index].destructive = command.prompt.options[index].destructive;
        }
        pet.setPrompt(command.prompt.id, command.prompt.kind, command.prompt.title, options, count);
        break;
      }
      case PetCommand::Type::PromptClear:
        // 空 id 表示清空全部；带 id 时只清掉同一张卡片。
        if (!command.id[0] || !strcmp(command.id, pet.promptId())) pet.clearPrompt();
        break;
      case PetCommand::Type::WifiReset:
        FC_LOGLN(1, "[finchchan] wifi-reset requested from Finch: clearing credentials and restarting");
        provisioning.forgetCredentials();   // 不会返回：内部 ESP.restart()
        break;
      case PetCommand::Type::Settings:
        // 小程序设置菜单下发的功能设置；改完立刻回报一份完整设置。
        if (command.settingMusic >= 0) pet.setMusicMode(command.settingMusic != 0);
        if (command.settingGain >= 0) pet.setMicGainLevel(static_cast<uint8_t>(command.settingGain));
        if (command.settingBeat >= 0) pet.setBeatDance(command.settingBeat != 0);
        FC_LOG(1, "[settings] music=%d gain=%u beat=%d\n", pet.musicMode() ? 1 : 0, pet.micGainLevel(),
                      pet.beatDance() ? 1 : 0);
        relay.reportSettings(pet.musicMode(), pet.micGainLevel(), pet.beatDance());
        break;
      case PetCommand::Type::Ping: break;  // ack is emitted by relay before queueing.
    }
  }
}

/**
 * 输入（两套硬件，行为分开）。
 *
 * 1) 屏幕触摸：M5Unified 的 `M5.Touch`（CoreS3 / StackChan 的显示触摸面板）。
 *    卡片上的按钮就是靠它命中的：按坐标命中哪个选项就执行哪个选项。
 *    没有卡片且未读时点一下 = 打开会话；睡着时点一下 = 唤醒。
 *
 * 2) 顶部电容区：StackChan-BSP 的 `M5StackChan.TouchSensor`（Si12T，三个区 + 前后滑动）。
 *    没屏幕时也能用：Front = 第一个选项，Back = 第二个选项，Middle = 去 Finch。
 *
 * 3) 拍头：头里的 IMU 尖峰（见 readPatSpike）。
 */

/** 把「某个选项被选中」分发到正确的去处（设备本地配对卡片 / Finch 的等待卡片）。 */
void dispatchPromptOption(const char* source, const char* optionId) {
  if (!pet.hasPrompt()) return;
  const String requestId = String(pet.promptId());
  const bool pairCard = !strcmp(pet.promptId(), kPairPromptId);
  if (pairCard) {
    if (!strcmp(optionId, "confirm")) {
      pairRequestedAt = millis();
      relay.submitPairConfirm();
      pet.reactToAnswer("allow");
    } else {
      pairOfferActive = false;
      FC_LOG(1, "[%s] pairing offer dismissed on device\n", source);
    }
    pet.clearPrompt();
    return;
  }
  if (!strcmp(optionId, "open")) {
    relay.notifyTap(requestId.c_str());
    return;
  }
  // 权限卡：在设备上直接作答；用户已给出答案，卡片才收起来。
  relay.sendAnswer(requestId.c_str(), optionId);
  pet.clearPrompt();
  pet.reactToAnswer(optionId);
}

/** 顶部电容区（三个区 + 滑动）：把区位翻译成选项 id，再走同一套分发。 */
void handleZonePress(uint8_t zone) {
  if (pet.hasPrompt()) {
    const char* optionId;
    if (!strcmp(pet.promptId(), kPairPromptId)) {
      optionId = zone == 0 ? "confirm" : "cancel";
    } else if (pet.promptOptionCount() >= 2) {
      optionId = zone == 1 ? "open" : pet.promptOptionId(zone == 2 ? 1 : 0);
    } else {
      optionId = "open";   // 单选项卡片：去 Finch 作答
    }
    FC_LOG(2, "top touch zone=%u card=%s -> %s\n", zone, pet.promptId(), optionId);
    dispatchPromptOption("top", optionId);
    return;
  }
  if (pet.isUnread()) {
    FC_LOGLN(2, "top touch -> open unread session");
    relay.notifyTap();
    return;
  }
  FC_LOG(2, "top touch zone=%u ignored (no card, nothing unread)\n", zone);
}

uint32_t lastScreenTouchAt = 0;

/**
 * 点在表情/空白处（不是按钮）：跳去 Finch 打开这张卡片所属的会话，
 * 让用户看清楚到底在问什么，而不是替他在设备上做决定。
 * 配对确认卡是设备本地的，没有对应会话，点表情不做事。
 */
void openPromptSession(const char* source) {
  if (!pet.hasPrompt()) return;
  if (!strcmp(pet.promptId(), kPairPromptId)) {
    FC_LOG(2, "[%s] face tap on local pair card: ignored\n", source);
    return;
  }
  FC_LOG(1, "[%s] face tap -> open this card's session in Finch\n", source);
  relay.notifyTap(pet.promptId());
}

/** 屏幕触摸（M5.Touch）：卡片按钮靠坐标命中，点表情/空白处=去看会话。 */
void handleScreenTouch(uint32_t now) {
  if (!M5.Touch.isEnabled()) return;
  const auto& detail = M5.Touch.getDetail();
  if (!detail.wasPressed()) return;
  if (now - lastScreenTouchAt < 250) return;   // 去抖：一次点击只算一下
  lastScreenTouchAt = now;

  const int16_t x = detail.x;
  const int16_t y = detail.y;
  FC_LOG(2, "screen touch x=%d y=%d card=%s unread=%d\n", x, y, pet.hasPrompt() ? pet.promptId() : "-",
                pet.isUnread() ? 1 : 0);
  const bool wasSleeping = pet.isSleeping();
  pet.noteTouch();   // 记一次活动（睡着时这里顺便唤醒）
  if (wasSleeping) {
    FC_LOGLN(2, "screen touch while sleeping -> wake (friendly)");
    return;
  }
  if (pet.hasPrompt()) {
    char optionId[24] = {};
    if (pet.hitTestPrompt(x, y, optionId, sizeof(optionId))) {
      FC_LOG(2, "screen touch -> %s\n", optionId);
      dispatchPromptOption("screen", optionId);
    } else {
      // 没点在按钮上（点了表情或气泡）：跳去 Finch 看这张卡在问什么。
      openPromptSession("screen");
    }
    return;
  }
  if (pet.isUnread()) {
    FC_LOGLN(2, "screen touch -> open unread session");
    relay.notifyTap();
    return;
  }
  FC_LOGLN(2, "screen touch -> ignored (no card, nothing unread)");
}

/** IMU 慢跟随基线，用来识别加速度突变（拍头）。 */
float accelBaseline = 1.0f;
uint32_t lastImuSampleAt = 0;
uint32_t lastPatAt = 0;

/**
 * 拍头检测。头里没有压力传感器，但拍一下会在 IMU 上留一个加速度尖峰，
 * 用一个慢跟随基线 + 阈值就能识别；屏幕/顶部两个触摸面都不方便用的场景（比如
 * 拍脑袋）就靠这个。
 */
bool readPatSpike(uint32_t now) {
  if (!M5.Imu.isEnabled()) return false;
  if (now - lastImuSampleAt < 20) return false;   // 50Hz 采样就够
  lastImuSampleAt = now;
  float ax = 0, ay = 0, az = 0;
  if (!M5.Imu.getAccel(&ax, &ay, &az)) return false;
  const float magnitude = sqrtf(ax * ax + ay * ay + az * az);
  const float delta = fabsf(magnitude - accelBaseline);
  accelBaseline = accelBaseline * 0.94f + magnitude * 0.06f;
  if (delta < FINCHCHAN_PAT_THRESHOLD_G) return false;
  if (now - lastPatAt < 700) return false;        // 一次拍头只算一下
  lastPatAt = now;
  FC_LOG(2, "pat: delta=%.2fg\n", delta);
  return true;
}

/** 拍头与电容区共用：拍一下就是亲密反应（睡着也不例外）。 */
void onPat(uint32_t now) {
  (void)now;
  pet.notePat();
}

void handleTouch() {
  const uint32_t now = millis();
  // 拍头（IMU 尖峰）先判：睡着就唤醒，醒着就开心一下。
  if (readPatSpike(now)) onPat(now);
  // 屏幕触摸（M5.Touch）与顶部电容区是两套硬件，分别处理。
  handleScreenTouch(now);

  auto& touch = M5StackChan.TouchSensor;
  static bool pressed[3] = {false, false, false};
  const auto& intensities = touch.getIntensities();
  const bool anyTouch = intensities[0] || intensities[1] || intensities[2];
  const bool swiped = touch.wasSwipedForward() || touch.wasSwipedBackward();

  // 睡着（含关屏）时：任何触碰都只负责把它叫醒（友好叫醒，不演惊讶）。
  if (pet.isSleeping()) {
    if (anyTouch || swiped) {
      FC_LOGLN(2, "top touch while sleeping -> wake (friendly)");
      pet.noteTouch();
    }
    return;
  }

  for (uint8_t zone = 0; zone < 3; ++zone) {
    const bool down = intensities[zone] > 0;
    if (down && !pressed[zone]) {
      // 一行把「哪个区被按」与「当前屏幕上有没有卡片」都记下来，
      // 这样“按钮没被点中”是能被定位到具体哪一步的。
      FC_LOG(2, "top touch zone %u (i=%u,%u,%u) card=%s options=%u unread=%d\n", zone, intensities[0],
                    intensities[1], intensities[2], pet.hasPrompt() ? pet.promptId() : "-",
                    pet.promptOptionCount(), pet.isUnread() ? 1 : 0);
      pet.noteTouch();
      handleZonePress(zone);
    } else if (!down && pressed[zone]) {
      FC_LOG(2, "top touch zone %u released (i=%u,%u,%u)\n", zone, intensities[0], intensities[1], intensities[2]);
    }
    pressed[zone] = down;
  }
  // 前后滑动也当作按下：向前 = Front，向后 = Back。
  if (touch.wasSwipedForward()) {
    FC_LOGLN(2, "top touch swipe forward -> Front");
    handleZonePress(0);
  } else if (touch.wasSwipedBackward()) {
    FC_LOGLN(2, "top touch swipe backward -> Back");
    handleZonePress(2);
  }
}
}  // namespace

void setup() {
  Serial.begin(115200);
  // 串口是 USB-CDC：把发送超时设成 0（写不出去就丢），没有宿主连着时也不打日志，
  // 否则关掉串口监视器之后主循环会被 printf 拖住、界面直接卡死。
  fcLogBegin();
  delay(150);
  FC_LOG(1, "FinchChan %s booting\n", FINCHCHAN_FIRMWARE_VERSION);

  // BSP owns its safe motion/update lifecycle; FinchChan owns visible vector expressions.
  stackChan.begin();
  pet.begin();
  pet.setState(PetState::Idle);
  // 两套触摸硬件各自报一下状态（卡片按钮能不能点，看这行就知道）。
  FC_LOG(1, "[input] screen touch panel: %s\n", M5.Touch.isEnabled() ? "enabled" : "NOT detected");
  FC_LOGLN(1, "[input] top touch zones: Si12T Front/Middle/Back via StackChan-BSP");
  // 配网 → 找桥接 → 连 WS。地址都不再写死在固件里。
  provisioning.begin();
  discovery.begin();
  relay.begin();
  // 小程序推过来的提示音落在 pet 的音频模块里（PSRAM）。
  relay.setSoundBank(&pet.audioBank());
}

void loop() {
  const uint32_t now = millis();
  M5.update();
  handleSerialCommands();

  // PWR 短按：切换律动模式（麦克风音频动效）。只有显示时才开麦，关掉就释放。
  // 切换后立刻上报，这样小程序设置菜单里那行「律动模式」会和硬件保持一致。
  if (M5.BtnPWR.wasClicked()) {
    FC_LOGLN(1, "[input] PWR clicked -> toggle rhythm mode");
    pet.setMusicMode(!pet.musicMode());
    relay.reportSettings(pet.musicMode(), pet.micGainLevel(), pet.beatDance());
  }

  provisioning.update(now);
  // 配网 / 连接阶段：屏幕只显示提示，不跑表情与卡片。
  if (provisioning.portalActive()) {
    pet.showNotice("配网中", provisioning.apName(), "手机连上它，打开 192.168.4.1");
    delay(2);
    return;
  }
  if (provisioning.phase() == WifiProvisioning::Phase::Connecting) {
    pet.showNotice("正在连接 WiFi", provisioning.ssid(), "连不上会自动回到配网模式");
    delay(2);
    return;
  }

  discovery.update(now, provisioning.connected());
  if (discovery.found()) relay.setEndpoint(discovery.host(), discovery.port());

  handleTouch();
  stackChan.update();
  relay.update(now);
  processCommands();
  // 诊断（第 2 档日志）：堆占用与**最大可用块**。跑久了变卡时看这两行数值就知道
  // 是不是堆碎片化（largest 一路变小 = 碎片；free 一路变小 = 泄漏）。
  static uint32_t heapLoggedAt = 0;
  if (now - heapLoggedAt > 30000UL) {
    heapLoggedAt = now;
    FC_LOG(2, "[heap] free=%u largest=%u\n", static_cast<unsigned>(ESP.getFreeHeap()),
           static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)));
  }
  // 桥接刚连上（有任务/会话在活动）也当作“有事发生”，把睡着的叫醒。
  static bool wasConnected = false;
  static uint32_t lastConnectedAt = 0;
  const bool connected = relay.connected();
  if (connected && !wasConnected) pet.noteTouch();
  if (connected) lastConnectedAt = now;
  wasConnected = connected;
  // 一直连不上去（可能换了网络 / 电脑 IP 变了）：重新广播找一次。
  if (!connected && lastConnectedAt && now - lastConnectedAt > 45000UL) discovery.invalidate();

  // ── 配对：只有 Finch 侧开了配对窗口（收到 pair_offer / hello.pairing），
  // 设备才弹卡片（复用等待卡片 UI）。连上就弹会让用户莫名其妙，
  // 而且那时按下「确认」必然被桥接拒掉。 ──
  const bool pairing = connected && !relay.paired();
  const bool pairCardShowing = pet.hasPrompt() && !strcmp(pet.promptId(), kPairPromptId);
  if (relay.consumePairOffer()) {
    pairOfferActive = true;
    pairRequestedAt = 0;
    pairErrorUntil = 0;
    FC_LOGLN(1, "[finchchan] Finch opened a pairing window: showing confirm card");
  }
  if (relay.consumePairError()) {
    pairErrorUntil = now + 6000;
    pairRequestedAt = 0;
    pairOfferActive = false;
    FC_LOGLN(1, "[finchchan] pairing refused: open the pairing window in Finch first");
  }
  if (!pairing) {
    pairOfferActive = false;
    pairRequestedAt = 0;
  }
  if (!pairing || !pairOfferActive) {
    // 没在配对：什么都不显示，保持眼睛表情。
    if (pairCardShowing) pet.clearPrompt();
    pet.clearNotice();
  } else if (now < pairErrorUntil) {
    if (pairCardShowing) pet.clearPrompt();
    pet.showNotice("配对没成功", "先在 Finch 里开配对窗口", "然后再按设备上的「确认」");
  } else if (pairRequestedAt && now - pairRequestedAt < 15000UL) {
    if (pairCardShowing) pet.clearPrompt();
    pet.showNotice("配对中…", "正在等 Finch 确认", "");
  } else if (!pet.hasPrompt()) {
    // 复用等待卡片：front = 确认，back = 取消（middle 也当取消）。
    PetRenderer::PromptOption options[2];
    strlcpy(options[0].id, "confirm", sizeof(options[0].id));
    strlcpy(options[0].label, "确认", sizeof(options[0].label));
    options[0].destructive = false;
    strlcpy(options[1].id, "cancel", sizeof(options[1].id));
    strlcpy(options[1].label, "取消", sizeof(options[1].label));
    options[1].destructive = false;
    pet.clearNotice();
    pet.setPrompt(kPairPromptId, "question", "要连上 Finch 吗？", options, 2);
    FC_LOGLN(1, "[finchchan] pairing card shown: tap front to confirm");
  }
  pet.update(now);
  // 待机降功耗：打瞌睡就开 modem sleep，熄屏再加降主频；唤醒的那一帧立即恢复。
  stackChan.setPowerSave(pet.isSleeping(), pet.isScreenOff());
  delay(1);
}

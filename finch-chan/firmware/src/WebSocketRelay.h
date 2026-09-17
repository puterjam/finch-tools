#pragma once
#include <ArduinoJson.h>
#include <ArduinoWebsockets.h>
#include "AudioVisualizer.h"
#include "CommandQueue.h"
#include "config.h"

class WebSocketRelay {
 public:
  explicit WebSocketRelay(CommandQueue& queue) : queue_(queue) {}
  void begin();
  /**
   * 把「小程序推过来的提示音」落到 AudioVisualizer 的 PSRAM 槽里。
   * 用指针而不是引用，因为两者在 main 里分别构造。
   */
  void setSoundBank(AudioVisualizer* bank) { soundBank_ = bank; }
  void update(uint32_t now);
  /** 运行时指定桥接地址（由 UDP 发现提供）。 */
  void setEndpoint(const char* host, uint16_t port);
  /**
   * 串口输入的配对码：存 NVS，若当前已连上但还没认证就立刻发出去。
   * 配对码只有 10 分钟有效，所以不能写进编译期配置。
   */
  void submitPairCode(const char* code);
  /** 设备屏幕上按「确认」：不带码请求配对（Finch 侧必须先开配对窗口）。 */
  void submitPairConfirm();
  /**
   * Finch 侧是否刚开了配对窗口（收到 hello.pairing 或 pair_offer）。
   * 设备据此决定要不要弹「确认 / 取消」卡片——不再连上就弹。
   */
  bool consumePairOffer() {
    const bool value = pairOffered_;
    pairOffered_ = false;
    return value;
  }
  /** 取出一次配对失败事件（用于在屏幕上提示“先去 Finch 开始配对”）。 */
  bool consumePairError() {
    const bool value = pairError_;
    pairError_ = false;
    return value;
  }
  /** 是否已拿到（或已用 token 通过）认证。 */
  bool paired() const { return paired_; }
  bool connected() const { return connected_; }
  /** 请求 Finch 打开会话：带 requestId 时打开那张卡片所属的会话。 */
  void notifyTap(const char* requestId = nullptr);
  /** 把用户在屏幕上的选择回传给 Finch，由小程序代为应答该等待。 */
  void sendAnswer(const char* requestId, const char* optionId);

 private:
  websockets::WebsocketsClient client_;
  CommandQueue& queue_;
  /** 提示音接收方（小程序推过来的音频，存在 PSRAM）。 */
  AudioVisualizer* soundBank_ = nullptr;
  char host_[40] = {};
  uint16_t port_ = FINCHCHAN_WS_PORT;
  bool connected_ = false;
  uint32_t nextConnectAt_ = 0;
  uint32_t reconnectDelay_ = FINCHCHAN_RECONNECT_MIN_MS;
  uint32_t lastStatusAt_ = 0;
  uint32_t sequence_ = 0;
  char token_[96] = {};
  char pairCode_[16] = {};
  bool paired_ = false;
  bool pairError_ = false;
  bool pairOffered_ = false;

  void connect();
  void onMessage(websockets::WebsocketsMessage message);
  /** 二进制帧：小程序推过来的提示音（16 字节头 + PCM16 单声道）。 */
  void handleSoundFrame(const websockets::WebsocketsMessage& message);
  void loadToken();
  void persistToken(const char* token);
  /** 服务端不再认识我们的 token（被取消配对）时清掉本地凭证。 */
  void clearToken();
  void loadPairCode();
  void savePairCode();
  void clearPairCode();
  void sendHello();
  void sendPair();
  void sendAuth();
  void sendAck(const PetCommand& command);
  void sendStatus();
  void sendJson(JsonDocument& doc);
};

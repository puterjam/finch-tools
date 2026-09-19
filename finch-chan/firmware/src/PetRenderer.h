#pragma once

#include "AudioVisualizer.h"
#include <Arduino.h>
#include <M5Unified.h>
#include "EmotionFace.h"
#include "LedRing.h"
#include "MotionDirector.h"
#include "Protocol.h"
#include "config.h"

/** 设备端最多同时展示的选项数量（屏幕高度决定的硬限制）。 */
constexpr uint8_t kMaxPromptOptions = 3;

class PetRenderer {
 public:
  struct PromptOption {
    char id[24];
    char label[40];
    bool destructive;
  };

  void begin();
  void setState(PetState state, const char* speech = nullptr, const char* bubble = nullptr);
  void update(uint32_t now);
  /** 空帧自检（稀疏采样画布，全黑则打日志）。 */
  void checkBlankFrame(uint32_t now);

  /** 收到 Finch 的等待请求：在屏幕上显示成可选择的问题卡片。 */
  void setPrompt(const char* requestId, const char* kind, const char* title,
                 const PromptOption* options, uint8_t optionCount);
  /** 问题被别处解决，或已在本机作答。 */
  void clearPrompt();
  bool hasPrompt() const { return promptActive_; }
  const char* promptId() const { return promptId_; }

  /**
   * 触摸命中测试。命中某个选项时写入 optionId 并返回 true。
   * 返回 false 表示这一下没有落在选项上（调用方可以据此决定其它行为）。
   */
  bool hitTestPrompt(int16_t x, int16_t y, char* optionId, size_t optionIdSize) const;

  /** 未读结果时，整屏点按表示"打开会话"。 */
  bool isUnread() const { return state_ == PetState::Success; }

  /** 用户作答后的即时反馈：允许→笑一下，拒绝→无奈。 */
  void reactToAnswer(const char* optionId);
  /** PWR 短按：切换麦克风音频动效（收听模式）。 */
  void toggleAudioVisualizer();
  bool audioVisible() const { return audio_.visible(); }
  /** 律动模式开关（PWR 键与小程序设置菜单共用）。 */
  void setMusicMode(bool on);
  bool musicMode() const { return audio_.visible(); }
  /** 收音灵敏度：0=低 / 1=中 / 2=高（麦克风增益 1.8 / 2.4 / 3.0）。 */
  void setMicGainLevel(uint8_t level) { audio_.setGainLevel(level); }
  uint8_t micGainLevel() const { return audio_.gainLevel(); }
  /** 随节奏舞动：关掉后频谱照旧，只是不再跟拍点头。 */
  void setBeatDance(bool on) { beatDance_ = on; }
  bool beatDance() const { return beatDance_; }
  /** 供 WebSocketRelay 接收小程序推过来的提示音（同一份 audio_）。 */
  AudioVisualizer& audioBank() { return audio_; }
  /** 被拍了一下头：笑脸或爱心（随机）+ 慢慢摇头。 */
  void reactToPat();
  /**
   * 被"撸"了（顶部面板顺毛/来回摸）：比拍头更沉一点的开心 —— 笑眼 + 小幅摆动，
   * 反应时间也更长。默认走同一个防抖窗口（手同时碰到电容区不会叠两次）；
   * overridePat=true 时允许盖掉刚触发不久的那次"拍头" —— 手刚碰上去时 IMU
   * 会先判成拍了一下，随后才滑出"撸"的手势，这时应该以撸为准。
   */
  void reactToStroke(bool overridePat = false);
  /** 屏幕被碰了一下：被摸醒也算友好叫醒，不演惊讶。 */
  void noteTouch();
  /** 被拍头（IMU 尖峰）：任何时候都是亲密反应。 */
  void notePat();
  /** 是否处于打瞌睡 / 关屏（此时任何触碰都只用于唤醒）。 */
  bool isSleeping() const { return sleepLevel_ != SleepLevel::Awake; }
  /** 是否已熄屏（更深的一层，此时可以降主频）。 */
  bool isScreenOff() const { return sleepLevel_ == SleepLevel::DeepSleep; }
  /**
   * 配网 / 连接中的提示屏：暂停表情渲染，只显示三行提示。
   * 内容不变时不会重绘，所以可以每帧调。
   */
  void showNotice(const char* title, const char* line1, const char* line2);
  void clearNotice();
  bool noticeActive() const { return noticeActive_; }
  /** 卡片选项：外部（触摸区）需要知道当前有哪几个选项。 */
  uint8_t promptOptionCount() const { return promptOptionCount_; }
  const char* promptOptionId(uint8_t index) const {
    return index < promptOptionCount_ ? promptOptions_[index].id : "";
  }

 private:
  /** 空闲久了会依次进入：打瞌睡 → 关屏。 */
  enum class SleepLevel : uint8_t { Awake, Dozing, DeepSleep };

  M5Canvas canvas_{&M5.Display};
  bool canvasReady_ = false;
  EmotionFace face_;
  LedRing leds_;
  MotionDirector motion_;

  PetState state_ = PetState::Idle;
  FaceExpression expression_ = FaceExpression::Neutral;
  bool reacting_ = false;
  uint32_t reactionUntil_ = 0;
  /** 睡眠状态机与空闲计时。 */
  SleepLevel sleepLevel_ = SleepLevel::Awake;
  uint32_t lastActivityAt_ = 0;
  uint8_t brightness_ = 128;
  /** 惊醒动画期间先不切表情，等演完再进入目标状态。 */
  bool waking_ = false;
  /** 麦克风音频动效（muspi spectrum 的简化版）。 */
  AudioVisualizer audio_;
  /** 跟拍点头：上一拍播完之前不接下一拍（毫秒时间戳）。 */
  uint32_t beatNodUntil_ = 0;
  /** 最近一拍的时间戳：给表情做同步的小顿落。 */
  uint32_t beatPulseAt_ = 0;
  /** 未读「查看」按钮的入场进度 0→1（与卡片同一套位移/时长）。 */
  float unreadProgress_ = 0.0f;
  bool noticeActive_ = false;
  String noticeTitle_;
  String noticeLine1_;
  String noticeLine2_;
  uint32_t wakeUntil_ = 0;
  String speech_;
  String bubble_;
  uint32_t stateChangedAt_ = 0;
  uint32_t lastFrameAt_ = 0;
  
  uint32_t blankLogAt_ = 0;
  /** 已渲染帧数（空帧自检与帧率统计共用）。 */
  uint32_t frameCount_ = 0;
  /** 帧率统计窗口（第 2 档日志每 5 秒报一次 fps）。 */
  uint32_t fpsWindowAt_ = 0;
  uint32_t fpsWindowFrames_ = 0;
  /** 这一窗口里"合成"（画到离屏画布）与"推送"（SPI 发到屏幕）累计微秒数。 */
  uint32_t composeUs_ = 0;
  uint32_t pushUs_ = 0;
  uint32_t pushedPixels_ = 0;
  /**
   * 渲染帧内部的细分耗时（µs，累计值）：只靠 compose/push 对不上账，
   * 帧循环里还有一段时间花在音频/灯光/舵机上，拆开才知道该掐哪一段。
   * 顺序：audio / led / motion / sleep（含电量轮询）/ erase / face。
   */
  uint32_t subUs_[6] = {};
  /** 下一帧要不要整屏重画/重推（静态内容变了，或每 2 秒兜底一次）。 */
  bool fullFrame_ = true;
  uint32_t lastFullFrameAt_ = 0;
  /** 上一帧实际推过的"眼睛带"上下沿（-1 = 还没推过）：本帧按并集推，见 update。 */
  int16_t eyePushedTop_ = -1;
  int16_t eyePushedBottom_ = -1;
  /** 补亮屏幕的限频时间戳。 */
  uint32_t lastRelightAt_ = 0;
  /** 电量（-1 = 读不到）与上次轮询时间。 */
  int32_t batteryLevel_ = -1;
  uint32_t batteryPolledAt_ = 0;
  /** 随节奏舞动（小程序设置菜单可关）。 */
  bool beatDance_ = true;

  bool promptActive_ = false;
  char promptId_[40] = {};
  char promptKind_[16] = {};
  /** 权限卡在设备上直接作答，答题卡/表单卡则跳回对应会话。 */
  bool promptAnswerable_ = false;
  /** 卡片出现动画的进度（0→1）与起始时间：眼睛上移、按钮滑入。 */
  uint32_t promptShownAt_ = 0;
  float promptProgress_ = 1.0f;
  String promptTitle_;
  PromptOption promptOptions_[kMaxPromptOptions] = {};
  uint8_t promptOptionCount_ = 0;
  /** 每个选项在屏幕上占据的矩形，用于触摸命中测试。 */
  int16_t optionRect_[kMaxPromptOptions][4] = {};

  static FaceExpression faceFor(PetState state);
  static bool wantsBubble(PetState state);
  void applyExpression(FaceExpression expression);
  /** 记录一次“有事发生”。startled=true 表示被任务/连接叫醒（才演惊醒）。 */
  void noteActivity(uint32_t now, bool startled);
  void enterDozing(uint32_t now);
  void enterDeepSleep(uint32_t now, int32_t idleMs);
  void wakeUp(uint32_t now, bool startled);
  /** 把文字画成顶部气泡，返回气泡下方可用的起始 y。
   *  paint=false 时只算几何不落笔：增量帧靠它拿到眼睛该落在哪，但不重画静态气泡。 */
  int16_t drawBubble(LovyanGFX& g, const char* text, bool paint = true);
  /** 等待卡片的按钮行：在表情下方（权限卡为允许/拒绝，答题卡为去回复）。 */
  void drawPromptButtons(LovyanGFX& g);
  /** 有未读时底部的灰色「查看」按钮（点击行为与“任意点击”一致）。 */
  void drawUnreadButton(LovyanGFX& g);
  /** 右上角状态条：`♪ 100%`（电量常显，♪ 只在音乐模式）。 */
  void drawStatusBadge(LovyanGFX& g);
  /** thinking 静止 / working 摆动的那支笔（帧见 pen_frames.h）。 */
  void drawPen(LovyanGFX& g, uint32_t now);
  /** 轮询并缓存电量（I2C 读 PMIC，别每帧读）。 */
  void pollBattery(uint32_t now);
  /**
   * 只把画布的一块矩形推到屏幕（逐行 pushImage）。
   * 整屏 320x240 推一次要 34ms（SPI 约 4.5MB/s），所以静止内容不重推、
   * 每帧只推"这一帧真的变了"的区域 —— 这是帧率能上 30+ 的关键。
   */
  void pushCanvasRect(int16_t x, int16_t y, int16_t w, int16_t h);
  /** 静态内容变了（状态/卡片/气泡/电量/律动模式）→ 下一帧整屏重画重推。 */
  void markFullFrame() { fullFrame_ = true; }
  void drawSpeech(LovyanGFX& g);
  void cue(PetState state);
};

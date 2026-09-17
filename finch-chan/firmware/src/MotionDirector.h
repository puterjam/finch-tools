#pragma once

#include <Arduino.h>
#include "EmotionFace.h"

/**
 * 头部动作导演：把表情状态翻译成 StackChan 的头/颈动作。
 *
 * 三条基本规则：
 *   1. 空闲时头部跟着视线走——眼睛看向左上/右下，头也转过去，偶尔回中；
 *   2. 执行任务（working）时偶尔微微点头，表示"还在忙"；
 *   3. 收到反馈时播放预设动作：允许 = 连点两下，拒绝 = 左右摇头后低头。
 *
 * 另外准备了一组"有趣动作"（好奇歪头、左右扫视、抬头、抖动），
 * 空闲时会随机挑一个播，让机器人看起来是活的。
 *
 * 安全：所有角度都按归一化值下发并限幅在 ±0.85，速度上限由预设控制，
 * 任何动作播完都会回到中位；网络消息无法直接驱动舵机。
 */
class MotionDirector {
 public:
  enum class Action : uint8_t {
    None,
    Center,
    Nod,        // 轻轻点一下头
    DoubleNod,  // 连点两下（同意 / 允许）
    Shake,      // 左右摇头（拒绝）
    Tilt,       // 好奇歪头
    Droop,      // 低头（无奈 / 出错）
    Perk,       // 抬头（注意到你）
    Sweep,      // 左右扫视一圈
    Wiggle,     // 小幅摆动（开心）
    WakeShake,  // 惊醒：回中后左右轻晃几下
    PatShake,   // 被拍头：慢慢地左右摇两下（笑脸）
    BeatNod,     // 跟着音乐节拍点头（音乐模式）
    BeatNodStrong, // 强拍 / 慢歌：幅度更大的点头
    BeatNodFast    // 快歌：短促点头，保证一拍内做完
  };

  void begin();
  void setEnabled(bool enabled);
  bool enabled() const { return enabled_; }
  /**
   * 节拍模式：跟拍点头期间打开。
   * 打开时停掉空闲的“左顾右盼”与随机小动作，免得把节奏抢走。
   */
  void setBeatMode(bool on) { beatMode_ = on; }
  /** 打瞌睡：舵机停在 0 度附近，只在 0~1° 之间极慢地微微上抬。 */
  void setDozing(bool dozing);
  bool dozing() const { return dozing_; }

  /** 每帧调用：有空闲行为需要时自行触发，正在播动作时按关键帧推进。 */
  void update(uint32_t now, FaceExpression expression, int16_t gazeX, int16_t gazeY);
  /** 立即播放一个预设动作（会打断当前动作）。 */
  void play(Action action);
  bool busy() const { return current_ != Action::None; }

 private:
  struct Frame {
    int8_t yaw;    // -100..100 归一化，正数为向右
    int8_t pitch;  // -100..100 归一化，正数为抬头
    uint16_t holdMs;
  };

  void start(const Frame* frames, uint8_t count, Action action, int speed);
  void applyFrame(const Frame& frame);
  /** 回中：不是水平正中，而是微微抬头。 */
  void home();
  /**
   * 所有舵机下发都走这里：记录当前姿态，当变化超过阈值时打一行日志。
   * 睡着以后舵机不应该“突然位移”，日志是唯一能确认是谁动的手。
   */
  void command(float yaw, int pitchAngle, int speed, const char* reason);

  bool enabled_ = true;
  bool beatMode_ = false;
  bool dozing_ = false;
  uint32_t dozingSince_ = 0;
  /** 进入打瞌睡时的姿态，用来在 2.5 秒内渐变过去，而不是一步跳过去。 */
  float dozingStartYaw_ = 0.0f;
  int dozingStartPitch_ = 0;
  /** 最后一次下发的姿态（归一化 yaw 与角度单位 pitch）。 */
  float lastYaw_ = 0.0f;
  int lastPitchAngle_ = 0;
  int speed_ = 420;   // 当前动作的舵机速度（0-1000，越小越慢）
  const Frame* frames_ = nullptr;
  uint8_t frameCount_ = 0;
  uint8_t frameIndex_ = 0;
  uint32_t frameStartedAt_ = 0;
  Action current_ = Action::None;

  FaceExpression lastExpression_ = FaceExpression::Neutral;
  uint32_t nextIdleMotionAt_ = 0;
  uint32_t nextWorkNodAt_ = 0;
  uint32_t nextGazeAt_ = 0;
  int16_t lastGazeX_ = 0;
  int16_t lastGazeY_ = 0;
  uint16_t idleMotionIndex_ = 0;
};

#include "MotionDirector.h"

#include <M5StackChan.h>

namespace {
/* ── 俯仰轴的坐标换算 ────────────────────────────────────────────────────────
 * StackChan-BSP 里 pitch 舵机的 angleLimit = 0..900，而 ScsServo 的换算是
 *   raw = zeroPos + angle * 16 / 5 / 10        （angle 0 = 标定零点 = 水平位）
 * 也就是说 angle 为 0 时头是水平的，angle 越大越抬头；450 已经是零点上方
 * 约 145 个原始步进（40° 以上）。而 lookAtNormalized(y) 把 y=0 映到 angle 450，
 * 所以"归一化中点"并不等于水平位——中位必须用角度来表达。
 */
constexpr float kAnglePerNorm = 450.0f;   // 归一化 1.0 对应 450 个角度单位
constexpr float kPitchMidAngle = 450.0f;  // 归一化 0.0 对应的角度

/** 中位：标定零点上方 10°（1° ≈ 10 个角度单位，angle→raw 为 angle/3.125）。 */
constexpr int kHomePitchAngle = 100;
/** 俯仰只使用这一段（用户建议 0-200 就够了），避免再出现"抬太高"。 */
constexpr int kPitchMinAngle = 0;
constexpr int kPitchMaxAngle = 200;

float pitchToNorm(int angle) {
  return (static_cast<float>(angle) - kPitchMidAngle) / kAnglePerNorm;
}

int clampPitchAngle(int angle) {
  if (angle < kPitchMinAngle) return kPitchMinAngle;
  if (angle > kPitchMaxAngle) return kPitchMaxAngle;
  return angle;
}

/* ── 左右轴 ──────────────────────────────────────────────────────────────── */
// 归一化上限：留出余量，避免顶到机械极限。
constexpr float kLimit = 0.85f;
// 动作幅度：用户反馈"位移太多"，整体减半。
constexpr float kYawScale = 0.26f;    // 视线满偏时头部转多少（约 ±13°）
constexpr float kPitchScale = 0.05f;  // 俯仰跟随：只做轻微上下浮动

constexpr int kPresetSpeed = 420;
constexpr int kGentleSpeed = 190;   // 惊醒等需要慢、柔的动作
constexpr int kGazeSpeed = 220;
/** 进入打瞌睡时用多久渐变到睡姿（毫秒）。太短会像“头突然抽一下”。 */
constexpr uint32_t kDozingSettleMs = 2500;

/** 思考与执行都算"在忙"，这类状态下会定期轻轻点头。 */
/** 头部动作的名字，日志可读。 */
const char* actionName(MotionDirector::Action action) {
  static const char* names[] = {"none", "center", "nod", "doubleNod", "shake", "tilt", "droop",
                                "perk", "sweep", "wiggle", "wakeShake", "patShake", "beatNod",
                                "beatNodStrong", "beatNodFast"};
  const uint8_t index = static_cast<uint8_t>(action);
  return index < sizeof(names) / sizeof(names[0]) ? names[index] : "?";
}

constexpr bool isBusyExpression(FaceExpression expression) {
  return expression == FaceExpression::Thinking || expression == FaceExpression::Focused;
}
}  // namespace

void MotionDirector::home() {
  // 回中：标定零点上方一点点，基本就是平视。
  command(0.0f, kHomePitchAngle, kPresetSpeed, "home");
}

void MotionDirector::begin() {
  randomSeed(micros());
  const uint32_t now = millis();
  nextIdleMotionAt_ = now + random(18000, 35000);
  nextWorkNodAt_ = now + random(4000, 8000);
  if (enabled_) home();
}

void MotionDirector::setEnabled(bool enabled) {
  enabled_ = enabled;
  if (!enabled) {
    current_ = Action::None;
    frames_ = nullptr;
    home();
  }
}

void MotionDirector::setDozing(bool dozing) {
  if (dozing_ == dozing) return;
  dozing_ = dozing;
  if (dozing) {
    // 打瞌睡：结束当前动作，记下现在的姿态，准备在 2.5 秒内慢慢沉下去。
    // （早先是一步到位，视觉上就是“头突然抽一下”。）
    current_ = Action::None;
    frames_ = nullptr;
    dozingSince_ = millis();
    dozingStartYaw_ = lastYaw_;
    dozingStartPitch_ = lastPitchAngle_;
    Serial.printf("[motion] dozing on (from yaw=%.2f pitch=%d)\n", dozingStartYaw_, dozingStartPitch_);
  } else {
    // 不在这里立即 home()：惊醒应该慢慢抬头，交给 WakeShake 的第一帧。
    current_ = Action::None;
    frames_ = nullptr;
    Serial.println("[motion] dozing off");
  }
}

void MotionDirector::start(const Frame* frames, uint8_t count, Action action, int speed) {
  frames_ = frames;
  frameCount_ = count;
  frameIndex_ = 0;
  speed_ = speed;
  frameStartedAt_ = millis();
  current_ = action;
  if (count) applyFrame(frames[0]);
}

void MotionDirector::applyFrame(const Frame& frame) {
  const float yaw = static_cast<float>(frame.yaw) / 100.0f * kLimit;
  // 关键帧的 pitch 是相对中位的百分比，换算成角度后夹在 0-200 的俯仰窗口内。
  const int pitchAngle = clampPitchAngle(
      kHomePitchAngle + static_cast<int>(static_cast<float>(frame.pitch) / 100.0f * kLimit * kAnglePerNorm));
  command(yaw, pitchAngle, kPresetSpeed, "frame");
}

/**
 * 所有舵机下发都经过这里。
 * 变化超过阈值（yaw 0.05 归一化 / pitch 1 度）才打一行日志，
 * 免得每帧都刷屏，但“突然位移”一定能被记下来。
 */
void MotionDirector::command(float yaw, int pitchAngle, int speed, const char* reason) {
  if (yaw > kLimit) yaw = kLimit;
  if (yaw < -kLimit) yaw = -kLimit;
  const int clampedPitch = clampPitchAngle(pitchAngle);
#if FINCHCHAN_MOTION_TRACE
  // 逐帧舵机日志：默认关掉（每拍三行会把串口刷满）。
  const bool moved = fabsf(yaw - lastYaw_) > 0.05f || abs(clampedPitch - lastPitchAngle_) > 10;
  if (moved) {
    Serial.printf("[motion] yaw=%.2f pitch=%d speed=%d %s%s\n", yaw, clampedPitch, speed, reason,
                  dozing_ ? " (dozing)" : "");
  }
#endif
  lastYaw_ = yaw;
  lastPitchAngle_ = clampedPitch;
  M5StackChan.Motion.lookAtNormalized(yaw, pitchToNorm(clampedPitch), speed);
}

void MotionDirector::play(Action action) {
  if (!enabled_) return;
  // 关键帧表放在函数内，Frame 是私有嵌套类型，这样不必把它暴露到头文件。
  // 幅度已按用户反馈整体减半。
  static const Frame nod[] = {{0, -12, 170}, {0, 3, 190}, {0, 0, 140}};
  static const Frame doubleNod[] = {{0, -10, 150}, {0, 3, 140}, {0, -10, 150}, {0, 3, 140}, {0, 0, 140}};
  static const Frame shake[] = {{-8, 0, 160}, {8, 0, 160}, {-6, 0, 160}, {6, 0, 160}, {0, 0, 140}};
  static const Frame tilt[] = {{9, -3, 620}, {0, 0, 220}};
  static const Frame droop[] = {{0, -18, 700}, {0, -10, 320}, {0, 0, 220}};
  static const Frame perk[] = {{0, 7, 240}, {0, 0, 180}};
  static const Frame sweep[] = {{-10, 0, 260}, {10, 0, 380}, {-6, 0, 220}, {0, 0, 180}};
  static const Frame wiggle[] = {{-6, 4, 130}, {6, 4, 130}, {-4, 3, 130}, {4, 3, 130}, {0, 0, 130}};
  // 惊醒：很慢地回到中位，然后左右各 1° 轻晃两下（幅度小、速度慢）。
  static const Frame wakeShake[] = {{0, 0, 420}, {-1, 0, 170}, {1, 0, 170}, {-1, 0, 170}, {1, 0, 170}, {0, 0, 180}};

  // 被拍头：慢慢地左右摇两下。幅度适中、每步停留长、配合柔和的舵机速度，
  // 避免快速小幅度摇头那种“机械感”。
  static const Frame patShake[] = {{-7, 0, 420}, {7, 0, 420}, {-5, 0, 420}, {5, 0, 420}, {0, 0, 360}};
  // 跟拍点头：一次触发只播一次“下去→回中”，节奏感才干净。
  static const Frame beatNod[] = {{0, -16, 120}, {0, 4, 120}, {0, 0, 90}};
  // 强拍 / 慢歌：更深的点头（约 9°）。
  static const Frame beatNodStrong[] = {{0, -22, 130}, {0, 6, 130}, {0, 0, 90}};
  // 快歌（≥150BPM）：短促一点，保证能在下一拍之前做完整个来回。
  static const Frame beatNodFast[] = {{0, -13, 85}, {0, 3, 85}, {0, 0, 60}};

  // 跟拍点头不在这里打 motion= ：下一行 [beat] 已经说明了一拍。
  if (action != Action::BeatNod && action != Action::BeatNodStrong && action != Action::BeatNodFast) {
    Serial.printf("motion=%s\n", actionName(action));
  }
  switch (action) {
    case Action::Center: home(); current_ = Action::None; break;
    case Action::Nod: start(nod, sizeof(nod) / sizeof(Frame), action, kPresetSpeed); break;
    case Action::DoubleNod: start(doubleNod, sizeof(doubleNod) / sizeof(Frame), action, kPresetSpeed); break;
    case Action::Shake: start(shake, sizeof(shake) / sizeof(Frame), action, kPresetSpeed); break;
    case Action::Tilt: start(tilt, sizeof(tilt) / sizeof(Frame), action, kPresetSpeed); break;
    case Action::Droop: start(droop, sizeof(droop) / sizeof(Frame), action, kPresetSpeed); break;
    case Action::Perk: start(perk, sizeof(perk) / sizeof(Frame), action, kPresetSpeed); break;
    case Action::Sweep: start(sweep, sizeof(sweep) / sizeof(Frame), action, kPresetSpeed); break;
    case Action::Wiggle: start(wiggle, sizeof(wiggle) / sizeof(Frame), action, kPresetSpeed); break;
    case Action::WakeShake: start(wakeShake, sizeof(wakeShake) / sizeof(Frame), action, kGentleSpeed); break;
    case Action::PatShake: start(patShake, sizeof(patShake) / sizeof(Frame), action, kGentleSpeed); break;
    case Action::BeatNod: start(beatNod, sizeof(beatNod) / sizeof(Frame), action, kPresetSpeed); break;
    case Action::BeatNodStrong: start(beatNodStrong, sizeof(beatNodStrong) / sizeof(Frame), action, kPresetSpeed); break;
    case Action::BeatNodFast: start(beatNodFast, sizeof(beatNodFast) / sizeof(Frame), action, kPresetSpeed); break;
    default: break;
  }
}

void MotionDirector::update(uint32_t now, FaceExpression expression, int16_t gazeX, int16_t gazeY) {
  if (!enabled_) return;

  // 打瞌睡：不跟视线、不播动作。
  // 先花 kDozingSettleMs 从「刚才的姿态」慢慢沉到打瞌睡姿态（否则会看到头突然抽一下），
  // 然后再只做 0~1° 的极慢起伏（7 秒一个来回）。
  if (dozing_) {
    const uint32_t elapsed = now - dozingSince_;
    const float settle = elapsed >= kDozingSettleMs
                             ? 1.0f
                             : static_cast<float>(elapsed) / static_cast<float>(kDozingSettleMs);
    const uint32_t phase = elapsed % 7000UL;
    const uint32_t travel = phase < 3500UL ? phase : 7000UL - phase;
    const int ripple = clampPitchAngle(static_cast<int>(travel * 10UL / 3500UL));  // 0..10 单位 = 0~1°
    const float yaw = dozingStartYaw_ * (1.0f - settle);
    const int pitch = static_cast<int>(dozingStartPitch_ + (ripple - dozingStartPitch_) * settle);
    command(yaw, pitch, settle < 1.0f ? kGentleSpeed : kGazeSpeed, "doze");
    return;
  }

  // 表情切换时先给一个肢体反应，让"情绪"落到身体上。
  if (expression != lastExpression_) {
    const bool wasBusy = isBusyExpression(lastExpression_);
    const bool nowBusy = isBusyExpression(expression);
    // 只要不再处于空闲状态，就先把头收回到中位（running 时不应该歪着头）。
    if (expression != FaceExpression::Neutral) home();
    lastExpression_ = expression;
    switch (expression) {
      case FaceExpression::Sad:
      case FaceExpression::Reluctant: play(Action::Droop); break;
      case FaceExpression::Alarmed: play(Action::Shake); break;
      case FaceExpression::Delighted: play(Action::DoubleNod); break;
      case FaceExpression::Asking: play(Action::Perk); break;
      // 开始干活时轻轻点一下头，然后保持中位。
      case FaceExpression::Focused: play(Action::Nod); break;
      default: break;
    }
    // 进入/离开"忙"这一族时才重排点头时机；
    // thinking ↔ working 之间的抖动不能重置计时，否则一轮任务里永远轮不到点头。
    if (!wasBusy && nowBusy) {
      nextWorkNodAt_ = now + 2500;
    } else if (wasBusy && !nowBusy) {
      nextWorkNodAt_ = now + random(4000, 8000);
    }
    nextIdleMotionAt_ = now + random(18000, 35000);
  }

  // 正在播预设动作：按关键帧推进，播完自然回到"跟视线"模式。
  if (current_ != Action::None) {
    if (now - frameStartedAt_ >= frames_[frameIndex_].holdMs) {
      frameIndex_++;
      if (frameIndex_ >= frameCount_) {
        current_ = Action::None;
        frames_ = nullptr;
      } else {
        frameStartedAt_ = now;
        applyFrame(frames_[frameIndex_]);
      }
    }
    return;
  }

  // 干活期间（思考或执行）定期轻轻点头。
  if (isBusyExpression(expression) && now >= nextWorkNodAt_) {
    nextWorkNodAt_ = now + random(6000, 10000);
    play(Action::Nod);
    return;
  }

  // 空闲时随机播一个有趣动作（歪头 / 扫视 / 抬头 / 摆动）。
  // 节拍模式（听歌跟拍）下不播：这些动作会把节奏抢走。
  if (!beatMode_ && expression == FaceExpression::Neutral && now >= nextIdleMotionAt_) {
    static const Action idleCycle[] = {Action::Tilt, Action::Sweep, Action::Perk, Action::Wiggle};
    const Action action = idleCycle[idleMotionIndex_ % (sizeof(idleCycle) / sizeof(Action))];
    idleMotionIndex_++;
    // 空闲动作的频率降下来，别显得毛躁。
    nextIdleMotionAt_ = now + random(20000, 40000);
    play(action);
    return;
  }

  // 只有空闲（眼睛左顾右盼）时，头部才跟着视线走；其它状态一律保持中位。
  // 听歌跟拍时也不跟视线：头要保持稳，每一拍才看得出来。
  if (!beatMode_ &&
      expression == FaceExpression::Neutral &&
      now >= nextGazeAt_ &&
      (abs(gazeX - lastGazeX_) >= 4 || abs(gazeY - lastGazeY_) >= 3)) {
    lastGazeX_ = gazeX;
    lastGazeY_ = gazeY;
    nextGazeAt_ = now + 150;
    float yaw = constrain(static_cast<float>(gazeX) / 16.0f, -1.0f, 1.0f) * kYawScale;
    const int pitchAngle = clampPitchAngle(
        kHomePitchAngle + static_cast<int>(constrain(static_cast<float>(-gazeY) / 14.0f, -1.0f, 1.0f) * kPitchScale * kAnglePerNorm));
    command(yaw, pitchAngle, kGazeSpeed, "gaze");
  }
}

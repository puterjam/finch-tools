#pragma once

#include <Arduino.h>
#include <M5Unified.h>

/**
 * 由 muspi（树莓派项目 ui/emotion.py）移植的表情系统。
 *
 * 原设计的要点被完整保留：
 *   - 脸上只有眼睛，没有嘴：靠 12 种眼型和遮罩雕刻出情绪；
 *   - 眼型用「实心椭圆 + 背景色遮罩」拼出来，因此没有位图资源；
 *   - 自动行为：随机眨眼（2~8 秒）、neutral 下随机东张西望与皱眉抽动；
 *   - 切换表情时可选 shake / shocked / breathe 三种附加动画。
 *
 * 与移植前的差异（屏幕从 80x32 单色 OLED 变为 320x240 彩色 TFT）：
 *   1. 整脸等比放大 3 倍，眼睛单元从 22px 放大到 66px；
 *   2. 用彩色代替黑白：眼型颜色随表情变化（暖白 / 苔绿 / 玫瑰 / 琥珀）；
 *   3. 随机间隔与动画时长按毫秒实现，不再依赖 time.time()。
 */
enum class FaceExpression : uint8_t {
  Neutral,     // 空闲
  Thinking,    // 正在思考（眼睛看向侧上方 + 呼吸）
  Focused,     // 正在执行任务（半闭眼，muspi 的 confident）
  Happy,       // 有未读结果（happy 眼型）
  Loving,      // 被拍：爱心眼（muspi 的 loving）
  Delighted,   // 完成任务 / 用户点了允许（laughing 眼型 + 抖动）
  Asking,      // 有等待中的请求（wide 眼型 + 震惊动画）
  Reluctant,   // 用户点了拒绝：无奈（一大一小半闭眼，缓缓下移）
  Listening,   // 正在说话 / 播报（睁开 + 眨眼型 + 呼吸）
  Sad,         // 出错（furrowed + 下垂）
  Sleeping,    // 休眠
  Alarmed      // 紧急错误（wide + 快速抖动）
};

/** 眼型，与 muspi 的 eye state 一一对应。 */
enum class EyeShape : uint8_t {
  Open,
  HalfClose,
  NearlyClose,
  Close,
  Laughing,
  Relaxed,
  Winking,
  Sleeping,
  Happy,
  Furrowed,
  Wide,
  Hearts
};

class EmotionFace {
 public:
  void begin();
  void setExpression(FaceExpression expression);
  /** 把当前表情画到给定画布（通常是离屏 sprite）；topInset 用于给上方内容让位。 */
  void update(LovyanGFX& g, uint32_t now, int16_t topInset = 0);

  /** 当前视线偏移（像素），头部动作用它来同步看向同一侧。 */
  int16_t gazeOffsetX() const { return offsetX_; }
  int16_t gazeOffsetY() const { return offsetY_; }

 private:
  struct ExpressionSpec {
    EyeShape left;
    EyeShape right;
    uint8_t rotation;   // 遮罩旋转角度，0~90，用于 furrowed 的斜切方向
    bool shake;
    bool shocked;
    bool breathe;
  };

  static ExpressionSpec specFor(FaceExpression expression);
  /** 只负责形状本身（椭圆/弧/三角/爱心），不含抗锯齿。 */
  void drawEyeShape(LovyanGFX& g, int16_t x, int16_t y, uint8_t size, EyeShape shape,
                    uint8_t rotation, bool mirror);
  /** 抗锯齿的眼睛：先在 2 倍大的离屏画布上画形状，再按 0.5 缩放贴回。 */
  void drawEye(LovyanGFX& g, int16_t x, int16_t y, uint8_t size, EyeShape shape,
               uint8_t rotation, bool mirror);
  void drawHearts(LovyanGFX& g, int16_t x, int16_t y, uint8_t size);
  /** 眼睛偏移的缓动：0.2 秒内线性逼近目标位置。 */
  int16_t easeOffset(int16_t target, int16_t current);
  int16_t topInset_ = 0;
  void scheduleBehaviour(uint32_t now);

  ExpressionSpec spec_ = specFor(FaceExpression::Neutral);
  FaceExpression expression_ = FaceExpression::Neutral;
  EyeShape leftShape_ = EyeShape::Open;
  EyeShape rightShape_ = EyeShape::Open;

  uint32_t expressionChangedAt_ = 0;
  int16_t offsetX_ = 0;
  int16_t offsetY_ = 0;
  int16_t targetX_ = 0;
  int16_t targetY_ = 0;
  int16_t lastTargetX_ = 0;
  int16_t lastTargetY_ = 0;
  uint32_t offsetChangedAt_ = 0;

  uint32_t nextBlinkAt_ = 0;
  uint32_t blinkUntil_ = 0;
  bool blinking_ = false;
  /* 抗锯齿用的离屏画布：眼睛在这里按 2 倍画，再缩回原尺寸贴到屏幕上。
   * 边长要装得下最大的形状（Laughing 会把圆下沉 radius/4，所以取 1.25 倍直径）。 */
  static constexpr int16_t kEyeBufferSize = 160;
  M5Canvas eyeBuffer_;
  bool eyeBufferReady_ = false;
  uint32_t nextLookAt_ = 0;
  uint32_t nextFurrowAt_ = 0;
  uint32_t furrowUntil_ = 0;
  uint32_t swayUntil_ = 0;   // shake
  uint32_t gaspUntil_ = 0;   // shocked
  uint8_t lookMoves_ = 0;
};

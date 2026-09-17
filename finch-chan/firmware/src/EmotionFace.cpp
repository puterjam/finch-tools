#include "EmotionFace.h"

namespace {
// 屏幕 320x240，muspi 的 80x32 布局等比放大后：眼睛单元 80px，瞳孔 60px。
constexpr int16_t kEyeSize = 60;
constexpr int16_t kLeftEyeX = 112;
constexpr int16_t kRightEyeX = 208;
constexpr int16_t kEyeY = 108;

// 单色设计：眼睛只有白色，情绪完全靠形状表达（与 muspi 的单色 OLED 一致）。
constexpr uint16_t kEye = TFT_WHITE;
constexpr uint16_t kBackdrop = TFT_BLACK;

constexpr uint32_t kBlinkMinMs = 2000;
constexpr uint32_t kBlinkMaxMs = 8000;
constexpr uint32_t kBlinkHoldMs = 140;
constexpr uint32_t kLookMinMs = 12000;
constexpr uint32_t kLookMaxMs = 26000;
constexpr uint32_t kLookStepMs = 3200;
constexpr uint32_t kFurrowMinMs = 5000;
constexpr uint32_t kFurrowMaxMs = 10000;
constexpr uint32_t kFurrowHoldMs = 520;
constexpr uint32_t kShakeMs = 620;
constexpr uint32_t kGaspMs = 900;
constexpr uint32_t kEaseMs = 200;

// muspi PATTERN.HEARTS 的 16x16 位图，按行存成 16 位整数。
constexpr uint16_t kHearts[16] = {
  0x0000, 0x0000, 0x3C3C, 0x7E7E, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF,
  0x7FFE, 0x3FFC, 0x1FF8, 0x0FF0, 0x07E0, 0x03C0, 0x0180, 0x0000,
};

constexpr bool wantsBlink(FaceExpression expression) {
  // 与 muspi 的 NO_BLINK 列表对应：这些表情本身表达了闭眼语义。
  switch (expression) {
    case FaceExpression::Listening:
    case FaceExpression::Sleeping:
    case FaceExpression::Delighted:
    case FaceExpression::Happy:
    case FaceExpression::Loving:
    case FaceExpression::Reluctant:
    case FaceExpression::Alarmed:
      return false;
    default:
      return true;
  }
}
}  // namespace

EmotionFace::ExpressionSpec EmotionFace::specFor(FaceExpression expression) {
  switch (expression) {
    // 空闲：睁开双眼，随机眨眼 / 东张西望 / 皱眉
    case FaceExpression::Neutral: return {EyeShape::Open, EyeShape::Open, 0, false, false, false};
    // 思考：左睁右皱眉（muspi 的 thinking），眼睛缓慢呼吸
    case FaceExpression::Thinking: return {EyeShape::Open, EyeShape::Furrowed, 20, false, false, true};
    // 执行中：半闭眼（muspi 的 confident），表示专注
    case FaceExpression::Focused: return {EyeShape::NearlyClose, EyeShape::HalfClose, 0, false, false, false};
    // 有未读：弯眼笑
    case FaceExpression::Happy: return {EyeShape::Happy, EyeShape::Happy, 0, false, false, false};
    // 被拍：爱心眼
    case FaceExpression::Loving: return {EyeShape::Hearts, EyeShape::Hearts, 0, false, false, false};
    // 用户点了允许 / 刚完成：大笑 + 抖动
    case FaceExpression::Delighted: return {EyeShape::Laughing, EyeShape::Laughing, 0, true, false, false};
    // 等你处理：睁大 + 震惊动画
    case FaceExpression::Asking: return {EyeShape::Wide, EyeShape::Wide, 0, false, true, true};
    // 无奈：一大一小半闭眼，慢慢下沉后回位
    case FaceExpression::Reluctant: return {EyeShape::Relaxed, EyeShape::NearlyClose, 8, false, false, true};
    // 说话：左睁右眨眼 + 呼吸
    case FaceExpression::Listening: return {EyeShape::Open, EyeShape::Winking, 0, false, false, true};
    // 出错：皱眉下垂
    case FaceExpression::Sad: return {EyeShape::Furrowed, EyeShape::Furrowed, 30, false, false, true};
    // 休眠：闭眼 + 呼吸
    case FaceExpression::Sleeping: return {EyeShape::Sleeping, EyeShape::Sleeping, 0, false, false, true};
    // 紧急：睁大 + 快速抖动
    default: return {EyeShape::Wide, EyeShape::Wide, 0, true, true, false};
  }
}

void EmotionFace::begin() {
  randomSeed(micros());
  const uint32_t now = millis();
  spec_ = specFor(expression_);
  leftShape_ = spec_.left;
  rightShape_ = spec_.right;
  expressionChangedAt_ = now;
  nextBlinkAt_ = now + random(kBlinkMinMs, kBlinkMaxMs);
  nextLookAt_ = now + random(kLookMinMs, kLookMaxMs);
  nextFurrowAt_ = now + random(kFurrowMinMs, kFurrowMaxMs);
}

void EmotionFace::setExpression(FaceExpression expression) {
  const uint32_t now = millis();
  expression_ = expression;
  spec_ = specFor(expression);
  leftShape_ = spec_.left;
  rightShape_ = spec_.right;
  expressionChangedAt_ = now;
  targetX_ = 0; targetY_ = 0; lookMoves_ = 0;
  nextLookAt_ = now + random(kLookMinMs, kLookMaxMs);
  nextFurrowAt_ = now + random(kFurrowMinMs, kFurrowMaxMs);
  if (spec_.shake) swayUntil_ = now + kShakeMs;
  if (spec_.shocked) gaspUntil_ = now + kGaspMs;
  if (expression == FaceExpression::Thinking) { targetX_ = -14; targetY_ = -8; }
  if (expression == FaceExpression::Reluctant) { targetX_ = 10; targetY_ = 8; }
}

int16_t EmotionFace::easeOffset(int16_t target, int16_t current) {
  const uint32_t elapsed = millis() - offsetChangedAt_;
  if (elapsed >= kEaseMs) return target;
  return static_cast<int16_t>(current + static_cast<int32_t>(target - current) * elapsed / kEaseMs);
}

void EmotionFace::scheduleBehaviour(uint32_t now) {
  // 眨眼
  if (wantsBlink(expression_)) {
    if (!blinking_ && now >= nextBlinkAt_) {
      blinking_ = true;
      blinkUntil_ = now + kBlinkHoldMs;
      nextBlinkAt_ = now + random(kBlinkMinMs, kBlinkMaxMs);
    } else if (blinking_ && now >= blinkUntil_) {
      blinking_ = false;
    }
  } else {
    blinking_ = false;
  }

  // 只在空闲时东张西望与皱眉，和 muspi 一致
  if (expression_ == FaceExpression::Neutral) {
    if (now >= nextLookAt_) {
      if (lookMoves_ >= 6) {
        targetX_ = 0; targetY_ = 0; lookMoves_ = 0;
        nextLookAt_ = now + random(kLookMinMs, kLookMaxMs);
      } else {
        targetX_ = static_cast<int16_t>(random(-16, 17));
        targetY_ = static_cast<int16_t>(random(-14, 11));
        lookMoves_ += 1;
        nextLookAt_ = now + kLookStepMs;
      }
      offsetChangedAt_ = now;
    }
    if (now >= nextFurrowAt_) {
      furrowUntil_ = now + kFurrowHoldMs;
      nextFurrowAt_ = now + random(kFurrowMinMs, kFurrowMaxMs);
    }
  }
}

void EmotionFace::drawHearts(LovyanGFX& g, int16_t x, int16_t y, uint8_t size) {
  const uint8_t pixel = static_cast<uint8_t>(size / 16 > 0 ? size / 16 : 1);
  for (uint8_t row = 0; row < 16; ++row) {
    for (uint8_t column = 0; column < 16; ++column) {
      if (kHearts[row] & (1U << (15 - column))) {
        g.fillRect(x + column * pixel, y + row * pixel, pixel, pixel, kEye);
      }
    }
  }
}

void EmotionFace::drawEye(LovyanGFX& g, int16_t x, int16_t y, uint8_t size, EyeShape shape,
                          uint8_t rotation, bool mirror) {
  const int16_t radius = size / 2;
  const int16_t direction = mirror ? -1 : 1;

  switch (shape) {
    case EyeShape::Open:
      g.fillEllipse(x, y, radius, radius, kEye);
      break;
    case EyeShape::HalfClose:
      g.fillEllipse(x, y, radius, radius * 3 / 5, kEye);
      break;
    case EyeShape::NearlyClose:
      g.fillEllipse(x, y, radius, radius / 3, kEye);
      break;
    case EyeShape::Close:
      // 眨眼：一条「合上的眼睫」弧，和睡着时同一套弧线，只是更快。
      // 之前是一条 6px 细横线：在 2 寸屏上太细，容易被看成"这一帧没画眼睛"。
      g.fillArc(x, y - radius / 3, radius * 62 / 100, radius * 92 / 100, 20.0f, 160.0f, kEye);
      break;
    case EyeShape::Laughing:
      // 实心圆下沉后用更大的背景圆掏出下半部分，留下向下的弧（∩）
      g.fillEllipse(x, y + radius / 4, radius, radius, kEye);
      g.fillEllipse(x, y + radius / 4 + radius / 2, radius + 3, radius, kBackdrop);
      break;
    case EyeShape::Relaxed:
      g.fillEllipse(x, y - radius / 4, radius, radius, kEye);
      g.fillEllipse(x, y - radius / 4 - radius / 2, radius + 3, radius, kBackdrop);
      break;
    case EyeShape::Winking:
      // 眨眼：一条较细的下弯弧。
      g.fillArc(x, y - radius / 4, radius * 66 / 100, radius * 85 / 100, 15.0f, 165.0f, kEye);
      break;
    case EyeShape::Sleeping:
      // 睡着（muspi 的 sleeping）：更厚、更低的下弯弧，像合上的眼皮。
      // 用描边弧而不是椭圆镂空——后者在 60px 的眼睛上只剩几条横杠。
      g.fillArc(x, y - radius / 3, radius * 6 / 10, radius * 88 / 100, 20.0f, 160.0f, kEye);
      break;
    case EyeShape::Happy:
      g.fillEllipse(x, y, radius, radius, kEye);
      g.fillEllipse(x, y + radius / 2, radius + 2, radius, kBackdrop);
      break;
    case EyeShape::Furrowed: {
      g.fillEllipse(x, y, radius, radius, kEye);
      // 用背景色斜切掉上方一块：角度越大越"皱眉"
      const int16_t slant = static_cast<int16_t>(radius) * rotation / 100 * direction;
      const int16_t top = y - radius - 2;
      const int16_t cutLeft = y - radius / 2 + slant;
      const int16_t cutRight = y - radius / 2 - slant;
      g.fillTriangle(x - radius - 2, top, x + radius + 2, top, x + radius + 2, cutRight, kBackdrop);
      g.fillTriangle(x - radius - 2, top, x + radius + 2, cutRight, x - radius - 2, cutLeft, kBackdrop);
      break;
    }
    case EyeShape::Wide:
      g.fillEllipse(x, y, radius + radius / 4, radius + radius / 4, kEye);
      break;
    default: {
      // 爱心眼：比瞳孔放大 1.2 倍，小屏上更明显又不溢出。
      const int16_t heartSize = static_cast<int16_t>(size * 6 / 5);
      drawHearts(g, x - heartSize / 2, y - heartSize / 2, heartSize);
      break;
    }
  }
}

void EmotionFace::update(LovyanGFX& g, uint32_t now, int16_t topInset) {
  scheduleBehaviour(now);
  topInset_ = topInset;

  offsetX_ = easeOffset(targetX_, offsetX_);
  offsetY_ = easeOffset(targetY_, offsetY_);

  int16_t breathe = 0;
  if (spec_.breathe) {
    // 呼吸：3.2 秒一个来回，振幅 6px
    const uint32_t phase = (now - expressionChangedAt_) % 3200;
    const int32_t half = 1600;
    const int32_t travel = phase < half ? phase : 3200 - phase;
    breathe = static_cast<int16_t>((travel - half / 2) * 12 / half);
  }
  int16_t shake = 0;
  if (now < swayUntil_) {
    const uint32_t phase = (now - expressionChangedAt_) % 220;
    shake = phase < 110 ? -7 : 7;
  }

  const bool gasping = now < gaspUntil_;
  EyeShape left = blinking_ ? EyeShape::Close : leftShape_;
  EyeShape right = blinking_ ? EyeShape::Close : rightShape_;
  if (now < furrowUntil_) { left = EyeShape::Furrowed; right = EyeShape::Furrowed; }
  if (gasping && spec_.shocked) { left = EyeShape::Wide; right = EyeShape::Wide; }

  const int16_t offsetY = offsetY_ + breathe + shake + topInset_;
  drawEye(g, kLeftEyeX + offsetX_, kEyeY + offsetY, kEyeSize, left, spec_.rotation, false);
  drawEye(g, kRightEyeX + offsetX_, kEyeY + offsetY, kEyeSize, right, spec_.rotation, true);
}

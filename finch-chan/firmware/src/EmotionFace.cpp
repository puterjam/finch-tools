#include "EmotionFace.h"

#include "Log.h"

namespace {
// 屏幕 320x240，muspi 的 80x32 布局等比放大后：眼睛单元 80px，瞳孔 60px。
constexpr int16_t kEyeSize = 60;
constexpr int16_t kLeftEyeX = 112;
constexpr int16_t kRightEyeX = 208;
/* 眼睛中心的垂直基线。有气泡时 PetRenderer 会传 topInset 把它往下推（inset/2），
 * 卡片/未读再往上抬 kPromptEyeLift，所以这一条是"所有状态的共同基准"。
 * 98 比正中间（120）偏上，给底部按钮和频谱留出距离：眼睛占 68~128，
 * 3 个选项时上排按钮从 160 起，还有 32px 余量。 */
constexpr int16_t kEyeY = 98;

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
  // 抗锯齿用的离屏画布（PSRAM）：眼睛按 2 倍画在这上面，再缩回原尺寸贴到屏幕上。
  eyeBuffer_.setColorDepth(16);
  eyeBuffer_.setPivot(kEyeBufferSize / 2, kEyeBufferSize / 2);
  eyeBufferReady_ = eyeBuffer_.createSprite(kEyeBufferSize, kEyeBufferSize);
  eyeCacheReady_ = true;
  for (uint8_t slot = 0; slot < 2; ++slot) {
    eyeCache_[slot].setColorDepth(16);
    eyeCache_[slot].setPsram(true);
    if (!eyeCache_[slot].createSprite(kEyeCacheSize, kEyeCacheSize)) eyeCacheReady_ = false;
  }
  if (!eyeBufferReady_ || !eyeCacheReady_) {
    FC_LOGLN(1, "[face] eye AA buffer alloc failed: eyes fall back to hard edges");
    eyeBufferReady_ = false;
    eyeCacheReady_ = false;
  }
  const uint32_t now = millis();
  eyeDrawY_ = kEyeY;   // 第一帧之前先当成基线（增量推送要用）
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
  const bool changed = expression != expression_;
  expression_ = expression;
  spec_ = specFor(expression);
  leftShape_ = spec_.left;
  rightShape_ = spec_.right;
  expressionChangedAt_ = now;
  /* 只有**真的换表情**才重置视线与随机动作的计时。
   * 桥接每 2 秒对账会重发同一个状态 → 每次都调到这里；若每次都把 targetX_ 归零，
   * 眼睛正好看向旁边时就会用 0.2s 缓动"滑"回中间（切律动模式时最明显），
   * 而且 nextLookAt_/nextFurrowAt_ 永远被推迟 2 秒 → 随机环顾/皱眉根本上不了场。 */
  if (changed) {
    targetX_ = 0; targetY_ = 0; lookMoves_ = 0;
    nextLookAt_ = now + random(kLookMinMs, kLookMaxMs);
    nextFurrowAt_ = now + random(kFurrowMinMs, kFurrowMaxMs);
    if (spec_.shake) swayUntil_ = now + kShakeMs;
    if (spec_.shocked) gaspUntil_ = now + kGaspMs;
  }
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

/**
 * 抗锯齿的眼睛：形状先在 2 倍大的离屏画布上画，再用 `pushRotateZoomWithAA()` 按 0.5 缩放贴回。
 *
 * 为什么这么做：屏幕是 16 位色、没有 alpha 通道，矢量填充（`fillEllipse` / `fillArc` / 三角形）
 * 画出来都是硬边，60px 的圆边上能明显看到台阶。按 2 倍画再缩回去，LovyanGFX 会在缩放时
 * 按透明色算覆盖度做混合，于是**所有形状**（椭圆、弧、斜切三角、爱心）一次性都平滑了，
 * 不用把每个形状都换成"平滑图元"。
 */
void EmotionFace::drawEye(LovyanGFX& g, int16_t x, int16_t y, uint8_t size, EyeShape shape,
                          uint8_t rotation, bool mirror) {
  if (!eyeBufferReady_) {   // 兜底：离屏画布没建起来就按原来的硬边画
    drawEyeShape(g, x, y, size, shape, rotation, mirror);
    return;
  }
  constexpr int16_t scale = 2;
  /* 抗锯齿（2 倍画 → 0.5 贴回）本身很贵：`pushRotateZoomWithAA` 是逐像素的双线性重采样，
   * 一只眼睛就要十几毫秒。但**形状只在表情/眨眼/皱眉切换时才变**，位置变化都是平移。
   * 所以把「AA 之后的眼睛」缓存成一张小图（左右各一份，键 = 形状 + 旋转），
   * 每帧只做一次不透明的平移拷贝 —— 结果一模一样（底色都是黑），成本掉到零点几毫秒。 */
  const uint8_t slot = mirror ? 1 : 0;
  if (!eyeCacheReady_ || static_cast<uint8_t>(shape) != cacheShape_[slot] || rotation != cacheRotation_[slot]) {
    eyeBuffer_.fillScreen(kBackdrop);
    drawEyeShape(eyeBuffer_, kEyeBufferSize / 2, kEyeBufferSize / 2, size * scale, shape, rotation, mirror);
    eyeCache_[slot].fillScreen(kBackdrop);
    // 透明色 = 背景色：画布上没有 alpha，靠"和透明色的距离"算覆盖度，边上的灰像素就会混合。
    eyeBuffer_.pushRotateZoomWithAA(&eyeCache_[slot], kEyeCacheSize / 2, kEyeCacheSize / 2, 0.0f, 1.0f / scale,
                                    1.0f / scale, kBackdrop);
    cacheShape_[slot] = static_cast<uint8_t>(shape);
    cacheRotation_[slot] = rotation;
  }
  // 缓存图底色是黑、屏幕那块也是黑，所以不透明拷贝即可（没必要再按透明色混合一次）。
  const int16_t dstX = x - kEyeCacheSize / 2;
  const int16_t dstY = y - kEyeCacheSize / 2;
  if (eyeBlit_) {
    // 目标是离屏 sprite：两边都是 16 位、行优先紧密排布 → 直接按行 memcpy。
    // 走 pushSprite 的话是逐像素 writePixel（一只眼睛 6400 个像素要几毫秒）。
    auto* dst = static_cast<uint16_t*>(eyeBlit_->getBuffer());
    const auto* src = static_cast<const uint16_t*>(eyeCache_[slot].getBuffer());
    const int32_t stride = eyeBlit_->width();
    const int32_t limitY = eyeBlit_->height();
    for (int16_t row = 0; row < kEyeCacheSize; ++row) {
      const int32_t py = dstY + row;
      if (py < 0 || py >= limitY) continue;
      int32_t from = 0;
      int32_t to = kEyeCacheSize;
      if (dstX < 0) from = -dstX;
      if (dstX + to > stride) to = stride - dstX;
      if (to <= from) continue;
      memcpy(dst + py * stride + dstX + from, src + row * kEyeCacheSize + from,
             static_cast<size_t>(to - from) * sizeof(uint16_t));
    }
    return;
  }
  eyeCache_[slot].pushSprite(&g, dstX, dstY);
}

void EmotionFace::drawEyeShape(LovyanGFX& g, int16_t x, int16_t y, uint8_t size, EyeShape shape,
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
      // 眨眼：一条「合上的眼睫」弧，和睡着时同一套弧线，只是更快、更细。
      // 半径带 72%~88%（约 5px 厚），大致和眯眼那条横线同宽；
      // 之前一条 6px 细横线容易被看成"这一帧没画眼睛"，弧线虽然同样细但有长度，看得见。
      g.fillArc(x, y - radius / 3, radius * 72 / 100, radius * 88 / 100, 20.0f, 160.0f, kEye);
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

int16_t EmotionFace::eyeCenterY() const {
  // 眼睛实际落点：基线 + 气泡下推（topInset_）+ 视线偏移（呼吸/抖动只有几像素，算在带内余量里）
  return static_cast<int16_t>(kEyeY + topInset_ + offsetY_);
}

void EmotionFace::update(LovyanGFX& g, uint32_t now, int16_t topInset) {
  eyeBlit_ = nullptr;   // 通用目标（M5.Display 提示屏）：没有 memcpy 快速通道
  updateInternal(g, now, topInset);
}

void EmotionFace::update(M5Canvas& g, uint32_t now, int16_t topInset) {
  eyeBlit_ = &g;
  updateInternal(g, now, topInset);
}

void EmotionFace::updateInternal(LovyanGFX& g, uint32_t now, int16_t topInset) {
  scheduleBehaviour(now);
  if (topInset != topInset_) {
    // 第 2 档日志：眼睛落点变了才打一行。
    // 排查"表情是不是动了几像素""why 看起来下移了"时，看这一行最直接。
    topInset_ = topInset;
    FC_LOG(2, "[face] eyeY=%d (topInset=%d)\n", kEyeY + topInset_, topInset_);
  }

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
  const int16_t drawY = static_cast<int16_t>(kEyeY + offsetY);
  const int16_t drawX = offsetX_;
  /* 擦掉上一帧眼睛墨迹的残余。
   * 眼睛贴图是 80x80，而墨迹只有 60x60 —— 每边只余 10px，而视线缓动单帧就能挪
   * 10px 左右（东张西望时最明显），于是旧位置的边缘会剩一条细弧推上屏幕。
   * 这里在真的挪动过的时候把上一帧的墨迹范围擦成底色（静止时零成本）。
   * 眼睛带里没有别的静态内容（布局核对过），唯一会重叠的是右下角那支笔，
   * 而笔是在这一步之后才画的。 */
  if (eyeDrawn_ && (drawX != eyeDrawX_ || drawY != eyeDrawY_)) {
    constexpr int16_t inkR = kEyeSize / 2;
    constexpr int16_t pad = 2;
    g.fillRect(kLeftEyeX + eyeDrawX_ - inkR - pad, eyeDrawY_ - inkR - pad,
               static_cast<int16_t>(kRightEyeX - kLeftEyeX + inkR * 2 + pad * 2),
               static_cast<int16_t>(inkR * 2 + pad * 2), kBackdrop);
  }
  eyeDrawn_ = true;
  eyeDrawX_ = drawX;
  eyeDrawY_ = drawY;   // 增量推送按"实际画到哪了"算带
  drawEye(g, kLeftEyeX + drawX, drawY, kEyeSize, left, spec_.rotation, false);
  drawEye(g, kRightEyeX + drawX, drawY, kEyeSize, right, spec_.rotation, true);
}

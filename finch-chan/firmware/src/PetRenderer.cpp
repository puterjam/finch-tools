#include "PetRenderer.h"

#include "Log.h"
#include "pen_frames.h"

namespace {
/** UTF-8 单字长度，用于按字符折行（中文一个字 3 字节）。 */
size_t utf8GlyphLength(uint8_t lead) {
  if (lead < 0x80) return 1;
  if ((lead >> 5) == 0x6) return 2;
  if ((lead >> 4) == 0xE) return 3;
  return 4;
}

constexpr uint16_t kBubbleFill = 0x2945;
/** 表情的名字：日志里用可读名称比数字好用。 */
const char* faceName(FaceExpression expression) {
  static const char* names[] = {"neutral", "thinking", "focused", "happy", "loving", "delighted",
                                "asking", "reluctant", "listening", "sad", "sleeping", "alarmed"};
  const uint8_t index = static_cast<uint8_t>(expression);
  return index < sizeof(names) / sizeof(names[0]) ? names[index] : "?";
}

/**
 * 带淡入淡出的正弦提示音，替代 `Speaker.tone()`。
 * tone() 的波形是头尾突变的，播放时会听到“啪”的爆音；
 * 自己生成一段两端带包络的正弦就没有这个问题。
 */
void playEnvelopedTone(float frequency, uint32_t durationMs) {
  constexpr uint32_t kRate = 16000;
  constexpr size_t kCapacity = kRate / 10;   // 每块最多 100ms
  // playRaw 播放期间会引用这块内存，所以用两块轮流，避免互相踩。
  static int8_t buffers[2][kCapacity];
  static uint8_t cursor = 0;
  size_t count = static_cast<size_t>(kRate) * durationMs / 1000;
  if (count > kCapacity) count = kCapacity;
  int8_t* buffer = buffers[cursor];
  cursor = static_cast<uint8_t>((cursor + 1) % 2);
  const size_t fadeIn = kRate * 10 / 1000;    // 10ms 淡入
  const size_t fadeOut = kRate * 30 / 1000;   // 30ms 淡出
  for (size_t index = 0; index < count; ++index) {
    float envelope = 1.0f;
    if (index < fadeIn) envelope = static_cast<float>(index) / static_cast<float>(fadeIn);
    if (count > fadeOut && index + fadeOut > count) {
      const float tail = static_cast<float>(count - index) / static_cast<float>(fadeOut);
      if (tail < envelope) envelope = tail;
    }
    const float phase = 2.0f * PI * static_cast<float>(frequency) * static_cast<float>(index) / kRate;
    buffer[index] = static_cast<int8_t>(sinf(phase) * envelope * 105.0f);
  }
  M5.Speaker.playRaw(buffer, count, kRate, false, 1, -1, true);
}

constexpr uint16_t kBubbleEdge = 0x5AEB;
// RGB565 下的按钮配色：蓝色分量稍高就会偏粉/偏青，所以只给主色、不给多余蓝。
// 允许 #4CD964 → R5=9,G6=54,B5=12；拒绍 #E5484D → R5=28,G6=18,B5=9。
constexpr uint16_t kOptionNeutral = 0x31A6;  // 其它选项（去回复 / 在 Finch 处理）
constexpr uint16_t kOptionAllow = 0x4ECC;    // 允许：绿色
constexpr uint16_t kOptionDeny = 0xE249;     // 拒绍：红色
constexpr uint16_t kOptionDanger = 0xB143;   // 不可逆的“允许”：更深的红，故意更重
constexpr uint16_t kOptionEdge = 0x6B4D;
/* 右上角状态条：`♪ 🌕` —— 电量用 QuinqueFive 的月相字形表示，一个字符搞定，
 * 不显示数字；音符只在音乐模式开着时出现，放在左边。
 * 字形取自 muspi 的状态字体 assets/fonts/QuinqueFive.ttf，用它的**原生 5px** 点阵
 * （muspi 自己的状态栏就是这个字号），离线导出后内嵌，和表情一样不需要运行时字体文件。
 * 数据行优先、每行 1 字节、MSB 在左，只占高位 kBadgeGlyph 位。
 * 四档的填充量单调递减：实心 → 细缝 → 宽缝 → 空心。 */
constexpr int16_t kBadgeGlyph = 5;           // 字形边长（原生 5px）
constexpr int16_t kBadgeGap = 3;             // 音符与月相之间（1 = 字体自带步进，3 = 略松）
constexpr int16_t kBadgeMarginRight = 10;
constexpr int16_t kBadgeTopY = 8;
constexpr uint8_t kBadgeRows = 5;
constexpr uint8_t kBadgeStride = 1;
constexpr uint16_t kBadgeGreenColor = 0x4EF0;   // 和频谱条同一个薄荷绿：电量充足
constexpr uint16_t kBadgeWarnColor = 0xFFE0;    // 黄：该留意了（蓝分量为 0，不偏色）
constexpr uint16_t kBadgeLowColor = 0xE249;     // 红：快没电了
constexpr uint32_t kBatteryPollMs = 10000;    // 电量轮询间隔（I2C，别每帧读）
/* 电量分档：
 *   <=20%     空心 + 红
 *   20~100%   三段平均分配：21~46 宽缝、47~73 细缝、74~100 实心
 * 判定写成 (level - 20) * 3 与 80 / 160 比较：等价于把 80 个点三等分（每段 26.67），
 * 既不用浮点，也不会在边界上差一。 */
constexpr int32_t kBadgeRedPercent = 20;
/* 气泡顶边：状态栏占 y 8~12，所以气泡从 13 起，两者不会叠在一起。 */
constexpr int16_t kBubbleTopY = kBadgeTopY + kBadgeRows + 1;

/** U+266A ♪ */
const uint8_t kMusicNote[kBadgeRows] = {0x30, 0x28, 0x20, 0xE0, 0xE0};
/** 电量 74~100%：U+1F311（实心）。 */
const uint8_t kMoonSolid[kBadgeRows] = {0x70, 0xF8, 0xF8, 0xF8, 0x70};
/** 47~73%：U+1F313（细缝）。 */
const uint8_t kMoonSlit[kBadgeRows] = {0x70, 0xE8, 0xE8, 0xE8, 0x70};
/** 21~46%：U+1F314（宽缝）。 */
const uint8_t kMoonSlot[kBadgeRows] = {0x70, 0xC8, 0xC8, 0xC8, 0x70};
/** <=20%：U+1F315（空心，配合红色）。 */
const uint8_t kMoonRing[kBadgeRows] = {0x70, 0x88, 0x88, 0x88, 0x70};

/** 把一个点阵贴到画布上：行优先、每行 stride 字节、MSB 在左。 */
void blitMask(LovyanGFX& g, int16_t x, int16_t y, const uint8_t* rows, int16_t width, int16_t height,
              uint8_t stride, uint16_t color) {
  for (int16_t row = 0; row < height; ++row) {
    const uint8_t* line = rows + row * stride;
    for (int16_t col = 0; col < width; ++col) {
      if (line[col >> 3] & (1 << (7 - (col & 7)))) g.drawPixel(x + col, y + row, color);
    }
  }
}

/** 状态栏的点阵字形（尺寸见 kBadgeGlyph / kBadgeRows）。 */
void blitGlyph(LovyanGFX& g, int16_t x, int16_t y, const uint8_t* rows, uint16_t color) {
  blitMask(g, x, y, rows, kBadgeGlyph, kBadgeRows, kBadgeStride, color);
}

/**
 * 每像素 `bits` 位的点阵（0 = 透明，其余按比例映射到 16 档灰）。
 * 笔的帧用它来抗锯齿：斜边靠中间灰过渡，不然就是硬邦邦的台阶。
 * 只在 bits ∈ {1,2,4,8}（能整除一个字节）时使用。
 * 帧的档数变了（改生成器的 BITS）这里不用动：查表固定 16 档，按比例取。
 */
void blitMaskN(LovyanGFX& g, int16_t x, int16_t y, const uint8_t* rows, int16_t width, int16_t height,
               uint8_t stride, uint8_t bits, const uint16_t* grayLut) {
  const uint8_t per_byte = static_cast<uint8_t>(8 / bits);
  const uint8_t maxLevel = static_cast<uint8_t>((1 << bits) - 1);
  for (int16_t row = 0; row < height; ++row) {
    const uint8_t* line = rows + row * stride;
    for (int16_t col = 0; col < width; ++col) {
      const uint8_t shift = static_cast<uint8_t>((per_byte - 1 - (col % per_byte)) * bits);
      const uint8_t level = static_cast<uint8_t>((line[col / per_byte] >> shift) & maxLevel);
      if (level) g.drawPixel(x + col, y + row, grayLut[level * 15 / maxLevel]);
    }
  }
}
// 卡片出现动画：眼睛向上让位，按钮从屏幕下方滑入。
constexpr uint32_t kPromptAnimMs = 280;
constexpr int16_t kPromptEyeLift = 26;
/* 只有气泡、没有卡片抬升时（thinking / working）额外下压的量：
 * 这两个状态气泡与眼睛之间本来就有 55px 空隙，基线抬高后再跟着上移会显得表情浮在半空。
 * 卡片滑入时按 lift 线性收到 0，所以入场动画不会中途跳一下。 */
constexpr int16_t kBubbleOnlyDrop = 10;
/* 「动笔」：thinking/working 状态右下角那支笔（帧见 pen_frames.h）。
 * 笔尖固定在这个屏幕坐标上，笔身绕它来回摆——所以调位置是调笔尖，不是调整帧。
 * 只有 working 会摆；thinking 停在正中那帧（初始位置）。
 * 摆幅用 kPenSwingFrames 缩放：拿中心附近几帧来用，9 = 满摆（预渲染的 ±6°）、
 * 3 ≈ ±1.4°、1 = 完全不动。 */
constexpr int16_t kPenTipScreenX = 253;
constexpr int16_t kPenTipScreenY = 187;
constexpr uint8_t kPenSwingFrames = 9;
constexpr uint32_t kPenSwingPeriodMs = 1400;   // 摆动一次（一个来回）的时间
constexpr uint8_t kPenSwingsPerRound = 3;      // 一轮摆几下
constexpr uint32_t kPenRestMs = 3000;          // 一轮摆完停多久再继续
/** 16 档灰查找表（RGB565，0 不用）：帧的位数变化时按比例映射到这里，改 BITS 不用动固件。 */
constexpr uint16_t kPenGrayLut[16] = {
    0x0000, 0x1082, 0x2104, 0x3186, 0x4228, 0x52AA, 0x632C, 0x73AE,
    0x8C51, 0x9CD3, 0xAD55, 0xBDD7, 0xCE79, 0xDEFB, 0xEF7D, 0xFFFF,
};
constexpr int16_t kPromptButtonSlide = 56;
/** 音频动效占用底部一行，高度与单按钮行一致（muspi spectrum 的条形区）。 */
constexpr int16_t kAudioRowMargin = 10;
constexpr int16_t kAudioRowHeight = 48;

/** 按宽度把文本折成最多 maxLines 行；折不下时最后一行加省略号。 */
uint8_t wrapLines(LovyanGFX& g, const String& text, int16_t maxWidth, String* lines, uint8_t maxLines) {
  uint8_t count = 0;
  String current;
  size_t position = 0;
  while (position < text.length() && count < maxLines) {
    const size_t glyphLength = utf8GlyphLength(static_cast<uint8_t>(text[position]));
    const String glyph = text.substring(position, position + glyphLength);
    const String candidate = current + glyph;
    if (current.length() && g.textWidth(candidate) > maxWidth) {
      lines[count++] = current;
      current = glyph;
    } else {
      current = candidate;
    }
    position += glyphLength;
  }
  if (count < maxLines && current.length()) lines[count++] = current;
  if (position < text.length() && count == maxLines) lines[maxLines - 1] += "…";
  return count;
}
}  // namespace

void PetRenderer::begin() {
  // PSRAM 离屏画布：每帧只推一次，避免整屏擦写造成的闪烁。
  canvas_.setColorDepth(16);
  canvas_.setPsram(true);
  canvasReady_ = canvas_.createSprite(M5.Display.width(), M5.Display.height());
  if (!canvasReady_) canvas_.setPsram(false);
  face_.begin();
  leds_.begin();
  motion_.begin();
  audio_.begin();   // 麦克风默认不开，等 PWR 键切到收听模式再开
  // 显式设一次亮度并记住：getBrightness() 的初始值可能是 0，用它当恢复值会导致“唤不醒”。
  brightness_ = FINCHCHAN_BRIGHTNESS;
  M5.Display.setBrightness(brightness_);
  lastActivityAt_ = millis();
#if !FINCHCHAN_MOTION_EFFECTS
  motion_.setEnabled(false);
#endif
  applyExpression(faceFor(state_));
}

void PetRenderer::applyExpression(FaceExpression expression) {
  expression_ = expression;
  face_.setExpression(expression);
  // 诊断用：表情切换日志（可读名称，见 faceName）。
  FC_LOG(2, "face=%s\n", faceName(expression));
}

void PetRenderer::noteTouch() {
  noteActivity(millis(), false);
}

/**
 * 律动模式（麦克风音频动效）开关。
 * PWR 短按和小程序设置菜单走的是同一条路径，所以两边的状态永远一致；
 * 由调用方负责把新状态回报给桥接（见 main.cpp）。
 */
void PetRenderer::setMusicMode(bool on) {
  if (audio_.visible() == on) return;
  audio_.setVisible(on);
  if (on) {
    noteTouch();   // 睡着时先友好叫醒，并重置空闲计时
    applyExpression(FaceExpression::Happy);
  } else {
    applyExpression(faceFor(state_));
  }
}

/** PWR 短按：切换律动模式。 */
void PetRenderer::toggleAudioVisualizer() {
  setMusicMode(!audio_.visible());
}

/**
 * 配网 / 连接中的提示屏。
 * 内容不变就不重绘（调用方可以每帧调），并且会先把屏幕亮度拉回来，
 * 免得在关屏状态下配网时什么也看不见。
 */
void PetRenderer::showNotice(const char* title, const char* line1, const char* line2) {
  const String nextTitle = title ? title : "";
  const String nextLine1 = line1 ? line1 : "";
  const String nextLine2 = line2 ? line2 : "";
  if (noticeActive_ && nextTitle == noticeTitle_ && nextLine1 == noticeLine1_ && nextLine2 == noticeLine2_) return;
  noticeActive_ = true;
  noticeTitle_ = nextTitle;
  noticeLine1_ = nextLine1;
  noticeLine2_ = nextLine2;

  auto& g = M5.Display;   // 注意不能用 LovyanGFX&：setBrightness 在 M5GFX 上
  g.setBrightness(brightness_);
  g.fillScreen(TFT_BLACK);
  g.setTextDatum(middle_center);
  const int16_t centerX = g.width() / 2;
  g.setFont(&fonts::efontCN_16_b);
  g.setTextColor(TFT_WHITE, TFT_BLACK);
  g.drawString(noticeTitle_, centerX, 72);
  g.setFont(&fonts::efontCN_16);
  g.setTextColor(0xC618, TFT_BLACK);
  g.drawString(noticeLine1_, centerX, 118);
  g.drawString(noticeLine2_, centerX, 150);
  g.setTextDatum(top_left);
  g.setFont(&fonts::Font0);
}

void PetRenderer::clearNotice() {
  if (!noticeActive_) return;
  noticeActive_ = false;
  noticeTitle_ = "";
  noticeLine1_ = "";
  noticeLine2_ = "";
  // 回到正常渲染：重置空闲计时，免得刚配完网就立刻打瞌睡。
  lastActivityAt_ = millis();
  M5.Display.setBrightness(brightness_);
  applyExpression(faceFor(state_));
  leds_.setState(state_);
}

/**
 * 记录一次“有事发生”。
 * startled=true：被任务/连接叫醒 → 演“惊醒”（睁大眼 + 轻晃）。
 * startled=false：被摸/被拍叫醒 → 直接给亲密反应，不演惊讶脸。
 */
void PetRenderer::noteActivity(uint32_t now, bool startled) {
  lastActivityAt_ = now;
  // 睡着才需要“醒过来”；醒着只是重置空闲计时（所以 running 期间不会反复演惊醒）。
  wakeUp(now, startled);
}

void PetRenderer::enterDozing(uint32_t now) {
  if (sleepLevel_ == SleepLevel::Dozing) return;
  sleepLevel_ = SleepLevel::Dozing;
  FC_LOGLN(1, "sleep=dozing");
  reacting_ = false;
  applyExpression(FaceExpression::Sleeping);
  leds_.setState(PetState::Sleeping);
  motion_.setDozing(true);   // 舵机沉到 0 度附近，只在 0~1° 之间微微起伏
  (void)now;
}

void PetRenderer::enterDeepSleep(uint32_t now, int32_t idleMs) {
  if (sleepLevel_ == SleepLevel::DeepSleep) return;
  sleepLevel_ = SleepLevel::DeepSleep;
  FC_LOG(1, "sleep=deep (screen off, idle %ldms)\n", static_cast<long>(idleMs));
  applyExpression(FaceExpression::Sleeping);
  leds_.setState(PetState::Sleeping);
  motion_.setDozing(true);
  M5.Display.setBrightness(0);   // 关屏：直到有人碰屏幕或有任务过来
  (void)now;
}

/**
 * 从睡着的状态醒过来。
 * 已经醒着时是空操作——这点很关键：running 期间 state 会反复变化，
 * 不能每次都演一遍惊醒。
 * startled=true：被任务/连接叫醒 → 睁大眼 + 左右轻晃。
 * startled=false：被摸/被拍醒 → 直接给亲密反应。
 */
void PetRenderer::wakeUp(uint32_t now, bool startled) {
  if (sleepLevel_ == SleepLevel::Awake) return;
  sleepLevel_ = SleepLevel::Awake;
  lastActivityAt_ = now;
  M5.Display.setBrightness(brightness_);
  motion_.setDozing(false);
  if (startled) {
    FC_LOGLN(1, "wake=startled (task/connection)");
    waking_ = true;
    wakeUntil_ = now + 900;
    // 惊醒：先睁大眼、左右轻晃一下，演完再进入真正的状态表情。
    applyExpression(FaceExpression::Alarmed);
    motion_.play(MotionDirector::Action::WakeShake);
    leds_.setState(state_);
    return;
  }
  FC_LOGLN(1, "wake=friendly (touch/pat)");
  reactToPat();
}

void PetRenderer::notePat() {
  // 拍头与被摸走同一条友好路径（reactToPat 自带防抖，同一拍不会重复触发）。
  noteActivity(millis(), false);
  reactToPat();
}

void PetRenderer::reactToPat() {
  const uint32_t now = millis();
  // 防抖：一次拍头会同时碰到电容区，两者只应该产生一次反应。
  if (reacting_ && now < reactionUntil_) return;
  // 笑脸或爱心（随机）+ 慢慢地左右摇两下（约 2 秒），绿光亮 3 秒。
  applyExpression(random(0, 2) == 0 ? FaceExpression::Happy : FaceExpression::Loving);
  motion_.play(MotionDirector::Action::PatShake);
  reacting_ = true;
  reactionUntil_ = now + 3000;
  leds_.setState(PetState::Success);
  cue(PetState::Success);
}

void PetRenderer::reactToAnswer(const char* optionId) {
  if (!optionId) return;
  const uint32_t now = millis();
  noteActivity(now, false);
  if (!strcmp(optionId, "allow")) {
    // 点了允许：笑一下，头部会跟着连点两下（MotionDirector 在表情切换时自行触发）。
    applyExpression(FaceExpression::Delighted);
    reacting_ = true; reactionUntil_ = now + 1500;
    leds_.setState(PetState::Success);
    cue(PetState::Success);
  } else if (!strcmp(optionId, "deny")) {
    // 点了拒绝：无奈表情 + 摇头后低头。
    applyExpression(FaceExpression::Reluctant);
    reacting_ = true; reactionUntil_ = now + 1800;
    leds_.setState(PetState::Waiting);
    cue(PetState::Error);
  }
}

FaceExpression PetRenderer::faceFor(PetState state) {
  switch (state) {
    case PetState::Thinking: return FaceExpression::Thinking;
    case PetState::Working: return FaceExpression::Focused;
    case PetState::Waiting: return FaceExpression::Asking;
    case PetState::Success: return FaceExpression::Happy;
    case PetState::Error: return FaceExpression::Sad;
    case PetState::Sleeping: return FaceExpression::Sleeping;
    case PetState::Speaking: return FaceExpression::Listening;
    default: return FaceExpression::Neutral;
  }
}

bool PetRenderer::wantsBubble(PetState state) {
  return state == PetState::Thinking || state == PetState::Working ||
         state == PetState::Waiting || state == PetState::Success;
}

void PetRenderer::setState(PetState state, const char* speech, const char* bubble) {
  const uint32_t now = millis();
  const bool changed = state != state_;
  if (changed) FC_LOG(1, "state=%s\n", petStateName(state));   // 只在真的变了才打
  state_ = state;
  stateChangedAt_ = now;
  noteActivity(now, true);   // 有任务/状态过来 = 被叫起来干活
  if (speech && *speech) speech_ = String(speech).substring(0, FINCHCHAN_SAY_MAX_CHARS);
  if (state != PetState::Speaking) speech_ = "";
  bubble_ = (bubble && *bubble && wantsBubble(state)) ? String(bubble).substring(0, 64) : "";
  // 有等待卡片、反馈动画或惊醒动画时不抢表情。
  if (!promptActive_ && !reacting_ && !waking_) applyExpression(faceFor(state_));
  leds_.setState(state);
  // 只有状态真的变了才响：桥接为了对账会强制重发同一状态，
  // 不过滤就会出现“点一下又响一次”。
  if (changed) cue(state);
}

void PetRenderer::setPrompt(const char* requestId, const char* kind, const char* title,
                           const PromptOption* options, uint8_t optionCount) {
  strlcpy(promptId_, requestId ? requestId : "", sizeof(promptId_));
  strlcpy(promptKind_, kind ? kind : "", sizeof(promptKind_));
  promptTitle_ = String(title ? title : "").substring(0, 160);
  promptOptionCount_ = optionCount > kMaxPromptOptions ? kMaxPromptOptions : optionCount;
  for (uint8_t index = 0; index < promptOptionCount_; ++index) promptOptions_[index] = options[index];
  promptActive_ = promptOptionCount_ > 0;
  promptAnswerable_ = promptActive_ && !strcmp(promptKind_, "permission");
  noteActivity(millis(), true);   // 弹出卡片 = 被叫起来干活
  if (promptActive_) {
    // 每张新卡片都从头播一次入场动画。
    promptShownAt_ = millis();
    promptProgress_ = 0.0f;
    applyExpression(FaceExpression::Asking);
    leds_.setState(PetState::Waiting);
  }
}

void PetRenderer::clearPrompt() {
  promptActive_ = false;
  promptOptionCount_ = 0;
  applyExpression(faceFor(state_));
  leds_.setState(state_);
  noteActivity(millis(), false);
}

bool PetRenderer::hitTestPrompt(int16_t x, int16_t y, char* optionId, size_t optionIdSize) const {
  if (!promptActive_) return false;
  for (uint8_t index = 0; index < promptOptionCount_; ++index) {
    const int16_t* rect = optionRect_[index];
    if (x >= rect[0] && x <= rect[0] + rect[2] && y >= rect[1] && y <= rect[1] + rect[3]) {
      strlcpy(optionId, promptOptions_[index].id, optionIdSize);
      return true;
    }
  }
  return false;
}

void PetRenderer::cue(PetState state) {
  if (!M5.Speaker.isEnabled()) return;
  // 小程序推过来的音优先（不用内置素材）；没推过就退回下面的内置合成音。
  // slot：0=未读/完成、1=需要你处理、2=出错。
  const int8_t slot = state == PetState::Success ? 0 : (state == PetState::Waiting ? 1 : (state == PetState::Error ? 2 : -1));
  if (slot >= 0 && audio_.playSound(static_cast<uint8_t>(slot))) return;

  float frequency = 0.0f;
  uint32_t duration = 0;
  switch (state) {
    case PetState::Success: frequency = 1047.0f; duration = 90; break;
    case PetState::Waiting: frequency = 880.0f; duration = 130; break;
    case PetState::Error: frequency = 220.0f; duration = 140; break;
    case PetState::Speaking: frequency = 660.0f; duration = 60; break;
    default: return;
  }
  // 提示音期间不看麦克风：否则会把自己的声音当成输入，频谱瞬间拉满。
  // 先做端口交接（音乐模式下麦克风正占着共用的 I2S，直接播就是爆音）。
  if (!audio_.beginPlayback()) return;
  audio_.muteFor(duration + 350);
  playEnvelopedTone(frequency, duration);
}

void PetRenderer::update(uint32_t now) {
  if (noticeActive_) return;   // 配网提示屏优先：不画表情，也不计时睡眠
  if (now - lastFrameAt_ < 40) return;
  lastFrameAt_ = now;
  audio_.update(now);   // 采样 + 条形/音符推进（关掉时只把动画收尾）
  pollBattery(now);     // 10 秒一次，缓存给右上角状态条用

  // ── 睡眠只在真正的空闲里计时：idle 且无卡片。running / waiting 等状态不睡 ──
  // 注意：handleTouch() 用的是更新的 millis()，可能比本轮的 now 还新几毫秒；
  // 直接做无符号相会下溢成极大值，表现为“刚拍一下就立刻睡过去”。这里用有符号差值。
  const bool idling = state_ == PetState::Idle && !promptActive_;
  int32_t idleMs = static_cast<int32_t>(now - lastActivityAt_);
  if (idleMs < 0) idleMs = 0;   // 活动比本轮 now 更新 = 刚刚发生
  if (!idling) {
    lastActivityAt_ = now;   // 非空闲状态把计时器一直归零
  } else if (audio_.visible() && audio_.isLoud()) {
    // 音乐模式：有声音就一直重置计时（不会睡），只有特别安静才按普通计时睡。
    // 睡着时听到声音也直接友好叫醒，不再演“惊醒”。
    if (sleepLevel_ != SleepLevel::Awake) {
      noteTouch();
    } else {
      lastActivityAt_ = now;
    }
  } else if (idleMs >= static_cast<int32_t>(FINCHCHAN_DEEP_SLEEP_AFTER_MS)) {
    enterDeepSleep(now, idleMs);
  } else if (sleepLevel_ == SleepLevel::Awake && idleMs >= static_cast<int32_t>(FINCHCHAN_NAP_AFTER_MS)) {
    enterDozing(now);
  }
  // 屏幕已关：什么都不画，等 noteActivity() 把它叫醒。
  if (sleepLevel_ == SleepLevel::DeepSleep) return;

  // 兜底：醒着的状态下屏幕不该是黑的。若被外部因素（PMIC / IO 扩展器抖动）关掉，
  // 这里自己亮回来——否则用户会看到“点一下屏幕反而息屏”。
  // 限频：wakeup() 会重发 SLPOUT/DISPON，短时间内反复触发本身就会闪黑一帧。
  if (M5.Display.getBrightness() == 0 && now - lastRelightAt_ > 1000) {
    lastRelightAt_ = now;
    FC_LOGLN(1, "[power] panel relight (brightness was 0)");
    M5.Display.wakeup();
    M5.Display.setBrightness(brightness_);
  }

  // 惊醒动画演完，才进入真正的状态表情（有卡片时卡片优先）。
  if (waking_ && now >= wakeUntil_) {
    waking_ = false;
    if (!promptActive_) applyExpression(faceFor(state_));
  }

  leds_.update(now);
  if (promptActive_) {
    const uint32_t elapsed = now - promptShownAt_;
    promptProgress_ = elapsed >= kPromptAnimMs ? 1.0f : static_cast<float>(elapsed) / kPromptAnimMs;
  }
  // 反馈动画到期后回到当前状态对应的表情与灯光。
  if (reacting_ && now >= reactionUntil_) {
    reacting_ = false;
    applyExpression(faceFor(state_));
    // 拍头/作答的绿光（或红光）只该亮一小会儿：恢复成当前状态的灯效，
    // idle 下就是熄灭。
    leds_.setState(state_);
  }
  // 音乐模式下 idle 的表情：
  //   安静 → 退回 idle 的普通表情（模式不变，频谱照旧在下面跟）
  //   连续收音够久（默认 5 秒）→ 笑脸
  // running / waiting 等状态不受影响，保持它们自己的表情。
  if (audio_.visible() && state_ == PetState::Idle && !promptActive_ && !waking_ && !reacting_ &&
      sleepLevel_ == SleepLevel::Awake) {
    const FaceExpression wanted = audio_.isMusicSmiling(now) ? FaceExpression::Happy : faceFor(state_);
    if (expression_ != wanted) applyExpression(wanted);
  }

  // 头部动作：空闲跟视线、working 偶尔点头、表情切换时的肢体反应。
  motion_.update(now, expression_, face_.gazeOffsetX(), face_.gazeOffsetY());

  // 惊醒中 / 打瞌睡时都不叠气泡与卡片，只演表情。
  const bool overlays = !waking_ && sleepLevel_ == SleepLevel::Awake;
  // 只有卡片会把表情顶上去；音乐模式不上移（频谱在底部，不挡脸）。
  const bool cardShowing = promptActive_ && overlays;
  const bool unreadShowing = overlays && !cardShowing && isUnread();
  const bool audioShowing = !cardShowing && audio_.visible() && overlays;
  // 只有 working 画那支动笔（thinking 不画，看起来怪）；有卡片时让位给卡片
  const bool penShowing = overlays && !cardShowing &&
                           state_ == PetState::Working;
  // 未读「查看」按钮的入场进度（只有按钮自己滑入，表情不跟着抬）。
  unreadProgress_ = unreadShowing ? fminf(1.0f, static_cast<float>(now - stateChangedAt_) / kPromptAnimMs) : 0.0f;
  /* 只有**等待卡片**会把表情抬起来让位；未读那个「查看」按钮不抬——
   * 笑脸保持原位（气泡推下来的位置），按钮自己从下面滑进来。 */
  const float lift = cardShowing ? kPromptEyeLift * promptProgress_ : 0.0f;
  /* 只有气泡、没有卡片/未读抬升时（thinking / working）再多压 kBubbleOnlyDrop 下来。
   * 那两个状态下气泡和眼睛之间本来就有 55px 空隙，基线抬高后再跟着上移会显得表情浮在半空。
   * 补偿跟着 lift 线性淡出：卡片滑入时 lift 从 0 涨到 26，补偿同步从 10 收到 0，
   * 所以入场动画中途不会跳一下。 */
  const int16_t bubbleDrop = static_cast<int16_t>(lift >= kPromptEyeLift ? 0.0f
                                                                        : (1.0f - lift / kPromptEyeLift) * kBubbleOnlyDrop);
  // 音乐模式下 idle 的笑脸会跟随音乐轻微浮动（2~5px，声音越大浮动越明显）。
  int16_t audioBob = 0;
  if (audioShowing && state_ == PetState::Idle) {
    if (audio_.isMusicSmiling(now)) {
      const float amplitude = 2.0f + 3.0f * audio_.level();
      audioBob = static_cast<int16_t>(sinf(static_cast<float>(now) / 320.0f) * amplitude);
    }
    // 拍点上的小顿落：让节奏在表情上也看得出来（150ms 内衰减）。
    if (beatPulseAt_ != 0 && now - beatPulseAt_ < 150) {
      audioBob += static_cast<int16_t>(3.5f * (1.0f - static_cast<float>(now - beatPulseAt_) / 150.0f));
    }
  }
  // 音乐模式 + idle：跟着鼓点点头（模拟人听歌不自觉跟着节奏点头）。
  // 一次触发只播一个完整点头；动作没播完（含伺服回稳）之前，后面的鼓点排队跳过，
  // 这样每个点头都是干净的“下去→回中”，而不是被打断得碎碎地抽。
  // 「随节奏舞动」可以关掉：频谱照旧，只是不再点头。
  const bool beatMode = audioShowing && state_ == PetState::Idle && beatDance_;
  motion_.setBeatMode(beatMode);   // 跟拍期间不跟视线、不播随机小动作，头部保持稳
  if (beatMode && audio_.isLoud() && audio_.consumeBeat()) {
    if (!motion_.busy() && now >= beatNodUntil_) {
      const float strength = audio_.lastBeatStrength();
      const uint32_t period = audio_.beatPeriodMs();   // 0 = 周期还没估出来
      const bool strong = strength >= 1.8f;
      // 按估计的节拍周期挑点头时长：点头必须在下一拍之前做完，
      // 这样每个拍子都能点满一次（以前隔一个点一次，节奏感只有一半）。
      MotionDirector::Action action;
      uint32_t duration;
      if (period != 0 && period <= 400) {          // 快歌（≥150BPM）：短促点头
        action = strong ? MotionDirector::Action::BeatNod : MotionDirector::Action::BeatNodFast;
        duration = strong ? 340 : 250;
      } else if (period >= 620) {                   // 慢歌（≤100BPM）：可以点得深一点
        action = MotionDirector::Action::BeatNodStrong;
        duration = 360;
      } else {                                      // 中速
        action = strong ? MotionDirector::Action::BeatNodStrong : MotionDirector::Action::BeatNod;
        duration = 350;
      }
      motion_.play(action);
      beatNodUntil_ = now + duration + 50;   // 帧表 + 伺服回稳余量
      beatPulseAt_ = now;
      const char* name = action == MotionDirector::Action::BeatNodFast
                             ? "nodFast"
                             : (action == MotionDirector::Action::BeatNodStrong ? "nodStrong" : "nod");
      FC_LOG(2, "[beat] #%u x%.1f bpm=%u -> %s\n", audio_.beatCount(), strength,
                    period ? 60000UL / period : 0, name);
    }
  }

  if (!canvasReady_) {
    // 无画布时退化为直接绘制（首帧或 PSRAM 不足时的兜底路径）。
    M5.Display.fillScreen(TFT_BLACK);
    if (cardShowing) {
      const int16_t inset = drawBubble(M5.Display, promptTitle_);
      face_.update(M5.Display, now, inset / 2 - static_cast<int16_t>(lift) + (inset ? bubbleDrop : 0));
      drawPromptButtons(M5.Display);
    } else if (overlays) {
      const int16_t inset = drawBubble(M5.Display, bubble_);
      face_.update(M5.Display, now, inset / 2 - static_cast<int16_t>(lift) + (inset ? bubbleDrop : 0) - audioBob);
      drawSpeech(M5.Display);
      if (audioShowing) audio_.draw(M5.Display, kAudioRowMargin, kAudioRowHeight);
    } else {
      // 惊醒中 / 打瞌睡：只演表情。
      face_.update(M5.Display, now, 0);
    }
  // 音符画在最上层，两侧摇着往上飘（关掉动效后让它们飘完）。
  // 卡片在的时候不画：卡片要能完全盖住音频动效。
  if (overlays && !cardShowing && audio_.notesAlive()) audio_.drawNotes(M5.Display);
  if (unreadShowing) drawUnreadButton(M5.Display);
  // 右上角状态条：电量常显，音乐模式时前面多一个 ♪。
  if (penShowing) drawPen(M5.Display, now);
  if (overlays) drawStatusBadge(M5.Display);
    return;
  }

  canvas_.fillScreen(TFT_BLACK);
  if (cardShowing) {
    // 等待卡片：气泡标题在上，眼睛向上让位，按钮从下方滑入停在表情下方。
    const int16_t inset = drawBubble(canvas_, promptTitle_);
    face_.update(canvas_, now, inset / 2 - static_cast<int16_t>(lift) + (inset ? bubbleDrop : 0));
    drawPromptButtons(canvas_);
  } else if (overlays) {
    const int16_t inset = drawBubble(canvas_, bubble_);
    face_.update(canvas_, now, inset / 2 - static_cast<int16_t>(lift) + (inset ? bubbleDrop : 0) - audioBob);
    drawSpeech(canvas_);
    // 音频动效：底部一行条形；卡片出现时上面那条分支已经把它盖掉了。
    if (audioShowing) audio_.draw(canvas_, kAudioRowMargin, kAudioRowHeight);
  } else {
    face_.update(canvas_, now, 0);
  }
  // 音符画在最上层，两侧摇着往上飘（关掉动效后让它们飘完）。
  // 卡片在的时候不画：卡片要能完全盖住音频动效。
  if (overlays && !cardShowing && audio_.notesAlive()) audio_.drawNotes(canvas_);
  // 有未读：底部给一个灰色「查看」按钮（和卡片一样盖在频谱上面）。
  if (unreadShowing) drawUnreadButton(canvas_);
  // 右上角状态条：电量常显，音乐模式时前面多一个 ♪。
  if (penShowing) drawPen(canvas_, now);
  if (overlays) drawStatusBadge(canvas_);
  canvas_.pushSprite(0, 0);
  // 等这一帧的 DMA 真正发完，再开始画下一帧：否则下一帧的 fillScreen 会追着
  // 还在读缓冲的 DMA 改内容，偶发一帧花屏/整帧黑（正是"眨眼时闪一下空帧"的样子）。
  M5.Display.waitDisplay();
  checkBlankFrame(now);
}

/**
 * 空帧自检：稀疏采样画布，若整帧全黑说明推了一帧"什么都没有"的画面
 * （正常帧至少有两颗白眼睛）。只在真的出现时打日志并限频，
 * 用来确认/排除渲染层的空帧问题，而不是靠肉眼猜。
 */
void PetRenderer::checkBlankFrame(uint32_t now) {
  frameCount_ += 1;
  if ((frameCount_ & 3) != 0) return;   // 每 4 帧抽一次，开销可忽略
  for (int16_t y = 6; y < 240; y += 12) {
    for (int16_t x = 6; x < 320; x += 24) {
      if (canvas_.readPixelValue(x, y) != 0) return;   // 有内容 = 正常
    }
  }
  if (now - blankLogAt_ < 3000) return;
  blankLogAt_ = now;
  FC_LOG(1, "[frame] blank! #%lu state=%s face=%s sleep=%d prompt=%d\n",
                static_cast<unsigned long>(frameCount_), petStateName(state_), faceName(expression_),
                static_cast<int>(sleepLevel_), promptActive_ ? 1 : 0);
}

/**
 * working 右下角那支动笔（thinking 不画，看起来怪）。
 * 笔尖钉在 (kPenTipScreenX, kPenTipScreenY)，笔身绕它按正弦来回摆；
 * 帧是离线预渲染好的（帧内笔尖在 (kPenTipX, kPenTipY)），这里只做选帧 + blit。
 *
 * 节奏：摆 kPenSwingsPerRound 下（每下 kPenSwingPeriodMs），然后停 kPenRestMs 再继续；
 * 停顿期间停在正中那帧（= 初始位置）。
 */
void PetRenderer::drawPen(LovyanGFX& g, uint32_t now) {
  const int16_t center = (kPenFrameCount - 1) / 2;          // 正中那帧（0°）
  const int16_t half = (kPenSwingFrames - 1) / 2;           // 两侧各取几帧
  int16_t index = center;
  if (state_ == PetState::Working) {
    const uint32_t swingTotal = kPenSwingPeriodMs * kPenSwingsPerRound;
    const uint32_t phase = now % (swingTotal + kPenRestMs);
    if (phase < swingTotal) {
      const float t = static_cast<float>(phase % kPenSwingPeriodMs) / kPenSwingPeriodMs * 2.0f * PI;
      index = center + static_cast<int16_t>(lroundf(sinf(t) * half));
    }
  }
  if (index < 0) index = 0;
  if (index >= kPenFrameCount) index = kPenFrameCount - 1;
  blitMaskN(g, kPenTipScreenX - kPenTipX, kPenTipScreenY - kPenTipY, kPenFrames[index],
            kPenFrameSize, kPenFrameSize, static_cast<uint8_t>(kPenFrameSize * kPenFrameBits / 8),
            kPenFrameBits, kPenGrayLut);
}

/**
 * 右上角状态条：`♪ 🌕`。
 * 电量用一个月相字形表示（不显示数字）：20~100% 三等分（74~100 实心、47~73 细缝、
 * 21~46 宽缝），≤20% 空心。颜色按红绿灯走：音符与实心/细缝是薄荷绿（`kBadgeGreenColor`）、
 * 宽缝转黄（`kBadgeWarnColor`）、空心转红（`kBadgeLowColor`）。
 * 音符只在音乐模式开着时出现，放在月相左边。
 */
void PetRenderer::drawStatusBadge(LovyanGFX& g) {
  const bool music = audio_.visible();
  const bool hasLevel = batteryLevel_ >= 0;
  if (!music && !hasLevel) return;   // 电量读不到、又不在音乐模式：整条不画

  const uint8_t* moon = kMoonRing;
  uint16_t moonColor = kBadgeLowColor;
  if (hasLevel) {
    const int32_t scaled = (batteryLevel_ - kBadgeRedPercent) * 3;   // 0 ~ 240
    if (scaled > 160) {
      moon = kMoonSolid;
      moonColor = kBadgeGreenColor;
    } else if (scaled > 80) {
      moon = kMoonSlit;
      moonColor = kBadgeGreenColor;
    } else if (scaled > 0) {
      moon = kMoonSlot;
      moonColor = kBadgeWarnColor;
    } else {
      moon = kMoonRing;
      moonColor = kBadgeLowColor;   // ≤20%
    }
  }

  const int16_t parts = (music ? 1 : 0) + (hasLevel ? 1 : 0);
  const int16_t width = parts * kBadgeGlyph + (parts - 1) * kBadgeGap;
  int16_t x = static_cast<int16_t>(g.width() - kBadgeMarginRight - width);
  // 固定在右上角：气泡出现也不跟着动（状态栏在最后绘制，盖在气泡上面）。
  const int16_t y = kBadgeTopY;
  if (music) {
    blitGlyph(g, x, y, kMusicNote, kBadgeGreenColor);
    x += kBadgeGlyph + kBadgeGap;
  }
  if (hasLevel) blitGlyph(g, x, y, moon, moonColor);
}

/**
 * 轮询电量。读的是 AXP2101（I2C），不要每帧读，所以缓存 + 10 秒一次；
 * 数值变化时才打日志，方便在串口里核对读数是否可信。
 */
void PetRenderer::pollBattery(uint32_t now) {
  if (batteryPolledAt_ && now - batteryPolledAt_ < kBatteryPollMs) return;
  batteryPolledAt_ = now;
  const int32_t level = M5.Power.getBatteryLevel();
  if (level == batteryLevel_) return;
  batteryLevel_ = level;
  FC_LOG(2, "[power] battery=%ld%%%s\n", static_cast<long>(level), M5.Power.isCharging() ? " (charging)" : "");
}

/**
 * 有未读时底部的灰色「查看」按钮。
 * 几何与单按钮行完全一致；点击行为跟“任意点击屏幕打开会话”一样，
 * 这里只是给个明确的入口提示。文字用粗体（与卡片按钮同一套样式）。
 */
void PetRenderer::drawUnreadButton(LovyanGFX& g) {
  constexpr int16_t margin = 10;
  constexpr int16_t height = 48;
  const int16_t width = g.width() - margin * 2;
  // 与卡片按钮同一套入场：从屏幕下方滑入。
  const int16_t slide = static_cast<int16_t>((1.0f - unreadProgress_) * kPromptButtonSlide);
  const int16_t y = g.height() - margin - height + slide;
  g.fillRoundRect(margin, y, width, height, 10, kOptionNeutral);
  g.drawRoundRect(margin, y, width, height, 10, kOptionEdge);
  const char* label = "查看";
  g.setFont(&fonts::efontCN_16_b);
  g.setTextSize(1);
  g.setTextDatum(top_left);
  g.setTextColor(TFT_WHITE, kOptionNeutral);
  g.drawString(label, margin + (width - g.textWidth(label)) / 2, y + (height - g.fontHeight()) / 2);
  g.setFont(&fonts::Font0);
}

void PetRenderer::drawPromptButtons(LovyanGFX& g) {
  if (!promptOptionCount_) return;
  g.setFont(&fonts::efontCN_16);
  g.setTextSize(1);
  g.setTextDatum(top_left);

  const int16_t margin = 10;
  const int16_t gap = 10;
  const int16_t width = g.width() - margin * 2;
  // 权限卡是两个按钮并排，答题卡/表单卡是一个整宽按钮。
  const uint8_t perRow = promptOptionCount_ >= 3 ? 2 : promptOptionCount_;
  const int16_t height = promptOptionCount_ >= 3 ? 30 : 48;
  const int16_t buttonWidth = perRow > 1 ? (width - gap) / 2 : width;
  const int16_t totalHeight = promptOptionCount_ >= 3 ? height * 2 + gap : height;
  // 入场动画：从屏幕下方滑入到最终位置。
  const int16_t slide = static_cast<int16_t>((1.0f - promptProgress_) * kPromptButtonSlide);
  int16_t y = g.height() - margin - totalHeight + slide;

  for (uint8_t index = 0; index < promptOptionCount_; ++index) {
    const uint8_t column = perRow > 1 ? index % perRow : 0;
    if (index && column == 0) y += height + gap;
    const int16_t x = margin + column * (buttonWidth + gap);
    optionRect_[index][0] = x;
    optionRect_[index][1] = y;
    optionRect_[index][2] = buttonWidth;
    optionRect_[index][3] = height;
    // 允许 = 绿，拒绍 = 红（都是饱和主色 + 白字）。
    const PromptOption& option = promptOptions_[index];
    uint16_t fill = kOptionNeutral;
    uint16_t labelColor = TFT_WHITE;
    if (option.destructive) {
      fill = kOptionDanger;
    } else if (!strcmp(option.id, "allow")) {
      fill = kOptionAllow;
    } else if (!strcmp(option.id, "deny")) {
      fill = kOptionDeny;
    }
    g.fillRoundRect(x, y, buttonWidth, height, 10, fill);
    g.drawRoundRect(x, y, buttonWidth, height, 10, kOptionEdge);
    const String label = String(option.label);
    // 按钮文字用粗体，小屏上更容易读。
    g.setFont(&fonts::efontCN_16_b);
    g.setTextColor(labelColor, fill);
    g.drawString(label, x + (buttonWidth - g.textWidth(label)) / 2, y + (height - g.fontHeight()) / 2);
    g.setFont(&fonts::efontCN_16);
  }
  g.setFont(&fonts::Font0);
  g.setTextDatum(middle_center);
}

int16_t PetRenderer::drawBubble(LovyanGFX& g, const String& text) {
  if (!text.length()) return 0;
  g.setFont(&fonts::efontCN_16);
  g.setTextSize(1);
  g.setTextDatum(top_left);

  String lines[2];
  const int16_t maxWidth = g.width() - 34;
  const uint8_t lineCount = wrapLines(g, text, maxWidth, lines, 2);
  if (!lineCount) { g.setFont(&fonts::Font0); g.setTextDatum(middle_center); return 0; }

  const int16_t lineHeight = g.fontHeight();
  int16_t widest = 0;
  for (uint8_t index = 0; index < lineCount; ++index) widest = max(widest, static_cast<int16_t>(g.textWidth(lines[index])));
  const int16_t padding = 7;
  const int16_t bubbleWidth = min(static_cast<int16_t>(g.width() - 16), static_cast<int16_t>(widest + padding * 2));
  const int16_t bubbleHeight = lineCount * lineHeight + padding * 2 - 2;
  const int16_t x = (g.width() - bubbleWidth) / 2;
  const int16_t y = kBubbleTopY;   // 让开右上角的状态栏（见 kBubbleTopY 注释）

  g.fillRoundRect(x, y, bubbleWidth, bubbleHeight, 10, kBubbleFill);
  g.drawRoundRect(x, y, bubbleWidth, bubbleHeight, 10, kBubbleEdge);
  g.fillTriangle(g.width() / 2 - 7, y + bubbleHeight - 2, g.width() / 2 + 7, y + bubbleHeight - 2,
                 g.width() / 2, y + bubbleHeight + 7);
  g.setTextColor(TFT_WHITE, kBubbleFill);
  for (uint8_t index = 0; index < lineCount; ++index) {
    g.drawString(lines[index], x + (bubbleWidth - g.textWidth(lines[index])) / 2,
                 y + padding - 1 + index * lineHeight);
  }
  g.setFont(&fonts::Font0);
  g.setTextDatum(middle_center);
  return y + bubbleHeight + 10;
}

void PetRenderer::drawSpeech(LovyanGFX& g) {
  if (!speech_.length()) return;
  g.setTextDatum(top_center);
  g.setTextSize(1);
  g.setTextColor(TFT_WHITE, TFT_BLACK);
  g.drawString(speech_, g.width() / 2, g.height() - 20);
}

#include "AudioVisualizer.h"

#include <M5Unified.h>
#include <esp_heap_caps.h>

#include "config.h"

namespace {

/** 配色（RGB565，蓝分量压低避免 16 位屏偏色）。 */
constexpr uint16_t kBarColor = 0x4EF0;    // 薄荷绿
constexpr uint16_t kPeakColor = 0xDFFB;   // 峰值线：接近白
constexpr uint16_t kNoteColor = 0xFE4F;   // 音符：暖琥珀

constexpr uint32_t kSampleIntervalMs = 40;   // 与渲染帧率一致
constexpr int16_t kSampleCount = kAudioFftSize;
/* 灵敏度（比较敏感时都往小里改）：
 *   kMicGain  : 进 FFT 前的线性增益，小 → 小声不显示
 *   kDbFloor  : 显示下限，抬高 → 安静内容扁下去
 *   kSignalThreshold : 峰值振幅低于它就当成静音，条直接归零
 */
constexpr float kMicGain = 2.2f;

/* ── 以下数值沿用 muspi spectrum 的默认配置（可按听感微调） ──────────── */
constexpr float kMinFrequency = 40.0f;    // 最低频率
constexpr float kDbFloor = -60.0f;        // 显示下限（muspi: -70，抬高就没那么敏感）
constexpr float kDbCeiling = -15.0f;      // 显示上限
constexpr float kBarGamma = 0.5f;         // 条高指数
constexpr float kRiseSmoothing = 0.35f;   // 上升平滑
constexpr float kDecaySmoothing = 0.65f;  // 回落平滑
constexpr float kPeakDecay = 0.02f;       // 峰值回落
constexpr float kSignalThreshold = 0.025f; // 峰值振幅低于它算静音（0.01 太敏感）
constexpr uint32_t kSilenceHoldMs = 400;  // 静音持续多久后把条归零
/** 音乐模式判“有声音”的门槛：平均条高超过它就不睡。 */
constexpr float kLoudLevel = 0.05f;
/** 音乐模式下连续收音多久才换成笑脸。 */
constexpr uint32_t kMusicSmileDelayMs = 5000;

/* ── 节拍检测（低音跟拍） ──────────────────────────────────────────────── */
/** 参与检测的频段数：对数分频下前 12 段大约 40~370Hz。
 *  不要只看最低几段：手机/电脑小喇叭 100Hz 以下几乎没能量，会一直不触发。 */
constexpr uint8_t kBeatBands = 12;
constexpr float kFluxAverageSmoothing = 0.05f;  // 约 0.8 秒的滑动平均
constexpr float kFluxTriggerFactor = 1.6f;      // 谱通量高于近期平均这么多倍就算一拍
constexpr float kFluxMin = 0.08f;               // 绝对下限，太安静不触发
constexpr float kBeatMinLevel = 0.06f;          // 整体音量下限
constexpr float kBeatMinLow = 0.24f;            // 低频段下限：太安静的低频不算鼓点
constexpr uint32_t kBeatMinGapMs = 240;         // 最小间隔（约 250BPM 上限）
constexpr uint32_t kBeatProbeIntervalMs = 2000; // 没触发也要定期报一次数值
/* 周期估计的接受带（相对当前估计）：
 * 太松会被“抖拍”带着跑（估计周期变小 → 门变松 → 更容易捕到更快的间隔，正反馈），
 * 太紧则歌真的变速时跟不上。超出带子的间隔只记账，连续几次才整体重同步。 */
constexpr float kTempoBandLow = 0.75f;    // 不得快于当前周期的 75%
constexpr float kTempoBandHigh = 1.33f;   // 不得慢于当前周期的 133%
constexpr uint8_t kTempoResyncCount = 3;  // 连续几次超出 → 认为是换节奏了

/* ── 音符 ──────────────────────────────────────────────────────────────── */
/* 眼睛水平占据 82~238（左眼中心 112 / 右眼 208，眼宽 60）。
 * 所以音符只允许出现在两侧的空带里，保证永远不会遮住眼睛。 */
constexpr int16_t kNoteLeftMinX = 14;
constexpr int16_t kNoteLeftMaxX = 58;
constexpr int16_t kNoteRightMinX = 262;   // 320 - 58
constexpr int16_t kNoteRightMaxX = 306;   // 320 - 14
/* 起始高度在下半部随机，但避开最下面那一行频谱（182 以下）。 */
constexpr int16_t kNoteTopY = 116;
constexpr int16_t kNoteBottomY = 168;
constexpr uint32_t kNoteLifeMinMs = 1400;
constexpr uint32_t kNoteLifeMaxMs = 1950;
constexpr uint32_t kNoteMinGapMs = 900;
constexpr uint32_t kNoteMaxGapMs = 2200;

}  // namespace

void AudioVisualizer::begin() {
  if (!M5.Mic.isEnabled()) {
    Serial.println("[audio] mic NOT available: spectrum will stay flat");
    return;
  }
  // 频段边界：40Hz → Nyquist 等比划分，映射到 FFT bin（和 muspi 的 geomspace 一致）。
  const float nyquist = sampleRate_ / 2.0f;
  const float top = nyquist > kMinFrequency * 2 ? nyquist : kMinFrequency * 2;
  for (uint8_t index = 0; index <= kAudioBarCount; ++index) {
    const float ratio = static_cast<float>(index) / kAudioBarCount;
    const float frequency = kMinFrequency * powf(top / kMinFrequency, ratio);
    int bin = static_cast<int>(lroundf(frequency * kAudioFftSize / sampleRate_));
    if (bin < 1) bin = 1;
    if (bin > kAudioFftSize / 2 - 1) bin = kAudioFftSize / 2 - 1;
    // 保证单调递增，否则某些段会空掉。
    if (index && bin <= bandEdge_[index - 1]) bin = bandEdge_[index - 1] + 1;
    bandEdge_[index] = static_cast<uint16_t>(bin);
  }
  // Hann 窗
  for (uint16_t index = 0; index < kAudioFftSize; ++index) {
    window_[index] = 0.5f - 0.5f * cosf(2.0f * PI * index / (kAudioFftSize - 1));
  }
  // 旋转因子表（e^{-2πi k/N}，只需前一半）
  for (uint16_t index = 0; index < kAudioFftSize / 2; ++index) {
    const float angle = -2.0f * PI * index / kAudioFftSize;
    twiddleRe_[index] = cosf(angle);
    twiddleIm_[index] = sinf(angle);
  }
  Serial.printf("[audio] spectrum ready: %u bars, %u-pt FFT @ %uHz\n", kAudioBarCount, kAudioFftSize,
                static_cast<unsigned>(sampleRate_));
}

void AudioVisualizer::setVisible(bool visible) {
  if (visible_ == visible) return;
  visible_ = visible;
  animStartAt_ = millis();
  if (visible) {
    nextNoteAt_ = millis() + 300;
    if (M5.Mic.isEnabled() && !micOn_) {
      M5.Mic.begin();
      micOn_ = true;
    }
    haveSpectrum_ = false;
    loudSince_ = 0;
    outOfBandCount_ = 0;
    Serial.println("[audio] visualizer ON (PWR to toggle)");
  } else {
    if (micOn_) {
      M5.Mic.end();
      micOn_ = false;
    }
    loudSince_ = 0;
    Serial.println("[audio] visualizer OFF");
  }
}

bool AudioVisualizer::isLoud() const {
  // 刚响过（还没到静音超时）或者平均条高够高，都算“有声音”。
  return avgLevel_ > kLoudLevel || (micOn_ && millis() - lastSilenceAt_ < kSilenceHoldMs);
}

uint32_t AudioVisualizer::loudDurationMs(uint32_t now) const {
  return loudSince_ ? now - loudSince_ : 0;
}

bool AudioVisualizer::isMusicSmiling(uint32_t now) const {
  return loudSince_ != 0 && now - loudSince_ >= kMusicSmileDelayMs;
}

bool AudioVisualizer::consumeBeat() {
  if (!beatPending_) return false;
  beatPending_ = false;
  return true;
}

bool AudioVisualizer::acceptSound(uint8_t slot, uint32_t sampleRate, uint32_t sampleCount, const int16_t* samples) {
  if (slot >= kSoundSlots || !samples || sampleCount == 0) return false;
  if (sampleCount > kSoundCapacity) sampleCount = kSoundCapacity;   // 超长只取前 1.2 秒
  if (!soundData_[slot]) {
    // 提示音放 PSRAM：内部 RAM 留给栈与网络缓冲。
    soundData_[slot] = static_cast<int16_t*>(heap_caps_malloc(kSoundCapacity * sizeof(int16_t), MALLOC_CAP_SPIRAM));
    if (!soundData_[slot]) {
      Serial.println("[sound] PSRAM alloc failed");
      return false;
    }
  }
  memcpy(soundData_[slot], samples, sampleCount * sizeof(int16_t));
  soundSamples_[slot] = sampleCount;
  soundRate_[slot] = sampleRate ? sampleRate : 16000;
  Serial.printf("[sound] slot %u <- %u samples @ %uHz (%ums)\n", slot, sampleCount, soundRate_[slot],
                soundSamples_[slot] * 1000UL / soundRate_[slot]);
  return true;
}

bool AudioVisualizer::hasSound(uint8_t slot) const {
  return slot < kSoundSlots && soundData_[slot] && soundSamples_[slot] > 0;
}

bool AudioVisualizer::playSound(uint8_t slot) {
  if (!hasSound(slot) || !M5.Speaker.isEnabled()) return false;
  // 与内置提示音一样：播放期间门控麦克风，播完重开（两者共用 I2S）。
  muteFor(soundSamples_[slot] * 1000UL / soundRate_[slot] + 250);
  return M5.Speaker.playRaw(soundData_[slot], soundSamples_[slot], soundRate_[slot], false, 1, -1, true);
}

void AudioVisualizer::muteFor(uint32_t durationMs) {
  const uint32_t until = millis() + durationMs;
  if (until > mutedUntil_) mutedUntil_ = until;
  // StackChan 上麦克风与扬声器共用 I2S_NUM_1：播放会改掉采样率/配置，
  // 所以播完要重开一次麦克风，否则频谱会一直是错的（表现为“突然全满”）。
  needMicRestart_ = true;
}

bool AudioVisualizer::isMuted(uint32_t now) const {
  return now < mutedUntil_ || (M5.Speaker.isEnabled() && M5.Speaker.isPlaying());
}

void AudioVisualizer::sample(uint32_t now) {
  if (!micOn_ || now - lastSampleAt_ < kSampleIntervalMs) return;
  lastSampleAt_ = now;

  // 扬声器在响：把自己的输入读掉丢弃。不读的话 I2S 缓冲会积压，
  // 解禁后拿到的是几帧之前的提示音，一样会把频谱拉满。
  const bool muted = isMuted(now);
  if (muted) flushFrames_ = 2;
  if (muted || flushFrames_) {
    if (!muted && flushFrames_) --flushFrames_;
    static int16_t discard[kSampleCount];
    M5.Mic.record(discard, kSampleCount);
    return;
  }

  static int16_t buffer[kSampleCount];
  if (!M5.Mic.record(buffer, kSampleCount)) return;   // 数据还不够，保持上一帧频谱

  // 静音判定沿用 muspi：看波形的峰值振幅。
  float peak = 0.0f;
  for (int16_t index = 0; index < kSampleCount; ++index) {
    const float value = fabsf(static_cast<float>(buffer[index]) / 32768.0f);
    if (value > peak) peak = value;
    re_[index] = static_cast<float>(buffer[index]) / 32768.0f * kMicGain * window_[index];
    im_[index] = 0.0f;
  }
  if (peak > kSignalThreshold) lastSilenceAt_ = now;
  haveSpectrum_ = true;
  computeSpectrum();
}

void AudioVisualizer::computeSpectrum() {
  fft();

  // 幅度谱 → dB → 逐段取最大值 → 归一化 → gamma（与 muspi 的 _aggregate_bars 相同）
  const float scale = 2.0f / kAudioFftSize;
  const float range = kDbCeiling - kDbFloor > 1.0f ? kDbCeiling - kDbFloor : 10.0f;
  const bool silent = millis() - lastSilenceAt_ > kSilenceHoldMs;

  for (uint8_t bar = 0; bar < kAudioBarCount; ++bar) {
    const uint16_t start = bandEdge_[bar];
    const uint16_t end = bandEdge_[bar + 1];
    float level = kDbFloor;
    for (uint16_t bin = start; bin < end; ++bin) {
      const float magnitude = sqrtf(re_[bin] * re_[bin] + im_[bin] * im_[bin]) * scale;
      const float db = 20.0f * log10f(magnitude > 1e-7f ? magnitude : 1e-7f);
      if (db > level) level = db;
    }
    float value = (level - kDbFloor) / range;
    if (value < 0.0f) value = 0.0f;
    if (value > 1.0f) value = 1.0f;
    if (silent) value = 0.0f;
    rawBands_[bar] = value;   // 原始值：节拍检测用（平滑会抹掉 onset）

    const float diff = value - bars_[bar];
    bars_[bar] += diff * (diff >= 0.0f ? kRiseSmoothing : kDecaySmoothing);
    const float decayed = peaks_[bar] - kPeakDecay;
    peaks_[bar] = fmaxf(bars_[bar], fmaxf(decayed, 0.0f));
  }

  // 平均电平：muspi 会把它画成屏幕最底部的进度条。
  float sum = 0.0f;
  for (uint8_t bar = 0; bar < kAudioBarCount; ++bar) sum += bars_[bar];
  avgLevel_ = sum / kAudioBarCount;

  /* ── 节拍检测：低频段的谱通量（相邻两帧的正向增量）──
   * 用原始值（未平滑）算，平滑后的值会把 onset 抹掉；
   * 用“相对近期平均”而不是绝对阀值，小声放歌也能跟得上。 */
  float flux = 0.0f;
  float lowMax = 0.0f;
  for (uint8_t bar = 0; bar < kBeatBands && bar < kAudioBarCount; ++bar) {
    const float delta = rawBands_[bar] - previousRaw_[bar];
    if (delta > 0.0f) flux += delta;
    previousRaw_[bar] = rawBands_[bar];
    if (rawBands_[bar] > lowMax) lowMax = rawBands_[bar];
  }
  fluxAverage_ += (flux - fluxAverage_) * kFluxAverageSmoothing;
  const float threshold = fmaxf(kFluxMin, fluxAverage_ * kFluxTriggerFactor);
  const uint32_t now = millis();
  // 最小间隔跟着当前周期走：半个周期内不再算一拍，能干掉重复触发的“抖拍”。
  const uint32_t minGap = beatIntervalMs_ ? fmaxf(200.0f, beatIntervalMs_ / 2.0f) : kBeatMinGapMs;

  if (flux >= threshold && avgLevel_ > kBeatMinLevel && lowMax >= kBeatMinLow &&
      now - lastBeatAt_ >= minGap) {
    // 拍间隔：用最近几次的中位数估周期（对漏拍/多拍不敏感）。
    const uint32_t interval = now - lastBeatAt_;
    if (lastBeatAt_ != 0 && interval < 2000) {
      bool accept = true;
      if (beatIntervalMs_ != 0) {
        const uint32_t lowEdge = static_cast<uint32_t>(beatIntervalMs_ * kTempoBandLow);
        const uint32_t highEdge = static_cast<uint32_t>(beatIntervalMs_ * kTempoBandHigh);
        const bool nearHalf = interval * 5 >= beatIntervalMs_ * 2 && interval * 5 <= beatIntervalMs_ * 3;
        const bool nearDouble = interval * 10 >= beatIntervalMs_ * 17 && interval * 10 <= beatIntervalMs_ * 23;
        if (interval >= lowEdge && interval <= highEdge) {
          outOfBandCount_ = 0;
        } else if (nearHalf || nearDouble) {
          // 接近半周期/倍周期：典型的漏拍/多拍。只用来点头，绝不拿来改周期估计，
          // 也不算进重同步计数——否则估出来的 BPM 会在 84↔267 之间来回跳。
          accept = false;
        } else {
          accept = false;
          if (++outOfBandCount_ >= kTempoResyncCount) {
            // 连着几次都落在带外、又不是倍频关系：歌真的变速了，整体切过去。
            outOfBandCount_ = 0;
            for (uint8_t index = 0; index < kIntervalCount; ++index) intervals_[index] = interval;
            beatIntervalMs_ = interval;
            Serial.printf("[beat] tempo resync -> %u bpm\n", 60000UL / interval);
          }
        }
      }
      if (accept) {
        intervals_[intervalCursor_] = interval;
        intervalCursor_ = static_cast<uint8_t>((intervalCursor_ + 1) % kIntervalCount);
        uint32_t sorted[kIntervalCount];
        for (uint8_t index = 0; index < kIntervalCount; ++index) sorted[index] = intervals_[index];
        for (uint8_t a = 1; a < kIntervalCount; ++a) {   // 插入排序，5 个元素够了
          const uint32_t key = sorted[a];
          int8_t b = a - 1;
          while (b >= 0 && sorted[b] > key) {
            sorted[b + 1] = sorted[b];
            --b;
          }
          sorted[b + 1] = key;
        }
        beatIntervalMs_ = sorted[kIntervalCount / 2];
      }
    }
    lastBeatAt_ = now;
    beatPending_ = true;
    lastBeatStrength_ = flux / threshold;
    ++beatCount_;
    // 这里不打日志：真正点头时由 PetRenderer 打一行（被排队跳过的拍只体现在 probe 里）。
  } else if (visible_ && now - lastProbeAt_ >= kBeatProbeIntervalMs) {
    // 没触发也报一行（也算鼓点日志），能看出是“没音乐”还是“阀值不合理”。
    lastProbeAt_ = now;
    Serial.printf("[beat] probe flux=%.2f thr=%.2f low=%.2f level=%.2f bpm=%u beats=%u\n", flux, threshold,
                  lowMax, avgLevel_, beatIntervalMs_ ? 60000 / beatIntervalMs_ : 0, beatCount_);
  }
}

/** 原地 radix-2 FFT（迭代版）。512 点在这个主频下开销可以忽略。 */
void AudioVisualizer::fft() {
  const uint16_t size = kAudioFftSize;
  // 位反转置换
  for (uint16_t index = 1, reversed = 0; index < size; ++index) {
    uint16_t bit = size >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) {
      const float tr = re_[index]; re_[index] = re_[reversed]; re_[reversed] = tr;
      const float ti = im_[index]; im_[index] = im_[reversed]; im_[reversed] = ti;
    }
  }
  // 蝶形运算
  for (uint16_t len = 2; len <= size; len <<= 1) {
    const uint16_t half = len >> 1;
    const uint16_t step = size / len;
    for (uint16_t base = 0; base < size; base += len) {
      for (uint16_t k = 0; k < half; ++k) {
        const float wr = twiddleRe_[k * step];
        const float wi = twiddleIm_[k * step];
        const uint16_t a = base + k;
        const uint16_t b = a + half;
        const float tr = re_[b] * wr - im_[b] * wi;
        const float ti = re_[b] * wi + im_[b] * wr;
        re_[b] = re_[a] - tr;
        im_[b] = im_[a] - ti;
        re_[a] += tr;
        im_[a] += ti;
      }
    }
  }
}

void AudioVisualizer::update(uint32_t now) {
  // 提示音播完、静音窗口也过了：重开麦克风，把 I2S 配置拉回采样需要的状态。
  if (needMicRestart_ && now >= mutedUntil_ && !(M5.Speaker.isEnabled() && M5.Speaker.isPlaying())) {
    needMicRestart_ = false;
    if (micOn_) {
      M5.Mic.end();
      M5.Mic.begin();
      flushFrames_ = 2;
      Serial.println("[audio] mic restarted after cue tone");
    }
  }

  // 入场/退场动画（和卡片同速）。
  const float target = visible_ ? 1.0f : 0.0f;
  const float step = static_cast<float>(now - animStartAt_) / 260.0f;
  progress_ = target > progress_ ? fminf(target, step) : fmaxf(target, 1.0f - step);

  sample(now);

  // 连续收音计时：安静就清零（表情随之退回 idle）。
  if (visible_ && micOn_ && isLoud()) {
    if (!loudSince_) {
      loudSince_ = now;
      Serial.println("[audio] music mode: listening...");
    }
  } else if (loudSince_) {
    loudSince_ = 0;
    beatPending_ = false;
    outOfBandCount_ = 0;   // 下一首歌重新累积
    // 音乐停了：音符也一起收掉（“安静了就不该还有音符冒出来”）。
    for (uint8_t index = 0; index < kNotes; ++index) notes_[index].alive = false;
    Serial.println("[audio] music mode: quiet, back to idle face");
  }

  // 关掉之后（以及提示音期间）条要收干净：采样停了，靠这里的衰减。
  if (!micOn_ || isMuted(now)) {
    for (uint8_t bar = 0; bar < kAudioBarCount; ++bar) {
      bars_[bar] += (0.0f - bars_[bar]) * 0.3f;
      peaks_[bar] = fmaxf(0.0f, peaks_[bar] - kPeakDecay);
    }
    avgLevel_ *= 0.7f;
  }

  // 音符：显示时每隔 0.9~2.2 秒从左右交替飘一个；关掉后让在飞的飘完。
  for (uint8_t index = 0; index < kNotes; ++index) {
    if (!notes_[index].alive) continue;
    if (now - notes_[index].bornAt > notes_[index].lifeMs) {
      notes_[index].alive = false;
      continue;
    }
    notes_[index].y -= notes_[index].vy;
    notes_[index].x += notes_[index].sway;
  }
  // 音符只在“正在收音”时冒（安静后立即停，且清掉在飞的）。
  if (visible_ && loudSince_ != 0 && now >= nextNoteAt_) {
    Note& note = notes_[noteCursor_];
    note.alive = true;
    note.bornAt = now;
    note.lifeMs = kNoteLifeMinMs + static_cast<uint32_t>(random(0, kNoteLifeMaxMs - kNoteLifeMinMs));
    note.right = noteOnRight_;
    // 两侧空带里随机，避着眼睛。
    note.x = noteOnRight_ ? static_cast<float>(random(kNoteRightMinX, kNoteRightMaxX))
                          : static_cast<float>(random(kNoteLeftMinX, kNoteLeftMaxX));
    // 起始高度也随机（下半部，不压到频谱那一行）。
    note.y = static_cast<float>(random(kNoteTopY, kNoteBottomY));
    note.vy = 1.2f + static_cast<float>(random(0, 90)) / 100.0f;              // 1.2~2.1 px/帧
    note.sway = (static_cast<float>(random(0, 100)) / 100.0f - 0.5f) * 0.5f;   // 左右慢摆
    noteOnRight_ = !noteOnRight_;
    noteCursor_ = (noteCursor_ + 1) % kNotes;
    nextNoteAt_ = now + kNoteMinGapMs + static_cast<uint32_t>(random(0, kNoteMaxGapMs - kNoteMinGapMs));
  }
}

void AudioVisualizer::draw(LovyanGFX& g, int16_t margin, int16_t height) {
  const int16_t width = g.width() - margin * 2;
  const int16_t baseline = g.height() - margin;
  const int16_t slide = static_cast<int16_t>((1.0f - progress_) * 20.0f);
  const int16_t maxHeight = height - 8;
  const int16_t base = baseline + slide;

  // 条宽自适应：muspi 是 3px + 1px，这里按屏幕宽度铺满并居中。
  const int16_t spacing = 2;
  int16_t barWidth = (width - spacing * (kAudioBarCount - 1)) / kAudioBarCount;
  if (barWidth < 2) barWidth = 2;
  const int16_t total = kAudioBarCount * barWidth + (kAudioBarCount - 1) * spacing;
  int16_t x = margin + (width - total) / 2;

  for (uint8_t bar = 0; bar < kAudioBarCount; ++bar) {
    // gamme 0.5：和 muspi 的 bar_gamma 一致，小声也看得见。
    const float value = powf(bars_[bar] > 0.0f ? bars_[bar] : 0.0f, kBarGamma);
    const int16_t barHeight = static_cast<int16_t>(value * maxHeight);
    if (barHeight > 0) g.fillRect(x, base - barHeight, barWidth, barHeight, kBarColor);

    const float peakValue = powf(peaks_[bar] > 0.0f ? peaks_[bar] : 0.0f, kBarGamma);
    const int16_t peakHeight = static_cast<int16_t>(peakValue * maxHeight);
    if (peakHeight > 1) g.fillRect(x, base - peakHeight, barWidth, 2, kPeakColor);
    x += barWidth + spacing;
  }
  // 不需要底部的横向线/电平条：只留一条条跳动的频谱。
}

void AudioVisualizer::drawNotes(LovyanGFX& g) {
  for (uint8_t index = 0; index < kNotes; ++index) {
    const Note& note = notes_[index];
    if (!note.alive) continue;
    const uint32_t age = millis() - note.bornAt;
    if (age > note.lifeMs) continue;
    // 后半程缩小当作淡出（16 位屏上没有逐像素 alpha）。
    const float fade = age > note.lifeMs / 2 ? 1.0f - (age - note.lifeMs / 2.0f) / (note.lifeMs / 2.0f) : 1.0f;
    const int16_t size = static_cast<int16_t>(4 + 5 * fade);
    const int16_t x = static_cast<int16_t>(note.x);
    const int16_t y = static_cast<int16_t>(note.y);
    // 音符 = 实心圆头 + 符干 + 小旗，全部向量绘制，不依赖字体。
    g.fillCircle(x, y, size, kNoteColor);
    g.drawFastVLine(x + size - 1, y - size * 3, size * 3, kNoteColor);
    g.drawLine(x + size - 1, y - size * 3, x + size, y - size * 3, kNoteColor);
    g.drawLine(x + size, y - size * 3, x + size + 3, y - size * 3 + 4, kNoteColor);
  }
}

bool AudioVisualizer::notesAlive() const {
  const uint32_t now = millis();
  for (uint8_t index = 0; index < kNotes; ++index) {
    if (notes_[index].alive && now - notes_[index].bornAt <= notes_[index].lifeMs) return true;
  }
  return false;
}

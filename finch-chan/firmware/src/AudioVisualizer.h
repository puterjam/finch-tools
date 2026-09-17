#pragma once

#include <Arduino.h>
#include <M5Unified.h>   // 提供 LovyanGFX 类型（不直接引 LovyanGFX.h）

/** 频谱条数量：与 muspi 的 spectrum 插件一致（上限 32）。 */
constexpr uint8_t kAudioBarCount = 32;
/** FFT 点数。muspi 用 2048，这里取样率低一些（16kHz），512 足够画出同样的形。 */
constexpr uint16_t kAudioFftSize = 512;
/** 收音灵敏度档位（低/中/高）对应的麦克风线性增益；小程序设置菜单可切换。 */
constexpr float kGainLevelGains[3] = {1.8f, 2.4f, 3.0f};
constexpr uint8_t kGainLevelDefault = 1;   // 默认「中」

/**
 * 麦克风频谱动效（复刻 muspi 的 `screen/plugins/spectrum`）。
 *
 * 与 muspi 一一对应的地方：
 *   - 512 点 FFT + Hann 窗，取幅度谱转 dB；
 *   - 40Hz → Nyquist 等比划分 32 个频段，每段取最大值；
 *   - dB 归一化到 [dbFloor, dbCeiling] 后夹在 0..1，再开 gamma(0.5)；
 *   - 上升/衰减分别平滑（0.35 / 0.65），峰值以固定步长回落（0.02）；
 *   - 静音超过一段时间就把条归零；
 *   - 画法：每根条 + 上方峰值线 + 底部平均电平条。
 *
 * 与 muspi 不同的地方（都是屏幕/硬件差异）：
 *   - 取样率 16kHz 而非 44.1kHz（板载麦克风默认），频段上限即 Nyquist 8kHz；
 *   - 频谱画在底部一行（高度与按钮行一致），而不是覆盖整屏；
 *   - 额外有 PWR 开关、表情上移、两侧飘 ♪ 这些桌面宠物需要的体验。
 */
class AudioVisualizer {
 public:
  void begin();

  void setVisible(bool visible);
  void toggle() { setVisible(!visible_); }
  bool visible() const { return visible_; }

  /**
   * 收音灵敏度（小程序设置菜单里可切）：0=低、1=中、2=高，
   * 对应麦克风增益 1.8 / 2.4 / 3.0。越界值会被夹住。
   */
  void setGainLevel(uint8_t level);
  uint8_t gainLevel() const { return gainLevel_; }

  /** 入场动画进度 0→1：调用方用它把表情顶上去（和卡片同一套位移）。 */
  float progress() const { return progress_; }

  /** 当前平滑音量 0..1：音乐模式下给笑脸的轻微浮动用。 */
  float level() const { return avgLevel_; }
  /** 现在算“有声音”吗：音乐模式据此不睡（只有特别安静才按普通计时睡）。 */
  bool isLoud() const;

  /** 连续“有声音”持续了多久（毫秒）；安静时返回 0。 */
  uint32_t loudDurationMs(uint32_t now) const;
  /**
   * 音乐模式是否该笑：连续收音够久（`kMusicSmileDelayMs`）才算。
   * 安静时立刻为假，调用方据此把表情退回 idle 的普通表情（模式不变）。
   */
  bool isMusicSmiling(uint32_t now) const;

  /** 是否刚踩到一个节拍（读一次就清）。音乐模式据此跟节拍点头。 */
  bool consumeBeat();
  /** 刚才那一拍的强度（通量 / 阀值，1.0 刚好踩线）：用来区分强弱拍。 */
  float lastBeatStrength() const { return lastBeatStrength_; }
  /** 累计检测到多少拍（含被点头排队跳过的）。 */
  uint32_t beatCount() const { return beatCount_; }
  /** 估算的节拍周期（毫秒）：最近几次间隔的中位数，没数据时为 0。 */
  uint32_t beatPeriodMs() const { return beatIntervalMs_; }

  /** 关掉（或提示音期间）不再看麦克风：传时长，之后再丢两帧把残留排掉。 */
  void muteFor(uint32_t durationMs);

  /**
   * 小程序推过来的提示音（存在 PSRAM，不用内置素材）。
   * slot: 0=未读/完成, 1=需要你处理, 2=出错。
   */
  static constexpr uint8_t kSoundSlots = 3;
  bool acceptSound(uint8_t slot, uint32_t sampleRate, uint32_t sampleCount, const int16_t* samples);
  bool hasSound(uint8_t slot) const;
  /** 播放指定 slot；没推过就返回 false，调用方回退到内置合成音。 */
  bool playSound(uint8_t slot);

  /**
   * 播放前的音频端口交接。StackChan 的麦克风与扬声器共用 I2S_NUM_1：
   * 麦克风在跑时扬声器写进去只会出噪声；麦克风 end() 之后端口被卸掉，
   * 扬声器自以为还在跑、从此再没声音。所以不管播提示音还是内置音，
   * 都要先走这一步。返回 false 表示这台设备没有可用的扬声器。
   */
  bool beginPlayback();

  /** 每帧调用：采样 + 频谱 + 条与音符推进。关闭时只把动画收尾。 */
  void update(uint32_t now);

  /** 画底部频谱；margin/height 应和按钮行保持一致。 */
  void draw(LovyanGFX& g, int16_t margin, int16_t height);
  /** 画正在飘的音符（两侧）。 */
  void drawNotes(LovyanGFX& g);
  /** 还有音符在空中（关掉动效后让它们飘完）。 */
  bool notesAlive() const;

 private:
  static constexpr uint8_t kNotes = 4;

  struct Note {
    bool alive = false;
    float x = 0.0f;
    float y = 0.0f;
    float vy = 0.0f;
    float sway = 0.0f;
    uint32_t bornAt = 0;
    uint32_t lifeMs = 1600;
    bool right = false;
  };

  bool visible_ = false;
  bool micOn_ = false;
  bool haveSpectrum_ = false;
  float progress_ = 0.0f;
  float bars_[kAudioBarCount] = {};
  float peaks_[kAudioBarCount] = {};
  float avgLevel_ = 0.0f;
  Note notes_[kNotes];
  uint32_t lastSampleAt_ = 0;
  uint32_t lastSilenceAt_ = 0;
  /** 「还算在响」的保持窗口：见 isLoud()，用来压掉阈值上下的逐帧抖动。 */
  uint32_t loudHoldUntil_ = 0;
  /** 连续有声音的起点；安静时清零（音乐模式的笑脸计时）。 */
  uint32_t loudSince_ = 0;
  /** 低频段能量与谱通量：节拍检测用。 */
  uint32_t lastBeatAt_ = 0;
  bool beatPending_ = false;
  float lastBeatStrength_ = 0.0f;
  /** 最近几次拍间隔（毫秒）：取中位数估 BPM，对漏拍/多拍都不敏感。 */
  static constexpr uint8_t kIntervalCount = 5;
  uint32_t intervals_[kIntervalCount] = {500, 500, 500, 500, 500};
  uint8_t intervalCursor_ = 0;
  uint32_t beatIntervalMs_ = 0;
  /** 连续多少次拍间隔落在接受带外（用于判断“歌真的变速了”）。 */
  uint8_t outOfBandCount_ = 0;

  /** 逐段原始值（未平滑）与上一帧值：谱通量（onset）检测用。 */
  float rawBands_[kAudioBarCount] = {};
  float previousRaw_[kAudioBarCount] = {};
  float fluxAverage_ = 0.0f;
  uint32_t beatCount_ = 0;
  uint32_t lastProbeAt_ = 0;
  /** 提示音播放期间不看麦克风（否则会把自己的声音当成输入，频谱瞬间拉满）。 */
  uint32_t mutedUntil_ = 0;
  /** 提示音结束后要不要重开麦克风（StackChan 的麦克风与扬声器共用 I2S）。 */
  bool needMicRestart_ = false;
  uint8_t flushFrames_ = 0;
  uint32_t nextNoteAt_ = 0;
  uint8_t noteCursor_ = 0;
  bool noteOnRight_ = false;
  uint32_t animStartAt_ = 0;

  uint32_t sampleRate_ = 16000;
  /** 收音灵敏度档位（0 低 / 1 中 / 2 高）与其对应的线性增益。 */
  uint8_t gainLevel_ = kGainLevelDefault;
  float micGain() const { return kGainLevelGains[gainLevel_ <= 2 ? gainLevel_ : kGainLevelDefault]; }
  /** 麦克风动过共用 I2S 端口（begin/end/重启）——下次播放前要把扬声器装回去。 */
  bool speakerDirty_ = false;
  uint16_t bandEdge_[kAudioBarCount + 1] = {};
  float re_[kAudioFftSize] = {};
  float im_[kAudioFftSize] = {};
  float window_[kAudioFftSize] = {};
  float twiddleRe_[kAudioFftSize / 2] = {};
  float twiddleIm_[kAudioFftSize / 2] = {};

  void sample(uint32_t now);
  void computeSpectrum();
  void fft();
  /** 现在该不该停止采样（提示音在响 / 刚响完）。 */
  bool isMuted(uint32_t now) const;

  /** 每段提示音的容量：2.5 秒 @16kHz 单声道 16bit ≈ 80KB（存在 PSRAM）。 */
  static constexpr uint32_t kSoundCapacity = 40000;
  int16_t* soundData_[kSoundSlots] = {};
  uint32_t soundSamples_[kSoundSlots] = {};
  uint32_t soundRate_[kSoundSlots] = {};
};

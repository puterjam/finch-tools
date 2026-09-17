/**
 * 通知音：在小程序里合成 PCM 后推给设备，**不用把音频内置到固件**。
 *
 * 音色想改就改这里，重载小程序即可，不用重烧固件。
 * 规格与固件 AudioVisualizer::acceptSound 对齐：16 kHz、单声道、16-bit PCM。
 */

import { IMPORTED_SOUNDS } from './sounds.js';

/** 采样率（Hz）：与固件约定一致（导入的 PCM 也是 16kHz）。 */
export const SOUND_RATE = 16000;

/** 槽位：与固件 AudioVisualizer 的 slot 一一对应。 */
export const SOUND_SLOT = { unread: 0, wait: 1, error: 2 } as const;
export type SoundSlot = (typeof SOUND_SLOT)[keyof typeof SOUND_SLOT];

interface Note {
  /** 频率（Hz） */
  freq: number;
  /** 相对本段开头的起始时间（毫秒） */
  atMs: number;
  /** 持续时间（毫秒） */
  durMs: number;
  gain?: number;
}

/**
 * 合成一段音：正弦 + 5ms 起音 + 指数衰减。
 * 完全没有突变，所以不会像直接 `Speaker.tone()` 那样“啪”一声。
 */
function synth(notes: Note[], totalMs: number, targetPeak = 0.85): Int16Array {
  const length = Math.ceil((totalMs * SOUND_RATE) / 1000);
  const mix = new Float32Array(length);
  for (const note of notes) {
    const start = Math.floor((note.atMs * SOUND_RATE) / 1000);
    const count = Math.floor((note.durMs * SOUND_RATE) / 1000);
    const gain = note.gain ?? 1;
    for (let index = 0; index < count && start + index < length; ++index) {
      const seconds = index / SOUND_RATE;
      const attack = Math.min(1, index / (0.008 * SOUND_RATE));
      const decay = Math.exp(-2.2 * seconds);   // 比之前缓：尾音听得见
      const phase = 2 * Math.PI * note.freq * seconds;
      // 加一点二次谐波：小喇叭上更亮、更容易听出来。
      mix[start + index] += (Math.sin(phase) + 0.25 * Math.sin(2 * phase)) * attack * decay * gain;
    }
  }
  // 归一化到统一峰值：三段音响度一致，不会出现“某一个听不到”。
  let peak = 0;
  for (const value of mix) peak = Math.max(peak, Math.abs(value));
  const scale = peak > 0 ? targetPeak / peak : 0;
  const pcm = new Int16Array(length);
  for (let index = 0; index < length; ++index) {
    pcm[index] = Math.round(Math.max(-1, Math.min(1, mix[index] * scale)) * 32767);
  }
  return pcm;
}

/**
 * 三段时间（用户提供的 WAV，经 tools/import-sounds.mjs 转成 PCM）：
 *   unread：message-ping（一般完成 / 有未读）
 *   wait  ：new-notification-064（需要你处理）
 *   error ：new-notification-010（出错）
 * 源：Pixabay universfield，可自由使用。
 */
function decodePcm(base64: string): Int16Array {
  const raw = Buffer.from(base64, 'base64');
  const samples = new Int16Array(raw.length >> 1);
  for (let index = 0; index < samples.length; ++index) samples[index] = raw.readInt16LE(index * 2);
  return samples;
}

export const NOTIFICATION_SOUNDS: Record<SoundSlot, Int16Array> = {
  [SOUND_SLOT.unread]: decodePcm(IMPORTED_SOUNDS.unread ?? ''),
  [SOUND_SLOT.wait]: decodePcm(IMPORTED_SOUNDS.wait ?? ''),
  [SOUND_SLOT.error]: decodePcm(IMPORTED_SOUNDS.error ?? ''),
};

/**
 * 备用：代码合成的三段音（不依赖任何素材）。
 * 把 `NOTIFICATION_SOUNDS` 换成 `SYNTH_NOTIFICATION_SOUNDS` 就能用回它。
 */
export const SYNTH_NOTIFICATION_SOUNDS: Record<SoundSlot, Int16Array> = {
  [SOUND_SLOT.unread]: synth(
    [
      { freq: 784, atMs: 0, durMs: 280 },
      { freq: 1047, atMs: 190, durMs: 380 },
    ],
    570,
  ),
  [SOUND_SLOT.wait]: synth(
    [
      { freq: 988, atMs: 0, durMs: 240 },
      { freq: 988, atMs: 300, durMs: 340 },
    ],
    660,
  ),
  [SOUND_SLOT.error]: synth(
    [
      { freq: 659, atMs: 0, durMs: 320 },
      { freq: 494, atMs: 260, durMs: 420 },
    ],
    700,
  ),
};

/**
 * 打包成固件认识的二进制帧：
 *   byte 0   : 'A' 魔数
 *   byte 1   : 版本 = 1
 *   byte 2   : slot
 *   byte 3   : 格式 = 1（PCM16 单声道）
 *   byte 4-7 : 采样率 uint32 LE
 *   byte 8-11: 采样点数 uint32 LE
 *   byte 12-15: 保留
 *   之后：PCM16 数据
 */
export function soundFrame(slot: SoundSlot, pcm: Int16Array): Buffer {
  const header = Buffer.alloc(16);
  header.write('A', 0, 'ascii');
  header.writeUInt8(1, 1);
  header.writeUInt8(slot, 2);
  header.writeUInt8(1, 3);
  header.writeUInt32LE(SOUND_RATE, 4);
  header.writeUInt32LE(pcm.length, 8);
  return Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length * 2)]);
}

/** 三段音的二进制帧，按 slot 顺序返回（用于设备认证后一次性推送）。 */
export function soundFrames(): Buffer[] {
  return (Object.values(SOUND_SLOT) as SoundSlot[]).map((slot) => soundFrame(slot, NOTIFICATION_SOUNDS[slot]));
}

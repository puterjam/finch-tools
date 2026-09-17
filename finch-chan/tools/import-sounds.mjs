/**
 * 把转好的 WAV 变成小程序里的 PCM 数据（src/sounds.ts）。
 * 用法：node tools/import-sounds.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const RATE = 16000;
/** 与固件 AudioVisualizer::kSoundCapacity 一致：2.5 秒 @16kHz。 */
const MAX_SAMPLES = 40000;
const TARGET_PEAK = 0.85;

/** 只取 data chunk，忽略其它（afconvert 会加 fmt/FLLR 之类）。 */
function readWav(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${file}: not a RIFF/WAVE file`);
  }
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'data') {
      const start = offset + 8;
      const count = Math.min(size, buffer.length - start) >> 1;
      const samples = new Int16Array(count);
      for (let index = 0; index < count; ++index) samples[index] = buffer.readInt16LE(start + index * 2);
      return samples;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`${file}: no data chunk`);
}

function stats(samples) {
  let peak = 0;
  let energy = 0;
  for (const value of samples) {
    peak = Math.max(peak, Math.abs(value));
    energy += value * value;
  }
  return { peak, rms: Math.round(Math.sqrt(energy / samples.length)) };
}

function process(file) {
  const raw = readWav(file);
  let samples = raw;
  if (samples.length > MAX_SAMPLES) samples = samples.slice(0, MAX_SAMPLES);
  // 归一化：统一响度；增益上限 3 倍，避免把底噪一起放大。
  const { peak } = stats(samples);
  const target = TARGET_PEAK * 32767;
  const gain = peak > 0 ? Math.min(target / peak, 3) : 1;
  const out = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; ++index) {
    out[index] = Math.max(-32768, Math.min(32767, Math.round(samples[index] * gain)));
  }
  // 结尾 25ms 淡出：即便被截断也不会有“啪”。
  const fade = Math.round(0.025 * RATE);
  for (let index = 0; index < fade && index < out.length; ++index) {
    const scale = index / fade;
    out[out.length - 1 - index] = Math.round(out[out.length - 1 - index] * scale);
  }
  const after = stats(out);
  console.log(
    `${path.basename(file)}: ${raw.length} samples (${((raw.length / RATE) * 1000).toFixed(0)}ms)` +
      ` -> kept ${out.length} (${((out.length / RATE) * 1000).toFixed(0)}ms) gain=${gain.toFixed(2)}` +
      ` peak ${peak}->${after.peak} rms=${after.rms}`,
  );
  return out;
}

const sources = [
  ['unread', '/tmp/snd-unread.wav'],
  ['wait', '/tmp/snd-wait.wav'],
  ['error', '/tmp/snd-error.wav'],
];

const parts = [];
for (const [slot, file] of sources) {
  const samples = process(file);
  const base64 = Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2).toString('base64');
  parts.push({ slot, samples: samples.length, base64 });
}

const lines = [];
lines.push('/**');
lines.push(' * 通知音的 PCM 数据（16kHz 单声道 16-bit），由 tools/import-sounds.mjs 从 WAV 生成。');
lines.push(' *');
lines.push(' * 来源：Pixabay（universfield）——可自由使用；音色要改就重跑那个脚本，');
lines.push(' * 或者直接在 audio.ts 里改合成音（SYNTH 那份）。');
lines.push(' */');
lines.push('');
lines.push('export const IMPORTED_SOUND_RATE = 16000;');
lines.push('');
lines.push('export const IMPORTED_SOUNDS: Record<string, string> = {');
for (const part of parts) {
  lines.push(`  // ${part.slot}: ${part.samples} samples`);
  lines.push(`  ${part.slot}: '${part.base64}',`);
}
lines.push('};');
lines.push('');

const outFile = '/Users/puterjam/finchnest/finch-tools/finch-chan/src/sounds.ts';
fs.writeFileSync(outFile, lines.join('\n'));
console.log(`wrote ${outFile} (${(fs.statSync(outFile).size / 1024).toFixed(0)} KB)`);

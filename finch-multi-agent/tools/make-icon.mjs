// Generates the 300x300 icon.png for finch-multi-agent.
// Renders with signed-distance fields + 4x supersampling, encodes PNG via zlib.
// Zero dependencies — this is a build-time script, not shipped.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SIZE = 300;
const SS = 4; // supersample factor
const N = SIZE * SS;

const BG = [0x4a, 0x7c, 0x63];
const FG = [0xff, 0xff, 0xff];

// Geometry in a 300x300 space (matches icons/agents.svg).
const SCALE = SS;
const cx = 150 * SCALE;
const cy = 150 * SCALE;
const rx = 66 * SCALE;
const s = (v) => v * SCALE;

const HUB_R = s(20.5);
const NODE_R = s(14.4);
const STROKE = s(13);

const nodes = [
  [150, 86.2],
  [94.5, 185],
  [205.5, 185],
].map(([x, y]) => [x * SCALE, y * SCALE]);

const spokes = [
  [150, 100.5, 150, 130.2],
  [136.3, 162.9, 106.7, 177.4],
  [163.7, 162.9, 205.5, 177.4],
].map((v) => v.map((n) => n * SCALE));

function sdRoundBox(px, py, halfW, halfH, r) {
  const qx = Math.abs(px) - halfW + r;
  const qy = Math.abs(py) - halfH + r;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

function sdRing(px, py, ox, oy, r) {
  return Math.abs(Math.hypot(px - ox, py - oy) - r) - STROKE / 2;
}

function sdCapsule(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy)) - STROKE / 2;
}

function coverage(x, y) {
  if (sdRoundBox(x - cx, y - cy, s(150), s(150), rx) > 0) return 0;
  let best = sdRing(x, y, cx, cy, HUB_R);
  for (const [nx, ny] of nodes) best = Math.min(best, sdRing(x, y, nx, ny, NODE_R));
  for (const [x1, y1, x2, y2] of spokes) best = Math.min(best, sdCapsule(x, y, x1, y1, x2, y2));
  return best <= 0 ? 1 : 0;
}

// 1. supersampled coverage buffer
const hi = new Float32Array(N * N);
for (let y = 0; y < N; y += 1) {
  for (let x = 0; x < N; x += 1) {
    hi[y * N + x] = coverage(x + 0.5, y + 0.5);
  }
}

// 2. box-downsample to the final RGBA image
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y += 1) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0; // PNG filter: none
  for (let x = 0; x < SIZE; x += 1) {
    let acc = 0;
    for (let sy = 0; sy < SS; sy += 1) {
      for (let sx = 0; sx < SS; sx += 1) {
        acc += hi[(y * SS + sy) * N + (x * SS + sx)];
      }
    }
    const a = acc / (SS * SS);
    const offset = rowStart + 1 + x * 4;
    raw[offset] = Math.round(BG[0] + (FG[0] - BG[0]) * a);
    raw[offset + 1] = Math.round(BG[1] + (FG[1] - BG[1]) * a);
    raw[offset + 2] = Math.round(BG[2] + (FG[2] - BG[2]) * a);
    raw[offset + 3] = 255;
  }
}

// 3. encode PNG
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const target = process.argv[2];
if (!target) throw new Error('usage: node tools/make-icon.mjs <out.png>');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, png);
console.log(`wrote ${target} (${png.length} bytes)`);

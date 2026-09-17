#!/usr/bin/env python3
"""重新生成 thinking/working 状态右下角那支笔的动画帧（firmware/src/pen_frames.h）。

只依赖 macOS 自带的工具 + Pillow：
  1. 把内嵌的 Lucide pencil SVG 交给 QuickLook 栅格化（macOS 上没有别的 SVG 渲染器可用；
     ImageMagick 自带的 MSVG 在这里渲染出来是全透明的，别用）；
  2. **保留灰度**：先在超采样倍率下渲染/旋转，再降采样回帧尺寸，最后量化成
     LEVELS 档（0 = 透明，1..LEVELS-1 = 由浅到深的灰）——
     这样斜线不再是一格一格的锯齿（纯 1 位阈值化在高对比屏上非常明显）；
  3. 以**笔尖为轴**旋转，预渲染 FRAMES 帧（角度按正弦分布在 ±MAX_DEG 之间）；
  4. 每帧落在 CELL x CELL 的方框里，笔尖对齐固定锚点 (TIP_X, TIP_Y)，固件据 blit。

想换摆幅/大小/灰阶数就改下面的常量再跑一次：
    python3 tools/pen-frames.py
"""
import math
import os
import subprocess
import sys
import tempfile

from PIL import Image

SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#000000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>"""

CELL = 56          # 帧边长，必须能被 4 整除（每像素 4 位 → 每字节 2 像素）
BITS = 2           # 每像素位数：2 位 = 4 档（0 透明 + 3 档灰），比 4 位锐利一些
LEVELS = 1 << BITS
STRIDE = CELL * BITS // 8
FRAMES = 9         # 预渲染帧数
MAX_DEG = 6.0      # 预渲染的最大摆角（固件用"取中心附近几帧"再缩放）
INK_SIZE = 38      # 铅笔长边占多少像素
TIP_X, TIP_Y = 2, CELL - 2   # 笔尖在帧内的锚点
SS = 4             # 超采样倍率（旋转与降采样都在这个精度上做）
PAD = 24           # 旋转画布比笔多出来的余量（原始像素）

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'firmware', 'src', 'pen_frames.h')


def rasterize(svg_text):
    """用 QuickLook 把 SVG 渲染成灰度图（墨迹是亮的，背景透明 → 0）。"""
    with tempfile.TemporaryDirectory() as tmp:
        svg_path = os.path.join(tmp, 'pen.svg')
        with open(svg_path, 'w') as handle:
            handle.write(svg_text)
        subprocess.run(['qlmanage', '-t', '-s', '400', '-o', tmp, svg_path],
                       check=True, capture_output=True)
        png = os.path.join(tmp, 'pen.svg.png')
        if not os.path.exists(png):
            raise RuntimeError('QuickLook 没有产出缩略图')
        # 反相：墨迹 = 高值，方便后续按"覆盖度"处理
        return Image.open(png).convert('L').point(lambda p: 255 - p).copy()


def tip_of(image, threshold=128):
    """笔尖 = 最左下（y - x 最大）的那个够亮的像素。"""
    px = image.load()
    return max((y - x, x, y) for y in range(image.height) for x in range(image.width)
               if px[x, y] >= threshold)[1:]


def build_frames():
    ink = rasterize(SVG)
    ink = ink.crop(ink.getbbox())
    scale = INK_SIZE * SS / max(ink.size)
    big = ink.resize((max(1, round(ink.width * scale)), max(1, round(ink.height * scale))), Image.LANCZOS)

    stage = Image.new('L', (big.width + PAD * 2 * SS, big.height + PAD * 2 * SS), 0)
    stage.paste(big, (PAD * SS, PAD * SS))
    stage_tip = tip_of(stage)
    print(f'ink {ink.size} -> big {big.size}  stage {stage.size}  tip {stage_tip}')

    angles = [MAX_DEG * math.sin(2 * math.pi * i / FRAMES) for i in range(FRAMES)]
    frames = []
    for deg in angles:
        rotated = stage.rotate(deg, center=stage_tip, resample=Image.BILINEAR, fillcolor=0)
        # 只按超采样倍率缩回去（不是缩到 CELL）：BOX = 面积平均，保留灰阶（抗锯齿的关键）
        small = rotated.resize((rotated.width // SS, rotated.height // SS), Image.BOX)
        # 旋转是绕笔尖做的，所以笔尖在 stage 里没动；换算到 small 的坐标即可
        ox = TIP_X - round(stage_tip[0] / SS)
        oy = TIP_Y - round(stage_tip[1] / SS)
        cell = Image.new('L', (CELL, CELL), 0)
        cell.paste(small, (ox, oy))
        frames.append(cell)
    return frames, angles


def quantize(cell):
    """灰度 → LEVELS 档（0 = 透明）。"""
    px = cell.load()
    levels = [[0] * CELL for _ in range(CELL)]
    for y in range(CELL):
        for x in range(CELL):
            value = px[x, y]
            level = min(LEVELS - 1, (value * LEVELS) // 256) if value >= 24 else 0
            levels[y][x] = level
    return levels


def emit(frames, angles):
    lines = [
        '/**',
        ' * 「动笔」动画帧（thinking/working 状态右下角那支笔）。',
        ' *',
        ' * 来源：Lucide pencil 图标，离线栅格化后以**笔尖为轴**旋转预渲染 %d 帧，' % FRAMES,
        ' * 摆角按正弦分布在 ±%.0f° 之间。每帧 %dx%d、**每像素 %d 位**（0 = 透明，1..%d = 由浅到深的灰，' % (MAX_DEG, CELL, CELL, BITS, LEVELS - 1),
        ' * 灰阶是为了抗锯齿：纯 1 位阈值化在斜线上是一格一格的锯齿），行优先、MSB 在左。',
        ' * 笔尖固定在帧内 (%d, %d)，固件按这个锚点 blit 并轮换帧。' % (TIP_X, TIP_Y),
        ' * 重新生成：python3 tools/pen-frames.py（需要 macOS 的 qlmanage + Pillow）。',
        ' */',
        'constexpr int16_t kPenFrameSize = %d;' % CELL,
        'constexpr uint8_t kPenFrameBits = %d;' % BITS,
        'constexpr int16_t kPenTipX = %d;' % TIP_X,
        'constexpr int16_t kPenTipY = %d;' % TIP_Y,
        'constexpr uint8_t kPenFrameCount = %d;' % FRAMES,
        '/** 0 = 透明；1..%d = 由浅到深的灰（抗锯齿用的过渡色）。 */' % (LEVELS - 1),
        'const uint8_t kPenFrames[kPenFrameCount][%d] = {' % (CELL * STRIDE),
    ]
    for index, cell in enumerate(frames):
        levels = quantize(cell)
        rows = []
        values = [levels[y][x] for y in range(CELL) for x in range(CELL)]
        per_byte = 8 // BITS
        for start in range(0, len(values), per_byte):
            value = 0
            for offset in range(per_byte):
                value = (value << BITS) | values[start + offset]
            rows.append(value)
        lines.append('  {  // frame %d  (%+.2f°)' % (index, angles[index]))
        for start in range(0, len(rows), 10):
            lines.append('      ' + ', '.join('0x%02X' % v for v in rows[start:start + 10]) + ',')
        lines.append('  },')
    lines.append('};')
    with open(OUT, 'w') as handle:
        handle.write('\n'.join(lines) + '\n')
    print(f'wrote {OUT}  ({len(frames)} frames, {CELL}x{CELL}x{BITS}bit, {CELL * STRIDE} bytes each)')


if __name__ == '__main__':
    if sys.platform != 'darwin':
        print('需要 macOS：SVG 栅格化用的是 qlmanage', file=sys.stderr)
        sys.exit(1)
    cells, degs = build_frames()
    print('angles:', ', '.join('%+.2f' % a for a in degs))
    for index, cell in enumerate(cells):
        levels = quantize(cell)
        ink = [(x, y) for y in range(CELL) for x in range(CELL) if levels[y][x]]
        xs = [p[0] for p in ink]
        ys = [p[1] for p in ink]
        print(f'  frame {index}: ink x {min(xs)}..{max(xs)}  y {min(ys)}..{max(ys)}')
    # 顺便导出一张放大预览，方便肉眼比对抗锯齿效果
    preview = Image.new('L', (CELL * len(cells), CELL), 0)
    for index, cell in enumerate(cells):
        preview.paste(cell, (index * CELL, 0))
    preview.resize((preview.width * 3, preview.height * 3), Image.NEAREST).save('/tmp/pen-frames-preview.png')
    print('wrote /tmp/pen-frames-preview.png')
    emit(cells, degs)

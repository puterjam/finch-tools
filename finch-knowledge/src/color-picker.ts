export interface HSV { h: number; s: number; v: number }
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function hexToHsv(hex: string): HSV {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error('Invalid HEX color.');
  const [r, g, b] = [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const raw = delta === 0 ? 0 : max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { h: (raw * 60 + 360) % 360, s: max === 0 ? 0 : delta / max, v: max };
}
export function hsvToHex({ h, s, v }: HSV): string {
  h = ((h % 360) + 360) % 360; s = clamp(s, 0, 1); v = clamp(v, 0, 1);
  const chroma = v * s, x = chroma * (1 - Math.abs(h / 60 % 2 - 1)), base = v - chroma;
  const rgb = h < 60 ? [chroma, x, 0] : h < 120 ? [x, chroma, 0] : h < 180 ? [0, chroma, x]
    : h < 240 ? [0, x, chroma] : h < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return `#${rgb.map(value => Math.round((value + base) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** Inline HSV controls: no large swatch and no second, system-owned color popup. */
export function createColorSurface(options: {
  initialHex: string; label: string; hueLabel: string;
  valueText: (saturation: number, brightness: number) => string;
  onChange: (hex: string) => void;
}) {
  let hsv = hexToHsv(options.initialHex), lastHex = options.initialHex.toLowerCase();
  let pointer: number | null = null;
  const element = document.createElement('div'); element.className = 'color-surface';
  const plane = document.createElement('div'); plane.className = 'color-sv'; plane.tabIndex = 0;
  plane.setAttribute('role', 'slider'); plane.setAttribute('aria-label', options.label);
  plane.setAttribute('aria-valuemin', '0'); plane.setAttribute('aria-valuemax', '100');
  const cursor = document.createElement('span'); cursor.className = 'color-cursor'; cursor.setAttribute('aria-hidden', 'true'); plane.append(cursor);
  const hue = document.createElement('input'); hue.className = 'color-hue'; hue.type = 'range'; hue.min = '0'; hue.max = '360'; hue.step = '1';
  hue.setAttribute('aria-label', options.hueLabel);
  const paint = (): void => {
    plane.style.backgroundColor = `hsl(${hsv.h} 100% 50%)`;
    cursor.style.left = `${hsv.s * 100}%`; cursor.style.top = `${(1 - hsv.v) * 100}%`;
    const s = Math.round(hsv.s * 100), v = Math.round(hsv.v * 100);
    plane.setAttribute('aria-valuenow', String(s)); plane.setAttribute('aria-valuetext', options.valueText(s, v));
    hue.value = String(hsv.h); hue.style.setProperty('--color-hue', String(hsv.h));
  };
  const emit = (): void => { lastHex = hsvToHex(hsv); paint(); options.onChange(lastHex); };
  const move = (event: PointerEvent): void => {
    const rect = plane.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    hsv.s = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    hsv.v = 1 - clamp((event.clientY - rect.top) / rect.height, 0, 1); emit();
  };
  plane.addEventListener('pointerdown', event => {
    if (event.button !== 0 || pointer !== null) return;
    pointer = event.pointerId; plane.setPointerCapture(pointer); plane.focus({ preventScroll: true });
    event.preventDefault(); move(event);
  });
  plane.addEventListener('pointermove', event => { if (event.pointerId === pointer) move(event); });
  const finish = (event: PointerEvent): void => {
    if (event.pointerId !== pointer) return;
    pointer = null;
    if (plane.hasPointerCapture(event.pointerId)) plane.releasePointerCapture(event.pointerId);
  };
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) plane.addEventListener(name, finish);
  plane.addEventListener('keydown', event => {
    const step = event.shiftKey ? .1 : .01;
    if (event.key === 'ArrowLeft') hsv.s = clamp(hsv.s - step, 0, 1);
    else if (event.key === 'ArrowRight') hsv.s = clamp(hsv.s + step, 0, 1);
    else if (event.key === 'ArrowUp') hsv.v = clamp(hsv.v + step, 0, 1);
    else if (event.key === 'ArrowDown') hsv.v = clamp(hsv.v - step, 0, 1);
    else return;
    event.preventDefault(); emit();
  });
  hue.addEventListener('input', () => { hsv.h = Number(hue.value); emit(); });
  element.append(plane, hue); paint();
  return { element,
    setHex(hex: string) {
      hex = hex.toLowerCase(); if (hex === lastHex) return;
      const next = hexToHsv(hex);
      // Gray and black do not define a hue; retain the user's position on the hue strip.
      if (next.s === 0 || next.v === 0) next.h = hsv.h;
      hsv = next; lastHex = hex; paint();
    },
    focus() { plane.focus({ preventScroll: true }); },
  };
}

/** FLIP the existing card nodes, never their images: no reloads on reflow. */
type CardBox = { x: number; y: number; width: number; height: number };
export function captureCards(grid: HTMLElement): Map<HTMLElement, CardBox> {
  const boxes = new Map<HTMLElement, CardBox>();
  grid.querySelectorAll<HTMLElement>('.card').forEach((card) => {
    const rect = card.getBoundingClientRect();
    if (rect.width && rect.height) boxes.set(card, {
      x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height,
    });
  });
  // Capture the current painted positions before cancelling interrupted motion.
  boxes.forEach((_, card) => card.getAnimations().forEach((animation) => animation.cancel()));
  return boxes;
}

export function animateCards(before: Map<HTMLElement, CardBox>): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  before.forEach((old, card) => {
    if (!card.isConnected) return;
    const next = card.getBoundingClientRect();
    if (!next.width || !next.height) return;
    const dx = old.x - next.left - scrollX;
    const dy = old.y - next.top - scrollY;
    if (Math.abs(dx) < .5 && Math.abs(dy) < .5 && Math.abs(old.width - next.width) < .5 && Math.abs(old.height - next.height) < .5) return;
    card.animate([
      { transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${old.width / next.width}, ${old.height / next.height})` },
      { transformOrigin: '0 0', transform: 'none' },
    ], { duration: 240, easing: 'cubic-bezier(.22, 1, .36, 1)' });
  });
}

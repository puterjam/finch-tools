export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 420;
const CONTENT_MIN = 280;
const STORAGE_KEY = 'knowledge.sidebar.width';

/** Reserve room for document content even before the stacked-layout breakpoint. */
export function sidebarBounds(available: number, gap: number): { min: number; max: number } {
  return { min: SIDEBAR_MIN, max: Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.floor(available - gap - CONTENT_MIN))) };
}
export function boundSidebar(value: number, available: number, gap: number): number {
  const { min, max } = sidebarBounds(available, gap);
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : 300));
}

/** Resize only grid tracks: document nodes, classifications and scroll state stay untouched. */
export function wireWorkspaceResize(workspace: HTMLElement, separator: HTMLElement): void {
  let preferred: number | null = null;
  let actual = 300;
  let pointer: number | null = null;
  let startX = 0, startWidth = 300;
  const stacked = () => window.matchMedia('(max-width: 600px)').matches;
  const defaultWidth = () => window.matchMedia('(max-width: 820px)').matches ? 255 : 300;
  try {
    const saved = Number.parseFloat(localStorage.getItem(STORAGE_KEY) ?? '');
    if (Number.isFinite(saved)) preferred = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, saved));
  } catch { /* Browser storage is optional. */ }
  const persist = (): void => {
    try {
      if (preferred === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, String(preferred));
    } catch { /* Resizing still works when storage is unavailable. */ }
  };
  const clearPointer = (): void => {
    const previous = pointer; pointer = null;
    document.documentElement.classList.remove('workspace-resizing');
    // Releasing over the handle leaves :hover (and sometimes :focus-visible) set. Keep the guide
    // quiet until the next deliberate hover, focus or keyboard interaction without stealing focus.
    if (previous !== null) separator.classList.add('is-resting');
    if (previous !== null && separator.hasPointerCapture(previous)) separator.releasePointerCapture(previous);
  };
  const apply = (): void => {
    const disabled = stacked();
    separator.setAttribute('aria-disabled', String(disabled)); separator.tabIndex = disabled ? -1 : 0;
    if (disabled) { clearPointer(); return; }
    const available = workspace.getBoundingClientRect().width;
    if (!available) return;
    const gap = Number.parseFloat(getComputedStyle(workspace).columnGap) || 0;
    actual = boundSidebar(preferred ?? defaultWidth(), available, gap);
    workspace.style.setProperty('--sidebar-width', `${actual}px`);
    const bounds = sidebarBounds(available, gap);
    separator.setAttribute('aria-valuemin', String(bounds.min));
    separator.setAttribute('aria-valuemax', String(bounds.max));
    separator.setAttribute('aria-valuenow', String(Math.round(actual)));
  };
  const setWidth = (value: number): void => {
    const available = workspace.getBoundingClientRect().width;
    const gap = Number.parseFloat(getComputedStyle(workspace).columnGap) || 0;
    preferred = boundSidebar(value, available, gap); apply();
  };
  const reveal = (): void => { separator.classList.remove('is-resting'); };
  separator.addEventListener('pointerenter', reveal);
  separator.addEventListener('focus', () => { if (pointer === null) reveal(); });
  separator.addEventListener('pointerdown', event => {
    if (event.button !== 0 || pointer !== null || stacked()) return;
    reveal(); apply(); pointer = event.pointerId; startX = event.clientX; startWidth = actual;
    separator.setPointerCapture(pointer); separator.focus({ preventScroll: true });
    document.documentElement.classList.add('workspace-resizing'); event.preventDefault();
  });
  separator.addEventListener('pointermove', event => {
    if (event.pointerId === pointer) setWidth(startWidth + event.clientX - startX);
  });
  const finish = (event: PointerEvent): void => {
    if (event.pointerId !== pointer) return;
    clearPointer(); persist();
  };
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) separator.addEventListener(name, finish);
  const reset = (): void => { preferred = null; persist(); apply(); };
  separator.addEventListener('dblclick', reset);
  separator.addEventListener('keydown', event => {
    if (stacked()) return;
    reveal();
    if (event.key === 'Enter') { event.preventDefault(); reset(); return; }
    const step = event.shiftKey ? 30 : 10;
    const next = event.key === 'ArrowLeft' ? actual - step : event.key === 'ArrowRight' ? actual + step
      : event.key === 'Home' ? SIDEBAR_MIN : event.key === 'End' ? SIDEBAR_MAX : null;
    if (next === null) return;
    event.preventDefault(); setWidth(next); persist();
  });
  const observer = new ResizeObserver(apply); observer.observe(workspace);
  window.addEventListener('resize', apply);
  window.addEventListener('blur', () => { if (pointer !== null) { clearPointer(); persist(); } });
  apply();
}

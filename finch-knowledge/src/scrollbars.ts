export const SCROLL_AREAS = '.directory-tree, .tag-list, .documents-scroll, .matches, .row-submenu, .sort-menu, .tag-color-picker, .library-list';

/** Capture scrolls from existing and dynamically rendered panes without intercepting input. */
export function wireScrollbars(doc: Document = document, idleMs = 900): () => void {
  const view = doc.defaultView;
  if (!view) return () => {};
  const timers = new Map<HTMLElement, number>();
  const onScroll = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof view.HTMLElement) || !target.matches(SCROLL_AREAS)) return;
    const previous = timers.get(target);
    if (previous !== undefined) view.clearTimeout(previous);
    target.classList.add('is-scrolling');
    timers.set(target, view.setTimeout(() => {
      target.classList.remove('is-scrolling'); timers.delete(target);
    }, idleMs));
  };
  doc.addEventListener('scroll', onScroll, { capture: true, passive: true });
  return () => {
    doc.removeEventListener('scroll', onScroll, true);
    for (const [element, timer] of timers) { view.clearTimeout(timer); element.classList.remove('is-scrolling'); }
    timers.clear();
  };
}

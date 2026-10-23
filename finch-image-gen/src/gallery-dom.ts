/** Lucide paths (ISC); inline SVGs inherit the Finch theme inside the webview. */
const paths: Record<string, string> = {
  'book-image': '<path d="m20 13.7-2.1-2.1a2 2 0 0 0-2.8 0L9.7 17"/><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/><circle cx="10" cy="8" r="2"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  'pencil-line': '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  'message-square-plus': '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v6m-3-3h6"/>',
  'trash-2': '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/>',
  'undo-2': '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15.5-6.5L3 13"/>',
  eraser: '<path d="m7 21-4.3-4.3a2 2 0 0 1 0-2.8L13.9 2.7a2 2 0 0 1 2.8 0l4.6 4.6a2 2 0 0 1 0 2.8L10.4 21zM22 21H7M5 12l7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="m18 6-12 12M6 6l12 12"/>',
  'corner-down-left': '<path d="M9 10 4 15l5 5"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>',
  send: '<path d="M14.54 20.6a.55.55 0 0 0 1.03-.05l6.4-17.12a.55.55 0 0 0-.7-.7L4.15 9.13a.55.55 0 0 0-.05 1.03l6.62 3.2a.55.55 0 0 1 .27.27z"/><path d="M20.5 3.5 10.7 13.3"/>',
  'image-upscale': '<path d="M16 3h5v5"/><path d="M17 2l-5 5"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7"/>',
  square: '<rect width="18" height="18" x="3" y="3" rx="2"/>',
  'rectangle-vertical': '<rect width="12" height="20" x="6" y="2" rx="2"/>',
  'rectangle-horizontal': '<rect width="20" height="12" x="2" y="6" rx="2"/>',
  'sliders-horizontal': '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
};
export function icon(name: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.image}</svg>`;
}
export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing UI element: ${id}`);
  return node as T;
}
export function paintIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach((node) => { node.innerHTML = icon(node.dataset.icon || 'image'); });
}
export function labelButton(node: HTMLElement, label: string): void {
  node.title = label;
  node.setAttribute('aria-label', label);
}
export function textNode(tag: string, text: string, className = ''): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
export function notice(text: string): void {
  const node = el('notice');
  node.textContent = text; node.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { node.hidden = true; }, 2600);
}

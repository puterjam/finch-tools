/**
 * Runtime SVG icon pack (`agents-icons`, declared in `contributes.iconPacks`).
 *
 * A hub with three orbiting workers — the same mark is shipped as
 * `icons/agents.svg` for the manifest icon declaration.
 */
export interface IconDefinition {
  svg: string;
}

export const AGENTS_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="12" cy="12" r="2.6"/>' +
  '<circle cx="12" cy="3.6" r="1.8"/>' +
  '<circle cx="4.7" cy="16.6" r="1.8"/>' +
  '<circle cx="19.3" cy="16.6" r="1.8"/>' +
  '<path d="M12 5.4v4"/>' +
  '<path d="M10.2 13.7 6.3 15.6"/>' +
  '<path d="M13.8 13.7l3.9 1.9"/>' +
  '</svg>';

export const CLEANUP_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M3 6h18"/>' +
  '<path d="M8 6V4h8v2"/>' +
  '<path d="M19 6l-1 14H6L5 6"/>' +
  '<path d="M10 11v5M14 11v5"/>' +
  '</svg>';

export const ICONS: Record<string, IconDefinition> = {
  agents: { svg: AGENTS_ICON_SVG },
  cleanup: { svg: CLEANUP_ICON_SVG },
};

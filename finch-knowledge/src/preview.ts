/**
 * Opening a listed document, by whatever tool actually suits its type.
 *
 * Only two kinds of file belong in Finch's own preview:
 *
 * - Markdown and plain text, which `window.finch.appView.openPreview()` pushes onto this App
 *   View's navigation stack as a rendered document.
 * - Images, which the host answers with its dedicated image viewer: a "look once and close"
 *   popup that takes no navigation level at all.
 *
 * Everything else — PDF, Word — goes back out to the file manager, exactly as it did before the
 * preview existed, rather than being handed to a viewer that would refuse it.
 *
 * The page-side call is the only workable one here: the backend equivalent
 * (`ctx.ui.openFilePreview`) targets the right-hand Panel surface, which an App View does not
 * render, so a row click routed through the backend looks like a dead click.
 */

/**
 * Extensions Finch renders itself. Kept in step with the library's accepted types: the ones that
 * are neither here nor in {@link IMAGE_EXTENSIONS} open externally.
 */
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
/** Extensions the host answers with its dedicated image viewer. */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff']);

/** Where a listed document opens: Finch's document preview, its image viewer, or outside Finch. */
export type PreviewRoute = 'text' | 'image' | 'external';

/** Routes by extension alone — the library stores no MIME type, and these names are what it has. */
export function previewRoute(name: string): PreviewRoute {
  const match = /(\.[^./\\]+)$/.exec(name.trim().toLowerCase());
  const extension = match?.[1] ?? '';
  if (TEXT_EXTENSIONS.has(extension)) return 'text';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  return 'external';
}

/** The slice of the page bridge this needs, so the decision is testable without a webview. */
export interface PreviewHost {
  appView?: { openPreview?(path: string): Promise<unknown> } | undefined;
}

/**
 * Asks the host for its built-in preview — the document view for text, the image viewer for an
 * image; the host picks by the path itself.
 *
 * @returns `true` when the preview was requested, `false` when the caller must open the file
 * externally instead (missing API, or a call that threw synchronously). A rejection is reported
 * through `onUnavailable`, since by then the caller's own click handler has already returned.
 */
export function openInPreview(host: PreviewHost | undefined, path: string, onUnavailable: () => void): boolean {
  const appView = host?.appView;
  const openPreview = appView?.openPreview;
  if (typeof openPreview !== 'function') return false;
  try {
    void Promise.resolve(openPreview.call(appView, path)).catch(onUnavailable);
  } catch {
    // A host that throws instead of rejecting is still a host that cannot preview this file.
    return false;
  }
  return true;
}

/**
 * The single entry point the App View uses, so the row and its own first button can never
 * disagree about what a click does.
 *
 * @returns `true` when Finch took the file, `false` when the caller must open it externally.
 */
export function openListedDocument(
  host: PreviewHost | undefined,
  name: string,
  path: string,
  onUnavailable: () => void,
): boolean {
  if (previewRoute(name) === 'external') return false;
  return openInPreview(host, path, onUnavailable);
}

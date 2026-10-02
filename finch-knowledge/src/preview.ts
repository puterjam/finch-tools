/**
 * Opening a listed document, in the order the user expects.
 *
 * Finch's built-in file preview is a page-side capability: `window.finch.appView.openPreview()`
 * pushes the preview onto this App View's own navigation stack, and an image opens as a
 * "look once and close" popup instead of taking a level. The backend equivalent
 * (`ctx.ui.openFilePreview`) targets the right-hand Panel surface, which an App View does not
 * render, so running a row click through the backend looks like a dead click.
 *
 * Two cases fall back to revealing the file in the file manager: a host without the API (older
 * Finch), and a file the preview refuses — an office document, say. Either way the click must not
 * end in nothing happening.
 */

/** The slice of the page bridge this needs, so the decision is testable without a webview. */
export interface PreviewHost {
  appView?: { openPreview?(path: string): Promise<unknown> } | undefined;
}

/**
 * Asks the host for its built-in preview.
 *
 * @returns `true` when the preview was requested, `false` when the caller must reveal the file
 * instead (missing API, or a call that threw synchronously). A rejection is reported through
 * `onUnavailable`, since by then the caller's own click handler has already returned.
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

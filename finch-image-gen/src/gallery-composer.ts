import type * as finch from 'finch';

type ImageContext = Extract<finch.ComposerContextDraft, { type: 'image-region' }>;

/** Optional host enhancement, not a dependency on an unreleased SDK. */
type EditableTextInsert = (text: string, options?: { mode?: 'replace' | 'append' }) => Promise<void>;

/**
 * What one click hands to the Composer.
 *
 * The host turns `[quote]…[/quote]` into a reference, and `src` names the local
 * image that reference points at — so a single quote carries both the picture to
 * work from and the wording the user should not have to read through. The user's
 * own instructions stay editable prose above it. Images that only exist as bytes
 * (the marked preview) still ride along as an attachment.
 */
export interface ComposerInsertionPlan {
  /** The user's own wording; left editable in the input box. */
  text?: string;
  /** Generated detail (numbered comments, the original prompt); quoted. */
  quoted?: string;
  /** Local file the edit applies to; the quote's `src`. */
  imagePath?: string;
  /** Bytes of an image with no file of its own (the marked preview). */
  attachment?: ImageContext;
  /** Bytes to attach on top of the quotes (true only for `attachment`). */
  attachBytes?: boolean;
  /** Hosts without text insertion get the whole request as one image annotation. */
  legacyText: string;
}

/** A quoted reference; `src` is a bare path, so quotes and newlines are stripped. */
function quote(plan: ComposerInsertionPlan): string {
  const src = plan.imagePath ? ` src="${plan.imagePath.replace(/["\r\n]/g, '')}"` : '';
  const body = plan.quoted?.trim();
  return `[quote${src}]${body ? `\n${body}\n` : ''}[/quote]`;
}

function referenceText(plan: ComposerInsertionPlan): string {
  return [plan.text?.trim(), plan.imagePath || plan.quoted ? quote(plan) : '']
    .filter((block): block is string => Boolean(block && block.trim()))
    .join('\n');
}

/**
 * One click, one acknowledged operation. Text goes first: it is the step that
 * fails when no input box is on screen, and failing before an image is added
 * leaves nothing half-done behind.
 */
export async function insertComposerRequest(
  api: finch.WebviewBridgeApi,
  plan: ComposerInsertionPlan,
): Promise<void> {
  const composer = api.composer as typeof api.composer & { fillText?: EditableTextInsert };
  if ('fillText' in composer && typeof composer.fillText === 'function') {
    await composer.fillText.call(composer, referenceText(plan) || plan.legacyText, { mode: 'append' });
    if (plan.attachBytes && plan.attachment) {
      const result = await api.composer.addContexts([plan.attachment]);
      if (result.added < 1) throw new Error('The Composer did not accept the marked preview');
    }
    return;
  }
  // Old hosts have no text channel, so the proven annotation route carries both
  // the image and the request; the host announces the added context itself.
  const image = plan.attachment;
  if (!image) throw new Error('This Finch version cannot insert from the gallery');
  const result = await api.composer.addContexts([{
    type: 'annotation', label: image.name, promptText: plan.legacyText,
    image: { name: image.name, mimeType: image.mimeType, content: image.content },
  }]);
  if (result.added < 1 && !(result as { annotations?: number }).annotations) {
    throw new Error('The Composer did not accept the annotation');
  }
}

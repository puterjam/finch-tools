import type * as finch from 'finch';

type ImageContext = Extract<finch.ComposerContextDraft, { type: 'image-region' }>;

/** Optional host enhancement, not a dependency on an unreleased SDK. */
type EditableContextInsert = (
  contexts: readonly finch.ComposerContextDraft[],
  options: { text: string; mode: 'append' },
) => Promise<{ added: number }>;

/** One click, one acknowledged operation: never fill text before a file fails. */
export async function insertImagePrompt(
  api: finch.WebviewBridgeApi,
  image: ImageContext,
  text: string,
): Promise<'editable' | 'annotation'> {
  if ('fillText' in api.composer && typeof api.composer.fillText === 'function') {
    // Both capabilities ship together in the host; old hosts keep the fully
    // typed annotation path below. No SDK update or version-string guess.
    const insert = api.composer.addContexts as EditableContextInsert;
    const result = await insert.call(api.composer, [image], { text, mode: 'append' });
    if (result.added !== 1) throw new Error('The Composer did not accept the image');
    return 'editable';
  }
  // Old hosts' plain attachments only update a draft projection, not the live
  // Composer. Use the proven annotation route and explicitly label the downgrade
  // in the calling UI; do not claim this put editable text in the input box.
  const result = await api.composer.addContexts([{
    type: 'annotation', label: image.name, promptText: text,
    image: { name: image.name, mimeType: image.mimeType, content: image.content },
  }]);
  if (result.added < 1 && !(result as { annotations?: number }).annotations) {
    throw new Error('The Composer did not accept the annotation');
  }
  return 'annotation';
}

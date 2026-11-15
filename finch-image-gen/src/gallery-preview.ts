import type * as finch from 'finch';
import type { GalleryItem } from './gallery-model';

/**
 * Page-driven multi-image preview (`window.finch.appView.openImagePreview`),
 * added to the host after the SDK this package builds against. Declared locally
 * so the page can use it the moment a Finch build carries it, and keep working
 * on every older one — the published typings must not be edited here.
 */
export interface ImagePreviewItem {
  /** Local absolute path, or an https / data / finch-file URL. */
  src: string;
  name?: string;
  mimeType?: string;
}

export interface ImagePreviewRequest {
  /** How many pictures the whole set holds — the preview shows "n / count". */
  count: number;
  /** Which one to open on, counted inside this set, not globally. */
  current: number;
  items?: (ImagePreviewItem | null)[];
  onRequest?: (index: number) => Promise<ImagePreviewItem | null>;
  title?: string;
}

export type OpenImagePreview = (request: ImagePreviewRequest) => Promise<unknown>;

type PreviewCapableAppView = NonNullable<finch.WebviewBridgeApi['appView']> & {
  openImagePreview?: (request: ImagePreviewRequest) => Promise<unknown>;
};

/**
 * The multi-image entry when this Finch has it, otherwise undefined. Checked on
 * every call rather than once at load: a mini tool is updated independently of
 * the app, so a page must never assume the host is as new as it will be.
 */
export function multiPreviewApi(api?: finch.WebviewBridgeApi): OpenImagePreview | undefined {
  const host = api?.appView as PreviewCapableAppView | undefined;
  const open = host?.openImagePreview;
  // Bind: it is a host method, and an unbound call loses its receiver.
  return typeof open === 'function' ? open.bind(host) : undefined;
}

/** The caption Finch shows beside the picture: the prompt, shortened. */
const NAME_LIMIT = 40;
export function previewName(record: GalleryItem): string {
  const prompt = (record.prompt || '').replace(/\s+/g, ' ').trim();
  if (prompt) return prompt.length > NAME_LIMIT ? `${prompt.slice(0, NAME_LIMIT)}…` : prompt;
  return record.filePath.split(/[\\/]/).pop() || record.name;
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
};

/** Omitted when unrecognised, so the host can still read it off the file. */
function mimeTypeOf(record: GalleryItem): string | undefined {
  const fromPath = /\.([a-z0-9]+)$/i.exec(record.filePath)?.[1]?.toLowerCase();
  const fromFormat = (record.format || '').toLowerCase().replace(/^\./, '');
  return MIME_BY_EXT[fromPath ?? ''] ?? MIME_BY_EXT[fromFormat];
}

export function previewItem(record: GalleryItem): ImagePreviewItem {
  const mime = mimeTypeOf(record);
  const item: ImagePreviewItem = { src: record.filePath, name: previewName(record) };
  if (mime) item.mimeType = mime;
  return item;
}

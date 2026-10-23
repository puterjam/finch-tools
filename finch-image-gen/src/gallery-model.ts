/** Shared, serializable annotation geometry. All positions are normalized 0..1. */
export interface Point { x: number; y: number }
export interface Stroke { id: string; points: Point[]; width: number }
export interface ImageComment extends Point { id: string; text: string }
export interface GalleryAnnotations { version: 1; strokes: Stroke[]; comments: ImageComment[] }
export interface GalleryItem {
  id: string; filePath: string; name: string; prompt: string; model: string;
  size: string; quality: string; format: string; width: number; height: number;
  createdAt: number; sessionId: string; note: string; annotations?: GalleryAnnotations;
}

export const emptyAnnotations = (): GalleryAnnotations => ({ version: 1, strokes: [], comments: [] });
export const clamp = (n: number): number => Math.max(0, Math.min(1, n));

/** No implicit growth to fill empty columns; 220px is an absolute cap. */
export function masonryMetrics(available: number): { columns: number; width: number } {
  const columns = available < 280 ? 1 : Math.max(2, Math.min(5, Math.floor((available + 12) / 160)));
  return { columns, width: Math.max(1, Math.min(220, (available - (columns - 1) * 12) / columns)) };
}

/** Reject malformed data rather than persisting an unbounded webview payload. */
export function parseAnnotations(raw: unknown): GalleryAnnotations | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  if (input.version !== 1 || !Array.isArray(input.strokes) || !Array.isArray(input.comments)) return null;
  if (input.strokes.length > 100 || input.comments.length > 50) return null;
  const unit = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
  const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 100;
  let pointCount = 0;
  const strokes: Stroke[] = [];
  const comments: ImageComment[] = [];
  for (const value of input.strokes) {
    if (!value || typeof value !== 'object') return null;
    const stroke = value as Record<string, unknown>;
    if (!id(stroke.id) || !unit(stroke.width) || stroke.width === 0 || stroke.width > .1 || !Array.isArray(stroke.points) || !stroke.points.length) return null;
    pointCount += stroke.points.length;
    if (pointCount > 20000) return null;
    const points: Point[] = [];
    for (const point of stroke.points) {
      if (!point || !unit(point.x) || !unit(point.y)) return null;
      points.push({ x: point.x, y: point.y });
    }
    strokes.push({ id: stroke.id, width: stroke.width, points });
  }
  for (const value of input.comments) {
    if (!value || typeof value !== 'object') return null;
    const comment = value as Record<string, unknown>;
    if (!id(comment.id) || !unit(comment.x) || !unit(comment.y) || typeof comment.text !== 'string' || comment.text.length > 4000) return null;
    comments.push({ id: comment.id, x: comment.x, y: comment.y, text: comment.text });
  }
  return { version: 1, strokes, comments };
}

export function imageDimensions(item: GalleryItem): { width: number; height: number } {
  if (item.width > 0 && item.height > 0) return { width: item.width, height: item.height };
  const match = /^(\d+)x(\d+)$/.exec(item.size || '');
  return match ? { width: +match[1], height: +match[2] } : { width: 1024, height: 1024 };
}

/**
 * Streaming download with real byte-level progress.
 *
 * The engine installers used to buffer the whole archive with `arrayBuffer()`,
 * which meant the UI could only show a made-up "tens of MB" line. Reading the
 * body as a stream lets progress report actual bytes against the actual total.
 */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Collapses repeated reports. The streaming reader emits on every whole percent
 * of the transfer, but callers usually map that onto a smaller range, which would
 * otherwise send the same displayed percentage several times.
 */
export function oncePerPercent(
  report: (message: string, percent?: number) => void,
): (message: string, percent?: number) => void {
  let last: number | undefined;
  return (message, percent) => {
    if (percent !== undefined && percent === last) return;
    last = percent;
    report(message, percent);
  };
}

export interface DownloadOptions {
  /** Fallback total when the response does not declare one (e.g. a release asset size). */
  totalBytes?: number;
  /** Hard cap; the download is aborted as soon as it is exceeded. */
  maxBytes: number;
  /** Called with bytes received and the best-known total (0 when unknown). */
  onProgress?: (received: number, total: number) => void;
  headers?: Record<string, string>;
}

/** Downloads a URL into a Buffer, reporting progress as bytes arrive. */
export async function downloadWithProgress(url: string, options: DownloadOptions): Promise<Buffer> {
  const response = await fetch(url, { headers: options.headers });
  if (!response.ok) throw new Error(`download failed (${response.status})`);

  const declared = Number(response.headers.get('content-length') ?? '0');
  const total = declared > 0 ? declared : (options.totalBytes ?? 0);
  if (total > options.maxBytes) throw new Error('download exceeds the size limit');

  const body = response.body;
  if (!body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > options.maxBytes) throw new Error('download exceeds the size limit');
    options.onProgress?.(buffer.length, total || buffer.length);
    return buffer;
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  let lastPercent = -1;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      received += value.length;
      if (received > options.maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('download exceeds the size limit');
      }
      chunks.push(Buffer.from(value));
      // Report on each whole percent, plus the first and last chunk, so a fast
      // download still shows movement without flooding the UI.
      const percent = total > 0 ? Math.floor((received / total) * 100) : -1;
      if (lastPercent < 0 || percent !== lastPercent || received === total) {
        lastPercent = percent;
        options.onProgress?.(received, total);
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  options.onProgress?.(received, total || received);
  return Buffer.concat(chunks);
}

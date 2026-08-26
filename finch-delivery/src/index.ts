import type * as finch from 'finch';
import { randomUUID } from 'node:crypto';
import { readFile, stat, unlink } from 'node:fs/promises';

// ── Types ───────────────────────────────────────────────────────────────────

interface DeliveryRecord {
  id: string;
  sessionId: string;
  sessionTitle?: string;
  filePath: string;
  fileName: string;
  fileType: string;
  title: string;
  description: string;
  textPreview?: string;
  createdAt: number;
}

type Deliveries = DeliveryRecord[];

const STORAGE_KEY = 'deliveries';
const MAX_PREVIEW = 500;

// ── Helpers ─────────────────────────────────────────────────────────────────

function text(message: string, isError = false): finch.ToolResult {
  return { content: [{ type: 'text', text: message }], isError };
}

/** Extract a short file name from a full path. */
function baseName(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || filePath;
}

/** Map a file extension to a delivery file type. */
function detectFileType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'doc' || ext === 'docx') return 'word';
  if (ext === 'ppt' || ext === 'pptx') return 'ppt';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'xls' || ext === 'xlsx' || ext === 'csv') return 'excel';
  if (ext === 'html' || ext === 'htm') return 'web';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return 'image';
  return 'other';
}

/** MIME type for an image file path, used to build a `data:` URL for the card thumbnail. */
function imageMime(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'bmp') return 'image/bmp';
  if (ext === 'svg') return 'image/svg+xml';
  return 'image/png';
}

/**
 * Cap for a base64 thumbnail embedded in a card. Full-resolution source
 * images (9:16 posters, PNGs) can be megabytes; embedding the whole thing
 * would bloat the stored record and the webview postMessage. We embed a
 * downscaled version where possible, but the backend has no image
 * processing deps — so instead we just refuse to embed images larger than a
 * practical ceiling and let the card fall back to its text preview. This
 * keeps the feature safe without pulling in a canvas/sharp dependency.
 */
const MAX_IMAGE_EMBED_BYTES = 1.5 * 1024 * 1024; // ~1.5 MB

/** Format a timestamp for display. */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const mins = String(d.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hours}:${mins}`;
}

/** Human-readable label for each file type, per fallback (non-localized) English. */
const TYPE_LABEL_EN: Record<string, string> = {
  md: 'MD',
  word: 'Word',
  ppt: 'PPT',
  pdf: 'PDF',
  excel: 'Excel',
  web: 'Web',
  image: 'Image',
  other: 'File',
};

/**
 * Build a short summary for the Delivery sidebar row, e.g. "3 MD" when every
 * record shares one file type, or a generic "5 files" when mixed. Space in
 * the sidebar row is very limited, so this never lists every type by name.
 */
function buildDeliveryDetail(ctx: finch.MiniToolContext, records: Deliveries): string {
  if (records.length === 0) return '';
  const counts = new Map<string, number>();
  for (const r of records) counts.set(r.fileType, (counts.get(r.fileType) ?? 0) + 1);

  if (counts.size === 1) {
    const [fileType, count] = [...counts.entries()][0];
    const typeKey = `delivery.type.${fileType}`;
    const typeLabel = ctx.i18n.has(typeKey) ? ctx.i18n.t(typeKey) : TYPE_LABEL_EN[fileType] ?? TYPE_LABEL_EN.other;
    return ctx.i18n.t('delivery.detailSingle', { count: String(count), type: typeLabel });
  }
  return ctx.i18n.t('delivery.detailMixed', { count: String(records.length) });
}

// ── Storage helpers ─────────────────────────────────────────────────────────

async function loadDeliveries(ctx: finch.MiniToolContext): Promise<Deliveries> {
  return (await ctx.storage.get<Deliveries>(STORAGE_KEY)) ?? [];
}

async function saveDeliveries(ctx: finch.MiniToolContext, data: Deliveries): Promise<void> {
  await ctx.storage.set(STORAGE_KEY, data);
}

// The user's Finch assistant name ("帕亚", or the default "Finch"). Resolved
// once and reused for every env payload; the webview needs it to render the
// empty-state copy ("Ask {finch} to create a document…") without a round trip.
let cachedAssistantName: string | null = null;
async function getAssistantName(ctx: finch.MiniToolContext): Promise<string> {
  if (cachedAssistantName) return cachedAssistantName;
  try {
    cachedAssistantName = (await ctx.app.getInfo()).assistantName || 'Finch';
  } catch (err) {
    ctx.logger.warn('Failed to resolve assistant name: ' + String(err));
    cachedAssistantName = 'Finch';
  }
  return cachedAssistantName;
}

/** Update the Delivery sidebar row for the current session. */
async function refreshDeliveryRow(
  ctx: finch.MiniToolContext,
  sessionId: string | undefined,
): Promise<void> {
  if (!sessionId) return;
  const all = await loadDeliveries(ctx);
  const sessionRecords = all.filter((r) => r.sessionId === sessionId);
  if (sessionRecords.length === 0) {
    await ctx.ui.delivery.remove();
    return;
  }
  const latest = sessionRecords[sessionRecords.length - 1];
  await ctx.ui.delivery.set({
    // Keep the title short and stable — the record's own title can be long
    // and would crowd this narrow row; the type/count breakdown goes in detail.
    title: ctx.i18n.t('delivery.title'),
    detail: buildDeliveryDetail(ctx, sessionRecords),
    // Full pack-qualified form — the delivery row's auto pack resolution
    // for the shorthand `ext:library` can fall back to the default puzzle
    // icon, so reference the registered pack explicitly.
    icon: 'ext:delivery-icons/library',
    payload: { sessionId, latestId: latest.id },
  });
}

// ── Open panel registry ────────────────────────────────────────────────────

/**
 * Every live panel instance — right-side Panel Apps across sessions plus the
 * appView sidebar page. `ctx.storage` has no change event, so mutations that
 * happen outside a panel's own message flow (the record_artifact tool running
 * in any session, or remove/clearSession issued from a *different* panel) would
 * otherwise leave already-open views stale until reopen. Every mutation fans
 * out from {@link broadcastDeliveries} to all panels in this set; panels leave
 * it on dispose, so it only ever holds instances Finch considers alive.
 */
const livePanels = new Set<finch.AppPanel>();

/**
 * Guards against double-binding listeners: re-opening a still-alive
 * single-instance panel re-emits it from `onDidOpenPanel` (with updated
 * payload), and we must not register a second `onDidReceiveMessage` for it.
 */
const boundPanels = new WeakSet<finch.AppPanel>();

/** Env payload shared by the initial push, `requestDeliveries` and broadcasts. */
async function buildPanelEnv(
  ctx: finch.MiniToolContext,
  panel: finch.AppPanel,
): Promise<Record<string, unknown>> {
  return {
    sessionId: panel.sessionId ?? '',
    view: panel.view ?? '',
    spaceId: panel.spaceId ?? '',
    spaceName: panel.spaceName ?? '',
    // `finch:env.locale` is only delivered for the appView scope today, so
    // thread the resolved locale through our own env payload instead — it
    // works uniformly for both the right-side Panel App and the appView
    // sidebar entry.
    locale: ctx.i18n.locale,
    assistantName: await getAssistantName(ctx),
  };
}

/** Push the latest deliveries to every live panel so open views stay current. */
async function broadcastDeliveries(ctx: finch.MiniToolContext): Promise<void> {
  if (livePanels.size === 0) return;
  const all = await loadDeliveries(ctx);
  for (const panel of livePanels) {
    try {
      await panel.postMessage({ type: 'deliveries', data: all, env: await buildPanelEnv(ctx, panel) });
    } catch (err) {
      // A dying panel must never break the mutation that triggered the push.
      ctx.logger.warn(`Failed to push deliveries to panel ${panel.id}: ${String(err)}`);
    }
  }
}

// ── Panel message handling ──────────────────────────────────────────────────

interface PanelMessage {
  type: string;
  id?: string;
  sessionId?: string;
  filePath?: string;
  /** Panel-only: when true, also delete the underlying file from disk (best-effort). */
  deleteFile?: boolean;
}

/**
 * Opens Finch's built-in file preview for a local absolute path.
 * `openFilePreview` is not yet part of the published `@finchtoys/minitool-api`
 * type definitions, so it is accessed via a loose cast.
 */
async function openFilePreview(ctx: finch.MiniToolContext, filePath: string): Promise<void> {
  const ui = ctx.ui as unknown as { openFilePreview?: (path: string) => Promise<void> };
  if (typeof ui.openFilePreview !== 'function') {
    ctx.logger.warn('ctx.ui.openFilePreview is not available on this Finch version');
    return;
  }
  await ui.openFilePreview(filePath);
}

async function handlePanelMessage(
  ctx: finch.MiniToolContext,
  panel: finch.AppPanel,
  message: unknown,
): Promise<void> {
  const msg = message as PanelMessage;
  const all = await loadDeliveries(ctx);

  switch (msg.type) {
    case 'requestDeliveries': {
      // Send all deliveries + current env info
      await panel.postMessage({
        type: 'deliveries',
        data: all,
        env: await buildPanelEnv(ctx, panel),
      });
      break;
    }
    case 'remove': {
      if (!msg.id) break;
      const removed = all.find((r) => r.id === msg.id);
      const filtered = all.filter((r) => r.id !== msg.id);
      await saveDeliveries(ctx, filtered);
      // Broadcast instead of replying only to the requester — the same
      // removal must also update any other open panel (e.g. the appView
      // sidebar page) watching this data.
      await broadcastDeliveries(ctx);
      // Refresh delivery row for the affected session
      if (removed) await refreshDeliveryRow(ctx, removed.sessionId);

      // Deleting the record never blocks on the disk delete below — the
      // record is the source of truth for this tool, the file is best-effort.
      let fileDeleteError: string | undefined;
      if (removed && msg.deleteFile) {
        try {
          await unlink(removed.filePath);
        } catch (err) {
          fileDeleteError = err instanceof Error ? err.message : String(err);
          ctx.logger.warn(`Failed to delete file on disk: ${removed.filePath} — ${fileDeleteError}`);
        }
      }
      await panel.postMessage({
        type: 'removeResult',
        id: msg.id,
        deleteFileRequested: !!msg.deleteFile,
        fileDeleteError,
      });
      break;
    }
    case 'clearSession': {
      if (!msg.sessionId) break;
      const filtered = all.filter((r) => r.sessionId !== msg.sessionId);
      await saveDeliveries(ctx, filtered);
      await broadcastDeliveries(ctx);
      await refreshDeliveryRow(ctx, msg.sessionId);
      break;
    }
    case 'openPreview': {
      if (!msg.filePath) break;
      await openFilePreview(ctx, msg.filePath);
      break;
    }
    case 'requestImage': {
      // The card gallery reads image thumbnails on demand instead of
      // persisting them — keeps the stored record small and also works for
      // already-recorded images. Read the file, embed as a base64 data URL
      // (bounded), and let the page slot it into the matching card.
      if (!msg.filePath) break;
      const filePath = msg.filePath;
      try {
        const fileStat = await stat(filePath).catch(() => null);
        if (fileStat && fileStat.size > MAX_IMAGE_EMBED_BYTES) {
          ctx.logger.warn(`Skipping thumbnail for oversized image: ${filePath} (${fileStat.size} bytes)`);
          await panel.postMessage({ type: 'imageData', filePath, error: 'too-large' });
          break;
        }
        const buf = await readFile(filePath);
        const dataUrl = `data:${imageMime(filePath)};base64,${buf.toString('base64')}`;
        await panel.postMessage({ type: 'imageData', filePath, dataUrl });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`Failed to read image for thumbnail: ${filePath} — ${message}`);
        await panel.postMessage({ type: 'imageData', filePath, error: 'unreadable' });
      }
      break;
    }
  }
}

// ── Activate ────────────────────────────────────────────────────────────────

export function activate(ctx: finch.MiniToolContext): void {
  // ── Icon pack ─────────────────────────────────────────────────────────────
  const iconPack = ctx.icons.register('delivery-icons', {
    'library': {
      svg:
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<rect width="8" height="18" x="3" y="3" rx="1"/>' +
        '<path d="M7 3v18"/>' +
        '<path d="M20.4 18.9c.2.5-.1 1.1-.6 1.3l-1.9.7c-.5.2-1.1-.1-1.3-.6L11.1 5.1c-.2-.5.1-1.1.6-1.3l1.9-.7c.5-.2 1.1.1 1.3.6Z"/>' +
        '</svg>',
    },
  });
  ctx.subscriptions.push(iconPack);

  // ── Panel open listener ──────────────────────────────────────────────────
  ctx.subscriptions.push(
    ctx.ui.onDidOpenPanel((panel) => {
      // Track the instance for broadcasts. Re-opening a still-alive
      // single-instance panel re-emits it here, so guard the one-time
      // listener binding with `boundPanels`.
      livePanels.add(panel);
      if (!boundPanels.has(panel)) {
        boundPanels.add(panel);
        ctx.subscriptions.push(
          panel.onDidDispose(() => livePanels.delete(panel)),
          panel.onDidReceiveMessage((msg) => handlePanelMessage(ctx, panel, msg)),
        );
      }
      // Proactively send current data on open
      loadDeliveries(ctx).then(async (all) => {
        panel.postMessage({ type: 'deliveries', data: all, env: await buildPanelEnv(ctx, panel) });
      });
    }),
  );

  // ── Agent tool ───────────────────────────────────────────────────────────
  const tool = ctx.tools.register({
    name: 'record_artifact',
    title: 'Artifact Recorder',
    description:
      "Record and manage deliverables (finished document-type files: Markdown, Word, PPT, PDF, Excel, web pages, images) produced for the user.\n" +
      "Never call action 'record' for source code, config, or project files (.ts, .js, .py, .css, .json, etc) — those are not deliverables.\n" +
      'action:\n' +
      '  record — log a new deliverable (filePath, title, description, textPreview for md)\n' +
      '  list   — list deliverables, optionally filtered by sessionId\n' +
      '  remove — remove a deliverable by id',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['record', 'list', 'remove'],
          description: 'Operation to perform.',
        },
        filePath: {
          type: 'string',
          description: 'Absolute path to the deliverable file (required for record).',
        },
        fileType: {
          type: 'string',
          enum: ['md', 'word', 'ppt', 'pdf', 'excel', 'web', 'image', 'other'],
          description: 'File type category. If omitted, auto-detected from extension.',
        },
        title: {
          type: 'string',
          description: 'Short title for the deliverable (required for record).',
        },
        description: {
          type: 'string',
          description: 'One-line description of what this deliverable contains.',
        },
        textPreview: {
          type: 'string',
          description: 'For Markdown files: first ~500 characters of content for thumbnail preview.',
        },
        sessionId: {
          type: 'string',
          description: 'Session ID to filter by (for list) or to associate with (for record).',
        },
        id: {
          type: 'string',
          description: 'Delivery record ID (required for remove).',
        },
      },
      required: ['action'],
    },
    risk: 'low',
    async execute(input, exec): Promise<finch.ToolResult> {
      const action = String(input.action ?? '');

      switch (action) {
        // ── record ─────────────────────────────────────────────────────────
        case 'record': {
          const filePath = String(input.filePath ?? '').trim();
          const title = String(input.title ?? '').trim();
          if (!filePath || !title) {
            return text('`record` requires both `filePath` and `title`.', true);
          }
          const description = String(input.description ?? '').trim();
          const fileType = String(input.fileType ?? '') || detectFileType(filePath);
          const textPreview = String(input.textPreview ?? '').slice(0, MAX_PREVIEW) || undefined;
          const sessionId = String(input.sessionId ?? exec.sessionId ?? '');

          const record: DeliveryRecord = {
            id: randomUUID(),
            sessionId,
            filePath,
            fileName: baseName(filePath),
            fileType,
            title,
            description,
            textPreview,
            createdAt: Date.now(),
          };

          const all = await loadDeliveries(ctx);
          all.push(record);
          await saveDeliveries(ctx, all);
          await refreshDeliveryRow(ctx, sessionId || undefined);
          // Keep every already-open panel (right-side Panel App / appView
          // sidebar) in sync — the user's bug report: a panel opened before
          // this push never saw the new record until manually reopened.
          await broadcastDeliveries(ctx);

          return text(
            `Deliverable recorded: ${title} (${fileType})\nID: ${record.id}\nFile: ${record.fileName}`,
          );
        }

        // ── list ───────────────────────────────────────────────────────────
        case 'list': {
          const all = await loadDeliveries(ctx);
          const filterSession = String(input.sessionId ?? '');
          const filtered = filterSession
            ? all.filter((r) => r.sessionId === filterSession)
            : all;

          if (filtered.length === 0) {
            return text('No deliverables found.');
          }

          const lines = filtered.map((r, i) => {
            const time = formatTime(r.createdAt);
            return `${i + 1}. [${r.fileType}] ${r.title} — ${r.fileName} (${time})\n   ID: ${r.id}`;
          });
          return text(
            `${filtered.length} deliverable(s):\n\n${lines.join('\n\n')}`,
          );
        }

        // ── remove ─────────────────────────────────────────────────────────
        case 'remove': {
          const id = String(input.id ?? '').trim();
          if (!id) {
            return text('`remove` requires `id`.', true);
          }
          const all = await loadDeliveries(ctx);
          const found = all.find((r) => r.id === id);
          if (!found) {
            return text(`No deliverable found with id: ${id}`, true);
          }
          const filtered = all.filter((r) => r.id !== id);
          await saveDeliveries(ctx, filtered);
          await refreshDeliveryRow(ctx, found.sessionId);
          await broadcastDeliveries(ctx);

          return text(`Removed: ${found.title} (${found.fileName})`);
        }

        default:
          return text(`Unknown action: ${action}`, true);
      }
    },
  });

  ctx.subscriptions.push(tool);

  ctx.logger.info('finch-delivery activated');
}

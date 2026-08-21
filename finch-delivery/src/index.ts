import type * as finch from 'finch';
import { randomUUID } from 'node:crypto';

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
    icon: 'ext:package',
    payload: { sessionId, latestId: latest.id },
  });
}

// ── Panel message handling ──────────────────────────────────────────────────

interface PanelMessage {
  type: string;
  id?: string;
  sessionId?: string;
  filePath?: string;
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
      const env: Record<string, unknown> = {
        sessionId: panel.sessionId ?? '',
        view: panel.view ?? '',
        spaceId: panel.spaceId ?? '',
        spaceName: panel.spaceName ?? '',
      };
      await panel.postMessage({
        type: 'deliveries',
        data: all,
        env,
      });
      break;
    }
    case 'remove': {
      if (!msg.id) break;
      const filtered = all.filter((r) => r.id !== msg.id);
      await saveDeliveries(ctx, filtered);
      await panel.postMessage({ type: 'deliveries', data: filtered });
      // Refresh delivery row for the affected session
      const removed = all.find((r) => r.id === msg.id);
      if (removed) await refreshDeliveryRow(ctx, removed.sessionId);
      break;
    }
    case 'clearSession': {
      if (!msg.sessionId) break;
      const filtered = all.filter((r) => r.sessionId !== msg.sessionId);
      await saveDeliveries(ctx, filtered);
      await panel.postMessage({ type: 'deliveries', data: filtered });
      await refreshDeliveryRow(ctx, msg.sessionId);
      break;
    }
    case 'openPreview': {
      if (!msg.filePath) break;
      await openFilePreview(ctx, msg.filePath);
      break;
    }
  }
}

// ── Activate ────────────────────────────────────────────────────────────────

export function activate(ctx: finch.MiniToolContext): void {
  // ── Icon pack ─────────────────────────────────────────────────────────────
  const iconPack = ctx.icons.register('delivery-icons', {
    'package': {
      svg:
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/>' +
        '<path d="M12 22V12"/>' +
        '<polyline points="3.29 7 12 12 20.71 7"/>' +
        '<path d="m7.5 4.27 9 5.15"/>' +
        '</svg>',
    },
  });
  ctx.subscriptions.push(iconPack);

  // ── Panel open listener ──────────────────────────────────────────────────
  ctx.subscriptions.push(
    ctx.ui.onDidOpenPanel((panel) => {
      ctx.subscriptions.push(
        panel.onDidReceiveMessage((msg) => handlePanelMessage(ctx, panel, msg)),
      );
      // Proactively send current data on open
      loadDeliveries(ctx).then((all) => {
        const env: Record<string, unknown> = {
          sessionId: panel.sessionId ?? '',
          view: panel.view ?? '',
          spaceId: panel.spaceId ?? '',
          spaceName: panel.spaceName ?? '',
        };
        panel.postMessage({ type: 'deliveries', data: all, env });
      });
    }),
  );

  // ── Agent tool ───────────────────────────────────────────────────────────
  const tool = ctx.tools.register({
    name: 'delivery_manage',
    title: 'Delivery Manager',
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

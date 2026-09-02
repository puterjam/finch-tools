import path from 'node:path';

export interface DocumentState {
  path?: string;
  /** Monotonic per-file delivery version. Guests ignore stale pushes that
   * complete after a newer file write or panel rebind. */
  revision?: number;
  markdown: string;
  title: string;
  /** True when `markdown` came from a recovered unsaved draft rather than
   * the file's actual on-disk content — the panel marks the document dirty
   * and tells the user, instead of pretending it matches disk. */
  draftRestored?: boolean;
  /** True when a draft existed but disk had already moved on since the
   * draft's baseline (an external save happened) — `markdown` here is the
   * current disk content, not the draft, and the stale draft was kept
   * on disk rather than silently applied or discarded. */
  draftConflict?: boolean;
  /** The file's *actual* on-disk content, only meaningfully different from
   * `markdown` when `draftRestored` is true. The panel must track this
   * (not the restored draft it's displaying) as its "last disk-confirmed"
   * baseline — otherwise the next draft it mirrors back would record its
   * `baseHash` against the *draft*, not disk, so a later reopen would see
   * disk still sitting at the true baseline and wrongly report an
   * external-edit conflict that never happened. */
  diskMarkdown?: string;
}
/** `apply`'s targeted-edit mode — the same find-and-replace contract as a
 * code editor's Edit tool: each `old_string` is matched against the file's
 * *current* content (already reflecting any earlier edits in this same
 * call), not against the original snapshot, so a batch of edits composes
 * left-to-right. This lets the caller send a handful of small replacements
 * instead of the entire document for anything short of a full rewrite. */
export interface EditSpec { old_string: string; new_string: string; replace_all?: boolean }

export type EditSpecsResult = { ok: true; content: string } | { ok: false; error: string };

type TextEnvelope = { bom: string; lineEnding: '\r\n' | '\n'; text: string };

/** Preserve the source's BOM and dominant newline convention while matching
 * edit strings against LF-normalized content. Models almost always emit LF,
 * while user-authored Markdown can be CRLF (or carry a UTF-8 BOM). */
function unwrapTextEnvelope(content: string): TextEnvelope {
  const bom = content.startsWith('\ufeff') ? '\ufeff' : '';
  const text = bom ? content.slice(1) : content;
  const firstCrLf = text.indexOf('\r\n');
  const firstLf = text.indexOf('\n');
  const lineEnding: '\r\n' | '\n' = firstCrLf !== -1 && (firstLf === -1 || firstCrLf <= firstLf) ? '\r\n' : '\n';
  return { bom, lineEnding, text: text.replace(/\r\n/g, '\n').replace(/\r/g, '\n') };
}

function normalizeToLf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function rewrapTextEnvelope(envelope: TextEnvelope, normalizedText: string): string {
  const restored = envelope.lineEnding === '\r\n' ? normalizedText.replace(/\n/g, '\r\n') : normalizedText;
  return envelope.bom + restored;
}

/** Used by full-document replacement too, so apply never silently strips a
 * BOM or rewrites every line ending merely because the model sent LF text. */
export function preserveTextEnvelope(existingContent: string, replacement: string): string {
  const envelope = unwrapTextEnvelope(existingContent);
  return rewrapTextEnvelope(envelope, normalizeToLf(replacement.replace(/^\ufeff/, '')));
}

export function applyEditSpecs(content: string, edits: EditSpec[]): EditSpecsResult {
  const envelope = unwrapTextEnvelope(content);
  let working = envelope.text;
  for (let i = 0; i < edits.length; i++) {
    const { old_string: rawOldString, new_string: rawNewString, replace_all: replaceAll } = edits[i];
    if (typeof rawOldString !== 'string' || rawOldString.length === 0) {
      return { ok: false, error: `edits[${i}]: 'old_string' must be a non-empty string.` };
    }
    if (typeof rawNewString !== 'string') {
      return { ok: false, error: `edits[${i}]: 'new_string' must be a string.` };
    }
    const oldString = normalizeToLf(rawOldString);
    const newString = normalizeToLf(rawNewString);
    if (oldString === newString) {
      return { ok: false, error: `edits[${i}]: 'old_string' and 'new_string' are identical — nothing to change.` };
    }
    const occurrences = working.split(oldString).length - 1;
    if (occurrences === 0) {
      return { ok: false, error: `edits[${i}]: 'old_string' was not found in the file's current content. Check the exact text (including whitespace/line breaks) — the file may differ from what you last saw.` };
    }
    if (occurrences > 1 && !replaceAll) {
      return { ok: false, error: `edits[${i}]: 'old_string' matches ${occurrences} places in the file. Include more surrounding context to make it unique, or set 'replace_all: true' to replace every match.` };
    }
    if (replaceAll) {
      working = working.split(oldString).join(newString);
    } else {
      const index = working.indexOf(oldString);
      working = working.slice(0, index) + newString + working.slice(index + oldString.length);
    }
  }
  return { ok: true, content: rewrapTextEnvelope(envelope, working) };
}

export function documentTitle(markdown: string, filePath?: string): string {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || (filePath ? path.basename(filePath, path.extname(filePath)) : 'Untitled article');
}

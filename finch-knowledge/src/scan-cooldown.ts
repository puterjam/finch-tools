import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
export const AUTO_SCAN_INTERVAL_MS = 30 * 60 * 1000;

/** Only automatic triggers are gated; the shared scanner records manual and automatic attempts. */
export class AutoScanCooldown {
  private readonly timestamps = new Map<string, number | null>();
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(private readonly read: (key: string) => Promise<unknown>, private readonly write: (key: string, value: number) => Promise<void>, private readonly now = Date.now) {}
  private rootKey(root: string): string { const path = resolve(root); return process.platform === 'win32' ? path.toLowerCase() : path; }
  private storageKey(root: string): string { return `autoScan.${createHash('sha256').update(root).digest('hex')}`; }
  async record(root: string): Promise<void> {
    root = this.rootKey(root); const timestamp = this.now(); this.timestamps.set(root, timestamp);
    try { await this.write(this.storageKey(root), timestamp); } catch { /* Keep the in-memory cooldown if persistence is unavailable. */ }
  }
  run<T>(root: string, action: () => Promise<T>): Promise<T | undefined> {
    root = this.rootKey(root);
    const existing = this.pending.get(root); if (existing) return existing as Promise<T | undefined>;
    const job = (async () => {
      if (!this.timestamps.has(root)) {
        let stored: unknown;
        try { stored = await this.read(this.storageKey(root)); } catch { /* A missing cache cannot disable scanning. */ }
        // A manual scan may finish while the persisted value is loading.
        if (!this.timestamps.has(root)) this.timestamps.set(root, typeof stored === 'number' && Number.isFinite(stored) && stored >= 0 ? stored : null);
      }
      const last = this.timestamps.get(root), elapsed = last == null ? Infinity : this.now() - last;
      if (elapsed >= 0 && elapsed < AUTO_SCAN_INTERVAL_MS) return undefined;
      return action();
    })().finally(() => { if (this.pending.get(root) === job) this.pending.delete(root); });
    this.pending.set(root, job); return job;
  }
}

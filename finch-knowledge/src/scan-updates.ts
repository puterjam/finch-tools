/** Coalesce scan checkpoints without overlapping catalogue reads or losing the trailing update. */
export class ScanUpdates {
  private dirty = false;
  private closed = false;
  private last = -Infinity;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  constructor(private readonly publish: () => Promise<void>, private readonly intervalMs = 1000) {}
  mark(): void {
    if (this.closed) return;
    this.dirty = true;
    this.schedule();
  }
  private schedule(): void {
    if (this.closed || this.running || this.timer || !this.dirty) return;
    const delay = Math.max(0, this.intervalMs - (Date.now() - this.last));
    if (!delay) { void this.send(); return; }
    this.timer = setTimeout(() => { this.timer = undefined; void this.send(); }, delay);
  }
  private async send(): Promise<void> {
    this.dirty = false;
    this.last = Date.now();
    this.running = Promise.resolve().then(this.publish).catch(() => {});
    await this.running;
    this.running = undefined;
    this.schedule();
  }
  async flush(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
    if (this.dirty) await this.send();
  }
}

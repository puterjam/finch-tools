/** Release cancelled callers promptly, while retaining native reads until safe disposal. */
export function interruptible<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    const cleanup = () => signal.removeEventListener('abort', abort);
    operation.then(value => { cleanup(); if (!signal.aborted) resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

export class WorkScope {
  private controller = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  get signal(): AbortSignal { return this.controller.signal; }
  cancel(): void { this.controller.abort(); }
  resume(): void { if (this.signal.aborted) this.controller = new AbortController(); }
  run<T>(operation: Promise<T>, signal = this.signal): Promise<T> {
    this.pending.add(operation);
    const settled = () => this.pending.delete(operation);
    void operation.then(settled, settled);
    return interruptible(operation, signal);
  }
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}

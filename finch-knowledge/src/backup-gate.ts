/** Prevents uploads and writes from changing the library during a multi-file snapshot. */
export class BackupGate {
  private activeWrites = 0;
  private snapshotActive = false;

  reserveWrite(): () => void {
    if (this.snapshotActive) throw new Error('A library backup is in progress. Try again when it finishes.');
    this.activeWrites++;
    let released = false;
    return () => {
      if (!released) { released = true; this.activeWrites--; }
    };
  }

  async write<T>(action: () => Promise<T>): Promise<T> {
    const release = this.reserveWrite();
    try { return await action(); }
    finally { release(); }
  }

  async snapshot<T>(action: () => Promise<T>): Promise<T> {
    if (this.snapshotActive || this.activeWrites) throw new Error('Finish current imports or edits before backing up.');
    this.snapshotActive = true;
    try { return await action(); }
    finally { this.snapshotActive = false; }
  }
}

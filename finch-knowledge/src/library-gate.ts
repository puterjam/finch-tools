/** Keep directory switching exclusive with active indexing and classification writes. */
export class LibraryGate {
  private writes = 0;
  private switching = false;

  async write<T>(action: () => Promise<T>): Promise<T> {
    if (this.switching) throw new Error('The library directory is switching. Try again when it finishes.');
    this.writes++;
    try { return await action(); }
    finally { this.writes--; }
  }

  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.switching || this.writes) throw new Error('Finish current indexing or edits before switching directories.');
    this.switching = true;
    try { return await action(); }
    finally { this.switching = false; }
  }
}

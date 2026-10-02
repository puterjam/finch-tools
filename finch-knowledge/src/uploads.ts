import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { ACCEPTED, DEFAULT_TAG, type KnowledgeStore } from './store.js';

export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
export const CHUNK_BYTES = 192 * 1024;
const IDLE_MS = 120_000;

interface Incoming {
  name: string;
  tagId: string;
  size: number;
  received: number;
  file: FileHandle;
  staging: string;
  timer?: ReturnType<typeof setTimeout>;
}

/** Browser File objects have no trustworthy disk path. Keep a managed local copy for indexing. */
export class UploadReceiver {
  private incoming?: Incoming;
  constructor(private readonly storagePath: string, private readonly store: KnowledgeStore) {}

  private arm(state: Incoming): void {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => { void this.abort(); }, IDLE_MS);
    state.timer.unref?.();
  }

  async abort(): Promise<void> {
    const state = this.incoming;
    this.incoming = undefined;
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    await state.file.close().catch(() => {});
    await unlink(state.staging).catch(() => {});
  }

  async begin(name: string, size: number, tagId = DEFAULT_TAG): Promise<void> {
    await this.abort();
    this.store.assertTag(tagId);
    if (!name || name.length > 255 || basename(name) !== name || /[\\/\x00-\x1f]/.test(name)) {
      throw new Error('Invalid file name.');
    }
    if (!ACCEPTED.includes(extname(name).toLowerCase())) throw new Error('Unsupported file type.');
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_UPLOAD_BYTES) {
      throw new Error('Choose a nonempty file smaller than 64 MB.');
    }
    const directory = join(this.storagePath, 'imports', '.staging');
    await mkdir(directory, { recursive: true });
    const staging = join(directory, `${randomUUID()}.upload`);
    const file = await open(staging, 'wx');
    const state: Incoming = { name, tagId, size, received: 0, file, staging };
    this.incoming = state;
    this.arm(state);
  }

  async chunk(data: string): Promise<number> {
    const state = this.incoming;
    if (!state) throw new Error('No active file upload.');
    if (typeof data !== 'string' || !data || data.length > Math.ceil(CHUNK_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
      throw new Error('Invalid file chunk.');
    }
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.length > CHUNK_BYTES || state.received + bytes.length > state.size) {
      throw new Error('File upload exceeds the declared size.');
    }
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await state.file.write(bytes, offset, bytes.length - offset, state.received + offset);
      if (bytesWritten <= 0) throw new Error('Could not write file chunk.');
      offset += bytesWritten;
    }
    state.received += bytes.length;
    this.arm(state);
    return state.received;
  }

  /** `sourcePath` is passed through when the caller knows where the bytes came from. */
  async finish(sourcePath: string | null = null): Promise<{ unchanged: boolean; name: string; documentId: string }> {
    const state = this.incoming;
    if (!state) throw new Error('No active file upload.');
    if (state.received !== state.size) throw new Error('File upload is incomplete.');
    this.incoming = undefined;
    if (state.timer) clearTimeout(state.timer);
    await state.file.close();
    const backup = join(this.storagePath, 'imports', '.staging', `${randomUUID()}.backup`);
    let target = '';
    let hadPrior = false;
    let replaced = false;
    try {
      target = await this.store.uploadTarget(state.tagId, state.name);
      await mkdir(dirname(target), { recursive: true });
      hadPrior = (await stat(target).catch(() => null))?.isFile() ?? false;
      if (hadPrior) await copyFile(target, backup);
      await rename(state.staging, target);
      replaced = true;
      const indexed = await this.store.importFile(target, state.name, state.tagId, sourcePath);
      return { unchanged: indexed.unchanged, name: state.name, documentId: indexed.document.id };
    } catch (error) {
      if (replaced && hadPrior) await rename(backup, target);
      else if (replaced) await unlink(target).catch(() => {});
      throw error;
    } finally {
      await unlink(state.staging).catch(() => {});
      await unlink(backup).catch(() => {});
    }
  }
}

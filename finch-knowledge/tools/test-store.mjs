import { KnowledgeStore as RealStore, activate as realActivate } from '../dist/index.js';
import { isAbsolute, relative, sep } from 'node:path';
export * from '../dist/index.js';
const stores = new Set();
const hosts = new Set();
const within = (root, path) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
/** Test-only lifetime tracking, including stores instantiated inline in older regression fixtures. */
export class KnowledgeStore extends RealStore {
  constructor(...args) { super(...args); stores.add(this); }
  async close() { await super.close(); stores.delete(this); }
}
export function activate(ctx) {
  hosts.add(ctx);
  return realActivate(ctx);
}
export async function closeFixtures(root) {
  for (const ctx of hosts) {
    if (!within(root, ctx.storagePath)) continue;
    // Finish startup before disposing, even in tests that only inspect the registered schema.
    await new Promise(resolve => setImmediate(resolve));
    for (const subscription of ctx.subscriptions) await subscription.dispose?.();
    hosts.delete(ctx);
  }
  for (const store of stores) if (within(root, store.root)) await store.close();
}

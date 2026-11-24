/**
 * Where per-frame `FrameMeta` waits between the burst and `complete`.
 *
 * FrameMeta carries the 478-landmark mesh and 52 blendshapes — biometric-like
 * data (CLAUDE.md) — so it is NOT written to AsyncStorage, which is not
 * encrypted. The native contract v1 has no call that returns a frame's meta
 * after the burst (`listSpool()` returns only id/bytes/createdAt), so until it
 * does the vault is memory-only:
 *
 *  - while the app stays alive, uploads, offline queueing and retries all work;
 *  - after a restart, a frame that was already completed needs nothing; a
 *    frame that was not completed has lost its meta, and the spool abandons the
 *    capture (frames deleted, «أُغلق التطبيق قبل اكتمال الرفع…», retake) rather
 *    than storing a frame without its acquisition record.
 *
 * If the native module ever exposes `getFrameMeta(id)` (proposed contract
 * addition, BUILD_STATUS open item) `nativeBackedMetaVault` uses it, and
 * resume after a restart becomes complete.
 */

import type { FrameMeta } from '../native/types.ts';

export interface FrameMetaVault {
  put(id: string, meta: FrameMeta): Promise<void>;
  get(id: string): Promise<FrameMeta | null>;
  delete(ids: string[]): Promise<void>;
}

export function memoryMetaVault(): FrameMetaVault & { size(): number } {
  const store = new Map<string, FrameMeta>();
  return {
    async put(id, meta) {
      store.set(id, meta);
    },
    async get(id) {
      return store.get(id) ?? null;
    },
    async delete(ids) {
      for (const id of ids) store.delete(id);
    },
    size() {
      return store.size;
    },
  };
}

/** Memory first, then an optional native reader of the encrypted spool. */
export function nativeBackedMetaVault(
  nativeGet: ((id: string) => Promise<FrameMeta | null>) | null,
): FrameMetaVault {
  const memory = memoryMetaVault();
  return {
    put: memory.put,
    delete: memory.delete,
    async get(id) {
      const value = await memory.get(id);
      if (value || !nativeGet) return value;
      try {
        return (await nativeGet(id)) ?? null;
      } catch {
        return null;
      }
    },
  };
}

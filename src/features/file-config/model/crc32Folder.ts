/**
 * Folds CRC-32 chunks in a worker, and falls back to this thread when there is no worker to be had.
 *
 * The fallback is not a formality: workers can be unavailable (an old WebView, a restrictive CSP)
 * and a worker can die mid-import. Either way the import must still finish and still verify — the
 * checksum is what stands between a corrupt archive and a project whose pads are silent — so a
 * failed fold is retried here rather than surfaced. That is safe only because the caller keeps its
 * own copy of every chunk; see `crc32Protocol.ts`.
 */
import { updateCrc32 } from "../../../shared/lib/crc32";
import type { Crc32FoldReply, Crc32FoldRequest } from "./crc32Protocol";

export type Crc32Folder = {
  fold: (state: number, chunk: Uint8Array) => Promise<number>;
  dispose: () => void;
  /** Diagnostics and tests: whether folding is actually happening off this thread. */
  offThread: () => boolean;
};

function createMainThreadFolder(): Crc32Folder {
  return {
    fold: (state, chunk) => Promise.resolve(updateCrc32(state, chunk)),
    dispose: () => undefined,
    offThread: () => false
  };
}

export function createCrc32Folder(): Crc32Folder {
  if (typeof Worker === "undefined") {
    return createMainThreadFolder();
  }

  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL("./crc32.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return createMainThreadFolder();
  }

  const live = worker;
  let nextId = 0;
  const pending = new Map<number, (state: number | null) => void>();

  const settleAll = () => {
    for (const resolve of [...pending.values()]) {
      resolve(null);
    }
    pending.clear();
  };

  const drop = () => {
    settleAll();
    if (worker) {
      worker.terminate();
      worker = null;
    }
  };

  live.onmessage = (event: MessageEvent<Crc32FoldReply>) => {
    const { id, state } = event.data;
    const resolve = pending.get(id);
    if (resolve) {
      pending.delete(id);
      resolve(state);
    }
  };
  // A worker that failed once is not trusted again: the remaining chunks fold here instead of
  // queueing against a dead port.
  live.onerror = drop;
  live.onmessageerror = drop;

  return {
    async fold(state, chunk) {
      const current = worker;
      if (!current) {
        return updateCrc32(state, chunk);
      }
      const id = nextId;
      nextId += 1;
      const request: Crc32FoldRequest = { id, state, chunk };
      const answer = await new Promise<number | null>((resolve) => {
        pending.set(id, resolve);
        try {
          current.postMessage(request);
        } catch {
          pending.delete(id);
          resolve(null);
        }
      });
      // `null` is the worker having gone away, not a checksum of zero.
      return answer ?? updateCrc32(state, chunk);
    },
    dispose: drop,
    offThread: () => worker !== null
  };
}

/**
 * CRC-32 folding, off the main thread.
 *
 * `updateCrc32` is a byte-at-a-time table loop — 240 MB/s on a warm desktop JIT and a fraction of
 * that on a phone. An import verifies every media byte, so on a project of several hundred
 * megabytes that loop is tens of seconds of main thread with nothing else able to run: the progress
 * label freezes and the app looks hung at exactly the moment the user is watching it.
 *
 * `self` is typed against the DOM lib in this project, so the two worker-only members are reached
 * through a minimal local type rather than by switching the lib for one file.
 */
import { updateCrc32 } from "../../../shared/lib/crc32";
import type { Crc32FoldReply, Crc32FoldRequest } from "./crc32Protocol";

type WorkerScope = {
  onmessage: ((event: MessageEvent<Crc32FoldRequest>) => void) | null;
  postMessage: (message: Crc32FoldReply) => void;
};

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const { id, state, chunk } = event.data;
  const reply: Crc32FoldReply = { id, state: updateCrc32(state, chunk) };
  scope.postMessage(reply);
};

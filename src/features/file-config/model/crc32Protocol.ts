/**
 * The two messages the CRC worker speaks.
 *
 * Its own module so the worker entry and its client can share the shape without either importing
 * the other — importing the worker entry from the main bundle would pull `self.onmessage` into it.
 *
 * The chunk is CLONED into the worker rather than transferred, and the reply carries no bytes back.
 * Transferring would be one memcpy cheaper, but it detaches the caller's view: if the worker then
 * dies, the bytes are gone and the import cannot even fall back to folding them here. A 4 MiB copy
 * costs about a millisecond against tens for the fold it replaces, so the safe shape is also the
 * one whose cost does not show up.
 */

export type Crc32FoldRequest = {
  id: number;
  /** Running, un-inverted accumulator; `CRC32_INITIAL` starts a fresh entry. */
  state: number;
  chunk: Uint8Array;
};

export type Crc32FoldReply = {
  id: number;
  state: number;
};

/**
 * Validation for the stored-entry ZIP the project format is.
 *
 * Extracted from `index.ts` for a reason stronger than tidiness: that file imports `getMediaBlob`,
 * which reaches `react` and `idb-keyval`, so the unit tier cannot load it AT ALL. Every acceptance
 * decision the reader makes was therefore unreachable from a test, and could only die if some e2e
 * happened to walk the same path with exactly the right corrupt bytes. Here they are pure functions
 * over small inputs.
 *
 * The boundary is "no I/O, no DOM, no runtime import of app state". Bytes in, verdicts out; the
 * caller does every read.
 */
import { CRC32_INITIAL, finalizeCrc32, updateCrc32 } from "../../../shared/lib/crc32";

export const ZIP_LOCAL_HEADER_BYTES = 30;
export const ZIP_CENTRAL_HEADER_BYTES = 46;
export const ZIP_END_RECORD_BYTES = 22;
/** 22 bytes of record plus a comment field that cannot exceed 65 535. */
export const ZIP_END_RECORD_SEARCH_BYTES = 65_557;
export const ZIP_MAX_UINT16 = 0xffff;
export const ZIP_MAX_UINT32 = 0xffff_ffff;

const SIGNATURE_LOCAL = 0x04034b50;
const SIGNATURE_CENTRAL = 0x02014b50;
const SIGNATURE_END = 0x06054b50;

/** Bit 0 is encryption, bit 3 says the sizes live in a trailing data descriptor. */
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;

export type ZipFailure =
  | "no-end-record"
  | "bad-end-record"
  | "zip64-unsupported"
  | "bad-central-signature"
  | "truncated-central-directory"
  | "entry-count-mismatch"
  | "unsupported-compression"
  | "unsupported-entry-flags"
  | "size-mismatch"
  | "bad-entry-name"
  | "duplicate-entry-name"
  | "entry-out-of-bounds"
  | "bad-local-header"
  | "header-mismatch";

export type ZipResult<T> = { ok: true; value: T } | { ok: false; reason: ZipFailure };

export type ZipEndRecord = {
  entryCount: number;
  centralDirectorySize: number;
  centralDirectoryOffset: number;
  /** Absolute file offset of the end-of-central-directory signature. */
  endRecordOffset: number;
};

export type ZipCentralEntry = {
  name: string;
  crc32: number;
  compressedSize: number;
  localOffset: number;
};

export type ZipDataRange = { start: number; end: number };

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Scanned BACKWARDS, so a comment that happens to contain the signature loses to the real record.
 */
export function findEndOfCentralDirectory(tail: Uint8Array): number {
  const minOffset = Math.max(0, tail.length - ZIP_END_RECORD_SEARCH_BYTES);
  for (let offset = tail.length - ZIP_END_RECORD_BYTES; offset >= minOffset; offset -= 1) {
    if (
      tail[offset] === 0x50 &&
      tail[offset + 1] === 0x4b &&
      tail[offset + 2] === 0x05 &&
      tail[offset + 3] === 0x06
    ) {
      return offset;
    }
  }
  return -1;
}

export function readEndRecord(
  tail: Uint8Array,
  offsetInTail: number,
  tailStart: number,
  fileSize: number
): ZipResult<ZipEndRecord> {
  if (offsetInTail < 0 || offsetInTail + ZIP_END_RECORD_BYTES > tail.length) {
    return { ok: false, reason: "no-end-record" };
  }
  const data = view(tail);
  if (data.getUint32(offsetInTail, true) !== SIGNATURE_END) {
    return { ok: false, reason: "bad-end-record" };
  }
  const diskNumber = data.getUint16(offsetInTail + 4, true);
  const diskWithDirectory = data.getUint16(offsetInTail + 6, true);
  const entriesOnDisk = data.getUint16(offsetInTail + 8, true);
  const entryCount = data.getUint16(offsetInTail + 10, true);
  const centralDirectorySize = data.getUint32(offsetInTail + 12, true);
  const centralDirectoryOffset = data.getUint32(offsetInTail + 16, true);
  const endRecordOffset = tailStart + offsetInTail;

  // The writer never spans disks, so anything else is not a file this reader produced.
  if (diskNumber !== 0 || diskWithDirectory !== 0 || entriesOnDisk !== entryCount) {
    return { ok: false, reason: "bad-end-record" };
  }
  // Named rather than left to fail as a bounds error: a real ZIP64 archive deserves a verdict that
  // says so, not a confusing "out of bounds".
  if (
    entryCount === ZIP_MAX_UINT16 ||
    centralDirectorySize === ZIP_MAX_UINT32 ||
    centralDirectoryOffset === ZIP_MAX_UINT32
  ) {
    return { ok: false, reason: "zip64-unsupported" };
  }
  // One equality that catches a shifted, padded or partly rewritten directory, and it is strictly
  // stronger than the "offset is before the end record" check it replaces.
  if (centralDirectoryOffset + centralDirectorySize !== endRecordOffset) {
    return { ok: false, reason: "bad-end-record" };
  }
  if (endRecordOffset + ZIP_END_RECORD_BYTES > fileSize) {
    return { ok: false, reason: "bad-end-record" };
  }

  return {
    ok: true,
    value: { entryCount, centralDirectorySize, centralDirectoryOffset, endRecordOffset }
  };
}

export function parseCentralDirectory(
  directory: Uint8Array,
  endRecord: ZipEndRecord
): ZipResult<ZipCentralEntry[]> {
  const data = view(directory);
  const decoder = new TextDecoder();
  const entries: ZipCentralEntry[] = [];
  const seen = new Set<string>();
  let cursor = 0;

  for (let index = 0; index < endRecord.entryCount; index += 1) {
    if (cursor + ZIP_CENTRAL_HEADER_BYTES > directory.length) {
      return { ok: false, reason: "truncated-central-directory" };
    }
    if (data.getUint32(cursor, true) !== SIGNATURE_CENTRAL) {
      return { ok: false, reason: "bad-central-signature" };
    }
    const flags = data.getUint16(cursor + 8, true);
    const method = data.getUint16(cursor + 10, true);
    const crc32 = data.getUint32(cursor + 16, true);
    const compressedSize = data.getUint32(cursor + 20, true);
    const uncompressedSize = data.getUint32(cursor + 24, true);
    const fileNameLength = data.getUint16(cursor + 28, true);
    const extraLength = data.getUint16(cursor + 30, true);
    const commentLength = data.getUint16(cursor + 32, true);
    const localOffset = data.getUint32(cursor + 42, true);

    // A data descriptor puts the real sizes after the payload, so the ones here are zero and every
    // range derived from them would be wrong. Encryption is simply not something this format has.
    if ((flags & (FLAG_DATA_DESCRIPTOR | FLAG_ENCRYPTED)) !== 0) {
      return { ok: false, reason: "unsupported-entry-flags" };
    }
    if (method !== 0) {
      return { ok: false, reason: "unsupported-compression" };
    }
    // Stored entries: the two sizes are the same number by definition. The reader used to ignore
    // `uncompressedSize` entirely, so a file with a tampered pair looked fine.
    if (compressedSize !== uncompressedSize) {
      return { ok: false, reason: "size-mismatch" };
    }
    if (cursor + ZIP_CENTRAL_HEADER_BYTES + fileNameLength > directory.length) {
      return { ok: false, reason: "truncated-central-directory" };
    }

    const name = decoder.decode(
      directory.subarray(
        cursor + ZIP_CENTRAL_HEADER_BYTES,
        cursor + ZIP_CENTRAL_HEADER_BYTES + fileNameLength
      )
    );
    if (name.length === 0 || name.includes("\0")) {
      return { ok: false, reason: "bad-entry-name" };
    }
    // The reader keys entries by name in a Map, so a duplicate silently let the later record win.
    if (seen.has(name)) {
      return { ok: false, reason: "duplicate-entry-name" };
    }
    seen.add(name);

    // Bounded against the START OF THE DIRECTORY rather than the file size: tighter, and it catches
    // an entry whose payload would overlap the directory itself.
    const maxEnd =
      localOffset + ZIP_LOCAL_HEADER_BYTES + fileNameLength + compressedSize;
    if (localOffset < 0 || maxEnd > endRecord.centralDirectoryOffset) {
      return { ok: false, reason: "entry-out-of-bounds" };
    }

    entries.push({ name, crc32, compressedSize, localOffset });
    cursor += ZIP_CENTRAL_HEADER_BYTES + fileNameLength + extraLength + commentLength;
  }

  // The directory must be consumed exactly: trailing bytes mean the declared count is short.
  if (cursor !== directory.length) {
    return { ok: false, reason: "entry-count-mismatch" };
  }
  return { ok: true, value: entries };
}

/**
 * Where an entry's payload actually starts, from its own local header.
 *
 * ZIP permits the local header's name and extra fields to differ from the directory's, so they are
 * read rather than assumed — and the CRC and sizes recorded in both must agree, or the file has
 * been edited in one place and not the other.
 *
 * REJECTS rather than clamps. A range running past the directory means a truncated file, and
 * returning a shorter blob for it is precisely the bug this replaces: `File.slice` past the end
 * yields fewer bytes with no error at all.
 */
export function resolveDataRange(
  entry: ZipCentralEntry,
  localHeader: Uint8Array,
  endRecord: ZipEndRecord
): ZipResult<ZipDataRange> {
  if (localHeader.length < ZIP_LOCAL_HEADER_BYTES) {
    return { ok: false, reason: "bad-local-header" };
  }
  const data = view(localHeader);
  if (data.getUint32(0, true) !== SIGNATURE_LOCAL) {
    return { ok: false, reason: "bad-local-header" };
  }
  const localCrc = data.getUint32(14, true);
  const localCompressed = data.getUint32(18, true);
  const localUncompressed = data.getUint32(22, true);
  if (
    localCrc !== entry.crc32 ||
    localCompressed !== entry.compressedSize ||
    localUncompressed !== entry.compressedSize
  ) {
    return { ok: false, reason: "header-mismatch" };
  }

  const nameLength = data.getUint16(26, true);
  const extraLength = data.getUint16(28, true);
  const start = entry.localOffset + ZIP_LOCAL_HEADER_BYTES + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > endRecord.centralDirectoryOffset) {
    return { ok: false, reason: "entry-out-of-bounds" };
  }
  return { ok: true, value: { start, end } };
}

/**
 * CRC as a fold, so the caller owns the reads.
 *
 * The byte counter is not redundant beside the checksum. `File.slice` past the end of a file yields
 * a SHORTER blob with no error, and the CRC of zero bytes is 0 — which would spuriously match any
 * entry whose recorded CRC happens to be 0. Checking the length is what turns "the bytes we got
 * hash correctly" into "we got the bytes".
 */
export type Crc32Fold = { state: number; bytes: number };

export function beginCrc32Fold(): Crc32Fold {
  return { state: CRC32_INITIAL, bytes: 0 };
}

export function foldCrc32Chunk(fold: Crc32Fold, chunk: Uint8Array): Crc32Fold {
  return { state: updateCrc32(fold.state, chunk), bytes: fold.bytes + chunk.byteLength };
}

export function verifyCrc32Fold(
  fold: Crc32Fold,
  expected: { crc32: number; size: number }
): boolean {
  return finalizeCrc32(fold.state) === expected.crc32 && fold.bytes === expected.size;
}

export type ZipWriteLimitFailure = "too-many-entries" | "entry-too-large" | "archive-too-large";

export type ZipWriteLimits = {
  maxEntryCount?: number;
  maxEntryBytes?: number;
  maxArchiveBytes?: number;
};

export type ZipWriteLimitResult =
  | { ok: true; archiveBytes: number }
  | { ok: false; reason: ZipWriteLimitFailure; archiveBytes: number; limit: number };

/**
 * Whether an archive can be written at all, given that every size and offset field is uint32.
 *
 * `DataView.setUint32` takes its value modulo 2^32 and reports nothing, so passing 4 GiB produced a
 * file that claimed success and no reader could open. The binding quantity is the payload total,
 * because that is what lands in `localOffset` and in the end record's directory offset.
 *
 * The limits are PARAMETERS with uint32 defaults, and that injectability is the single decision
 * that makes this testable: a unit test passes `maxArchiveBytes: 1024` and asserts the refusal
 * without building four gigabytes.
 */
export function checkZipWriteLimits(
  entries: readonly { name: string; size: number }[],
  limits: ZipWriteLimits = {}
): ZipWriteLimitResult {
  const maxEntryCount = limits.maxEntryCount ?? ZIP_MAX_UINT16;
  const maxEntryBytes = limits.maxEntryBytes ?? ZIP_MAX_UINT32;
  const maxArchiveBytes = limits.maxArchiveBytes ?? ZIP_MAX_UINT32;
  const encoder = new TextEncoder();

  let payloadBytes = 0;
  let centralBytes = 0;
  for (const entry of entries) {
    // Byte length, not character length: a Cyrillic name is two bytes per character.
    const nameBytes = encoder.encode(entry.name).length;
    payloadBytes += ZIP_LOCAL_HEADER_BYTES + nameBytes + entry.size;
    centralBytes += ZIP_CENTRAL_HEADER_BYTES + nameBytes;
  }
  const archiveBytes = payloadBytes + centralBytes + ZIP_END_RECORD_BYTES;

  // `>=`, not `>`. The reader treats an entry count of exactly `ZIP_MAX_UINT16` as the ZIP64
  // sentinel and refuses it, so writing that many produced a well-formed file this build then
  // rejected as "too large" — a failure with no explanation and no way for the user to act.
  if (entries.length >= maxEntryCount) {
    return { ok: false, reason: "too-many-entries", archiveBytes, limit: maxEntryCount };
  }
  for (const entry of entries) {
    if (entry.size > maxEntryBytes) {
      return { ok: false, reason: "entry-too-large", archiveBytes, limit: maxEntryBytes };
    }
  }
  if (payloadBytes > maxArchiveBytes || centralBytes > maxArchiveBytes) {
    return { ok: false, reason: "archive-too-large", archiveBytes, limit: maxArchiveBytes };
  }
  return { ok: true, archiveBytes };
}

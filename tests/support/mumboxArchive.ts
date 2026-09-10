/**
 * Node-side surgery on a real `.mumbox` file.
 *
 * Offsets are FOUND, never hard-coded: the manifest length varies with the project, so a fixed
 * offset would silently drift onto the wrong field the moment a seed changed. The archive is built
 * by the app's own export path, so what these tests corrupt is a genuine file.
 */
import { getCrc32 } from "../../src/shared/lib/crc32";

export type ArchiveEntry = {
  name: string;
  /** Offset of this entry's record inside the central directory. */
  centralOffset: number;
  localOffset: number;
  dataStart: number;
  compressedSize: number;
};

export type ParsedArchive = {
  eocdOffset: number;
  centralDirectoryOffset: number;
  entries: ArchiveEntry[];
};

function readUint16(bytes: Buffer, offset: number): number {
  return bytes.readUInt16LE(offset);
}

function readUint32(bytes: Buffer, offset: number): number {
  return bytes.readUInt32LE(offset);
}

export function parseArchive(bytes: Buffer): ParsedArchive {
  let eocdOffset = -1;
  for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
    if (
      bytes[offset] === 0x50 &&
      bytes[offset + 1] === 0x4b &&
      bytes[offset + 2] === 0x05 &&
      bytes[offset + 3] === 0x06
    ) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error("no end-of-central-directory record");
  }

  const entryCount = readUint16(bytes, eocdOffset + 10);
  const centralDirectoryOffset = readUint32(bytes, eocdOffset + 16);
  const entries: ArchiveEntry[] = [];
  let cursor = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    const compressedSize = readUint32(bytes, cursor + 20);
    const nameLength = readUint16(bytes, cursor + 28);
    const extraLength = readUint16(bytes, cursor + 30);
    const commentLength = readUint16(bytes, cursor + 32);
    const localOffset = readUint32(bytes, cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const localNameLength = readUint16(bytes, localOffset + 26);
    const localExtraLength = readUint16(bytes, localOffset + 28);
    entries.push({
      name,
      centralOffset: cursor,
      localOffset,
      dataStart: localOffset + 30 + localNameLength + localExtraLength,
      compressedSize
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return { eocdOffset, centralDirectoryOffset, entries };
}

export function findEntry(archive: ParsedArchive, predicate: (name: string) => boolean) {
  const entry = archive.entries.find((candidate) => predicate(candidate.name));
  if (!entry) {
    throw new Error("entry not found");
  }
  return entry;
}

/**
 * Rewrites an entry's payload IN PLACE and fixes both recorded CRCs.
 *
 * The fixup is the point. A manifest edit that leaves the CRC stale is caught by the checksum
 * first, so the test would prove the CRC works rather than the thing it meant to test. The
 * replacement must be the same length, or every offset after it moves.
 */
export function replaceEntryBytes(
  bytes: Buffer,
  entry: ArchiveEntry,
  replacement: Buffer
): void {
  if (replacement.length !== entry.compressedSize) {
    throw new Error(
      `replacement must be the same length: ${String(replacement.length)} vs ${String(entry.compressedSize)}`
    );
  }
  replacement.copy(bytes, entry.dataStart);
  const crc = getCrc32(new Uint8Array(replacement));
  bytes.writeUInt32LE(crc, entry.localOffset + 14);
  bytes.writeUInt32LE(crc, entry.centralOffset + 16);
}

/** Reads an entry's payload as text, for a same-length edit of the manifest. */
export function readEntryText(bytes: Buffer, entry: ArchiveEntry): string {
  return bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize).toString("utf8");
}

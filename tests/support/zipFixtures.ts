/**
 * A minimal stored-entry ZIP writer, for testing the READER's validation.
 *
 * It mirrors the production writer's field layout rather than importing it, which is the right
 * trade here: the subject under test is what the reader accepts, and a fixture built by the writer
 * under test could only ever produce archives the reader already agrees with. The writer/reader
 * round trip is pinned separately, by e2e that exports and re-imports a real project.
 */
import { getCrc32 } from "../../src/shared/lib/crc32";

export type ZipFixtureEntry = {
  name: string;
  bytes: Uint8Array;
  /**
   * Bytes of central-directory extra field and comment to pad the record with.
   *
   * The production writer emits neither, so nothing verified that the reader steps over them -
   * a mutation round confirmed it by hardcoding the extra length to zero and surviving. Any file
   * that has been through a general-purpose zip tool carries them.
   */
  centralExtraBytes?: number;
  centralCommentBytes?: number;
};

const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_RECORD_BYTES = 22;

function writeLocalHeader(nameBytes: Uint8Array, crc32: number, size: number): Uint8Array {
  const buffer = new ArrayBuffer(LOCAL_HEADER_BYTES + nameBytes.length);
  const view = new DataView(buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0x0800, true);
  view.setUint32(14, crc32, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, nameBytes.length, true);
  new Uint8Array(buffer, LOCAL_HEADER_BYTES).set(nameBytes);
  return new Uint8Array(buffer);
}

function writeCentralHeader(
  nameBytes: Uint8Array,
  crc32: number,
  size: number,
  localOffset: number,
  extraBytes = 0,
  commentBytes = 0
): Uint8Array {
  const buffer = new ArrayBuffer(
    CENTRAL_HEADER_BYTES + nameBytes.length + extraBytes + commentBytes
  );
  const view = new DataView(buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0x0800, true);
  view.setUint32(16, crc32, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, nameBytes.length, true);
  view.setUint16(30, extraBytes, true);
  view.setUint16(32, commentBytes, true);
  view.setUint32(42, localOffset, true);
  new Uint8Array(buffer, CENTRAL_HEADER_BYTES).set(nameBytes);
  return new Uint8Array(buffer);
}

export type ZipFixture = {
  bytes: Uint8Array;
  /** Where the central directory starts, and where each record within it sits. */
  centralDirectoryOffset: number;
  endRecordOffset: number;
  entries: { name: string; centralOffset: number; localOffset: number; dataStart: number }[];
};

export function buildZip(entries: readonly ZipFixtureEntry[]): ZipFixture {
  const encoder = new TextEncoder();
  const payloadParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  const placed: ZipFixture["entries"] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc32 = getCrc32(entry.bytes);
    const header = writeLocalHeader(nameBytes, crc32, entry.bytes.length);
    placed.push({
      name: entry.name,
      centralOffset: 0,
      localOffset: offset,
      dataStart: offset + header.length
    });
    payloadParts.push(header, entry.bytes);
    centralParts.push(
      writeCentralHeader(
        nameBytes,
        crc32,
        entry.bytes.length,
        offset,
        entry.centralExtraBytes ?? 0,
        entry.centralCommentBytes ?? 0
      )
    );
    offset += header.length + entry.bytes.length;
  }

  const centralDirectoryOffset = offset;
  let centralCursor = centralDirectoryOffset;
  centralParts.forEach((part, index) => {
    const place = placed[index];
    if (place) {
      place.centralOffset = centralCursor;
    }
    centralCursor += part.length;
  });
  const centralDirectorySize = centralCursor - centralDirectoryOffset;

  const end = new Uint8Array(END_RECORD_BYTES);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralDirectorySize, true);
  endView.setUint32(16, centralDirectoryOffset, true);

  const total =
    centralDirectoryOffset + centralDirectorySize + END_RECORD_BYTES;
  const bytes = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...payloadParts, ...centralParts, end]) {
    bytes.set(part, cursor);
    cursor += part.length;
  }

  return {
    bytes,
    centralDirectoryOffset,
    endRecordOffset: centralDirectoryOffset + centralDirectorySize,
    entries: placed
  };
}

/** Little-endian writers, so a test can state the mutation it makes in the field's own terms. */
export function patchUint16(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(offset, value, true);
}

export function patchUint32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
}

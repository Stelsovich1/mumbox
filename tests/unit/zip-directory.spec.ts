import { expect, test } from "@playwright/test";

import { getCrc32 } from "../../src/shared/lib/crc32";
import {
  beginCrc32Fold,
  checkZipWriteLimits,
  findEndOfCentralDirectory,
  foldCrc32Chunk,
  parseCentralDirectory,
  readEndRecord,
  resolveDataRange,
  verifyCrc32Fold,
  ZIP_END_RECORD_BYTES,
  ZIP_END_RECORD_SEARCH_BYTES,
  ZIP_LOCAL_HEADER_BYTES,
  ZIP_MAX_UINT32
} from "../../src/features/file-config/model/zipDirectory";
import { buildZip, patchUint16, patchUint32 } from "../support/zipFixtures";

/**
 * The reader's acceptance rules, now that they are reachable at all.
 *
 * `file-config/index.ts` imports `getMediaBlob`, which reaches `react` and `idb-keyval`, so the
 * unit tier could not load it and none of this could be tested. A mutant in the old reader could
 * only die if some e2e happened to walk the same path with exactly the right corrupt bytes.
 */

const encoder = new TextEncoder();

function fixture() {
  return buildZip([
    { name: "project.json", bytes: encoder.encode('{"kind":"mumbox-project"}') },
    { name: "media/media-1", bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }
  ]);
}

function readDirectory(zip: ReturnType<typeof buildZip>) {
  const offsetInTail = findEndOfCentralDirectory(zip.bytes);
  const end = readEndRecord(zip.bytes, offsetInTail, 0, zip.bytes.length);
  if (!end.ok) {
    throw new Error(`end record rejected: ${end.reason}`);
  }
  const directory = zip.bytes.subarray(
    end.value.centralDirectoryOffset,
    end.value.endRecordOffset
  );
  return { end: end.value, directory };
}

test.describe("findEndOfCentralDirectory", () => {
  test("finds the record in a clean archive", () => {
    const zip = fixture();
    expect(findEndOfCentralDirectory(zip.bytes)).toBe(zip.endRecordOffset);
  });

  test("returns -1 for a buffer too short to hold one", () => {
    expect(findEndOfCentralDirectory(new Uint8Array(8))).toBe(-1);
  });

  test("returns -1 when the signature is absent", () => {
    expect(findEndOfCentralDirectory(new Uint8Array(200))).toBe(-1);
  });

  test("prefers the last occurrence, so entry data cannot impersonate it", () => {
    // The scan runs backwards for exactly this: a media file containing the four signature bytes
    // would otherwise win over the real record.
    const zip = buildZip([
      { name: "media/decoy", bytes: new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]) }
    ]);
    expect(findEndOfCentralDirectory(zip.bytes)).toBe(zip.endRecordOffset);
  });

  test("does not look further back than the comment field allows", () => {
    const zip = fixture();
    const padded = new Uint8Array(zip.bytes.length + ZIP_END_RECORD_SEARCH_BYTES + 64);
    padded.set(zip.bytes, 0);
    expect(findEndOfCentralDirectory(padded)).toBe(-1);
  });
});

test.describe("readEndRecord", () => {
  test("accepts a clean archive", () => {
    const zip = fixture();
    const result = readEndRecord(zip.bytes, zip.endRecordOffset, 0, zip.bytes.length);
    expect(result.ok).toBe(true);
  });

  test("rejects a multi-disk archive", () => {
    const zip = fixture();
    patchUint16(zip.bytes, zip.endRecordOffset + 4, 1);
    const result = readEndRecord(zip.bytes, zip.endRecordOffset, 0, zip.bytes.length);
    expect(result.ok).toBe(false);
  });

  test("rejects a disagreement between entries-on-disk and the total", () => {
    const zip = fixture();
    patchUint16(zip.bytes, zip.endRecordOffset + 8, 5);
    const result = readEndRecord(zip.bytes, zip.endRecordOffset, 0, zip.bytes.length);
    expect(result.ok).toBe(false);
  });

  test("rejects a shifted directory offset", () => {
    // One equality catches a padded, shifted or partly rewritten directory, and it is strictly
    // stronger than the old "the offset is before the end record" check.
    const zip = fixture();
    patchUint32(zip.bytes, zip.endRecordOffset + 16, zip.centralDirectoryOffset + 1);
    const result = readEndRecord(zip.bytes, zip.endRecordOffset, 0, zip.bytes.length);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toBe("bad-end-record");
  });

  test("rejects a directory offset shifted in EITHER direction", () => {
    // The check is an equality precisely so both directions are caught. Only the upward shift
    // was covered, so relaxing it to a one-sided comparison survived a mutation round - and a
    // stale or partly rewritten directory shifts DOWN.
    for (const delta of [-1, 1]) {
      const zip = fixture();
      patchUint32(zip.bytes, zip.endRecordOffset + 16, zip.centralDirectoryOffset + delta);
      const result = readEndRecord(zip.bytes, zip.endRecordOffset, 0, zip.bytes.length);
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.reason).toBe("bad-end-record");
    }
  });

  test("names a ZIP64 archive rather than failing it as out of bounds", () => {
    const zip = fixture();
    patchUint16(zip.bytes, zip.endRecordOffset + 8, 0xffff);
    patchUint16(zip.bytes, zip.endRecordOffset + 10, 0xffff);
    const result = readEndRecord(zip.bytes, zip.endRecordOffset, 0, zip.bytes.length);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toBe("zip64-unsupported");
  });
});

test.describe("parseCentralDirectory", () => {
  test("reads both entries, decoding a Cyrillic name", () => {
    const zip = buildZip([
      { name: "project.json", bytes: encoder.encode("{}") },
      { name: "media/трек", bytes: new Uint8Array([9]) }
    ]);
    const { end, directory } = readDirectory(zip);
    const result = parseCentralDirectory(directory, end);
    expect(result.ok).toBe(true);
    expect(result.ok ? result.value.map((entry) => entry.name) : []).toEqual([
      "project.json",
      "media/трек"
    ]);
  });

  test("rejects a declared count above what the directory holds", () => {
    const zip = fixture();
    patchUint16(zip.bytes, zip.endRecordOffset + 8, 3);
    patchUint16(zip.bytes, zip.endRecordOffset + 10, 3);
    const offsetInTail = findEndOfCentralDirectory(zip.bytes);
    const end = readEndRecord(zip.bytes, offsetInTail, 0, zip.bytes.length);
    expect(end.ok).toBe(true);
    if (!end.ok) {
      return;
    }
    const directory = zip.bytes.subarray(end.value.centralDirectoryOffset, end.value.endRecordOffset);
    const result = parseCentralDirectory(directory, end.value);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toBe("truncated-central-directory");
  });

  test("rejects a declared count below what the directory holds", () => {
    const zip = fixture();
    const { end, directory } = readDirectory(zip);
    const result = parseCentralDirectory(directory, { ...end, entryCount: 1 });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toBe("entry-count-mismatch");
  });

  test("rejects a deflated entry", () => {
    const zip = fixture();
    const { end, directory } = readDirectory(zip);
    patchUint16(directory, 10, 8);
    const result = parseCentralDirectory(directory, end);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toBe("unsupported-compression");
  });

  test("rejects a data descriptor, whose sizes live after the payload", () => {
    const zip = fixture();
    const { end, directory } = readDirectory(zip);
    patchUint16(directory, 8, 0x0808);
    const result = parseCentralDirectory(directory, end);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toBe("unsupported-entry-flags");
  });

  test("rejects a stored entry whose two sizes disagree", () => {
    // The old reader read `compressedSize` and ignored `uncompressedSize` entirely.
    const zip = fixture();
    const { end, directory } = readDirectory(zip);
    patchUint32(directory, 24, 999);
    const result = parseCentralDirectory(directory, end);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toBe("size-mismatch");
  });

  test("rejects a duplicate entry name", () => {
    // Ranges were keyed by name in a Map, so the later record silently won.
    const zip = buildZip([
      { name: "media/media-1", bytes: new Uint8Array([1]) },
      { name: "media/media-1", bytes: new Uint8Array([2]) }
    ]);
    const { end, directory } = readDirectory(zip);
    const result = parseCentralDirectory(directory, end);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toBe("duplicate-entry-name");
  });

  test("rejects an entry whose payload would overlap the directory", () => {
    const zip = fixture();
    const { end, directory } = readDirectory(zip);
    patchUint32(directory, 20, 100_000);
    patchUint32(directory, 24, 100_000);
    const result = parseCentralDirectory(directory, end);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toBe("entry-out-of-bounds");
  });

  test("accepts an entry ending exactly at the directory", () => {
    // The boundary, which is what tells a `>` from a `>=`.
    const zip = fixture();
    const { end, directory } = readDirectory(zip);
    const result = parseCentralDirectory(directory, end);
    expect(result.ok).toBe(true);
  });
});

test.describe("resolveDataRange", () => {
  test("resolves the payload from the local header", () => {
    const zip = fixture();
    const { end, directory } = readDirectory(zip);
    const parsed = parseCentralDirectory(directory, end);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const entry = parsed.value[1];
    const place = zip.entries[1];
    expect(entry).toBeDefined();
    expect(place).toBeDefined();
    if (!entry || !place) {
      return;
    }
    const header = zip.bytes.subarray(
      entry.localOffset,
      entry.localOffset + ZIP_LOCAL_HEADER_BYTES
    );
    const range = resolveDataRange(entry, header, end);
    expect(range.ok).toBe(true);
    expect(range.ok ? range.value.start : -1).toBe(place.dataStart);
  });

  test("rejects a local header whose CRC disagrees with the directory", () => {
    // A file edited in one place and not the other.
    const zip = fixture();
    const { end, directory } = readDirectory(zip);
    const parsed = parseCentralDirectory(directory, end);
    if (!parsed.ok) {
      throw new Error("directory rejected");
    }
    const entry = parsed.value[1];
    if (!entry) {
      throw new Error("entry missing");
    }
    const header = new Uint8Array(
      zip.bytes.subarray(entry.localOffset, entry.localOffset + ZIP_LOCAL_HEADER_BYTES)
    );
    patchUint32(header, 14, 0xdeadbeef);
    const range = resolveDataRange(entry, header, end);
    expect(range.ok).toBe(false);
    expect(range.ok ? "" : range.reason).toBe("header-mismatch");
  });

  test("rejects a header with the wrong signature", () => {
    const zip = fixture();
    const { end, directory } = readDirectory(zip);
    const parsed = parseCentralDirectory(directory, end);
    if (!parsed.ok) {
      throw new Error("directory rejected");
    }
    const entry = parsed.value[0];
    if (!entry) {
      throw new Error("entry missing");
    }
    const header = new Uint8Array(ZIP_LOCAL_HEADER_BYTES);
    const range = resolveDataRange(entry, header, end);
    expect(range.ok).toBe(false);
    expect(range.ok ? "" : range.reason).toBe("bad-local-header");
  });
});

test.describe("crc fold", () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  test("one chunk equals the whole-buffer helper", () => {
    const fold = foldCrc32Chunk(beginCrc32Fold(), bytes);
    expect(verifyCrc32Fold(fold, { crc32: getCrc32(bytes), size: bytes.length })).toBe(true);
  });

  test("chunk size does not change the result", () => {
    let fold = beginCrc32Fold();
    for (let index = 0; index < bytes.length; index += 3) {
      fold = foldCrc32Chunk(fold, bytes.subarray(index, index + 3));
    }
    expect(verifyCrc32Fold(fold, { crc32: getCrc32(bytes), size: bytes.length })).toBe(true);
  });

  test("a single flipped bit is caught", () => {
    const corrupt = new Uint8Array(bytes);
    corrupt[4] = (corrupt[4] ?? 0) ^ 0x01;
    const fold = foldCrc32Chunk(beginCrc32Fold(), corrupt);
    expect(verifyCrc32Fold(fold, { crc32: getCrc32(bytes), size: bytes.length })).toBe(false);
  });

  test("a short read is caught even when the checksum would agree", () => {
    // This is why the byte counter exists beside the checksum: `File.slice` past the end of a file
    // yields FEWER bytes with no error, and the CRC of zero bytes is 0 — which would match any
    // entry whose recorded CRC happens to be 0.
    const fold = beginCrc32Fold();
    expect(verifyCrc32Fold(fold, { crc32: 0, size: 0 })).toBe(true);
    expect(verifyCrc32Fold(fold, { crc32: 0, size: 10 })).toBe(false);
  });

  test("folds a subarray view correctly", () => {
    const backing = new Uint8Array([255, 255, ...bytes, 255]);
    const window = backing.subarray(2, 2 + bytes.length);
    const fold = foldCrc32Chunk(beginCrc32Fold(), window);
    expect(verifyCrc32Fold(fold, { crc32: getCrc32(bytes), size: bytes.length })).toBe(true);
  });
});

test.describe("checkZipWriteLimits", () => {
  test("computes the archive size the writer will produce", () => {
    const result = checkZipWriteLimits([{ name: "a", size: 10 }]);
    expect(result.ok).toBe(true);
    // 30 + 1 + 10 payload, 46 + 1 central, 22 end.
    expect(result.archiveBytes).toBe(30 + 1 + 10 + 46 + 1 + ZIP_END_RECORD_BYTES);
  });

  test("counts a multi-byte name by its byte length", () => {
    const ascii = checkZipWriteLimits([{ name: "ab", size: 0 }]);
    const cyrillic = checkZipWriteLimits([{ name: "аб", size: 0 }]);
    expect(cyrillic.archiveBytes).toBeGreaterThan(ascii.archiveBytes);
  });

  test("refuses an entry over the per-entry limit, at the boundary", () => {
    expect(checkZipWriteLimits([{ name: "a", size: 100 }], { maxEntryBytes: 100 }).ok).toBe(true);
    const over = checkZipWriteLimits([{ name: "a", size: 101 }], { maxEntryBytes: 100 });
    expect(over.ok).toBe(false);
    expect(over.ok ? "" : over.reason).toBe("entry-too-large");
  });

  test("refuses an archive that crosses the limit through header overhead alone", () => {
    // No single entry is over, but the sum of headers pushes the total past it — the case a
    // per-entry-only check would miss.
    const entries = Array.from({ length: 10 }, (_, index) => ({
      name: `media/${String(index)}`,
      size: 90
    }));
    const result = checkZipWriteLimits(entries, { maxArchiveBytes: 1000 });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toBe("archive-too-large");
  });

  test("refuses an entry count the READER would reject", () => {
    // The limit is exclusive, and that is the point rather than an off-by-one. `readEndRecord`
    // treats an entry count of exactly `ZIP_MAX_UINT16` as the ZIP64 sentinel and refuses it, so a
    // writer that accepted that many produced a well-formed file this same build then called too
    // large - a failure with no explanation and nothing the user could do about it.
    const entries = Array.from({ length: 3 }, (_, index) => ({ name: String(index), size: 1 }));
    expect(checkZipWriteLimits(entries, { maxEntryCount: 4 }).ok).toBe(true);
    const atLimit = checkZipWriteLimits(entries, { maxEntryCount: 3 });
    expect(atLimit.ok).toBe(false);
    expect(atLimit.ok ? "" : atLimit.reason).toBe("too-many-entries");
    const over = checkZipWriteLimits(entries, { maxEntryCount: 2 });
    expect(over.ok).toBe(false);
    expect(over.ok ? "" : over.reason).toBe("too-many-entries");
  });

  test("enforces the real uint32 default without allocating anything", () => {
    // Sizes are numbers, so four gigabytes costs nothing to express — which is the whole reason the
    // limits are injectable and the defaults are the real ones.
    // 30 bytes of local header plus a one-byte name push this past the uint32 ceiling, while the
    // entry itself is still under the per-entry limit — so it is the ARCHIVE total that refuses.
    const over = checkZipWriteLimits([{ name: "a", size: ZIP_MAX_UINT32 - 10 }]);
    expect(over.ok).toBe(false);
    expect(over.ok ? "" : over.reason).toBe("archive-too-large");
    expect(checkZipWriteLimits([{ name: "a", size: 1024 }]).ok).toBe(true);
  });
});

test.describe("central-directory padding", () => {
  test("steps over extra fields and entry comments", () => {
    // The production writer emits neither, so this went unverified: hardcoding the extra length
    // to zero survived a mutation round. Any project file that has been through a
    // general-purpose zip tool - which is how a user would recover one by hand - carries them,
    // and misreading their length lands the cursor mid-record on the next entry.
    const zip = buildZip([
      {
        name: "project.json",
        bytes: encoder.encode("{}"),
        centralExtraBytes: 8,
        centralCommentBytes: 5
      },
      { name: "media/media-1", bytes: new Uint8Array([1, 2, 3]), centralExtraBytes: 4 }
    ]);
    const { end, directory } = readDirectory(zip);
    const result = parseCentralDirectory(directory, end);
    expect(result.ok).toBe(true);
    expect(result.ok ? result.value.map((entry) => entry.name) : []).toEqual([
      "project.json",
      "media/media-1"
    ]);
  });
});

test.describe("entry names and payload bounds", () => {
  test("rejects an entry with an empty or NUL-bearing name", () => {
    // Untested until now, so the guard could be deleted outright. An empty name lands as an `""`
    // key in the reader's name map, where it can shadow nothing and match nothing; a NUL is how a
    // truncated name is smuggled past a comparison that stops at the terminator.
    for (const name of ["", "media/\u0000hidden"]) {
      const zip = buildZip([{ name, bytes: new Uint8Array([1]) }]);
      const { end, directory } = readDirectory(zip);
      const result = parseCentralDirectory(directory, end);
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.reason).toBe("bad-entry-name");
    }
  });

  test("refuses a payload that would run into the central directory", () => {
    // The one case `parseCentralDirectory` structurally cannot see. It bounds an entry using the
    // CENTRAL header's name length and no extra field, while the payload actually starts after the
    // LOCAL header's name and extra lengths - which ZIP permits to differ. Inflating the local
    // extra length therefore slides the data window forward past the end of the payload, and
    // without this guard the reader hands back bytes of the central directory as audio.
    const zip = buildZip([
      { name: "project.json", bytes: encoder.encode("{}") },
      { name: "media/media-1", bytes: new Uint8Array([1, 2, 3, 4]) }
    ]);
    const entry = zip.entries[1];
    if (!entry) {
      throw new Error("fixture");
    }
    // Local header extra-field length lives at +28.
    patchUint16(zip.bytes, entry.localOffset + 28, 4096);
    const { end, directory } = readDirectory(zip);
    const parsed = parseCentralDirectory(directory, end);
    expect(parsed.ok).toBe(true);
    const record = parsed.ok ? parsed.value[1] : undefined;
    if (!record) {
      throw new Error("fixture");
    }
    const localHeader = zip.bytes.subarray(entry.localOffset, entry.localOffset + 30);
    const range = resolveDataRange(record, localHeader, end);
    expect(range.ok).toBe(false);
    expect(range.ok ? "" : range.reason).toBe("entry-out-of-bounds");
  });
});

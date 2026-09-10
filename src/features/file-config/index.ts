import { getMediaBlob } from "../../app/model/appState";
import { SerializableAppState } from "../../app/model/appState";
import { computeContentHash } from "../../shared/lib/contentHash";
import { CRC32_INITIAL, finalizeCrc32, updateCrc32 } from "../../shared/lib/crc32";
import { FileHandleLike, writeBlobToHandle } from "../../shared/lib/fileSystemAccess";
import { ProjectFileError } from "./model/projectFileError";
import { normalizeProjectMeta, ProjectMeta, toProjectFileName } from "./model/projectMeta";
import { parseProjectManifest } from "./model/projectManifest";
export type { ProjectFile, ProjectMediaBlob } from "./model/projectManifest";
import type { ProjectFile, ProjectMediaBlob } from "./model/projectManifest";
import {
  beginCrc32Fold,
  checkZipWriteLimits,
  findEndOfCentralDirectory,
  foldCrc32Chunk,
  parseCentralDirectory,
  readEndRecord,
  resolveDataRange,
  verifyCrc32Fold,
  ZIP_END_RECORD_SEARCH_BYTES,
  ZIP_LOCAL_HEADER_BYTES,
  ZipCentralEntry,
  ZipDataRange
} from "./model/zipDirectory";

export { normalizeProjectMeta, toProjectFileName };
export type { ProjectMeta };
export { ProjectFileError, classifyProjectFileError } from "./model/projectFileError";
export type { ProjectFileFailureKind } from "./model/projectFileError";

export const PROJECT_FILE_EXTENSION = ".mumbox";
export const PROJECT_FILE_MIME_TYPE = "application/vnd.mumbox.project+zip";
export const PROJECT_FILE_ACCEPT_TYPES = [
  PROJECT_FILE_EXTENSION,
  PROJECT_FILE_MIME_TYPE,
  "application/zip"
].join(",");
// iOS Safari ignores unknown extensions like .mumbox and matches only MIME types.
export const PROJECT_FILE_ACCEPT_TYPES_MOBILE = [
  PROJECT_FILE_EXTENSION,
  PROJECT_FILE_MIME_TYPE,
  "application/zip",
  "application/octet-stream"
].join(",");
export const LARGE_PROJECT_IMPORT_BYTES = 100 * 1024 * 1024;
const PROJECT_MANIFEST_NAME = "project.json";
const PROJECT_MEDIA_DIR = "media/";

export type SaveProjectResult = {
  fileName: string;
  completed: boolean;
};

export type ImportedProject = {
  state: SerializableAppState;
  meta: ProjectMeta;
  mediaBlobs: { id: string; fileName: string; mimeType: string; crc32: number; blob: Blob }[];
};

export type ProjectFileProgress = {
  phase: "export" | "import";
  completed: number;
  total: number;
  label: string;
};

function writeUint16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}

function writeUint32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value, true);
}

function makeZipLocalHeader(nameBytes: Uint8Array, crc32: number, size: number) {
  const buffer = new ArrayBuffer(30 + nameBytes.length);
  const view = new DataView(buffer);
  writeUint32(view, 0, 0x04034b50);
  writeUint16(view, 4, 20);
  writeUint16(view, 6, 0x0800);
  writeUint16(view, 8, 0);
  writeUint16(view, 10, 0);
  writeUint16(view, 12, 0);
  writeUint32(view, 14, crc32);
  writeUint32(view, 18, size);
  writeUint32(view, 22, size);
  writeUint16(view, 26, nameBytes.length);
  writeUint16(view, 28, 0);
  new Uint8Array(buffer, 30).set(nameBytes);
  return buffer;
}

function makeZipCentralHeader(nameBytes: Uint8Array, crc32: number, size: number, localOffset: number) {
  const buffer = new ArrayBuffer(46 + nameBytes.length);
  const view = new DataView(buffer);
  writeUint32(view, 0, 0x02014b50);
  writeUint16(view, 4, 20);
  writeUint16(view, 6, 20);
  writeUint16(view, 8, 0x0800);
  writeUint16(view, 10, 0);
  writeUint16(view, 12, 0);
  writeUint16(view, 14, 0);
  writeUint32(view, 16, crc32);
  writeUint32(view, 20, size);
  writeUint32(view, 24, size);
  writeUint16(view, 28, nameBytes.length);
  writeUint16(view, 30, 0);
  writeUint16(view, 32, 0);
  writeUint16(view, 34, 0);
  writeUint16(view, 36, 0);
  writeUint32(view, 38, 0);
  writeUint32(view, 42, localOffset);
  new Uint8Array(buffer, 46).set(nameBytes);
  return buffer;
}

function makeZipEndRecord(entryCount: number, centralDirectorySize: number, centralDirectoryOffset: number) {
  const buffer = new ArrayBuffer(22);
  const view = new DataView(buffer);
  writeUint32(view, 0, 0x06054b50);
  writeUint16(view, 4, 0);
  writeUint16(view, 6, 0);
  writeUint16(view, 8, entryCount);
  writeUint16(view, 10, entryCount);
  writeUint32(view, 12, centralDirectorySize);
  writeUint32(view, 16, centralDirectoryOffset);
  writeUint16(view, 20, 0);
  return buffer;
}

/**
 * How much of an entry is held in memory at once while its CRC is computed.
 *
 * A project is 700 MB - 1 GB of media, so the old shape — `await entry.blob.arrayBuffer()` per
 * entry — put a whole media file in memory just to checksum it, on top of the assembled output.
 * Reading in slices keeps the export peak at one slice, and the entry itself goes into the output
 * `Blob` by reference: a `Blob` built from other blobs does not copy their bytes.
 */
const ZIP_CRC_CHUNK_BYTES = 4 * 1024 * 1024;

async function getBlobCrc32(blob: Blob) {
  let state = CRC32_INITIAL;
  for (let offset = 0; offset < blob.size; offset += ZIP_CRC_CHUNK_BYTES) {
    const end = Math.min(blob.size, offset + ZIP_CRC_CHUNK_BYTES);
    const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    state = updateCrc32(state, chunk);
  }

  return finalizeCrc32(state);
}

/**
 * Refuses an archive that cannot be addressed by the format.
 *
 * Every size and offset in a ZIP local or central header is uint32, and `DataView.setUint32` takes
 * its value modulo 2^32 without complaint. So a project past 4 GiB produced a file that reported
 * success and no reader — including this one — could open. `CLAUDE.md` puts the working size at
 * 700 MB to 1 GB, so this is a guard rather than a limit anyone should meet.
 *
 * ZIP64 is deliberately not implemented. It is four coordinated additions (an extra field in both
 * header types, the ZIP64 end record, its locator, version-needed 45), written conditionally so a
 * build frozen at `version: 2` can still open the result, with a matching reader shipped at the
 * same time — and it cannot be fixtured at an honest size in CI. It would also buy the ability to
 * write a file the rest of the app cannot use: `saveProjectBlob` assembles ONE `Blob` and hands it
 * to `createWritable` or to an anchor, and on iOS — the only save path there — a 4 GiB blob URL
 * will not survive. Refusing is cheap, testable at any size through the injected limits, and turns
 * silent corruption into one sentence.
 */
function assertWritableArchive(entries: readonly { name: string; blob: Blob }[]) {
  const limits = checkZipWriteLimits(
    entries.map((entry) => ({ name: entry.name, size: entry.blob.size }))
  );
  if (!limits.ok) {
    throw new ProjectFileError("too-large", limits.reason);
  }
}

async function makeZipBlob(entries: { name: string; blob: Blob }[], onProgress?: (progress: ProjectFileProgress) => void) {
  // Authoritative: real blob sizes, checked before a single byte is assembled.
  assertWritableArchive(entries);
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const centralParts: ArrayBuffer[] = [];
  let offset = 0;
  const total = entries.length;

  for (const [index, entry] of entries.entries()) {
    const nameBytes = encoder.encode(entry.name);
    const crc32 = await getBlobCrc32(entry.blob);
    const localHeader = makeZipLocalHeader(nameBytes, crc32, entry.blob.size);
    parts.push(localHeader, entry.blob);
    centralParts.push(makeZipCentralHeader(nameBytes, crc32, entry.blob.size, offset));
    offset += localHeader.byteLength + entry.blob.size;
    onProgress?.({
      phase: "export",
      completed: index + 1,
      total,
      label: entry.name === PROJECT_MANIFEST_NAME ? "Сборка проекта" : `Упаковка аудио ${String(index)} из ${String(Math.max(0, total - 1))}`
    });
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
  }

  const centralDirectoryOffset = offset;
  const centralDirectorySize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
  return new Blob([...parts, ...centralParts, makeZipEndRecord(entries.length, centralDirectorySize, centralDirectoryOffset)], {
    type: PROJECT_FILE_MIME_TYPE
  });
}

function isZipFile(bytes: Uint8Array) {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * The end-of-central-directory record sits within the last 65 557 bytes: 22 bytes of record plus a
 * comment field that cannot exceed 65 535. Scanned backwards, so a comment that happens to contain
 * the signature does not win over the real record.
 */
/**
 * Local headers are separated by entry data, so each one is its own small read. They are issued in
 * batches rather than one at a time because a project can hold hundreds of media entries and the
 * reads are independent; the batch width matches the 24 used elsewhere for per-media work.
 */
const ZIP_HEADER_READ_BATCH = 24;

async function readSlice(file: File, start: number, end: number) {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/**
 * Reads a project without materialising it.
 *
 * The previous shape did `new Uint8Array(await file.arrayBuffer())` and then `bytes.slice(...)` per
 * entry — and `Uint8Array.slice` copies — so peak memory was the whole project plus a second copy
 * of every media byte: roughly 2 GB for a 1 GB project, which is reached before playback memory
 * ever matters. Here only the directory, the local headers and `project.json` are read; every media
 * entry stays a lazy `File.slice` view, and the third argument to `slice` stamps the MIME type
 * directly so the bytes are never wrapped or copied to fix it up.
 */
async function readZipProjectFile(file: File, onProgress?: (progress: ProjectFileProgress) => void): Promise<ImportedProject> {
  const tailStart = Math.max(0, file.size - ZIP_END_RECORD_SEARCH_BYTES);
  const tail = await readSlice(file, tailStart, file.size);
  const endOffsetInTail = findEndOfCentralDirectory(tail);
  if (endOffsetInTail < 0) {
    throw new ProjectFileError("not-a-project", "no-end-record");
  }

  const endRecord = readEndRecord(tail, endOffsetInTail, tailStart, file.size);
  if (!endRecord.ok) {
    throw new ProjectFileError(
      endRecord.reason === "zip64-unsupported" ? "too-large" : "corrupt",
      endRecord.reason
    );
  }

  const directory = await readSlice(
    file,
    endRecord.value.centralDirectoryOffset,
    endRecord.value.endRecordOffset
  );
  const parsedDirectory = parseCentralDirectory(directory, endRecord.value);
  if (!parsedDirectory.ok) {
    throw new ProjectFileError("corrupt", parsedDirectory.reason);
  }
  const centralEntries = parsedDirectory.value;

  // The local header's own name and extra fields are what fix where the data starts, and ZIP
  // permits them to differ from the central directory's — so they are read rather than assumed.
  const dataRanges = new Map<string, ZipDataRange>();
  const entriesByName = new Map<string, ZipCentralEntry>();
  for (let from = 0; from < centralEntries.length; from += ZIP_HEADER_READ_BATCH) {
    const batch = centralEntries.slice(from, from + ZIP_HEADER_READ_BATCH);
    const headers = await Promise.all(
      batch.map((entry) =>
        readSlice(file, entry.localOffset, entry.localOffset + ZIP_LOCAL_HEADER_BYTES)
      )
    );
    headers.forEach((header, offsetInBatch) => {
      const entry = batch[offsetInBatch];
      if (!entry) {
        throw new ProjectFileError("corrupt", "bad-local-header");
      }
      const range = resolveDataRange(entry, header, endRecord.value);
      if (!range.ok) {
        throw new ProjectFileError("corrupt", range.reason);
      }
      dataRanges.set(entry.name, range.value);
      entriesByName.set(entry.name, entry);
    });
    onProgress?.({
      phase: "import",
      completed: Math.min(centralEntries.length, from + batch.length),
      total: centralEntries.length,
      label: `Чтение проекта ${String(Math.min(centralEntries.length, from + batch.length))} из ${String(centralEntries.length)}`
    });
  }

  const manifestRange = dataRanges.get(PROJECT_MANIFEST_NAME);
  const manifestEntry = entriesByName.get(PROJECT_MANIFEST_NAME);
  if (!manifestRange || !manifestEntry) {
    throw new ProjectFileError("not-a-project", "no-manifest");
  }
  // The manifest is fully read anyway, so verifying it costs nothing and is always on. Media are a
  // different matter — see `verifyProjectMedia`.
  const manifestBytes = new Uint8Array(
    await file.slice(manifestRange.start, manifestRange.end).arrayBuffer()
  );
  if (
    !verifyCrc32Fold(foldCrc32Chunk(beginCrc32Fold(), manifestBytes), {
      crc32: manifestEntry.crc32,
      size: manifestEntry.compressedSize
    })
  ) {
    throw new ProjectFileError("corrupt", "manifest-crc");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new ProjectFileError("corrupt", "manifest-json");
  }
  const manifest = parseProjectManifest(parsed);
  if (!manifest.ok) {
    throw new ProjectFileError(
      manifest.reason === "wrong-kind" || manifest.reason === "not-an-object"
        ? "not-a-project"
        : "corrupt",
      manifest.reason
    );
  }

  return {
    state: manifest.value.state,
    meta: normalizeProjectMeta(manifest.value.meta),
    mediaBlobs: manifest.value.mediaBlobs.map((media) => {
      const name = `${PROJECT_MEDIA_DIR}${media.id}`;
      const range = dataRanges.get(name);
      const entry = entriesByName.get(name);
      if (!range || !entry) {
        throw new ProjectFileError("corrupt", `missing-media:${media.fileName}`);
      }
      return {
        id: media.id,
        fileName: media.fileName,
        mimeType: media.mimeType,
        // Carried so `verifyProjectMedia` can check the bytes without re-reading the directory.
        crc32: entry.crc32,
        blob: file.slice(range.start, range.end, media.mimeType)
      };
    })
  };
}

/**
 * Reads every media entry and checks it against the CRC the archive recorded.
 *
 * Deliberately NOT part of `readProjectFile`. That function is also called by
 * `addProjectsToLibrary`, once per file the user picks, purely to read the project name and two
 * counts for a bookmark row — verifying there would read every byte of every project just to build
 * a list. Structural checks are O(entries) and always on; content verification is O(bytes) and
 * asked for explicitly, on the one path that is about to overwrite the user's project.
 *
 * Sequential and chunked, so the peak is one 4 MiB slice rather than one media file.
 */
export async function verifyProjectMedia(
  project: ImportedProject,
  onProgress?: (progress: ProjectFileProgress) => void
): Promise<void> {
  const total = project.mediaBlobs.length;
  for (const [index, media] of project.mediaBlobs.entries()) {
    let fold = beginCrc32Fold();
    for (let offset = 0; offset < media.blob.size; offset += ZIP_CRC_CHUNK_BYTES) {
      const end = Math.min(media.blob.size, offset + ZIP_CRC_CHUNK_BYTES);
      const chunk = new Uint8Array(await media.blob.slice(offset, end).arrayBuffer());
      fold = foldCrc32Chunk(fold, chunk);
    }
    if (!verifyCrc32Fold(fold, { crc32: media.crc32, size: media.blob.size })) {
      throw new ProjectFileError("corrupt", `media-crc:${media.fileName}`);
    }
    onProgress?.({
      phase: "import",
      completed: index + 1,
      total,
      label: `Проверка аудио ${String(index + 1)} из ${String(total)}`
    });
  }
}

export type MakeProjectBlobOptions = {
  meta?: ProjectMeta;
  onProgress?: (progress: ProjectFileProgress) => void;
  /**
   * Called with any content hash computed along the way. The caller stores the result so a media
   * asset is hashed at most once per session — which is what keeps the cost bearable, because
   * `crypto.subtle.digest` has no incremental form and hashing therefore does need the whole blob
   * in memory. That is the one remaining full-file read in an export, and it is bounded to a single
   * media file at a time: the CRC beside it reads in slices, and entry bytes reach the output blob
   * by reference.
   */
  onHash?: (hashes: { mediaId: string; contentHash: string }[]) => void;
};

export async function makeProjectBlob(
  state: SerializableAppState,
  options: MakeProjectBlobOptions = {}
) {
  const { meta, onProgress, onHash } = options;
  // Pre-flight from metadata alone, before the multi-minute CRC-and-hash pass. `media.size` is
  // optional and can be stale, so this can only UNDER-estimate — the safe direction, with the
  // authoritative check on real blob sizes still waiting in `makeZipBlob`.
  assertWritableArchive(
    state.media.map((media) => ({
      name: `${PROJECT_MEDIA_DIR}${media.id}`,
      blob: { size: media.size } as Blob
    }))
  );
  const mediaBlobs: ProjectMediaBlob[] = [];
  const entries: { name: string; blob: Blob }[] = [];
  const computedHashes: { mediaId: string; contentHash: string }[] = [];

  for (const [index, media] of state.media.entries()) {
    const blob = await getMediaBlob(media.id);
    if (!blob) {
      throw new Error(`Missing media blob: ${media.fileName}`);
    }
    let contentHash = media.contentHash;
    if (!contentHash) {
      // Sequential by contract: hashing several large blobs at once multiplies the transient
      // memory that gets a mobile tab killed.
      contentHash = (await computeContentHash(blob)) ?? undefined;
      if (contentHash) {
        computedHashes.push({ mediaId: media.id, contentHash });
      }
    }
    mediaBlobs.push({
      id: media.id,
      fileName: media.fileName,
      mimeType: media.mimeType,
      size: blob.size,
      contentHash
    });
    entries.push({
      name: `${PROJECT_MEDIA_DIR}${media.id}`,
      blob: blob.type ? blob : new Blob([blob], { type: media.mimeType })
    });
    onProgress?.({
      phase: "export",
      completed: index,
      total: Math.max(1, state.media.length),
      label: `Подготовка аудио ${String(index + 1)} из ${String(state.media.length)}`
    });
  }

  if (computedHashes.length > 0) {
    onHash?.(computedHashes);
  }

  const hashByMediaId = new Map(mediaBlobs.map((item) => [item.id, item.contentHash]));
  const project: ProjectFile = {
    kind: "mumbox-project",
    version: 2,
    exportedAt: new Date().toISOString(),
    ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
    state: {
      ...state,
      media: state.media.map((media) => {
        const contentHash = media.contentHash ?? hashByMediaId.get(media.id);

        return contentHash ? { ...media, contentHash } : media;
      })
    },
    mediaBlobs
  };

  entries.unshift({
    name: PROJECT_MANIFEST_NAME,
    blob: new Blob([JSON.stringify(project)], { type: "application/json" })
  });

  return makeZipBlob(entries, onProgress);
}

/**
 * How long a download URL is kept alive after the click.
 *
 * Revoking synchronously is the documented way to leak nothing, and it is also how the download
 * gets cancelled on Safari and iOS — which is the ONLY save path there, since `showSaveFilePicker`
 * does not exist. The cost of waiting is that the blob stays resident for the interval, up to a
 * gigabyte on a large project; it is bounded and it is released.
 *
 * Not oversold: deferring the revoke removes one known cause of the iOS failure. It does not make a
 * gigabyte-sized blob URL reliable there.
 */
const DOWNLOAD_URL_TTL_MS = 60_000;

export function downloadProject(blob: Blob, requestedFileName?: string) {
  const fileName = toProjectFileName(requestedFileName ?? "");
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  // Firefox will not act on an anchor that is not in the document.
  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  let revoked = false;
  const revoke = () => {
    if (revoked) {
      return;
    }
    revoked = true;
    URL.revokeObjectURL(url);
  };
  window.setTimeout(revoke, DOWNLOAD_URL_TTL_MS);
  // A navigation before the timer would otherwise carry the blob into the next document.
  window.addEventListener("pagehide", revoke, { once: true });

  return fileName;
}

/**
 * Writes through a file handle where the browser has one — that path overwrites in place and can
 * report real completion — and falls back to a download everywhere else, where the browser owns the
 * destination and we never learn whether the user kept it.
 */
export async function saveProjectBlob(
  blob: Blob,
  requestedFileName?: string,
  handle?: FileHandleLike
): Promise<SaveProjectResult> {
  const fileName = toProjectFileName(requestedFileName ?? "");

  if (handle) {
    const written = await writeBlobToHandle(handle, blob);
    if (written) {
      return { fileName: handle.name, completed: true };
    }
  }

  return { fileName: downloadProject(blob, fileName), completed: false };
}

export async function readProjectFile(
  file: File,
  onProgress?: (progress: ProjectFileProgress) => void
): Promise<ImportedProject> {
  const header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (!isZipFile(header)) {
    throw new Error("Unsupported MUMBOX project file");
  }
  return readZipProjectFile(file, onProgress);
}

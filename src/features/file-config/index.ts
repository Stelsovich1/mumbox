import { getMediaBlob } from "../../app/model/appState";
import { SerializableAppState } from "../../app/model/appState";
import { computeContentHash } from "../../shared/lib/contentHash";
import { CRC32_INITIAL, finalizeCrc32, updateCrc32 } from "../../shared/lib/crc32";
import { FileHandleLike, writeBlobToHandle } from "../../shared/lib/fileSystemAccess";
import { normalizeProjectMeta, ProjectMeta, toProjectFileName } from "./model/projectMeta";

export { normalizeProjectMeta, toProjectFileName };
export type { ProjectMeta };

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

export type ProjectMediaBlob = {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  contentHash?: string;
};

export type ProjectFile = {
  kind: "mumbox-project";
  // Deliberately not bumped for `meta`. `isProjectFile` checks this exactly, and the app ships as a
  // PWA with `registerType: "prompt"`, so a user on an older build must still be able to open a
  // file a newer build wrote — and the other way round.
  version: 2;
  exportedAt: string;
  meta?: ProjectMeta;
  state: SerializableAppState;
  mediaBlobs: ProjectMediaBlob[];
};

export type ImportedProject = {
  state: SerializableAppState;
  meta: ProjectMeta;
  mediaBlobs: { id: string; fileName: string; mimeType: string; blob: Blob }[];
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

async function makeZipBlob(entries: { name: string; blob: Blob }[], onProgress?: (progress: ProjectFileProgress) => void) {
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
const ZIP_END_RECORD_SEARCH_BYTES = 65_557;
const ZIP_LOCAL_HEADER_BYTES = 30;
/**
 * Local headers are separated by entry data, so each one is its own small read. They are issued in
 * batches rather than one at a time because a project can hold hundreds of media entries and the
 * reads are independent; the batch width matches the 24 used elsewhere for per-media work.
 */
const ZIP_HEADER_READ_BATCH = 24;

function findEndOfCentralDirectory(bytes: Uint8Array) {
  const minOffset = Math.max(0, bytes.length - ZIP_END_RECORD_SEARCH_BYTES);
  for (let offset = bytes.length - 22; offset >= minOffset; offset -= 1) {
    if (
      bytes[offset] === 0x50 &&
      bytes[offset + 1] === 0x4b &&
      bytes[offset + 2] === 0x05 &&
      bytes[offset + 3] === 0x06
    ) {
      return offset;
    }
  }
  return -1;
}

async function readSlice(file: File, start: number, end: number) {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

function viewOf(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

type ZipCentralEntry = { name: string; localOffset: number; compressedSize: number };

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
    throw new Error("Unsupported MUMBOX project file");
  }

  const tailView = viewOf(tail);
  const entryCount = tailView.getUint16(endOffsetInTail + 10, true);
  const centralDirectoryOffset = tailView.getUint32(endOffsetInTail + 16, true);
  const centralDirectoryEnd = tailStart + endOffsetInTail;
  if (centralDirectoryOffset > centralDirectoryEnd) {
    throw new Error("Unsupported MUMBOX project file");
  }

  const directory = await readSlice(file, centralDirectoryOffset, centralDirectoryEnd);
  const directoryView = viewOf(directory);
  const decoder = new TextDecoder();
  const centralEntries: ZipCentralEntry[] = [];
  let cursor = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > directory.length || directoryView.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error("Unsupported MUMBOX project file");
    }
    const method = directoryView.getUint16(cursor + 10, true);
    const compressedSize = directoryView.getUint32(cursor + 20, true);
    const fileNameLength = directoryView.getUint16(cursor + 28, true);
    const extraLength = directoryView.getUint16(cursor + 30, true);
    const commentLength = directoryView.getUint16(cursor + 32, true);
    const localOffset = directoryView.getUint32(cursor + 42, true);
    if (method !== 0) {
      throw new Error("Unsupported MUMBOX project compression");
    }
    const name = decoder.decode(directory.subarray(cursor + 46, cursor + 46 + fileNameLength));
    centralEntries.push({ name, localOffset, compressedSize });
    cursor += 46 + fileNameLength + extraLength + commentLength;
  }

  // The local header's own name and extra fields are what fix where the data starts, and ZIP
  // permits them to differ from the central directory's — so they are read rather than assumed.
  const dataRanges = new Map<string, { start: number; end: number }>();
  for (let from = 0; from < centralEntries.length; from += ZIP_HEADER_READ_BATCH) {
    const batch = centralEntries.slice(from, from + ZIP_HEADER_READ_BATCH);
    const headers = await Promise.all(
      batch.map((entry) =>
        readSlice(file, entry.localOffset, entry.localOffset + ZIP_LOCAL_HEADER_BYTES)
      )
    );
    headers.forEach((header, offsetInBatch) => {
      const entry = batch[offsetInBatch];
      if (!entry || header.length < ZIP_LOCAL_HEADER_BYTES) {
        throw new Error("Unsupported MUMBOX project file");
      }
      const headerView = viewOf(header);
      const dataStart =
        entry.localOffset +
        ZIP_LOCAL_HEADER_BYTES +
        headerView.getUint16(26, true) +
        headerView.getUint16(28, true);
      dataRanges.set(entry.name, { start: dataStart, end: dataStart + entry.compressedSize });
    });
    onProgress?.({
      phase: "import",
      completed: Math.min(centralEntries.length, from + batch.length),
      total: centralEntries.length,
      label: `Чтение проекта ${String(Math.min(centralEntries.length, from + batch.length))} из ${String(centralEntries.length)}`
    });
  }

  const manifestRange = dataRanges.get(PROJECT_MANIFEST_NAME);
  if (!manifestRange) {
    throw new Error("Unsupported MUMBOX project file");
  }
  const parsed = JSON.parse(
    await file.slice(manifestRange.start, manifestRange.end).text()
  ) as unknown;
  if (!isProjectFile(parsed)) {
    throw new Error("Unsupported MUMBOX project file");
  }

  return {
    state: parsed.state,
    meta: normalizeProjectMeta(parsed.meta),
    mediaBlobs: parsed.mediaBlobs.map((media) => {
      const range = dataRanges.get(`${PROJECT_MEDIA_DIR}${media.id}`);
      if (!range) {
        throw new Error(`Missing media blob: ${media.fileName}`);
      }
      return {
        id: media.id,
        fileName: media.fileName,
        mimeType: media.mimeType,
        blob: file.slice(range.start, range.end, media.mimeType)
      };
    })
  };
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

export function downloadProject(blob: Blob, requestedFileName?: string) {
  const fileName = toProjectFileName(requestedFileName ?? "");
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);

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

function isProjectFile(value: unknown): value is ProjectFile {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ProjectFile>;

  return (
    candidate.kind === "mumbox-project" &&
    candidate.version === 2 &&
    Boolean(candidate.state) &&
    Array.isArray(candidate.mediaBlobs)
  );
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

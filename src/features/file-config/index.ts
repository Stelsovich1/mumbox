import { getMediaBlob } from "../../app/model/appState";
import { SerializableAppState } from "../../app/model/appState";

export const PROJECT_FILE_EXTENSION = ".mumbox";
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
};

export type ProjectFile = {
  kind: "mumbox-project";
  version: 2;
  exportedAt: string;
  state: SerializableAppState;
  mediaBlobs: ProjectMediaBlob[];
};

export type ImportedProject = {
  state: SerializableAppState;
  mediaBlobs: { id: string; fileName: string; mimeType: string; blob: Blob }[];
};

export type ProjectFileProgress = {
  phase: "export" | "import";
  completed: number;
  total: number;
  label: string;
};

function makeCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const crc32Table = makeCrc32Table();

function getCrc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc32Table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

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

async function makeZipBlob(entries: { name: string; blob: Blob }[], onProgress?: (progress: ProjectFileProgress) => void) {
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const centralParts: BlobPart[] = [];
  let offset = 0;
  const total = entries.length;

  for (const [index, entry] of entries.entries()) {
    const nameBytes = encoder.encode(entry.name);
    const bytes = new Uint8Array(await entry.blob.arrayBuffer());
    const crc32 = getCrc32(bytes);
    const localHeader = makeZipLocalHeader(nameBytes, crc32, bytes.byteLength);
    parts.push(localHeader, bytes);
    centralParts.push(makeZipCentralHeader(nameBytes, crc32, bytes.byteLength, offset));
    offset += localHeader.byteLength + bytes.byteLength;
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
  const centralDirectorySize = centralParts.reduce((sum, part) => sum + (part as ArrayBuffer).byteLength, 0);
  return new Blob([...parts, ...centralParts, makeZipEndRecord(entries.length, centralDirectorySize, centralDirectoryOffset)], {
    type: "application/vnd.mumbox.project+zip"
  });
}

function isZipFile(bytes: Uint8Array) {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function findEndOfCentralDirectory(bytes: Uint8Array) {
  const minOffset = Math.max(0, bytes.length - 65_557);
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

async function readZipProjectFile(file: File, onProgress?: (progress: ProjectFileProgress) => void): Promise<ImportedProject> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndOfCentralDirectory(bytes);
  if (endOffset < 0) {
    throw new Error("Unsupported MUMBOX project file");
  }

  const decoder = new TextDecoder();
  const entryCount = view.getUint16(endOffset + 10, true);
  const centralDirectoryOffset = view.getUint32(endOffset + 16, true);
  const entries = new Map<string, Blob>();
  let cursor = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error("Unsupported MUMBOX project file");
    }
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const fileNameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.slice(cursor + 46, cursor + 46 + fileNameLength));
    if (method !== 0) {
      throw new Error("Unsupported MUMBOX project compression");
    }

    const localFileNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localFileNameLength + localExtraLength;
    entries.set(name, new Blob([bytes.slice(dataStart, dataStart + compressedSize)]));
    cursor += 46 + fileNameLength + extraLength + commentLength;
    onProgress?.({
      phase: "import",
      completed: index + 1,
      total: entryCount,
      label: `Чтение проекта ${String(index + 1)} из ${String(entryCount)}`
    });
  }

  const manifestBlob = entries.get(PROJECT_MANIFEST_NAME);
  if (!manifestBlob) {
    throw new Error("Unsupported MUMBOX project file");
  }
  const parsed = JSON.parse(await manifestBlob.text()) as unknown;
  if (!isProjectFile(parsed)) {
    throw new Error("Unsupported MUMBOX project file");
  }

  return {
    state: parsed.state,
    mediaBlobs: parsed.mediaBlobs.map((media) => {
      const blob = entries.get(`${PROJECT_MEDIA_DIR}${media.id}`);
      if (!blob) {
        throw new Error(`Missing media blob: ${media.fileName}`);
      }
      return {
        id: media.id,
        fileName: media.fileName,
        mimeType: media.mimeType,
        blob: blob.type ? blob : new Blob([blob], { type: media.mimeType })
      };
    })
  };
}

export async function makeProjectBlob(
  state: SerializableAppState,
  onProgress?: (progress: ProjectFileProgress) => void
) {
  const mediaBlobs: ProjectMediaBlob[] = [];
  const entries: { name: string; blob: Blob }[] = [];

  for (const [index, media] of state.media.entries()) {
    const blob = await getMediaBlob(media.id);
    if (!blob) {
      throw new Error(`Missing media blob: ${media.fileName}`);
    }
    mediaBlobs.push({
      id: media.id,
      fileName: media.fileName,
      mimeType: media.mimeType,
      size: blob.size
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

  const project: ProjectFile = {
    kind: "mumbox-project",
    version: 2,
    exportedAt: new Date().toISOString(),
    state,
    mediaBlobs
  };

  entries.unshift({
    name: PROJECT_MANIFEST_NAME,
    blob: new Blob([JSON.stringify(project)], { type: "application/json" })
  });

  return makeZipBlob(entries, onProgress);
}

export function downloadProject(blob: Blob) {
  const fileName = `mumbox-project${PROJECT_FILE_EXTENSION}`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);

  return fileName;
}

export function saveProjectBlob(blob: Blob) {
  return Promise.resolve({ fileName: downloadProject(blob), completed: false });
}

export async function saveProjectFile(state: SerializableAppState) {
  const blob = await makeProjectBlob(state);
  return saveProjectBlob(blob);
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

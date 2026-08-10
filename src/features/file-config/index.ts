import { getMediaBlob } from "../../app/model/appState";
import { SerializableAppState } from "../../app/model/appState";

export const PROJECT_FILE_EXTENSION = ".mumbox";
export const LARGE_PROJECT_IMPORT_BYTES = 100 * 1024 * 1024;

export type SaveProjectResult = {
  fileName: string;
  completed: boolean;
};

export type ProjectMediaBlob = {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  dataBase64: string;
};

export type ProjectFile = {
  kind: "mumbox-project";
  version: 1;
  exportedAt: string;
  state: SerializableAppState;
  mediaBlobs: ProjectMediaBlob[];
};

export type ImportedProject = {
  state: SerializableAppState;
  mediaBlobs: { id: string; fileName: string; mimeType: string; blob: Blob }[];
};

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.includes(",") ? result.split(",")[1] ?? "" : result);
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Cannot read project media"));
    });
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(dataBase64: string, mimeType: string) {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: mimeType });
}

export async function makeProjectBlob(state: SerializableAppState) {
  const mediaBlobs = await Promise.all(
    state.media.map(async (media) => {
      const blob = await getMediaBlob(media.id);
      if (!blob) {
        throw new Error(`Missing media blob: ${media.fileName}`);
      }

      return {
        id: media.id,
        fileName: media.fileName,
        mimeType: media.mimeType,
        size: blob.size,
        dataBase64: await blobToBase64(blob)
      };
    })
  );
  const project: ProjectFile = {
    kind: "mumbox-project",
    version: 1,
    exportedAt: new Date().toISOString(),
    state,
    mediaBlobs
  };

  return new Blob([JSON.stringify(project)], {
    type: "application/json"
  });
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
    candidate.version === 1 &&
    Boolean(candidate.state) &&
    Array.isArray(candidate.mediaBlobs)
  );
}

export async function readProjectFile(file: File): Promise<ImportedProject> {
  const parsed = JSON.parse(await file.text()) as unknown;
  if (!isProjectFile(parsed)) {
    throw new Error("Unsupported MUMBOX project file");
  }

  return {
    state: parsed.state,
    mediaBlobs: parsed.mediaBlobs.map((media) => ({
      id: media.id,
      fileName: media.fileName,
      mimeType: media.mimeType,
      blob: base64ToBlob(media.dataBase64, media.mimeType)
    }))
  };
}

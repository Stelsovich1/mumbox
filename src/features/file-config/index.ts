import { SerializableAppState } from "../../app/model/appState";

type FileSystemWritableFileStreamLike = {
  write: (data: Blob) => Promise<void>;
  close: () => Promise<void>;
};

type FileSystemFileHandleLike = {
  name: string;
  createWritable: () => Promise<FileSystemWritableFileStreamLike>;
};

type SaveFilePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: {
      description: string;
      accept: Record<string, string[]>;
    }[];
  }) => Promise<FileSystemFileHandleLike>;
};

function makeConfigBlob(state: SerializableAppState) {
  return new Blob([JSON.stringify(state, null, 2)], {
    type: "application/json"
  });
}

export function downloadConfig(state: SerializableAppState) {
  const blob = makeConfigBlob(state);
  const fileName = "mumbox-config.json";
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);

  return fileName;
}

export async function saveConfigFile(state: SerializableAppState) {
  const pickerWindow = window as SaveFilePickerWindow;

  if (pickerWindow.showSaveFilePicker) {
    const handle = await pickerWindow.showSaveFilePicker({
      suggestedName: "mumbox-config.json",
      types: [
        {
          description: "MUMBOX config",
          accept: {
            "application/json": [".json"]
          }
        }
      ]
    });
    const writable = await handle.createWritable();
    await writable.write(makeConfigBlob(state));
    await writable.close();

    return handle.name;
  }

  return downloadConfig(state);
}

export async function readConfigFile(file: File) {
  return JSON.parse(await file.text()) as SerializableAppState;
}

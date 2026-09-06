/**
 * The only file that touches the File System Access API.
 *
 * TypeScript 5.8's `lib.dom` declares `FileSystemFileHandle` but not `showOpenFilePicker`,
 * `showSaveFilePicker`, `queryPermission`, `requestPermission` or `remove()`. Rather than adding a
 * dependency for those, the handle is declared structurally — which also means a unit test can
 * stand one up with a plain object literal.
 *
 * Everything here degrades: on Safari, iOS and Firefox there are no pickers at all, and the app
 * falls back to a download and a normal file input.
 */

export type FileHandleLike = {
  readonly name: string;
  getFile: () => Promise<File>;
  queryPermission?: (descriptor: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (descriptor: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
  createWritable?: (options?: { keepExistingData?: boolean }) => Promise<{
    write: (data: Blob) => Promise<void>;
    close: () => Promise<void>;
  }>;
  remove?: () => Promise<void>;
  isSameEntry?: (other: FileHandleLike) => Promise<boolean>;
};

type FilePickerWindow = {
  showOpenFilePicker?: (options?: {
    multiple?: boolean;
    excludeAcceptAllOption?: boolean;
    types?: { description?: string; accept: Record<string, string[]> }[];
  }) => Promise<FileHandleLike[]>;
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: { description?: string; accept: Record<string, string[]> }[];
  }) => Promise<FileHandleLike>;
};

const PROJECT_PICKER_TYPES = [
  {
    description: "Проект MUMBOX",
    accept: { "application/vnd.mumbox.project+zip": [".mumbox"] }
  }
];

function getPickerWindow(): FilePickerWindow {
  return window as unknown as FilePickerWindow;
}

export function supportsFilePickers() {
  const pickerWindow = getPickerWindow();

  return (
    typeof pickerWindow.showOpenFilePicker === "function" &&
    typeof pickerWindow.showSaveFilePicker === "function"
  );
}

/**
 * A handle rehydrated from IndexedDB can be anything — a browser that dropped support, or a value
 * a test wrote by hand. Validate before trusting it.
 */
export function isFileHandleLike(value: unknown): value is FileHandleLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as FileHandleLike).getFile === "function" &&
    typeof (value as FileHandleLike).name === "string"
  );
}

/**
 * Whether this specific handle can delete its own file. Detected per handle, never by browser
 * version: `remove()` landed in Chromium 110 and exists nowhere else.
 */
export function canRemoveFromDisk(handle: FileHandleLike | undefined) {
  return typeof handle?.remove === "function";
}

export async function pickProjectFilesToOpen(multiple: boolean) {
  const picker = getPickerWindow().showOpenFilePicker;
  if (!picker) {
    return null;
  }

  try {
    return await picker({ multiple, excludeAcceptAllOption: false, types: PROJECT_PICKER_TYPES });
  } catch {
    // The user dismissed the picker.
    return null;
  }
}

export async function pickProjectFileToSave(suggestedName: string) {
  const picker = getPickerWindow().showSaveFilePicker;
  if (!picker) {
    return null;
  }

  try {
    return await picker({ suggestedName, types: PROJECT_PICKER_TYPES });
  } catch {
    return null;
  }
}

export async function writeBlobToHandle(handle: FileHandleLike, blob: Blob) {
  if (!handle.createWritable) {
    return false;
  }

  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();

  return true;
}

/**
 * Asks for permission, but only when it is not already granted. `readwrite` in particular consumes
 * user activation, so it is requested lazily at the moment the user asks for a destructive action.
 */
export async function requestHandlePermission(
  handle: FileHandleLike,
  mode: "read" | "readwrite"
): Promise<PermissionState | "unsupported"> {
  if (!handle.queryPermission || !handle.requestPermission) {
    return "unsupported";
  }

  try {
    const current = await handle.queryPermission({ mode });
    if (current === "granted") {
      return current;
    }

    return await handle.requestPermission({ mode });
  } catch {
    return "denied";
  }
}

export async function queryHandlePermission(
  handle: FileHandleLike,
  mode: "read" | "readwrite"
): Promise<PermissionState | "unsupported"> {
  if (!handle.queryPermission) {
    return "unsupported";
  }

  try {
    return await handle.queryPermission({ mode });
  } catch {
    return "denied";
  }
}

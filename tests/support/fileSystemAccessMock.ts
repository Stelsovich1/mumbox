import type { Page } from "@playwright/test";

/**
 * Controls the File System Access API inside the page.
 *
 * `mode: "unsupported"` deletes the globals, which is what most tests want: headless Chromium does
 * expose `showSaveFilePicker`, so without this a save would open a native dialog and
 * `waitForEvent("download")` would hang until the test times out rather than failing fast.
 *
 * `mode: "handles"` installs fakes whose behaviour each test picks: whether a permission is already
 * granted, whether the file still exists, and whether the handle can delete itself.
 */
export type FilePickerMockOptions = {
  mode: "unsupported" | "handles";
  /** What `queryPermission` reports before anything is requested. */
  permission?: PermissionState;
  /** When true, `getFile()` throws NotFoundError, as a moved or deleted file does. */
  missing?: boolean;
  /** When false, the handle has no `remove()` — the pre-110 Chromium and every other browser. */
  removable?: boolean;
  /** File name the save picker returns. */
  saveName?: string;
  /** File names the open picker returns, one handle each. */
  openNames?: string[];
  /** Makes both pickers reject, exactly as a dismissed native dialog does. */
  cancel?: boolean;
};

type PickerCalls = {
  save: number;
  open: number;
  requestPermission: number;
  remove: string[];
  written: number;
};

type PickerWindow = Window & { __mumboxPickerCalls?: PickerCalls };

export async function installFilePickerMock(page: Page, options: FilePickerMockOptions) {
  await page.addInitScript((config: FilePickerMockOptions) => {
    const pickerWindow = window as PickerWindow;
    pickerWindow.__mumboxPickerCalls = {
      save: 0,
      open: 0,
      requestPermission: 0,
      remove: [],
      written: 0
    };

    if (config.mode === "unsupported") {
      Reflect.deleteProperty(window, "showSaveFilePicker");
      Reflect.deleteProperty(window, "showOpenFilePicker");
      return;
    }

    const calls = pickerWindow.__mumboxPickerCalls;
    let permission: PermissionState = config.permission ?? "granted";

    const makeHandle = (name: string) => {
      const handle: Record<string, unknown> = {
        name,
        getFile: () => {
          if (config.missing) {
            return Promise.reject(new DOMException("not found", "NotFoundError"));
          }
          if (permission !== "granted") {
            return Promise.reject(new DOMException("denied", "NotAllowedError"));
          }

          return Promise.resolve(new File([new Uint8Array([80, 75, 3, 4])], name));
        },
        queryPermission: () => Promise.resolve(permission),
        requestPermission: () => {
          calls.requestPermission += 1;
          permission = "granted";

          return Promise.resolve(permission);
        },
        createWritable: () =>
          Promise.resolve({
            write: () => {
              calls.written += 1;

              return Promise.resolve();
            },
            close: () => Promise.resolve()
          }),
        isSameEntry: (other: { name?: string }) => Promise.resolve(other.name === name)
      };

      if (config.removable !== false) {
        handle.remove = () => {
          calls.remove.push(name);

          return Promise.resolve();
        };
      }

      return handle;
    };

    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: () => {
        calls.save += 1;
        if (config.cancel) {
          return Promise.reject(new DOMException("dismissed", "AbortError"));
        }

        return Promise.resolve(makeHandle(config.saveName ?? "project.mumbox"));
      }
    });
    Object.defineProperty(window, "showOpenFilePicker", {
      configurable: true,
      value: () => {
        calls.open += 1;

        if (config.cancel) {
          return Promise.reject(new DOMException("dismissed", "AbortError"));
        }

        return Promise.resolve((config.openNames ?? ["project.mumbox"]).map(makeHandle));
      }
    });
  }, options);
}

export function readPickerCalls(page: Page) {
  return page.evaluate(
    () => (window as Window & { __mumboxPickerCalls?: PickerCalls }).__mumboxPickerCalls
  );
}

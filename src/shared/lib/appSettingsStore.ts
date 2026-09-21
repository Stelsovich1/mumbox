import { useSyncExternalStore } from "react";

import { applySettingsToDocument } from "./appSettingsDocument";
import { setOverlayFromSettings } from "./diagnostics";
import { AppSettings, DEFAULT_SETTINGS, settingsEqual } from "./appSettings";

/**
 * The live settings value, module-level for the same reason the playback buffer cache is: readers
 * are spread across layers that have no component in common — the audio engine, the grid, `App`'s
 * diagnostics gate — and threading a context through all of them buys nothing that a subscription
 * does not.
 *
 * Starts at the defaults and is replaced once by the boot gate when the record has been read. That
 * order matters: nothing may block the first render on a storage read, so the first frame is always
 * rendered with defaults and corrected a tick later. The only visible consequence would be a
 * diagnostics overlay that appears late, which is the right trade against a slower start.
 */

let current: AppSettings = DEFAULT_SETTINGS;
const listeners = new Set<() => void>();

export function getAppSettings(): AppSettings {
  return current;
}

/**
 * Replaces the live settings and notifies subscribers.
 *
 * Identity is stable when nothing changed: every reader that depends on the settings object also
 * puts it in an effect dependency array, and a new object for an unchanged value would restart a
 * warm-up on every save.
 */
export function setAppSettings(next: AppSettings): void {
  if (settingsEqual(current, next)) {
    return;
  }
  current = next;
  applySettingsToDocument(next);
  // Mirrored here rather than by a caller: `App` renders the overlay from this store, and
  // `snapshot().overlayEnabled` has to agree with what is on screen. Two call sites remembering to
  // do it in the right order is not an invariant, it is a habit.
  setOverlayFromSettings(next.diagnostics.overlay);
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeAppSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAppSettings(): AppSettings {
  return useSyncExternalStore(subscribeAppSettings, getAppSettings, getAppSettings);
}

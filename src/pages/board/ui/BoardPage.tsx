import { useEffect, useMemo, useState } from "react";

import { hydrateAppState } from "../../../app/model/appState";
import type { AppState } from "../../../app/model/appState";
import { createPersistence, readAppState, readStoredSettings } from "../../../app/model/appStateStorage";
import type { PersistenceHandle } from "../../../app/model/appStateStorage";
import { applyPlaybackSettings } from "../../../features/playback/model/playbackSettings";
import { DEFAULT_SETTINGS } from "../../../shared/lib/appSettings";
import type { AppSettings } from "../../../shared/lib/appSettings";
import { applySettingsToDocument } from "../../../shared/lib/appSettingsDocument";
import { setAppSettings } from "../../../shared/lib/appSettingsStore";
import { AppShell } from "../../../widgets/app-shell";

/**
 * The seam where loading the layout became asynchronous.
 *
 * `AppShell` runs ~230 lines of hooks before its first return and most of them depend on the state,
 * so gating inside it would mean threading a loading branch through all of them. Gating one level
 * up costs a five-line component.
 *
 * What the user sees while it reads: nothing new. `global.css` paints the background on `body` and
 * is bundled CSS, so it is applied before React renders at all — this is visually the same frame as
 * the pre-hydration one already was.
 */
/**
 * How long the boot gate will wait for the settings record before starting without it.
 *
 * The gate renders nothing while it waits, and this read was added after the layout read rather
 * than before it, so a database that opens but never answers would have left a blank page with a
 * real project behind it. A preference is not allowed to be able to do that: the settings simply
 * arrive late and apply on the next render.
 */
const SETTINGS_READ_BUDGET_MS = 2000;

function readSettingsWithinBudget(): Promise<AppSettings> {
  return Promise.race([
    readStoredSettings(),
    new Promise<AppSettings>((resolve) => {
      setTimeout(() => {
        resolve(DEFAULT_SETTINGS);
      }, SETTINGS_READ_BUDGET_MS);
    })
  ]).catch(() => DEFAULT_SETTINGS);
}

type Boot =
  | { status: "loading" }
  | { status: "ready"; state: AppState; persistence: PersistenceHandle | null };

export function BoardPage() {
  const [boot, setBoot] = useState<Boot>({ status: "loading" });
  /**
   * Latched, because a storage failure is not a transient hiccup: the state only grows, so once a
   * write fails it fails on every subsequent one.
   *
   * Until this existed the banner was driven solely by a failed initial READ, so the case the
   * whole module was written for — a `QuotaExceededError` on the write — reached a `console.error`
   * and nothing else. The user kept editing a layout that was no longer being saved and found the
   * previous version on the next launch, with nothing having been shown.
   */
  const [writeFailed, setWriteFailed] = useState(false);

  useEffect(() => {
    // A box rather than a plain `let`: the boot sequence awaits twice, and a narrowed local would
    // let the type checker conclude the second check can never fire — it cannot see that the
    // cleanup below flips the flag from outside.
    const boot = { cancelled: false };
    let handle: PersistenceHandle | null = null;

    void readAppState()
      .then((loaded) => {
        if (boot.cancelled) {
          return null;
        }
        const state = hydrateAppState(loaded.state, loaded.session);
        // A FAILED read is not an empty one. If the data is there and only the read failed, the
        // first debounced write would overwrite a real project with a fresh one — the single most
        // destructive thing this change could do — so persistence is suspended rather than started.
        handle = loaded.failed
          ? null
          : createPersistence(
              (error) => {
                console.error("mumbox: could not persist app state", error);
                if (!boot.cancelled) {
                  setWriteFailed(true);
                }
              },
              // What is already on disk, so the first panel switch of a session writes the sidecar
              // instead of the whole layout. Null when there was nothing to read: then the layout
              // record does not exist yet and the first write has to create it.
              loaded.state ? { state, session: state.projectSession } : null
            );
        // Settings are read AFTER the layout, in a second step rather than in parallel.
        //
        // Both records live in the same database, and the layout read is the one whose failure has
        // to be detected: a settings read racing ahead of it would be the one to meet a broken
        // handle, leaving `readAppState` to succeed and the suspend-writing rule unarmed.
        return readSettingsWithinBudget().then((settings) => ({ state, settings }));
      })
      .catch(() => null)
      .then((ready) => {
        if (!ready || boot.cancelled) {
          return;
        }
        // Applied before the shell mounts, so the engine does not start a warm-up in the default
        // mode and get restarted by the saved one a frame later.
        applySettingsToDocument(ready.settings);
        applyPlaybackSettings(ready.settings);
        setAppSettings(ready.settings);

        setBoot({
          status: "ready",
          state: ready.state,
          persistence: handle
        });
      });

    return () => {
      boot.cancelled = true;
      handle?.dispose();
    };
  }, []);

  const shell = useMemo(
    () =>
      boot.status === "ready" ? (
        <AppShell
          initialState={boot.state}
          persistence={boot.persistence}
          storageFailed={writeFailed}
        />
      ) : null,
    [boot, writeFailed]
  );

  return shell;
}

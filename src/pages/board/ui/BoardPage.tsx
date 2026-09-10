import { useEffect, useMemo, useState } from "react";

import { hydrateAppState } from "../../../app/model/appState";
import type { AppState } from "../../../app/model/appState";
import { createPersistence, readAppState } from "../../../app/model/appStateStorage";
import type { PersistenceHandle } from "../../../app/model/appStateStorage";
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
    let cancelled = false;
    let handle: PersistenceHandle | null = null;

    void readAppState().then((loaded) => {
      if (cancelled) {
        return;
      }
      const state = hydrateAppState(loaded.state, loaded.session);
      // A FAILED read is not an empty one. If the data is there and only the read failed, the first
      // debounced write would overwrite a real project with a fresh one — the single most
      // destructive thing this change could do — so persistence is suspended rather than started.
      handle = loaded.failed
        ? null
        : createPersistence(
            (error) => {
              console.error("mumbox: could not persist app state", error);
              if (!cancelled) {
                setWriteFailed(true);
              }
            },
            // What is already on disk, so the first panel switch of a session writes the sidecar
            // instead of the whole layout. Null when there was nothing to read: then the layout
            // record does not exist yet and the first write has to create it.
            loaded.state ? { state, session: state.projectSession } : null
          );
      setBoot({
        status: "ready",
        state,
        persistence: handle
      });
    });

    return () => {
      cancelled = true;
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

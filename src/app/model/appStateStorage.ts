import { createStore, del, get, set } from "idb-keyval";

import type { AppState, SerializableAppState } from "./appState";
import type { ProjectSession } from "./projectSession";
import { serializeState } from "./serializeState";

/**
 * Where the layout lives, and how often it is written.
 *
 * It used to be a synchronous `JSON.stringify` into localStorage on EVERY reducer action, with no
 * try/catch. Three separate failures came out of that:
 *
 * - Cost. The master volume slider dispatches on every `pointermove`, so a 20-panel project meant
 *   stringifying and writing ~0.78 MiB sixty times a second, on the main thread, while audio played.
 * - A ceiling. localStorage is about 5 MiB counted as UTF-16, so roughly 2.6 M ASCII characters —
 *   at ~283 bytes a cell that is about 9 200 cells, or 64 panels of 12x12. Reachable.
 * - Silence, then a blank page. `QuotaExceededError` escaped a passive effect with no error
 *   boundary to catch it, so React unwound the tree — and it recurred on the next action.
 *
 * IndexedDB removes the ceiling, the debounce removes the cost, and the caller reports a failed
 * write instead of dying from it.
 */

const APP_DB_NAME = "mumbox-app";
const APP_STORE_NAME = "state";
export const STATE_RECORD_KEY = "state:v1";
export const SESSION_RECORD_KEY = "session:v1";

/** The keys this store replaces, kept readable for one release. See `LEGACY_MIRROR_MAX_CHARS`. */
export const LEGACY_STATE_KEY = "mumbox:state:v1";
export const LEGACY_SESSION_KEY = "mumbox:project-session:v1";

/**
 * A dedicated store, not idb-keyval's default one.
 *
 * `clearStoredAppData` calls idb-keyval's `clear()`, which wipes the whole DEFAULT store — where
 * the media blobs live. Putting the layout there would make a full reset race a debounced write and
 * turn the erasure into an undocumented side effect. The projects list keeps its own database for
 * exactly this reason, and says so.
 */
const appStore = createStore(APP_DB_NAME, APP_STORE_NAME);

/**
 * Trailing debounce, with a cap so a long continuous gesture cannot postpone a write forever.
 *
 * 400 ms is far below any "did it save?" threshold and collapses a whole slider drag into one
 * write; the 2 s cap bounds the worst case to that much lost work if the tab dies mid-gesture.
 */
export const WRITE_DEBOUNCE_MS = 400;
export const WRITE_MAX_WAIT_MS = 2000;

/**
 * How large the localStorage mirror may get before it stops being written.
 *
 * The mirror exists so a user who is still on the previous build — the app is a PWA with
 * `registerType: "prompt"`, and someone can stay on one for weeks — does not open it to an empty
 * project. It is a ROLLBACK NET, not a sync channel: IndexedDB always wins, and edits made on the
 * old build are lost. Pretending otherwise would need merge-by-timestamp, which is a feature with
 * its own failure modes, and doing it badly is worse than saying so.
 *
 * Self-disabling: past this size the mirror simply stops, which is exactly where localStorage had
 * stopped working anyway. Remove the mirror, and this constant, one release later.
 */
const LEGACY_MIRROR_MAX_CHARS = 1_500_000;

export type LoadedAppState = {
  state: SerializableAppState | null;
  session: ProjectSession | null;
  /**
   * True when the read itself failed, as opposed to finding nothing.
   *
   * The distinction is the most destructive thing this module could get wrong: if the data is there
   * and only the read failed, writing over it would destroy a real project. The caller must start
   * empty AND suspend persistence.
   */
  failed: boolean;
};

function readLegacy(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Reads the layout, migrating a localStorage payload on first run.
 *
 * The old key is NOT removed here. A user who goes back to the previous build would find an empty
 * project, which from their point of view is data loss.
 */
export async function readAppState(): Promise<LoadedAppState> {
  let stored: SerializableAppState | undefined;
  try {
    stored = await get<SerializableAppState>(STATE_RECORD_KEY, appStore);
  } catch {
    return { state: null, session: null, failed: true };
  }
  if (stored) {
    // Its own try, because losing the session must not lose the LAYOUT. Sharing one meant a
    // transient failure on this second read threw away a project that had just been read
    // successfully, and showed the user an empty app they might reasonably respond to by
    // resetting. The session is identity metadata; a missing one costs a project name.
    let session: ProjectSession | undefined;
    try {
      session = await get<ProjectSession>(SESSION_RECORD_KEY, appStore);
    } catch {
      session = undefined;
    }
    return { state: stored, session: session ?? null, failed: false };
  }

  const legacyState = readLegacy(LEGACY_STATE_KEY) as SerializableAppState | null;
  if (!legacyState) {
    return { state: null, session: null, failed: false };
  }
  const legacySession = readLegacy(LEGACY_SESSION_KEY) as ProjectSession | null;
  try {
    await set(STATE_RECORD_KEY, legacyState, appStore);
    if (legacySession) {
      await set(SESSION_RECORD_KEY, legacySession, appStore);
    }
  } catch {
    // The migration failed but the data is readable; run from it rather than refusing to start.
  }
  return { state: legacyState, session: legacySession, failed: false };
}

export async function writeAppState(
  state: SerializableAppState,
  session: ProjectSession
): Promise<void> {
  await set(STATE_RECORD_KEY, state, appStore);
  await set(SESSION_RECORD_KEY, session, appStore);

  // The mirror, best effort and never allowed to fail the real write.
  try {
    const serialized = JSON.stringify(state);
    if (serialized.length <= LEGACY_MIRROR_MAX_CHARS) {
      localStorage.setItem(LEGACY_STATE_KEY, serialized);
      localStorage.setItem(LEGACY_SESSION_KEY, JSON.stringify(session));
    } else {
      // Stopping means REMOVING, not freezing. A mirror left at its last written value hands the
      // previous build a silently outdated project, which the user may then edit believing it is
      // current — and those edits are discarded on the way back. An absent mirror gives them the
      // honest empty project the design intends.
      localStorage.removeItem(LEGACY_STATE_KEY);
      localStorage.removeItem(LEGACY_SESSION_KEY);
    }
  } catch {
    // Exactly the case the mirror is expected to hit eventually.
  }
}

export async function clearAppStateStorage(): Promise<void> {
  await del(STATE_RECORD_KEY, appStore).catch(() => undefined);
  await del(SESSION_RECORD_KEY, appStore).catch(() => undefined);
  try {
    localStorage.removeItem(LEGACY_STATE_KEY);
    localStorage.removeItem(LEGACY_SESSION_KEY);
  } catch {
    // Nothing to do.
  }
}

export type PersistenceHandle = {
  /**
   * Queue a write.
   *
   * `delayMs` is the caller's judgement about how fast the source of the change fires. Debouncing
   * EVERYTHING was the obvious design and the wrong one: it also delays the edits — a cell
   * assignment, a hotkey, a grid resize — that happen once and that a user may follow immediately
   * with a reload, which would silently lose them. `DEFERRABLE_ACTIONS` in `appState.ts` lists the
   * six that pay a delay; the volume slider is the one that fires continuously, the other five are
   * cheap to delay and are covered by the max-wait cap and the `visibilitychange` flush.
   *
   * Takes the LIVE state, not its serialization: `serializeState` walks every cell of every panel,
   * and running it per dispatch meant paying that walk sixty times a second during a volume drag
   * for a result the debounce then discarded. A state object is immutable per dispatch, so
   * serializing at write time produces the same bytes.
   */
  schedule: (state: AppState, session: ProjectSession, delayMs: number) => void;
  /**
   * Write now and resolve when it has landed, reporting whether it SUCCEEDED.
   *
   * The boolean is not decoration. Callers use this as a barrier before deleting blobs the old
   * state names, and a barrier that cannot report failure cannot gate a deletion: a quota error
   * was swallowed into a console line while the caller went on to delete the audio anyway.
   */
  flush: () => Promise<boolean>;
  dispose: () => void;
};

export function createPersistence(onError: (error: unknown) => void): PersistenceHandle {
  let pending: { state: AppState; session: ProjectSession } | null = null;
  let timer: number | null = null;
  let firstQueuedAt = 0;
  /**
   * Set by `dispose`, so a write queued just before unmount cannot land afterwards.
   *
   * There used to be a `suspend()` alongside it, meant for the failed-read case. It had no call
   * site: `BoardPage` expresses that case by passing a null handle instead, which is stronger —
   * there is nothing to call `schedule` on at all.
   */
  let stopped = false;
  let lastWriteFailed = false;
  // Serialized, so two flushes can never interleave and the last one wins. Same idiom the warm-up
  // chain in the audio engine uses.
  let chain: Promise<void> = Promise.resolve();

  const clearTimer = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  const writeNow = () => {
    const next = pending;
    pending = null;
    firstQueuedAt = 0;
    if (!next || stopped) {
      return chain;
    }
    const attempt = () =>
      writeAppState(serializeState(next.state), next.session).then(
        () => {
          lastWriteFailed = false;
        },
        (error: unknown) => {
          // Recorded as well as reported: `flush` has to be able to tell a caller that the state
          // it is about to act on never reached storage.
          lastWriteFailed = true;
          onError(error);
        }
      );
    chain = chain.then(attempt, attempt);
    return chain;
  };

  const arm = (requested: number) => {
    clearTimer();
    const waited = firstQueuedAt === 0 ? 0 : Date.now() - firstQueuedAt;
    const delay = Math.max(0, Math.min(requested, WRITE_MAX_WAIT_MS - waited));
    timer = window.setTimeout(() => {
      timer = null;
      void writeNow();
    }, delay);
  };

  return {
    schedule(state, session, delayMs) {
      if (stopped) {
        return;
      }
      pending = { state, session };
      if (delayMs <= 0) {
        // Started in THIS task rather than after a timer. A reload immediately following an
        // edit would otherwise race the macrotask the timer costs, and lose the edit - observed
        // once as a flaky reload test under parallel load.
        clearTimer();
        void writeNow();
        return;
      }
      if (firstQueuedAt === 0) {
        firstQueuedAt = Date.now();
      }
      arm(delayMs);
    },
    async flush() {
      clearTimer();
      if (stopped) {
        return false;
      }
      await writeNow();
      return !lastWriteFailed;
    },
    dispose() {
      stopped = true;
      pending = null;
      clearTimer();
    }
  };
}

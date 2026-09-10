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
/**
 * The hot fields, in their own record.
 *
 * Switching a panel changes one string, and it used to rewrite the WHOLE layout - twice, once into
 * IndexedDB and once into the localStorage mirror. Both are LevelDB-backed, and overwriting a key
 * appends: the old value lives on until compaction, so `navigator.storage.estimate()` climbed by
 * roughly the size of the project on every tab switch. The number came back down on its own, but
 * the write amplification behind it was real - a 20-panel project meant ~0.78 MiB of serialization
 * and disk traffic for six bytes of change, on the main thread, while audio played.
 *
 * These five are exactly `DEFERRABLE_ACTIONS` minus `editMode`, which is not persisted at all. They
 * are still written into `state:v1` by every FULL write, so the record stays self-contained for a
 * reader that knows nothing about this key - including an older build.
 */
export const UI_RECORD_KEY = "ui:v1";

/**
 * The keys this store replaced.
 *
 * Still READ, so a layout written by an older build is migrated on first run; no longer written.
 * The mirror was a rollback net for one release and cost a full `JSON.stringify` plus a
 * synchronous localStorage write on every persisted change, which is the same amplification
 * `UI_RECORD_KEY` exists to remove. Going back to a build older than the IndexedDB move now finds
 * whatever that build last wrote, which is the honest answer rather than a silently stale project.
 */
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
 * The hot fields as they are written down.
 *
 * A plain object of primitives on purpose: it is compared by its JSON on every write, so it must be
 * small and it must not contain anything whose serialization depends on key order beyond this
 * literal.
 */
export type StoredUiState = {
  activePanelId: string;
  masterVolume: number;
  masterMuted: boolean;
  stopOthers: boolean;
  monoPlayback: boolean;
};

export function pickUiState(state: AppState): StoredUiState {
  return {
    activePanelId: state.activePanelId,
    masterVolume: state.masterVolume,
    masterMuted: state.masterMuted,
    stopOthers: state.stopOthers,
    monoPlayback: state.monoPlayback
  };
}

/**
 * Validated rather than cast.
 *
 * Nothing between this store and the reducer checks anything - `hydrateAppState` catches a throw
 * and starts fresh, which for a bad UI record would mean losing the whole project over a stale
 * boolean. A record that is not the expected shape is ignored and `state:v1` answers instead.
 */
function isStoredUiState(value: unknown): value is StoredUiState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<StoredUiState>;
  return (
    typeof candidate.activePanelId === "string" &&
    typeof candidate.masterVolume === "number" &&
    typeof candidate.masterMuted === "boolean" &&
    typeof candidate.stopOthers === "boolean" &&
    typeof candidate.monoPlayback === "boolean"
  );
}

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
    return { state: await applyStoredUi(stored), session: session ?? null, failed: false };
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
    // A sidecar left over from a project this one replaces would override the migrated volume and
    // active panel with another project's. The legacy payload is complete on its own.
    await del(UI_RECORD_KEY, appStore);
  } catch {
    // The migration failed but the data is readable; run from it rather than refusing to start.
  }
  return { state: legacyState, session: legacySession, failed: false };
}

/**
 * Folds `ui:v1` over the layout record.
 *
 * The two can disagree: `state:v1` also carries these five fields, and something that writes it
 * without going through this module - the e2e seeder, a hand-edited record, a build that predates
 * `ui:v1` - leaves the sidecar behind. `ui:v1` still wins, because in the only case that happens
 * in production it is the newer of the two; the seeder deletes it instead of racing this rule.
 * `hydrateAppState` re-checks `activePanelId` against the panels it actually has, so a stale id
 * costs the active tab, never the layout.
 */
async function applyStoredUi(state: SerializableAppState): Promise<SerializableAppState> {
  let ui: unknown;
  try {
    ui = await get(UI_RECORD_KEY, appStore);
  } catch {
    // A readable layout must not be discarded because a five-field sidecar failed.
    return state;
  }
  return isStoredUiState(ui) ? { ...state, ...ui } : state;
}

/**
 * The FULL write: layout, session and the hot fields, all three.
 *
 * `state:v1` keeps carrying the hot fields so it stays a complete layout on its own. Only
 * `writeUiState` skips it, and only when nothing but those fields changed.
 */
export async function writeAppState(
  state: SerializableAppState,
  session: ProjectSession,
  ui: StoredUiState
): Promise<void> {
  await set(STATE_RECORD_KEY, state, appStore);
  await set(SESSION_RECORD_KEY, session, appStore);
  await set(UI_RECORD_KEY, ui, appStore);
}

/** The cheap write: a few dozen bytes, and the layout record is not touched. */
export async function writeUiState(
  ui: StoredUiState,
  session: ProjectSession | null
): Promise<void> {
  await set(UI_RECORD_KEY, ui, appStore);
  if (session) {
    await set(SESSION_RECORD_KEY, session, appStore);
  }
}

export async function clearAppStateStorage(): Promise<void> {
  await del(STATE_RECORD_KEY, appStore).catch(() => undefined);
  await del(SESSION_RECORD_KEY, appStore).catch(() => undefined);
  await del(UI_RECORD_KEY, appStore).catch(() => undefined);
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

/**
 * What is already on disk when persistence starts, so the first cheap change stays cheap.
 *
 * Without it the first write of a session is always a full one, because nothing has been written
 * yet — so the very first panel switch after a launch rewrote the whole layout, which is the case
 * the split exists to remove. `BoardPage` passes the state it just READ; on a fresh project, or a
 * failed read, it passes null and the first write is full, because there is no layout record to
 * skip.
 *
 * The baseline layout need not be byte-identical to the record — `hydrateAppState` clamps and
 * migrates — only equivalent, which is the same rule `useAppStore` already applies by refusing to
 * write the state it loaded.
 */
export type PersistenceBaseline = {
  state: AppState;
  session: ProjectSession;
};

export function createPersistence(
  onError: (error: unknown) => void,
  baseline: PersistenceBaseline | null = null
): PersistenceHandle {
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
  /**
   * What the last successful write left on disk, by REFERENCE for the layout and by JSON for the
   * hot fields.
   *
   * Reference equality is exact here rather than approximate: the reducer returns the same
   * `panels`, `cellsByPanel` and `media` objects for every action that does not touch them, so
   * three pointer comparisons decide whether `state:v1` needs rewriting at all — without the whole
   * `serializeState` walk the comparison is meant to avoid. The hot fields are primitives and
   * compared by their JSON, which also makes a write that would change nothing at all disappear.
   *
   * Cleared on a failed write, so a retry is always a full one: after a failure there is no longer
   * anything to know about what is on disk.
   */
  let written: {
    panels: unknown;
    cellsByPanel: unknown;
    media: unknown;
    session: ProjectSession;
    ui: string;
  } | null = baseline
    ? {
        panels: baseline.state.panels,
        cellsByPanel: baseline.state.cellsByPanel,
        media: baseline.state.media,
        session: baseline.session,
        ui: JSON.stringify(pickUiState(baseline.state))
      }
    : null;
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
    const previous = written;
    const ui = pickUiState(next.state);
    const uiSignature = JSON.stringify(ui);
    const layoutUnchanged =
      previous !== null &&
      previous.panels === next.state.panels &&
      previous.cellsByPanel === next.state.cellsByPanel &&
      previous.media === next.state.media;
    const sessionUnchanged = previous !== null && previous.session === next.session;

    if (layoutUnchanged && sessionUnchanged && previous.ui === uiSignature) {
      // Nothing to write. Reached by an action that produced a new state object without changing
      // anything that is written down — and by returning early it also keeps the failure flag,
      // so `flush` still reports the truth about the last write that happened.
      return chain;
    }

    const record = () => {
      written = {
        panels: next.state.panels,
        cellsByPanel: next.state.cellsByPanel,
        media: next.state.media,
        session: next.session,
        ui: uiSignature
      };
      lastWriteFailed = false;
    };
    const fail = (error: unknown) => {
      // Recorded as well as reported: `flush` has to be able to tell a caller that the state
      // it is about to act on never reached storage.
      written = null;
      lastWriteFailed = true;
      onError(error);
    };
    const attempt = () =>
      (layoutUnchanged
        ? writeUiState(ui, sessionUnchanged ? null : next.session)
        : writeAppState(serializeState(next.state), next.session, ui)
      ).then(record, fail);
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

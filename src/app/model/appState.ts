import { clear, del, get, set } from "idb-keyval";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import { applyCellAssignments, assignCellMedia } from "../../entities/cell/model/assignCells";
import { clearPanelCells } from "../../entities/cell/model/clearCells";
import { copyCellInto, planCellCopy } from "../../entities/cell/model/copyCells";
import { makeCell } from "../../entities/cell/model/makeCell";
import { GridCell, PlaybackMode } from "../../entities/cell/model/types";
import { MediaAsset } from "../../entities/media/model/types";
import { planPanelDeletion } from "../../entities/panel/model/deletePanels";
import { preserveHiddenCells } from "../../entities/panel/model/hiddenCells";
import {
  ensurePanelCells,
  getPanelCellIds,
  normalizePanelCellIds,
  remapLegacyCells
} from "../../entities/panel/model/panelCells";
import { makeUniquePanelName } from "../../entities/panel/model/panelName";
import { GridSize, Panel } from "../../entities/panel/model/types";
import { ensureMedia } from "../../entities/media/model/normalizeMedia";
import { CELL_COLORS } from "../../shared/config/colorPalette";
import { readAudioDurationMs } from "../../shared/lib/duration";
import { clearAppStateStorage, WRITE_DEBOUNCE_MS } from "./appStateStorage";
import type { PersistenceHandle } from "./appStateStorage";
import { serializeState as serializeStatePure } from "./serializeState";
import { makeUnsavedSession, ProjectSession, withDirtyTracking } from "./projectSession";

export type { ProjectSession };
export { makeUnsavedSession };

// Re-exported so callers keep one import site while the implementations stay in pure, unit-testable
// modules. This file imports `react` and `idb-keyval`, which the unit tier cannot load.
export { makeCell } from "../../entities/cell/model/makeCell";
export { getPanelCellIds } from "../../entities/panel/model/panelCells";

const STORAGE_KEY = "mumbox:state:v1";
// A sidecar key on purpose: the layout payload stays byte-identical for an untouched project.
const PROJECT_SESSION_KEY = "mumbox:project-session:v1";
const MEDIA_BLOB_PREFIX = "mumbox:media:";

export type AppState = {
  panels: Panel[];
  activePanelId: string;
  cellsByPanel: Record<string, Record<string, GridCell>>;
  media: MediaAsset[];
  masterVolume: number;
  masterMuted: boolean;
  editMode: boolean;
  stopOthers: boolean;
  /**
   * Halves the decoded PCM footprint by downmixing to one channel. Off by default: stereo
   * material collapses, so this is a user decision, never an automatic optimization.
   */
  monoPlayback: boolean;
  /** Project identity. Never serialized into the file — see `projectSession.ts`. */
  projectSession: ProjectSession;
};

export type SerializableAppState = Omit<
  AppState,
  "editMode" | "masterMuted" | "monoPlayback" | "projectSession"
> & {
  masterMuted?: boolean;
  // Optional so projects and saves written before mono existed still import.
  monoPlayback?: boolean;
};

type ImportMediaDraft = {
  id: string;
  file: File;
  fileName: string;
  alias: string;
  color: string;
  mimeType: string;
  size: number;
  durationMs: number | null;
};

export type MediaStorageProgress = {
  completed: number;
  total: number;
  label: string;
};

export type AppAction =
  | { type: "panel/add" }
  | { type: "panel/copy"; sourcePanelId: string; name: string }
  | { type: "panel/select"; panelId: string }
  | { type: "panel/rename"; panelId: string; name: string }
  | { type: "panel/delete"; panelId: string }
  | { type: "panel/deleteMany"; panelIds: readonly string[] }
  | { type: "panel/gridSize"; panelId: string; gridSize: GridSize }
  | { type: "media/addMany"; media: MediaAsset[] }
  | { type: "media/update"; mediaId: string; alias?: string; color?: string }
  | { type: "media/deleteMany"; mediaIds: string[] }
  | {
      type: "cell/assign";
      panelId: string;
      cellId: string;
      mediaId: string;
      playbackMode?: PlaybackMode;
    }
  | {
      type: "cell/assignMany";
      panelId: string;
      assignments: { cellId: string; mediaId: string; playbackMode?: PlaybackMode }[];
    }
  | {
      type: "cell/update";
      panelId: string;
      cellId: string;
      patch: Partial<
        Pick<
          GridCell,
          | "aliasOverride"
          | "colorOverride"
          | "playbackMode"
          | "volumeOffset"
          | "hotkey"
          | "trimStartMs"
          | "trimEndMs"
          | "fadeInEnabled"
          | "fadeInMs"
          | "fadeOutEnabled"
          | "fadeOutMs"
        >
      >;
    }
  | { type: "cell/move"; panelId: string; fromCellId: string; toCellId: string }
  | { type: "cell/copy"; fromPanelId: string; fromCellId: string; toPanelId: string; toCellId: string }
  | {
      type: "cell/copyMany";
      fromPanelId: string;
      cellIds: readonly string[];
      toPanelId: string;
    }
  | { type: "cell/clear"; panelId: string; cellId: string }
  | { type: "cell/clearMany"; panelId: string; cellIds: readonly string[] }
  | { type: "volume/master"; value: number }
  | { type: "volume/muteToggle" }
  | { type: "editMode/toggle" }
  | { type: "stopOthers/toggle" }
  | { type: "mono/set"; value: boolean }
  | { type: "media/setContentHash"; hashes: { mediaId: string; contentHash: string }[] }
  | {
      type: "project/saved";
      projectId?: string | null;
      fileName: string;
      name: string;
      description: string;
    }
  | { type: "state/reset" }
  | { type: "state/import"; state: SerializableAppState; session?: ProjectSession }
  | { type: "state/merge"; state: SerializableAppState };

/**
 * Actions whose write may wait.
 *
 * The rule is what is LOST, not how often the action fires. Everything here changes a single field
 * of session-shaped state — which panel is on screen, how loud, muted or not — so losing 400 ms of
 * it to a crash costs nothing a user would notice. Everything else touches the layout or the media
 * library, where a reload moments after an edit must show that edit; those are written immediately.
 *
 * `volume/master` is the one that made a delay necessary at all: the slider dispatches on every
 * `pointermove`. `panel/select` joined it for a different reason found by measurement — an
 * immediate write of the whole layout on every panel switch showed up as a 60 % regression in
 * `panelSwitchRepeatMs`.
 */
/**
 * How long a persist barrier waits for a dispatch to reach the persistence effect.
 *
 * Only a ceiling, not a delay: the effect normally runs within a frame. It exists because a
 * dispatch is not guaranteed to change the state at all, and a barrier must never hang.
 */
const COMMIT_WAIT_TIMEOUT_MS = 2000;

const DEFERRABLE_ACTIONS = new Set<AppAction["type"] | null>([
  "volume/master",
  "volume/muteToggle",
  "panel/select",
  "editMode/toggle",
  "stopOthers/toggle",
  "mono/set"
]);

function createId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function makePanel(name: string): Panel {
  const id = createId("panel");
  return {
    id,
    name,
    gridSize: 8,
    cellIds: getPanelCellIds(8)
  };
}

export function createInitialState(): AppState {
  const panel = makePanel("Panel 1");

  return {
    panels: [panel],
    activePanelId: panel.id,
    cellsByPanel: {
      [panel.id]: ensurePanelCells(panel, undefined)
    },
    media: [],
    masterVolume: 80,
    masterMuted: false,
    editMode: false,
    stopOthers: false,
    monoPlayback: false,
    projectSession: makeUnsavedSession()
  };
}

function sanitizeImportedState(state: SerializableAppState, session?: ProjectSession): AppState {
  const fallback = createInitialState();
  const sourcePanels = state.panels.length > 0 ? state.panels : fallback.panels;
  const panels = sourcePanels.map((panel) => ({
    ...panel,
    cellIds: normalizePanelCellIds(panel)
  }));
  const cellsByPanel = panels.reduce<Record<string, Record<string, GridCell>>>(
    (accumulator, panel, index) => {
      const sourcePanel = sourcePanels[index] ?? panel;
      const sourceCells = remapLegacyCells(sourcePanel, state.cellsByPanel[sourcePanel.id]);
      // Cues outside the current grid are hidden, not deleted — the same promise the
      // `panel/gridSize` reducer makes in-session, kept across a load and an import.
      accumulator[panel.id] = preserveHiddenCells(
        panel,
        ensurePanelCells(panel, sourceCells),
        sourceCells
      );
      return accumulator;
    },
    {}
  );

  return {
    panels,
    activePanelId: panels.some((panel) => panel.id === state.activePanelId)
      ? state.activePanelId
      : panels[0]?.id ?? fallback.activePanelId,
    cellsByPanel,
    // State written by an older build, or a hand-edited manifest, reaches here as `unknown` shaped
    // data. `ensureMedia` never invents a `createdAt`.
    media: ensureMedia(state.media),
    // Clamped HERE, at the boundary, not only in the gain maths. The manifest predicate accepts
    // any finite number by design - over-validating would break the frozen-version contract -
    // and the reducer stores what it is handed, so a hand-edited file could otherwise carry a
    // master volume of 400 straight into a gain node.
    masterVolume: Number.isFinite(state.masterVolume)
      ? Math.min(100, Math.max(0, state.masterVolume))
      : fallback.masterVolume,
    masterMuted: state.masterMuted ?? false,
    editMode: false,
    stopOthers: state.stopOthers,
    monoPlayback: state.monoPlayback ?? false,
    projectSession: session ?? makeUnsavedSession()
  };
}

export function serializeState(state: AppState): SerializableAppState {
  return serializeStatePure(state);
}

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "panel/add": {
      if (!state.editMode) {
        return state;
      }

      const panel = makePanel(`Panel ${String(state.panels.length + 1)}`);
      return {
        ...state,
        panels: [...state.panels, panel],
        activePanelId: panel.id,
        cellsByPanel: {
          ...state.cellsByPanel,
          [panel.id]: ensurePanelCells(panel, undefined)
        }
      };
    }
    case "panel/copy": {
      if (!state.editMode) {
        return state;
      }

      const sourcePanel = state.panels.find((panel) => panel.id === action.sourcePanelId);
      if (!sourcePanel) {
        return state;
      }

      const panel: Panel = {
        ...sourcePanel,
        id: createId("panel"),
        name: makeUniquePanelName(state.panels, action.name)
      };
      const sourceCells = state.cellsByPanel[sourcePanel.id];

      return {
        ...state,
        panels: [...state.panels, panel],
        activePanelId: panel.id,
        cellsByPanel: {
          ...state.cellsByPanel,
          [panel.id]: ensurePanelCells(panel, sourceCells)
        }
      };
    }
    case "panel/select":
      return { ...state, activePanelId: action.panelId };
    case "panel/rename":
      if (!state.editMode) {
        return state;
      }

      return {
        ...state,
        panels: state.panels.map((panel) =>
          panel.id === action.panelId ? { ...panel, name: action.name.trim() || panel.name } : panel
        )
      };
    case "panel/delete": {
      if (!state.editMode) {
        return state;
      }

      const panelIndex = state.panels.findIndex((panel) => panel.id === action.panelId);
      if (panelIndex <= 0 || state.panels.length <= 1) {
        return state;
      }

      const panels = state.panels.filter((panel) => panel.id !== action.panelId);
      const fallbackPanel = panels[Math.max(0, panelIndex - 1)] ?? panels[0];
      const cellsByPanel = Object.fromEntries(
        Object.entries(state.cellsByPanel).filter(([panelId]) => panelId !== action.panelId)
      );

      if (!fallbackPanel) {
        return state;
      }

      return {
        ...state,
        panels,
        activePanelId:
          state.activePanelId === action.panelId ? fallbackPanel.id : state.activePanelId,
        cellsByPanel
      };
    }
    case "panel/deleteMany": {
      if (!state.editMode) {
        return state;
      }

      // One action, not a loop of `panel/delete`: a loop re-picks `activePanelId` on every step,
      // so a mid-loop fallback can land on a panel the next step deletes.
      const plan = planPanelDeletion({
        panels: state.panels,
        cellsByPanel: state.cellsByPanel,
        activePanelId: state.activePanelId,
        panelIds: action.panelIds
      });
      if (!plan) {
        return state;
      }

      return {
        ...state,
        panels: plan.panels,
        activePanelId: plan.activePanelId,
        cellsByPanel: plan.cellsByPanel
      };
    }
    case "panel/gridSize": {
      const panels = state.panels.map((panel) => {
        if (panel.id !== action.panelId) {
          return panel;
        }

        return {
          ...panel,
          gridSize: action.gridSize,
          cellIds: getPanelCellIds(action.gridSize)
        };
      });
      const panel = panels.find((candidate) => candidate.id === action.panelId);

      if (!panel) {
        return state;
      }

      return {
        ...state,
        panels,
        cellsByPanel: {
          ...state.cellsByPanel,
          [panel.id]: {
            ...state.cellsByPanel[panel.id],
            ...ensurePanelCells(panel, state.cellsByPanel[panel.id])
          }
        }
      };
    }
    case "media/addMany":
      return {
        ...state,
        media: [...state.media, ...action.media]
      };
    case "media/update":
      return {
        ...state,
        media: state.media.map((media) =>
          media.id === action.mediaId
            ? {
                ...media,
                alias: action.alias ?? media.alias,
                color: action.color ?? media.color
              }
            : media
        )
      };
    case "media/deleteMany": {
      const deleteSet = new Set(action.mediaIds);
      const cellsByPanel = Object.fromEntries(
        Object.entries(state.cellsByPanel).map(([panelId, cells]) => [
          panelId,
          Object.fromEntries(
            Object.entries(cells).map(([cellId, cell]) => [
              cellId,
              deleteSet.has(cell.mediaId ?? "") ? makeCell(cellId) : cell
            ])
          )
        ])
      );

      return {
        ...state,
        media: state.media.filter((media) => !deleteSet.has(media.id)),
        cellsByPanel
      };
    }
    case "cell/assign": {
      const cell = state.cellsByPanel[action.panelId]?.[action.cellId] ?? makeCell(action.cellId);
      return {
        ...state,
        cellsByPanel: {
          ...state.cellsByPanel,
          [action.panelId]: {
            ...state.cellsByPanel[action.panelId],
            [action.cellId]: assignCellMedia(cell, action.mediaId, action.playbackMode)
          }
        }
      };
    }
    case "cell/assignMany": {
      // One dispatch for a whole multi-drop. N separate `cell/assign` calls change the warm-up
      // signature N times, and every restart wipes the shared-decode staging, so the same media is
      // decoded again by workers that are still in flight.
      const panel = state.panels.find((candidate) => candidate.id === action.panelId);
      if (!panel || action.assignments.length === 0) {
        return state;
      }

      const { cells, changed } = applyCellAssignments(
        state.cellsByPanel[action.panelId] ?? {},
        panel.cellIds,
        action.assignments
      );

      // Returning the same object identity skips the localStorage write and leaves the warm-up
      // signature untouched.
      if (!changed) {
        return state;
      }

      return {
        ...state,
        cellsByPanel: {
          ...state.cellsByPanel,
          [action.panelId]: cells
        }
      };
    }
    case "cell/update": {
      const cell = state.cellsByPanel[action.panelId]?.[action.cellId];
      if (!cell) {
        return state;
      }

      return {
        ...state,
        cellsByPanel: {
          ...state.cellsByPanel,
          [action.panelId]: {
            ...state.cellsByPanel[action.panelId],
            [action.cellId]: {
              ...cell,
              ...action.patch
            }
          }
        }
      };
    }
    case "cell/move": {
      if (action.fromCellId === action.toCellId) {
        return state;
      }
      const panel = state.panels.find((candidate) => candidate.id === action.panelId);
      const cells = state.cellsByPanel[action.panelId];
      if (!panel || !cells) {
        return state;
      }
      if (!panel.cellIds.includes(action.fromCellId) || !panel.cellIds.includes(action.toCellId)) {
        return state;
      }
      const fromCell = cells[action.fromCellId] ?? makeCell(action.fromCellId);
      const toCell = cells[action.toCellId] ?? makeCell(action.toCellId);
      if (!fromCell.mediaId) {
        return state;
      }

      return {
        ...state,
        cellsByPanel: {
          ...state.cellsByPanel,
          [action.panelId]: {
            ...cells,
            [action.fromCellId]: toCell.mediaId
              ? {
                  ...toCell,
                  id: action.fromCellId
                }
              : makeCell(action.fromCellId),
            [action.toCellId]: {
              ...fromCell,
              id: action.toCellId
            }
          }
        }
      };
    }
    case "cell/copy": {
      const sourceCell = state.cellsByPanel[action.fromPanelId]?.[action.fromCellId];
      const targetPanel = state.panels.find((candidate) => candidate.id === action.toPanelId);
      const targetCells = state.cellsByPanel[action.toPanelId];
      if (!sourceCell?.mediaId || !targetPanel || !targetCells || !targetPanel.cellIds.includes(action.toCellId)) {
        return state;
      }

      const targetCell = targetCells[action.toCellId] ?? makeCell(action.toCellId);
      if (targetCell.mediaId) {
        return state;
      }

      const sourceMedia = state.media.find((media) => media.id === sourceCell.mediaId);
      const copyAliasBase = sourceCell.aliasOverride.trim() || (sourceMedia?.fileName ?? "");

      return {
        ...state,
        cellsByPanel: {
          ...state.cellsByPanel,
          [action.toPanelId]: {
            ...targetCells,
            [action.toCellId]: copyCellInto(sourceCell, action.toCellId, copyAliasBase)
          }
        }
      };
    }
    case "cell/copyMany": {
      const targetPanel = state.panels.find((candidate) => candidate.id === action.toPanelId);
      if (!targetPanel || action.cellIds.length === 0) {
        return state;
      }

      const plan = planCellCopy({
        sourceCells: state.cellsByPanel[action.fromPanelId] ?? {},
        sourceCellIds: action.cellIds,
        targetCells: state.cellsByPanel[action.toPanelId] ?? {},
        targetPanelCellIds: targetPanel.cellIds,
        aliasBaseFor: (cell) =>
          state.media.find((media) => media.id === cell.mediaId)?.fileName ?? ""
      });
      if (plan.pairs.length === 0) {
        return state;
      }

      return {
        ...state,
        cellsByPanel: {
          ...state.cellsByPanel,
          [action.toPanelId]: plan.cells
        }
      };
    }
    case "cell/clear":
      return {
        ...state,
        cellsByPanel: {
          ...state.cellsByPanel,
          [action.panelId]: {
            ...state.cellsByPanel[action.panelId],
            [action.cellId]: makeCell(action.cellId)
          }
        }
      };
    case "cell/clearMany": {
      const panel = state.panels.find((candidate) => candidate.id === action.panelId);
      if (!panel || action.cellIds.length === 0) {
        return state;
      }

      const { cells, changed } = clearPanelCells(
        state.cellsByPanel[action.panelId] ?? {},
        panel.cellIds,
        action.cellIds
      );
      if (!changed) {
        return state;
      }

      return {
        ...state,
        cellsByPanel: {
          ...state.cellsByPanel,
          [action.panelId]: cells
        }
      };
    }
    case "volume/master":
      return { ...state, masterVolume: action.value };
    case "volume/muteToggle":
      return { ...state, masterMuted: !state.masterMuted };
    case "editMode/toggle":
      return { ...state, editMode: !state.editMode };
    case "stopOthers/toggle":
      return { ...state, stopOthers: !state.stopOthers };
    case "mono/set":
      return state.monoPlayback === action.value ? state : { ...state, monoPlayback: action.value };
    case "media/setContentHash": {
      if (action.hashes.length === 0) {
        return state;
      }
      const hashByMediaId = new Map(action.hashes.map((item) => [item.mediaId, item.contentHash]));

      return {
        ...state,
        media: state.media.map((media) => {
          const contentHash = hashByMediaId.get(media.id);

          return contentHash && contentHash !== media.contentHash
            ? { ...media, contentHash }
            : media;
        })
      };
    }
    case "project/saved":
      return {
        ...state,
        projectSession: {
          projectId: action.projectId ?? state.projectSession.projectId,
          name: action.name,
          description: action.description,
          fileName: action.fileName,
          saved: true,
          dirty: false
        }
      };
    case "state/reset":
      return createInitialState();
    case "state/import":
      return sanitizeImportedState(action.state, action.session);
    case "state/merge":
      // The merged state was already built by `mergeProjectState`, which regenerated the incoming
      // panel ids; the sanitizer is idempotent over them. The session stays, and dirty tracking
      // marks the project changed.
      return sanitizeImportedState(action.state, state.projectSession);
    default:
      return state;
  }
}

function loadStoredSession(): ProjectSession {
  const raw = localStorage.getItem(PROJECT_SESSION_KEY);
  if (!raw) {
    return makeUnsavedSession();
  }

  try {
    return { ...makeUnsavedSession(), ...(JSON.parse(raw) as Partial<ProjectSession>) };
  } catch {
    return makeUnsavedSession();
  }
}

/** Builds the live state from whatever storage returned, or a fresh project. */
export function hydrateAppState(
  state: SerializableAppState | null,
  session: ProjectSession | null
): AppState {
  if (!state) {
    return createInitialState();
  }
  try {
    return sanitizeImportedState(state, session ?? undefined);
  } catch {
    // A stored payload that the sanitizer cannot survive. Starting fresh beats refusing to boot,
    // and the record is left alone so it can still be inspected.
    return createInitialState();
  }
}

export function loadStoredState(): AppState {
  const rawState = localStorage.getItem(STORAGE_KEY);
  if (!rawState) {
    return createInitialState();
  }

  try {
    return sanitizeImportedState(
      JSON.parse(rawState) as SerializableAppState,
      loadStoredSession()
    );
  } catch {
    return createInitialState();
  }
}

const trackedReducer = withDirtyTracking(reducer);

export type AppStoreOptions = {
  initialState: AppState;
  /** Null suspends persistence entirely — see `LoadedAppState.failed`. */
  persistence: PersistenceHandle | null;
  /** True once a write has failed. Owned by `BoardPage`, which is where the handle lives. */
  storageFailed?: boolean;
};

export function useAppStore({
  initialState,
  persistence,
  storageFailed = false
}: AppStoreOptions) {
  const [state, dispatch] = useReducer(trackedReducer, initialState);
  /**
   * Sticky on purpose. A storage failure is not a transient hiccup — the state only grows, so once
   * a write fails it fails on every subsequent one. Latching it means the user is told once instead
   * of on every keystroke, and never un-told while the cause is still there.
   *
   * Two causes, one flag, because they are the same fact from the user's point of view: nothing is
   * being saved. `persistence === null` means the initial READ failed and writing was never
   * started; `storageFailed` means a write was attempted and rejected — the quota case, which used
   * to reach a console line and no further.
   */
  const persistenceFailed = persistence === null || storageFailed;

  /**
   * The state as loaded. Writing it straight back would be pointless work on every boot, and on the
   * degraded path — where the READ failed but the data may still be there — it would destroy a real
   * project with an empty one. Exact identity, no heuristics.
   */
  const initialRef = useRef(initialState);

  /**
   * What produced the current state, so persistence can tell a repeated writer from a one-off edit.
   *
   * `DEFERRABLE_ACTIONS` is the list, and it is six entries rather than the one this comment used
   * to claim. `volume/master` is the only one that fires continuously; the other five — mute,
   * panel select, edit mode, stopOthers, mono — were added because each is cheap to redo and
   * several fire in quick succession while a user is arranging a set. All of them are serialized
   * fields, so the delay is a real exposure: the max-wait cap and the `visibilitychange` flush
   * bound it, but an OS kill inside the window still reverts that one setting.
   */
  const lastActionRef = useRef<AppAction["type"] | null>(null);
  const trackedDispatch = useCallback((action: AppAction) => {
    lastActionRef.current = action.type;
    dispatch(action);
  }, []);

  /**
   * Resolvers waiting for the CURRENT state to have been handed to persistence.
   *
   * A caller cannot simply dispatch and then await a flush. React schedules the re-render on a
   * macrotask and runs this effect after the commit, while an `await` resolves in a microtask -
   * so the flush ran first, found nothing queued, wrote nothing, and resolved. The barrier that
   * was supposed to guarantee the new state was durable before old audio was deleted did not
   * touch storage at all.
   */
  const commitWaitersRef = useRef<(() => void)[]>([]);

  useEffect(() => {
    if (!persistence || state === initialRef.current) {
      return;
    }
    const delayMs = DEFERRABLE_ACTIONS.has(lastActionRef.current) ? WRITE_DEBOUNCE_MS : 0;
    // The STATE is queued, not its serialization. `serializeState` walks every cell of every panel
    // and allocates a template object per cell, so running it here paid that walk on every
    // dispatch — 60 times a second during a volume drag — while the debounce it feeds discarded
    // all but the last result. A state object is immutable per dispatch, so serializing it when
    // the write actually happens produces the same bytes.
    persistence.schedule(state, state.projectSession, delayMs);
    const waiters = commitWaitersRef.current;
    commitWaitersRef.current = [];
    for (const resolve of waiters) {
      resolve();
    }
  }, [persistence, state]);

  /**
   * Waits for the most recent dispatch to reach storage, and reports whether it got there.
   *
   * Two halves, and both are load-bearing. The wait is what makes the barrier see the change at
   * all; the boolean is what lets a caller refuse to delete anything when the write failed. The
   * timeout exists so a caller can never hang on a dispatch that produced no state change -
   * `cell/assignMany` returns the same object when nothing was assigned, and several reducer
   * cases no-op outside edit mode.
   */
  const flushPendingState = useCallback(async () => {
    if (!persistence) {
      return false;
    }
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => {
        commitWaitersRef.current = commitWaitersRef.current.filter(
          (waiter) => waiter !== settle
        );
        resolve();
      }, COMMIT_WAIT_TIMEOUT_MS);
      const settle = () => {
        window.clearTimeout(timer);
        resolve();
      };
      commitWaitersRef.current.push(settle);
    });
    return persistence.flush();
  }, [persistence]);

  useEffect(() => {
    if (!persistence) {
      return;
    }
    // `visibilitychange` is the primary trigger on mobile: it fires reliably and well before
    // teardown, where `pagehide` is best effort. `diagnostics.ts` already relies on the same pair
    // for the same reason.
    const flush = () => {
      void persistence.flush();
    };
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [persistence]);

  const activePanel = useMemo(
    () => state.panels.find((panel) => panel.id === state.activePanelId) ?? state.panels[0],
    [state.activePanelId, state.panels]
  );

  return {
    state,
    activePanel,
    dispatch: trackedDispatch,
    persistenceFailed,
    flushPendingState
  };
}

export async function saveImportedMedia(
  drafts: ImportMediaDraft[],
  onProgress?: (progress: MediaStorageProgress) => void
) {
  // All or nothing, the same rule the two project writers follow. Without it a failure part-way
  // left every blob already written orphaned forever: `media/addMany` never runs, so nothing in
  // the state names them, and no UI can reach them — only a full reset reclaims the quota.
  const written: string[] = [];
  try {
    for (const [index, draft] of drafts.entries()) {
      await set(`${MEDIA_BLOB_PREFIX}${draft.id}`, draft.file);
      written.push(draft.id);
      onProgress?.({
        completed: index + 1,
        total: drafts.length,
        label: `Сохранение аудио ${String(index + 1)} из ${String(drafts.length)}`
      });
    }
  } catch (error) {
    await deleteStoredMedia(written).catch(() => undefined);
    throw error;
  }

  return drafts.map<MediaAsset>((draft) => ({
    id: draft.id,
    fileName: draft.fileName,
    alias: draft.alias,
    color: draft.color,
    mimeType: draft.mimeType,
    size: draft.size,
    durationMs: draft.durationMs,
    createdAt: new Date().toISOString()
  }));
}

export async function getMediaBlob(mediaId: string) {
  return get<Blob>(`${MEDIA_BLOB_PREFIX}${mediaId}`);
}

function remapImportedState(
  state: SerializableAppState,
  idByImportedId: Map<string, string>
): SerializableAppState {
  return {
    ...state,
    media: state.media.map((media) => ({
      ...media,
      id: idByImportedId.get(media.id) ?? media.id
    })),
    cellsByPanel: Object.fromEntries(
      Object.entries(state.cellsByPanel).map(([panelId, cells]) => [
        panelId,
        Object.fromEntries(
          Object.entries(cells).map(([cellId, cell]) => [
            cellId,
            {
              ...cell,
              mediaId: cell.mediaId ? idByImportedId.get(cell.mediaId) ?? cell.mediaId : null
            }
          ])
        )
      ])
    )
  };
}

/**
 * Writes only the media the merge decided to keep, and rewrites incoming ids to the ids the merged
 * project uses. Reused assets are never written again — that is the whole point of deduplicating.
 */
export async function writeMergedProjectMedia(
  incoming: SerializableAppState,
  blobs: { id: string; blob: Blob }[],
  mediaIdMap: Map<string, string>,
  keptIncomingIds: readonly string[],
  onProgress?: (progress: MediaStorageProgress) => void
) {
  const kept = new Set(keptIncomingIds);
  const idByImportedId = new Map<string, string>();
  for (const [incomingId, targetId] of mediaIdMap) {
    idByImportedId.set(incomingId, kept.has(incomingId) ? createId("media") : targetId);
  }

  const toWrite = blobs.filter((item) => kept.has(item.id));
  // All or nothing. A merge deletes nothing, but a write that fails halfway leaves every blob it
  // did write orphaned forever — invisible in the UI and occupying quota with no way to reclaim it.
  const written: string[] = [];
  try {
    for (const [index, item] of toWrite.entries()) {
      const nextId = idByImportedId.get(item.id);
      if (nextId) {
        await set(`${MEDIA_BLOB_PREFIX}${nextId}`, item.blob);
        written.push(nextId);
      }
      onProgress?.({
        completed: index + 1,
        total: toWrite.length,
        label: `Запись аудио ${String(index + 1)} из ${String(toWrite.length)}`
      });
    }
  } catch (error) {
    // Best effort, and it must never mask the cause.
    await deleteStoredMedia(written).catch(() => undefined);
    throw error;
  }

  const remapped = remapImportedState(incoming, idByImportedId);
  const addedMedia = remapped.media.filter((media) =>
    toWrite.some((item) => idByImportedId.get(item.id) === media.id)
  );

  return { state: remapped, addedMedia, idByImportedId };
}

export async function writeImportedProjectMedia(
  state: SerializableAppState,
  blobs: { id: string; blob: Blob }[],
  onProgress?: (progress: MediaStorageProgress) => void
) {
  const idByImportedId = new Map(blobs.map((item) => [item.id, createId("media")]));

  // All or nothing, so a failure part-way leaves storage exactly as it was found. Combined with
  // deleting the OUTGOING blobs only after the import has been applied, that is what makes a failed
  // import non-destructive rather than merely unlucky.
  const written: string[] = [];
  try {
    for (const [index, item] of blobs.entries()) {
      const nextId = idByImportedId.get(item.id);
      if (nextId) {
        await set(`${MEDIA_BLOB_PREFIX}${nextId}`, item.blob);
        written.push(nextId);
      }
      onProgress?.({
        completed: index + 1,
        total: blobs.length,
        label: `Запись аудио ${String(index + 1)} из ${String(blobs.length)}`
      });
    }
  } catch (error) {
    await deleteStoredMedia(written).catch(() => undefined);
    throw error;
  }

  return remapImportedState(state, idByImportedId);
}

export async function deleteStoredMedia(mediaIds: string[]) {
  await Promise.all(mediaIds.map((mediaId) => del(`${MEDIA_BLOB_PREFIX}${mediaId}`)));
}

export async function clearStoredAppData() {
  // Three stores, and none of them reaches the others. idb-keyval's `clear()` empties only its
  // DEFAULT store, where the media blobs live; the layout has its own database now, and the
  // projects list has had one all along — `AppShell` clears that with an explicit second call.
  await clearAppStateStorage();
  await clear();
}

export function makeMediaDraft(file: File, index: number): ImportMediaDraft {
  return {
    id: createId("media"),
    file,
    fileName: file.name,
    alias: "",
    color: CELL_COLORS[index % CELL_COLORS.length] ?? CELL_COLORS[0],
    mimeType: file.type || "audio/*",
    size: file.size,
    durationMs: null
  };
}

export async function autoImportAudioFiles(
  files: File[],
  onProgress?: (progress: MediaStorageProgress) => void
): Promise<MediaAsset[]> {
  const drafts = files.map((file, index) => makeMediaDraft(file, index));
  const DURATION_BATCH_SIZE = 24;

  for (let index = 0; index < drafts.length; index += DURATION_BATCH_SIZE) {
    const batch = drafts.slice(index, index + DURATION_BATCH_SIZE);
    const durations = await Promise.all(
      batch.map(async (draft) => ({
        id: draft.id,
        durationMs: await readAudioDurationMs(draft.file)
      }))
    );

    drafts.forEach((draft) => {
      const duration = durations.find((d) => d.id === draft.id);
      if (duration) {
        draft.durationMs = duration.durationMs;
      }
    });

    onProgress?.({
      completed: Math.min(index + batch.length, drafts.length),
      total: drafts.length,
      label: `Чтение длительности ${String(Math.min(index + batch.length, drafts.length))} из ${String(drafts.length)}`
    });
  }

  return saveImportedMedia(drafts, onProgress);
}

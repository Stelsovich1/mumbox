import { clear, del, get, set } from "idb-keyval";
import { useEffect, useMemo, useReducer } from "react";

import { makeCell } from "../../entities/cell/model/makeCell";
import { GridCell, PlaybackMode } from "../../entities/cell/model/types";
import { MediaAsset } from "../../entities/media/model/types";
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
  | { type: "cell/clear"; panelId: string; cellId: string }
  | { type: "volume/master"; value: number }
  | { type: "volume/muteToggle" }
  | { type: "editMode/toggle" }
  | { type: "stopOthers/toggle" }
  | { type: "mono/set"; value: boolean }
  | { type: "media/setContentHash"; hashes: { mediaId: string; contentHash: string }[] }
  | { type: "project/meta"; name?: string; description?: string }
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

function createId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

/** Shared by `cell/assign` and `cell/assignMany` so the two cannot drift. */
function assignCellMedia(cell: GridCell, mediaId: string, playbackMode?: PlaybackMode): GridCell {
  return {
    ...cell,
    mediaId,
    playbackMode: playbackMode ?? cell.playbackMode
  };
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
      const sourceCells = state.cellsByPanel[sourcePanel.id];
      accumulator[panel.id] = ensurePanelCells(panel, remapLegacyCells(sourcePanel, sourceCells));
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
    masterVolume: state.masterVolume,
    masterMuted: state.masterMuted ?? false,
    editMode: false,
    stopOthers: state.stopOthers,
    monoPlayback: state.monoPlayback ?? false,
    projectSession: session ?? makeUnsavedSession()
  };
}

export function serializeState(state: AppState): SerializableAppState {
  return {
    panels: state.panels,
    activePanelId: state.activePanelId,
    cellsByPanel: state.cellsByPanel,
    media: state.media,
    masterVolume: state.masterVolume,
    masterMuted: state.masterMuted,
    stopOthers: state.stopOthers,
    monoPlayback: state.monoPlayback
  };
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

      const panelCellIds = new Set(panel.cellIds);
      const cells = { ...state.cellsByPanel[action.panelId] };
      let changed = false;

      for (const assignment of action.assignments) {
        if (!panelCellIds.has(assignment.cellId)) {
          continue;
        }
        const cell = cells[assignment.cellId] ?? makeCell(assignment.cellId);
        cells[assignment.cellId] = assignCellMedia(cell, assignment.mediaId, assignment.playbackMode);
        changed = true;
      }

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
            [action.toCellId]: {
              ...sourceCell,
              id: action.toCellId,
              aliasOverride: copyAliasBase ? `${copyAliasBase}_copy` : "",
              hotkey: ""
            }
          }
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
    case "project/meta": {
      const name = action.name ?? state.projectSession.name;
      const description = action.description ?? state.projectSession.description;
      if (name === state.projectSession.name && description === state.projectSession.description) {
        return state;
      }

      return { ...state, projectSession: { ...state.projectSession, name, description } };
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

export function useAppStore() {
  const [state, dispatch] = useReducer(trackedReducer, undefined, loadStoredState);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeState(state)));
    localStorage.setItem(PROJECT_SESSION_KEY, JSON.stringify(state.projectSession));
  }, [state]);

  const activePanel = useMemo(
    () => state.panels.find((panel) => panel.id === state.activePanelId) ?? state.panels[0],
    [state.activePanelId, state.panels]
  );

  return { state, activePanel, dispatch };
}

export async function saveImportedMedia(
  drafts: ImportMediaDraft[],
  onProgress?: (progress: MediaStorageProgress) => void
) {
  for (const [index, draft] of drafts.entries()) {
    await set(`${MEDIA_BLOB_PREFIX}${draft.id}`, draft.file);
    onProgress?.({
      completed: index + 1,
      total: drafts.length,
      label: `Сохранение аудио ${String(index + 1)} из ${String(drafts.length)}`
    });
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
  for (const [index, item] of toWrite.entries()) {
    const nextId = idByImportedId.get(item.id);
    if (nextId) {
      await set(`${MEDIA_BLOB_PREFIX}${nextId}`, item.blob);
    }
    onProgress?.({
      completed: index + 1,
      total: toWrite.length,
      label: `Запись аудио ${String(index + 1)} из ${String(toWrite.length)}`
    });
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

  for (const [index, item] of blobs.entries()) {
    const nextId = idByImportedId.get(item.id);
    if (nextId) {
      await set(`${MEDIA_BLOB_PREFIX}${nextId}`, item.blob);
    }
    onProgress?.({
      completed: index + 1,
      total: blobs.length,
      label: `Запись аудио ${String(index + 1)} из ${String(blobs.length)}`
    });
  }

  return remapImportedState(state, idByImportedId);
}

export async function deleteStoredMedia(mediaIds: string[]) {
  await Promise.all(mediaIds.map((mediaId) => del(`${MEDIA_BLOB_PREFIX}${mediaId}`)));
}

export async function clearStoredAppData() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(PROJECT_SESSION_KEY);
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

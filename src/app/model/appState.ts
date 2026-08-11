import { clear, del, get, set } from "idb-keyval";
import { useEffect, useMemo, useReducer } from "react";

import { GridCell, PlaybackMode } from "../../entities/cell/model/types";
import { MediaAsset } from "../../entities/media/model/types";
import { GridSize, Panel } from "../../entities/panel/model/types";
import { CELL_COLORS } from "../../shared/config/colorPalette";

const STORAGE_KEY = "mumbox:state:v1";
const MEDIA_BLOB_PREFIX = "mumbox:media:";
const MAX_GRID_SIZE = 12;

export type AppState = {
  panels: Panel[];
  activePanelId: string;
  cellsByPanel: Record<string, Record<string, GridCell>>;
  media: MediaAsset[];
  masterVolume: number;
  masterMuted: boolean;
  editMode: boolean;
  stopOthers: boolean;
};

export type SerializableAppState = Omit<AppState, "editMode" | "masterMuted"> & {
  masterMuted?: boolean;
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
  | { type: "state/reset" }
  | { type: "state/import"; state: SerializableAppState };

function createId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function makeCell(id: string): GridCell {
  return {
    id,
    mediaId: null,
    aliasOverride: "",
    colorOverride: null,
    playbackMode: "once",
    volumeOffset: 0,
    hotkey: "",
    trimStartMs: null,
    trimEndMs: null,
    fadeInEnabled: false,
    fadeInMs: 0,
    fadeOutEnabled: false,
    fadeOutMs: 0
  };
}

export function getPanelCellIds(gridSize: GridSize) {
  return Array.from({ length: gridSize * gridSize }, (_, index) => {
    const row = Math.floor(index / gridSize);
    const column = index % gridSize;

    return `cell-${String(row * MAX_GRID_SIZE + column)}`;
  });
}

function getLegacyPanelCellIds(gridSize: GridSize) {
  return Array.from({ length: gridSize * gridSize }, (_, index) => `cell-${String(index)}`);
}

function hasSameCellIds(first: string[], second: string[]) {
  return first.length === second.length && first.every((cellId, index) => cellId === second[index]);
}

function normalizePanelCellIds(panel: Panel) {
  const stableCellIds = getPanelCellIds(panel.gridSize);
  const legacyCellIds = getLegacyPanelCellIds(panel.gridSize);

  if (
    hasSameCellIds(panel.cellIds, stableCellIds) ||
    hasSameCellIds(panel.cellIds, legacyCellIds)
  ) {
    return stableCellIds;
  }

  return panel.cellIds;
}

function remapLegacyCells(panel: Panel, cells: Record<string, GridCell> | undefined) {
  const legacyCellIds = getLegacyPanelCellIds(panel.gridSize);
  if (!cells || !hasSameCellIds(panel.cellIds, legacyCellIds)) {
    return cells;
  }

  const stableCellIds = getPanelCellIds(panel.gridSize);
  const legacyIdsToMove = new Set(
    legacyCellIds.filter((legacyCellId, index) => legacyCellId !== stableCellIds[index])
  );
  const migratedCells = Object.fromEntries(
    Object.entries(cells).filter(([cellId]) => !legacyIdsToMove.has(cellId))
  );

  for (const [index, legacyCellId] of legacyCellIds.entries()) {
    const stableCellId = stableCellIds[index];
    const legacyCell = cells[legacyCellId];
    if (!legacyCell || !stableCellId) {
      continue;
    }

    migratedCells[stableCellId] = {
      ...legacyCell,
      id: stableCellId
    };
  }

  return migratedCells;
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

function ensurePanelCells(panel: Panel, cells: Record<string, GridCell> | undefined) {
  return panel.cellIds.reduce<Record<string, GridCell>>((accumulator, cellId) => {
    accumulator[cellId] = {
      ...makeCell(cellId),
      ...cells?.[cellId],
      id: cellId
    };
    return accumulator;
  }, {});
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
    stopOthers: false
  };
}

function sanitizeImportedState(state: SerializableAppState): AppState {
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
    media: state.media,
    masterVolume: state.masterVolume,
    masterMuted: state.masterMuted ?? false,
    editMode: false,
    stopOthers: state.stopOthers
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
    stopOthers: state.stopOthers
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
            [action.cellId]: {
              ...cell,
              mediaId: action.mediaId,
              playbackMode: action.playbackMode ?? cell.playbackMode
            }
          }
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
    case "state/reset":
      return createInitialState();
    case "state/import":
      return sanitizeImportedState(action.state);
    default:
      return state;
  }
}

export function loadStoredState(): AppState {
  const rawState = localStorage.getItem(STORAGE_KEY);
  if (!rawState) {
    return createInitialState();
  }

  try {
    return sanitizeImportedState(JSON.parse(rawState) as SerializableAppState);
  } catch {
    return createInitialState();
  }
}

export function useAppStore() {
  const [state, dispatch] = useReducer(reducer, undefined, loadStoredState);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeState(state)));
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

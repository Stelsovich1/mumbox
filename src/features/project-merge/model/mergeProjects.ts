import type { SerializableAppState } from "../../../app/model/appState";
import { MediaAsset } from "../../../entities/media/model/types";
import { preserveHiddenCells } from "../../../entities/panel/model/hiddenCells";
import {
  ensurePanelCells,
  normalizePanelCellIds,
  remapLegacyCells
} from "../../../entities/panel/model/panelCells";
import { makeUniquePanelName } from "../../../entities/panel/model/panelName";
import { Panel } from "../../../entities/panel/model/types";

export type MergeInput = {
  current: SerializableAppState;
  incoming: SerializableAppState;
  /** Incoming media id -> the id the merged project uses. From `planMediaDedup`. */
  mediaIdMap: Map<string, string>;
  /** Survivors of dedup, ready to append to the library. */
  addedMedia: MediaAsset[];
  /** Injected so tests are deterministic. */
  createPanelId: () => string;
};

export type MergeResult = {
  state: SerializableAppState;
  addedPanelIds: string[];
  renamedPanels: { from: string; to: string }[];
};

/**
 * Appends an incoming project's panels to the current one.
 *
 * Every incoming panel id is regenerated: `sanitizeImportedState` keeps incoming ids as they are,
 * and a collision would silently overwrite a panel's cells. Names collide far more often, and are
 * resolved with the same `makeUniquePanelName` that panel copy uses — against the accumulating
 * list, so two incoming `Panel 1`s become `Panel 1_2` and `Panel 1_3`.
 *
 * Global settings are taken from the current project: the user asked for the incoming project's
 * panels, not for its volume.
 */
export function mergeProjectState({
  current,
  incoming,
  mediaIdMap,
  addedMedia,
  createPanelId
}: MergeInput): MergeResult {
  const panels: Panel[] = [...current.panels];
  const cellsByPanel = { ...current.cellsByPanel };
  const addedPanelIds: string[] = [];
  const renamedPanels: { from: string; to: string }[] = [];

  for (const sourcePanel of incoming.panels) {
    const panel: Panel = {
      id: createPanelId(),
      name: makeUniquePanelName(panels, sourcePanel.name),
      gridSize: sourcePanel.gridSize,
      cellIds: normalizePanelCellIds(sourcePanel)
    };

    // The legacy flat `cell-${index}` migration has to run on incoming panels too: a project saved
    // by an old build carries the old scheme.
    const sourceCells = remapLegacyCells(sourcePanel, incoming.cellsByPanel[sourcePanel.id]);
    // Cues the incoming panel's grid size hides come along too; dropping them here would delete
    // audio the merged file still lists.
    const cells = preserveHiddenCells(panel, ensurePanelCells(panel, sourceCells), sourceCells);

    for (const cell of Object.values(cells)) {
      cell.mediaId = cell.mediaId ? mediaIdMap.get(cell.mediaId) ?? null : null;
    }

    if (panel.name !== sourcePanel.name) {
      renamedPanels.push({ from: sourcePanel.name, to: panel.name });
    }
    panels.push(panel);
    cellsByPanel[panel.id] = cells;
    addedPanelIds.push(panel.id);
  }

  return {
    state: {
      ...current,
      panels,
      cellsByPanel,
      media: [...current.media, ...addedMedia]
    },
    addedPanelIds,
    renamedPanels
  };
}

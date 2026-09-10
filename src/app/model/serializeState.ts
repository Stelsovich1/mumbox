/**
 * Turning the live store into the shape that is written down.
 *
 * Extracted from `appState.ts` so it can be unit tested: that file imports `react` and `idb-keyval`,
 * which the unit tier cannot load, and this is the function whose output ends up both in storage
 * and inside every `.mumbox` file.
 */
import { makeCell } from "../../entities/cell/model/makeCell";
import { GridCell } from "../../entities/cell/model/types";
import { MediaAsset } from "../../entities/media/model/types";
import { Panel } from "../../entities/panel/model/types";

export type SerializableStateInput = {
  panels: Panel[];
  activePanelId: string;
  cellsByPanel: Record<string, Record<string, GridCell>>;
  media: MediaAsset[];
  masterVolume: number;
  masterMuted: boolean;
  stopOthers: boolean;
  monoPlayback: boolean;
};

/**
 * Whether a cell carries any information at all.
 *
 * `ensurePanelCells` spreads `makeCell(id)` FIRST and the stored cell second — the comment on
 * `makeCell` says that exists so a new field gets its default on both a load and a project import
 * without a migration. The corollary is that a cell equal to its own default is pure noise in the
 * payload, and every path that reads state runs `ensurePanelCells` and would rebuild it anyway.
 */
export function isDefaultCell(cell: GridCell): boolean {
  const template = makeCell(cell.id);
  return (Object.keys(template) as (keyof GridCell)[]).every((key) => cell[key] === template[key]);
}

/**
 * Drops cells that are indistinguishable from a fresh one.
 *
 * `ensurePanelCells` materialises EVERY cell of a panel, filled or not, so an empty 12x12 panel cost
 * about 35 KB of JSON and a 20-panel project about 0.78 MiB — written in full on every reducer
 * action. Typically 90 to 95 % of that is cells that say nothing.
 *
 * Compatible in both directions, which is what makes it safe for the `.mumbox` payload as well as
 * for storage: the load path rebuilds the omitted cells from `makeCell`, and an OLDER build reading
 * such a file runs the same `ensurePanelCells` and tolerates the omission too. `version` stays 2.
 */
export function serializeState(state: SerializableStateInput) {
  const cellsByPanel: Record<string, Record<string, GridCell>> = {};
  for (const [panelId, cells] of Object.entries(state.cellsByPanel)) {
    const kept: Record<string, GridCell> = {};
    for (const [cellId, cell] of Object.entries(cells)) {
      if (!isDefaultCell(cell)) {
        kept[cellId] = cell;
      }
    }
    cellsByPanel[panelId] = kept;
  }

  return {
    panels: state.panels,
    activePanelId: state.activePanelId,
    cellsByPanel,
    media: state.media,
    masterVolume: state.masterVolume,
    masterMuted: state.masterMuted,
    stopOthers: state.stopOthers,
    monoPlayback: state.monoPlayback
  };
}

// Cross-entity import: a panel is defined by the cells it holds, so the cell factory belongs here.
// The alternative — keeping this in `app/model/appState.ts` — puts it behind a `react` import and
// out of reach of the unit tier, which runs in Node with no browser and no Vite plugins.
import { makeCell } from "../../cell/model/makeCell";
import { GridCell } from "../../cell/model/types";
import { GridSize, Panel } from "./types";

export const MAX_GRID_SIZE = 12;

/**
 * Position-stable cell ids: `cell-${row * 12 + column}` regardless of the grid size, so a cell keeps
 * its coordinates when the grid grows or shrinks between 6/8/10/12.
 */
export function getPanelCellIds(gridSize: GridSize) {
  return Array.from({ length: gridSize * gridSize }, (_, index) => {
    const row = Math.floor(index / gridSize);
    const column = index % gridSize;

    return `cell-${String(row * MAX_GRID_SIZE + column)}`;
  });
}

/** The flat `cell-${index}` scheme used by saves written before the stable ids existed. */
export function getLegacyPanelCellIds(gridSize: GridSize) {
  return Array.from({ length: gridSize * gridSize }, (_, index) => `cell-${String(index)}`);
}

export function hasSameCellIds(first: string[], second: string[]) {
  return first.length === second.length && first.every((cellId, index) => cellId === second[index]);
}

export function normalizePanelCellIds(panel: Panel) {
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

export function remapLegacyCells(panel: Panel, cells: Record<string, GridCell> | undefined) {
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

export function ensurePanelCells(panel: Panel, cells: Record<string, GridCell> | undefined) {
  return panel.cellIds.reduce<Record<string, GridCell>>((accumulator, cellId) => {
    accumulator[cellId] = {
      ...makeCell(cellId),
      ...cells?.[cellId],
      id: cellId
    };
    return accumulator;
  }, {});
}

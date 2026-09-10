import { makeCell } from "./makeCell";
import { GridCell } from "./types";

export type CellCopyPair = { fromCellId: string; toCellId: string };

export type CellCopyPlan = {
  cells: Record<string, GridCell>;
  pairs: CellCopyPair[];
  /** Sources that carry media but found no free target left. */
  skippedCount: number;
};

/**
 * One cell copied onto another. Shared so the single copy and the bulk one cannot drift apart.
 *
 * The hotkey is dropped on purpose — two cells answering one key is not a copy, it is a conflict —
 * and the alias gains a `_copy` suffix so the duplicate is identifiable on the grid.
 */
export function copyCellInto(
  sourceCell: GridCell,
  targetCellId: string,
  aliasBase: string
): GridCell {
  return {
    ...sourceCell,
    id: targetCellId,
    aliasOverride: aliasBase ? `${aliasBase}_copy` : "",
    hotkey: ""
  };
}

/**
 * Cells of `panelCellIds` that hold no media, in lattice order.
 *
 * A cell absent from the record counts as free: `serializeState` drops every cell equal to
 * `makeCell`, so a freshly loaded panel legitimately has holes.
 */
export function getFreeCellIds(
  cells: Record<string, GridCell>,
  panelCellIds: readonly string[]
): string[] {
  return panelCellIds.filter((cellId) => !cells[cellId]?.mediaId);
}

function cellSortIndex(cellId: string): number {
  const raw = /^cell-(\d+)$/.exec(cellId)?.[1];
  return raw === undefined ? Number.MAX_SAFE_INTEGER : Number(raw);
}

/**
 * Plans a batch copy into the first free cells of the target panel, in lattice order on both sides.
 *
 * Fewer free targets than sources is NOT a failure: as many as fit are copied and the rest are
 * reported in `skippedCount`, because refusing the whole batch would make the feature useless on a
 * partly filled panel. The caller is expected to say the number out loud.
 *
 * Sources without media are ignored, mirroring the `cell/copy` guard.
 */
export function planCellCopy(options: {
  sourceCells: Record<string, GridCell>;
  sourceCellIds: readonly string[];
  targetCells: Record<string, GridCell>;
  targetPanelCellIds: readonly string[];
  /** Fallback alias when the source has no override of its own — normally the media file name. */
  aliasBaseFor: (cell: GridCell) => string;
}): CellCopyPlan {
  const { sourceCells, sourceCellIds, targetCells, targetPanelCellIds, aliasBaseFor } = options;
  const ordered = [...new Set(sourceCellIds)].sort((a, b) => cellSortIndex(a) - cellSortIndex(b));
  const free = getFreeCellIds(targetCells, targetPanelCellIds);
  const cells = { ...targetCells };
  const pairs: CellCopyPair[] = [];
  let skippedCount = 0;
  let freeIndex = 0;

  for (const fromCellId of ordered) {
    const sourceCell = sourceCells[fromCellId];
    if (!sourceCell?.mediaId) {
      continue;
    }
    const toCellId = free[freeIndex];
    if (toCellId === undefined) {
      skippedCount += 1;
      continue;
    }
    freeIndex += 1;
    const target = cells[toCellId] ?? makeCell(toCellId);
    const aliasBase = sourceCell.aliasOverride.trim() || aliasBaseFor(sourceCell);
    cells[toCellId] = copyCellInto(sourceCell, target.id, aliasBase);
    pairs.push({ fromCellId, toCellId });
  }

  return { cells, pairs, skippedCount };
}

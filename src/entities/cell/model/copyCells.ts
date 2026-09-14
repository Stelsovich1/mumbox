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
 * Everything the source carries — colour, playback mode, trim, fades, volume — comes along
 * untouched. Two fields do not: the hotkey is dropped on purpose, because two cells answering one
 * key is not a copy but a conflict, and the alias is whatever `copyAliasFor` decided.
 */
export function copyCellInto(
  sourceCell: GridCell,
  targetCellId: string,
  aliasOverride: string
): GridCell {
  return {
    ...sourceCell,
    id: targetCellId,
    aliasOverride,
    hotkey: ""
  };
}

/**
 * The alias a copy gets.
 *
 * Onto ANOTHER panel the override is carried verbatim: the copy is a standalone cue there, and a
 * cue that was called «Гром» on one panel must be «Гром» on the next — an empty override stays
 * empty, so the grid keeps falling back to the media alias exactly as the source does. The old
 * rule appended `_copy` to the media FILE name, skipping the media alias entirely, which is how a
 * cue named in the import dialog came out as `boom.wav_copy` on the target panel.
 *
 * Onto the SAME panel the duplicate needs telling apart from its source, so the visible label —
 * override, else media alias, else file name — gains a `_copy` suffix.
 */
export function copyAliasFor(
  sourceCell: GridCell,
  samePanel: boolean,
  labelFor: (cell: GridCell) => string
): string {
  if (!samePanel) {
    return sourceCell.aliasOverride;
  }
  const base = sourceCell.aliasOverride.trim() || labelFor(sourceCell);
  return base ? `${base}_copy` : "";
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
  /** Source and target are the same panel, so copies need the `_copy` suffix to be told apart. */
  samePanel: boolean;
  /** What the grid shows for a cell without an override — the media alias, else its file name. */
  labelFor: (cell: GridCell) => string;
}): CellCopyPlan {
  const { sourceCells, sourceCellIds, targetCells, targetPanelCellIds, samePanel, labelFor } = options;
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
    cells[toCellId] = copyCellInto(sourceCell, target.id, copyAliasFor(sourceCell, samePanel, labelFor));
    pairs.push({ fromCellId, toCellId });
  }

  return { cells, pairs, skippedCount };
}

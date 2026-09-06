import { makeCell } from "./makeCell";
import { GridCell, PlaybackMode } from "./types";

export type CellAssignment = {
  cellId: string;
  mediaId: string;
  playbackMode?: PlaybackMode;
};

/** One cell gets media. Shared so single and batch assignment cannot drift apart. */
export function assignCellMedia(
  cell: GridCell,
  mediaId: string,
  playbackMode?: PlaybackMode
): GridCell {
  return {
    ...cell,
    mediaId,
    playbackMode: playbackMode ?? cell.playbackMode
  };
}

/**
 * Applies a batch of assignments to one panel's cells.
 *
 * Assignments naming a cell the panel does not have are dropped, mirroring the membership guards in
 * `cell/move` and `cell/copy`. `changed` is false when nothing applied, which lets the reducer
 * return its state by identity — no localStorage write and no warm-up restart for a no-op.
 */
export function applyCellAssignments(
  cells: Record<string, GridCell>,
  panelCellIds: readonly string[],
  assignments: readonly CellAssignment[]
): { cells: Record<string, GridCell>; changed: boolean } {
  const allowed = new Set(panelCellIds);
  const next = { ...cells };
  let changed = false;

  for (const assignment of assignments) {
    if (!allowed.has(assignment.cellId)) {
      continue;
    }
    const cell = next[assignment.cellId] ?? makeCell(assignment.cellId);
    next[assignment.cellId] = assignCellMedia(cell, assignment.mediaId, assignment.playbackMode);
    changed = true;
  }

  return { cells: next, changed };
}

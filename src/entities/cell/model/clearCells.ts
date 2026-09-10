import { isConfiguredCell } from "./isConfiguredCell";
import { makeCell } from "./makeCell";
import { GridCell } from "./types";

/**
 * Resets a batch of cells to `makeCell`.
 *
 * Ids the panel does not have are dropped, mirroring the membership guards in `cell/move` and
 * `applyCellAssignments`: a stale selection must never resurrect a hidden cell as an empty one.
 * `changed` is false when nothing applied, so the reducer can return its state by identity — no
 * persistence write and no warm-up restart for a no-op.
 */
export function clearPanelCells(
  cells: Record<string, GridCell>,
  panelCellIds: readonly string[],
  cellIds: readonly string[]
): { cells: Record<string, GridCell>; changed: boolean } {
  const allowed = new Set(panelCellIds);
  const next = { ...cells };
  let changed = false;

  for (const cellId of cellIds) {
    if (!allowed.has(cellId)) {
      continue;
    }
    const existing = next[cellId];
    // A missing key is already an empty cell — `serializeState` drops every cell equal to
    // `makeCell`, so writing one back would report a change that changes nothing.
    if (!existing || !isConfiguredCell(existing)) {
      continue;
    }
    next[cellId] = makeCell(cellId);
    changed = true;
  }

  return { cells: next, changed };
}

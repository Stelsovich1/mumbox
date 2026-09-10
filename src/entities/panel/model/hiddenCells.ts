import { GridCell } from "../../cell/model/types";
import { getLegacyPanelCellIds, hasSameCellIds, MAX_GRID_SIZE } from "./panelCells";
import { GridSize, Panel } from "./types";

/** Selectable grid sizes, smallest first. */
export const GRID_SIZES: readonly GridSize[] = [6, 8, 10, 12];

export type CellPosition = { row: number; column: number };

/**
 * Shrinking a grid hides cells, it does not clear them: `panel/gridSize` keeps the whole cell
 * record and only regenerates `cellIds`, so a cue placed at 12x12 still exists while a 6x6 grid is on
 * screen. Nothing on the grid can show that, because the cell is not rendered at all.
 *
 * It does NOT play from its hotkey there. `AppShell` builds the hotkey list from the visible
 * `cellIds`, so a hidden cue is unreachable by any means. Said plainly because this comment used to
 * claim the opposite, and a claim like that is how the next reader trusts an invariant nothing
 * enforces. These helpers are what lets the size control say it instead.
 */

/**
 * Cell ids encode a position on the 12x12 lattice (`cell-${row * 12 + column}`), which is what
 * makes a cell keep its coordinates across a resize.
 *
 * An id that does not parse is not reported as hidden: no grid size would bring it back, so a
 * permanent warning about it would be advice the user cannot act on.
 */
export function getCellPosition(cellId: string): CellPosition | null {
  const raw = /^cell-(\d+)$/.exec(cellId)?.[1];
  if (raw === undefined) {
    return null;
  }
  const index = Number(raw);
  if (index >= MAX_GRID_SIZE * MAX_GRID_SIZE) {
    return null;
  }
  return { row: Math.floor(index / MAX_GRID_SIZE), column: index % MAX_GRID_SIZE };
}

export function isCellWithinGrid(cellId: string, gridSize: GridSize): boolean {
  const position = getCellPosition(cellId);
  if (!position) {
    return false;
  }
  return position.row < gridSize && position.column < gridSize;
}

/** Cells that hold media and sit outside the given grid — the ones the user cannot see or reach. */
export function getHiddenMediaCellIds(
  cells: Record<string, GridCell> | undefined,
  gridSize: GridSize
): string[] {
  if (!cells) {
    return [];
  }
  return Object.entries(cells)
    .filter(([cellId, cell]) => cell.mediaId !== null && getCellPosition(cellId) !== null)
    .filter(([cellId]) => !isCellWithinGrid(cellId, gridSize))
    .map(([cellId]) => cellId);
}

export function countHiddenMediaCells(
  cells: Record<string, GridCell> | undefined,
  gridSize: GridSize
): number {
  return getHiddenMediaCellIds(cells, gridSize).length;
}

/**
 * The smallest selectable size that shows every cue in the panel, or `null` when nothing is
 * assigned. Used to point at the size worth switching to rather than only saying that something
 * is missing.
 */
export function getMinGridSizeForMedia(cells: Record<string, GridCell> | undefined): GridSize | null {
  if (!cells) {
    return null;
  }

  let required = 0;
  for (const [cellId, cell] of Object.entries(cells)) {
    if (cell.mediaId === null) {
      continue;
    }
    const position = getCellPosition(cellId);
    if (!position) {
      continue;
    }
    required = Math.max(required, position.row + 1, position.column + 1);
  }

  if (required === 0) {
    return null;
  }
  return GRID_SIZES.find((size) => size >= required) ?? MAX_GRID_SIZE;
}

/**
 * Re-attaches cells that hold media and sit outside the panel's current grid.
 *
 * `ensurePanelCells` builds the record from `cellIds` alone, so on its own it deletes every cue a
 * shrunken grid is hiding — permanently, on the next load or the next import. In-session the
 * `panel/gridSize` reducer already keeps them; this is the same promise on the way in.
 *
 * Legacy panels are the one exception. Their ids are flat `cell-${index}` for the panel's own
 * grid size, so an id outside the current grid names a position only if that grid was 12 wide.
 * Reading it as a lattice position for any other size would move the cue somewhere it never was,
 * which is worse than the drop this repairs — and a legacy save predates the whole idea.
 */
export function preserveHiddenCells(
  panel: Panel,
  cells: Record<string, GridCell>,
  sourceCells: Record<string, GridCell> | undefined
): Record<string, GridCell> {
  if (!sourceCells) {
    return cells;
  }
  if (hasSameCellIds(panel.cellIds, getLegacyPanelCellIds(panel.gridSize))) {
    return cells;
  }

  const preserved = { ...cells };
  for (const [cellId, cell] of Object.entries(sourceCells)) {
    if (cellId in preserved || cell.mediaId === null || getCellPosition(cellId) === null) {
      continue;
    }
    preserved[cellId] = { ...cell, id: cellId };
  }
  return preserved;
}

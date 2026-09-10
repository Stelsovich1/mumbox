import { GridCell } from "./types";

/**
 * Whether a cell holds anything a user would miss. Pure and dependency-free so the unit tier can
 * load it, and shared so the single-cell confirmation and the bulk one cannot drift apart: a
 * confirmation dialog that under-reports is worse than no dialog, because it teaches the user that
 * "Очистить" is safe.
 *
 * Every field of `makeCell` is compared. A new `GridCell` field must be added here too, or clearing
 * it silently stops asking.
 */
export function isConfiguredCell(cell: GridCell): boolean {
  return (
    Boolean(cell.mediaId) ||
    cell.aliasOverride.length > 0 ||
    cell.colorOverride !== null ||
    cell.hotkey.length > 0 ||
    cell.playbackMode !== "once" ||
    cell.volumeOffset !== 0 ||
    cell.trimStartMs !== null ||
    cell.trimEndMs !== null ||
    cell.fadeInEnabled ||
    cell.fadeInMs !== 0 ||
    cell.fadeOutEnabled ||
    cell.fadeOutMs !== 0
  );
}

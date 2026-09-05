/**
 * How many cells across every panel hold one of the given media. Deleting media resets those cells,
 * and there is no undo, so a bulk delete has to say up front how much of the project it will clear.
 *
 * Structurally typed on `{ mediaId }` so a unit test needs no full `GridCell` fixture.
 */
export function countCellsUsingMedia(
  cellsByPanel: Record<string, Record<string, { mediaId: string | null }> | undefined>,
  mediaIds: readonly string[]
) {
  if (mediaIds.length === 0) {
    return 0;
  }

  const targets = new Set(mediaIds);
  let count = 0;
  for (const cells of Object.values(cellsByPanel)) {
    for (const cell of Object.values(cells ?? {})) {
      if (cell.mediaId !== null && targets.has(cell.mediaId)) {
        count += 1;
      }
    }
  }

  return count;
}

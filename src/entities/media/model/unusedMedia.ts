/**
 * Media that no cell of any panel points at.
 *
 * Structurally typed on `{ mediaId }` and `{ id }`, like `countCellsUsingMedia` next to it, so a
 * unit test needs no `GridCell` or `MediaAsset` fixture.
 *
 * The scan walks the whole `cellsByPanel` record — every cell of every panel, NOT `panel.cellIds`.
 * That difference is the whole correctness argument: shrinking a grid hides cells rather than
 * clearing them, so a cue placed at 12x12 still exists while a 6x6 grid is on screen, and a scan
 * driven by the visible lattice would report its media as unused and offer to delete it.
 */
export function findUnusedMediaIds(
  media: readonly { id: string }[],
  cellsByPanel: Record<string, Record<string, { mediaId: string | null }> | undefined>
): string[] {
  const used = new Set<string>();
  for (const cells of Object.values(cellsByPanel)) {
    for (const cell of Object.values(cells ?? {})) {
      if (cell.mediaId !== null) {
        used.add(cell.mediaId);
      }
    }
  }
  return media.filter((asset) => !used.has(asset.id)).map((asset) => asset.id);
}

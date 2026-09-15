import { Panel } from "./types";

/**
 * Moves `panelId` so that it ends up at `toIndex` in the resulting array, everything else keeping
 * its relative order. Returns the SAME array when nothing changes — an unknown id, an index out of
 * range, or a move onto the panel's own position — so the reducer can hand the state back
 * untouched and persistence sees no new `panels` reference to write.
 *
 * `toIndex` is the index in the final order, not an insertion slot in the old one: dragging the
 * first tab onto the third puts it third, which is what the pointer under the third tab means.
 */
export function reorderPanels(panels: readonly Panel[], panelId: string, toIndex: number): Panel[] {
  const fromIndex = panels.findIndex((panel) => panel.id === panelId);
  if (
    fromIndex === -1 ||
    !Number.isInteger(toIndex) ||
    toIndex < 0 ||
    toIndex >= panels.length ||
    toIndex === fromIndex
  ) {
    return panels as Panel[];
  }

  const next = [...panels];
  const [moved] = next.splice(fromIndex, 1);
  if (!moved) {
    return panels as Panel[];
  }
  next.splice(toIndex, 0, moved);
  return next;
}

/**
 * Where a media drag lands. Imports nothing, so it stays loadable from the unit tier, which runs in
 * Node with no browser and no Vite plugins.
 */

export type MediaAssignmentPlan = {
  assignments: { cellId: string; mediaId: string }[];
  /** How many media had nowhere left to go. */
  overflowCount: number;
};

type ResolveInput = {
  draggedMediaId: string;
  selectedMediaIds: ReadonlySet<string>;
  /** The picker's current visible order — the filtered, sorted list, not the whole library. */
  displayOrder: readonly string[];
};

type PlanInput = {
  /** `panel.cellIds` verbatim. Never sort it — see below. */
  cellIds: readonly string[];
  occupiedCellIds: ReadonlySet<string>;
  targetCellId: string;
  mediaIds: readonly string[];
};

/**
 * Which media a drag actually carries.
 *
 * Dragging an unselected row carries that row alone; dragging a selected one carries the whole
 * selection, with the dragged id first so that the row the pointer grabbed lands on the cell the
 * pointer aimed at. Selected ids hidden by the search or the colour filter are excluded — dropping
 * media the user cannot see is a surprise, not a feature.
 */
export function resolveDraggedMediaIds({
  draggedMediaId,
  selectedMediaIds,
  displayOrder
}: ResolveInput): string[] {
  if (!selectedMediaIds.has(draggedMediaId)) {
    return [draggedMediaId];
  }

  const resolved = [draggedMediaId];
  for (const mediaId of displayOrder) {
    if (mediaId !== draggedMediaId && selectedMediaIds.has(mediaId)) {
      resolved.push(mediaId);
    }
  }

  return resolved;
}

/**
 * Fills free cells starting at the drop target and walking `cellIds` **in array order**.
 *
 * Array order is load-bearing: `getPanelCellIds` yields `cell-0..cell-5, cell-12..cell-17, …` for a
 * 6x6 panel, so ordering by id or by the numeric suffix fills in the wrong visual order.
 *
 * An occupied target is accepted and the media slides forward to the next free cell; occupied cells
 * along the way are skipped, never overwritten, so a configured cell keeps its hotkey, trims and
 * fades. There is no wrap-around: free cells before the target are left alone and the remainder is
 * reported instead.
 */
export function planMediaDistribution({
  cellIds,
  occupiedCellIds,
  targetCellId,
  mediaIds
}: PlanInput): MediaAssignmentPlan {
  const startIndex = cellIds.indexOf(targetCellId);
  if (startIndex < 0 || mediaIds.length === 0) {
    return { assignments: [], overflowCount: mediaIds.length };
  }

  const assignments: { cellId: string; mediaId: string }[] = [];
  let mediaIndex = 0;

  for (let index = startIndex; index < cellIds.length && mediaIndex < mediaIds.length; index += 1) {
    const cellId = cellIds[index];
    const mediaId = mediaIds[mediaIndex];
    if (cellId === undefined || mediaId === undefined || occupiedCellIds.has(cellId)) {
      continue;
    }
    assignments.push({ cellId, mediaId });
    mediaIndex += 1;
  }

  return { assignments, overflowCount: mediaIds.length - mediaIndex };
}

/** The toast shown after a drop. Empty when everything fit — a toast per drop blocks the next one. */
export function buildDistributionMessage(plan: MediaAssignmentPlan) {
  if (plan.overflowCount === 0) {
    return "";
  }
  if (plan.assignments.length === 0) {
    return "Нет свободных ячеек";
  }

  return `Назначено ячеек: ${String(plan.assignments.length)}, не поместилось: ${String(plan.overflowCount)}`;
}

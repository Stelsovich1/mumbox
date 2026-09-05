/**
 * Selection-set math for the media tables. Pure and dependency-free so the unit tier can load it.
 *
 * Selection is keyed by row id, never by index: the media picker slices a virtual window out of the
 * filtered list, so an index means something different after every scroll and every sort.
 */

export type SelectAllState = "none" | "some" | "all";

export function toggleSelection(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (!next.delete(id)) {
    next.add(id);
  }

  return next;
}

/**
 * Adds or removes exactly `ids`, leaving every id outside that list alone. `ids` is the *filtered*
 * row list, so a select-all under an active search cannot silently sweep in the hidden rows.
 */
export function setSelection(
  selected: ReadonlySet<string>,
  ids: readonly string[],
  checked: boolean
): Set<string> {
  const next = new Set(selected);
  for (const id of ids) {
    if (checked) {
      next.add(id);
    } else {
      next.delete(id);
    }
  }

  return next;
}

export function countSelected(selected: ReadonlySet<string>, ids: readonly string[]): number {
  let count = 0;
  for (const id of ids) {
    if (selected.has(id)) {
      count += 1;
    }
  }

  return count;
}

export function getSelectAllState(
  selected: ReadonlySet<string>,
  ids: readonly string[]
): SelectAllState {
  if (ids.length === 0) {
    return "none";
  }

  const count = countSelected(selected, ids);
  if (count === 0) {
    return "none";
  }

  return count === ids.length ? "all" : "some";
}

/**
 * Drops ids that no longer exist. Without this a deleted row stays "selected" forever and the bulk
 * bar keeps counting ghosts.
 */
export function pruneSelection(
  selected: ReadonlySet<string>,
  existingIds: readonly string[]
): Set<string> {
  const existing = new Set(existingIds);
  const next = new Set<string>();
  for (const id of selected) {
    if (existing.has(id)) {
      next.add(id);
    }
  }

  return next;
}

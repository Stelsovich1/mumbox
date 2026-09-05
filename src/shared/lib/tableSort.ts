/**
 * Three-state column sorting for the hand-rolled `role="table"` grids. Pure and dependency-free.
 */

export type SortDirection = "asc" | "desc";
export type SortState<TKey extends string> = { key: TKey; direction: SortDirection } | null;
export type Comparator<TRow> = (first: TRow, second: TRow) => number;

/**
 * `null -> asc -> desc -> null`. Clicking a *different* column restarts at `asc` rather than
 * continuing the previous column's cycle.
 */
export function cycleSortState<TKey extends string>(
  current: SortState<TKey>,
  key: TKey
): SortState<TKey> {
  if (current?.key !== key) {
    return { key, direction: "asc" };
  }
  if (current.direction === "asc") {
    return { key, direction: "desc" };
  }

  return null;
}

export function getAriaSort(current: SortState<string>, key: string) {
  if (current?.key !== key) {
    return "none" as const;
  }

  return current.direction === "asc" ? ("ascending" as const) : ("descending" as const);
}

/**
 * Returns the **same array reference** for a `null` state, so an unsorted table costs no copy and
 * downstream `useMemo` chains do not churn. `Array.prototype.sort` is stable, so equal keys keep
 * insertion order.
 */
export function sortRows<TRow, TKey extends string>(
  rows: readonly TRow[],
  state: SortState<TKey>,
  // `Partial` on purpose: a table may declare a sortable column before its comparator exists, and
  // an unknown key must degrade to insertion order rather than throwing.
  comparators: Readonly<Partial<Record<TKey, Comparator<TRow>>>>
): readonly TRow[] {
  if (!state) {
    return rows;
  }

  const comparator = comparators[state.key];
  if (!comparator) {
    return rows;
  }

  const direction = state.direction === "asc" ? 1 : -1;

  return [...rows].sort((first, second) => comparator(first, second) * direction);
}

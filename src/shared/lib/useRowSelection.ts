import { useCallback, useState } from "react";

import {
  pruneSelection,
  setSelection,
  toggleSelection
} from "./rowSelection";

const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>();

/**
 * React sugar over `rowSelection`. Holds no logic of its own so all of it stays unit-testable.
 */
export function useRowSelection() {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(EMPTY_SELECTION);

  const toggle = useCallback((id: string) => {
    setSelectedIds((current) => toggleSelection(current, id));
  }, []);

  const setMany = useCallback((ids: readonly string[], checked: boolean) => {
    setSelectedIds((current) => setSelection(current, ids, checked));
  }, []);

  const clear = useCallback(() => {
    setSelectedIds(EMPTY_SELECTION);
  }, []);

  const prune = useCallback((existingIds: readonly string[]) => {
    setSelectedIds((current) => {
      const next = pruneSelection(current, existingIds);

      return next.size === current.size ? current : next;
    });
  }, []);

  return { selectedIds, toggle, setMany, clear, prune };
}

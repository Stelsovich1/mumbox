import { useCallback, useEffect, useState } from "react";

import { ProjectLibraryRow } from "../../../entities/project/model/types";
import { FileHandleLike } from "../../../shared/lib/fileSystemAccess";
import { probeProjectRows } from "./projectProbe";
import { ProjectRowProbe } from "./projectRowState";
import { deleteProjectRows, listProjectRows, saveProjectRow } from "./projectsStore";

export type ProjectRowDraft = {
  fileName: string;
  projectName: string;
  description: string;
  sizeBytes: number | null;
  panelCount: number | null;
  mediaCount: number | null;
  handle?: FileHandleLike;
};

function makeRowId() {
  return `project-${crypto.randomUUID()}`;
}

/**
 * Owns the projects list so `AppShell` does not double in size. Everything here is orchestration;
 * the decisions live in `projectRowState`, which is pure and unit-tested.
 */
export function useProjectLibrary(open: boolean) {
  const [rows, setRows] = useState<ProjectLibraryRow[]>([]);
  const [probes, setProbes] = useState<Map<string, ProjectRowProbe>>(new Map());

  const refresh = useCallback(async () => {
    const stored = await listProjectRows();
    setRows(stored);
    // Probing never prompts, so it is safe to run for every row as the dialog opens.
    setProbes(await probeProjectRows(stored));
  }, []);

  useEffect(() => {
    if (open) {
      void refresh();
    }
  }, [open, refresh]);

  const upsertRow = useCallback(
    async (draft: ProjectRowDraft, existingId?: string) => {
      const row: ProjectLibraryRow = {
        id: existingId ?? makeRowId(),
        fileName: draft.fileName,
        projectName: draft.projectName,
        description: draft.description,
        sizeBytes: draft.sizeBytes,
        savedAt: new Date().toISOString(),
        lastOpenedAt: null,
        panelCount: draft.panelCount,
        mediaCount: draft.mediaCount,
        handle: draft.handle
      };
      await saveProjectRow(row);
      await refresh();

      return row;
    },
    [refresh]
  );

  const markOpened = useCallback(
    async (row: ProjectLibraryRow) => {
      await saveProjectRow({ ...row, lastOpenedAt: new Date().toISOString() });
      await refresh();
    },
    [refresh]
  );

  const removeRows = useCallback(
    async (targets: readonly ProjectLibraryRow[]) => {
      // `readwrite` consumes user activation, so a bulk delete gets at most one prompt per gesture
      // and later rows can fail silently. Report per-row rather than promising all-or-nothing.
      let removedFromDisk = 0;
      let failedOnDisk = 0;

      for (const row of targets) {
        const remove = row.handle?.remove;
        if (!remove) {
          continue;
        }
        try {
          await remove.call(row.handle);
          removedFromDisk += 1;
        } catch {
          failedOnDisk += 1;
        }
      }

      await deleteProjectRows(targets.map((row) => row.id));
      await refresh();

      return { removedFromDisk, failedOnDisk };
    },
    [refresh]
  );

  return { rows, probes, refresh, upsertRow, markOpened, removeRows };
}

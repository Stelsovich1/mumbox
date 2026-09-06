import { clear, createStore, del, entries, set } from "idb-keyval";

import { ProjectLibraryRow } from "../../../entities/project/model/types";
import { isFileHandleLike } from "../../../shared/lib/fileSystemAccess";

/**
 * A store of its own, not the default keyval store.
 *
 * `clearStoredAppData` calls idb-keyval's `clear()`, which wipes the whole default store. Sharing it
 * would make the projects list vanish as an undocumented side effect; a separate store forces the
 * decision to be written down — and the decision is that a full reset does clear it, by an explicit
 * call.
 */
export const PROJECTS_DB_NAME = "mumbox-projects";
export const PROJECTS_STORE_NAME = "projects";

const projectsStore = createStore(PROJECTS_DB_NAME, PROJECTS_STORE_NAME);

export async function listProjectRows(): Promise<ProjectLibraryRow[]> {
  const stored = await entries<string, ProjectLibraryRow>(projectsStore);

  return stored
    .map(([, row]) => row as ProjectLibraryRow | undefined)
    .filter((row): row is ProjectLibraryRow => typeof row?.id === "string" && row.id.length > 0)
    .map((row) =>
      // A handle rehydrated from IndexedDB can be a stale shape; drop anything unusable rather than
      // letting a broken object reach the UI as a "linked" row.
      row.handle && isFileHandleLike(row.handle) ? row : { ...row, handle: undefined }
    )
    .sort((first, second) => second.savedAt.localeCompare(first.savedAt));
}

export async function saveProjectRow(row: ProjectLibraryRow) {
  try {
    await set(row.id, row, projectsStore);
  } catch (error: unknown) {
    // Structured clone rejects a handle Firefox and Safari never produced, and any test double with
    // function properties. Keep the row, lose only the link.
    if (error instanceof DOMException && error.name === "DataCloneError") {
      await set(row.id, { ...row, handle: undefined }, projectsStore);
      return;
    }
    throw error;
  }
}

export async function deleteProjectRows(ids: readonly string[]) {
  await Promise.all(ids.map((id) => del(id, projectsStore)));
}

export async function clearProjectsIndex() {
  await clear(projectsStore);
}

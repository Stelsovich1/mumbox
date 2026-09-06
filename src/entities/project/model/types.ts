import { FileHandleLike } from "../../../shared/lib/fileSystemAccess";

/**
 * One row of the projects list.
 *
 * The list holds metadata and, where the browser can keep one, a file handle. It never holds the
 * project's audio: duplicating every project's blobs into browser storage is exactly what this
 * design avoids. A row is a bookmark, and losing the list loses nothing that is not still on disk.
 *
 * There is no path field because no browser exposes one — not even through the File System Access
 * API, which gives a handle and a name and nothing else. `sizeBytes`, `savedAt`, `panelCount` and
 * `mediaCount` are what actually let a user tell two same-named files apart.
 */
export type ProjectLibraryRow = {
  id: string;
  fileName: string;
  projectName: string;
  description: string;
  sizeBytes: number | null;
  savedAt: string;
  lastOpenedAt: string | null;
  panelCount: number | null;
  mediaCount: number | null;
  handle?: FileHandleLike;
};

/**
 * - `ready` — the file is reachable right now.
 * - `needsPermission` — the handle is fine, the grant expired. The row stays usable; clicking it
 *   prompts. This is **not** an error state.
 * - `missing` — the file was moved, renamed or deleted. Delete or re-link only.
 * - `noHandle` — the browser cannot keep a reference at all (Safari, iOS, Firefox). Not a warning:
 *   the user simply points at the file again.
 */
export type ProjectRowStatus = "ready" | "needsPermission" | "missing" | "noHandle";

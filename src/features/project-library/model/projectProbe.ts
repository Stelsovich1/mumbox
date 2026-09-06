import { ProjectLibraryRow } from "../../../entities/project/model/types";
import { queryHandlePermission } from "../../../shared/lib/fileSystemAccess";
import { classifyFileError, ProjectRowProbe } from "./projectRowState";

/**
 * Asks the filesystem what state a row is in, without ever prompting.
 *
 * A row sitting at `prompt` is deliberately **not** probed with `getFile()`: that would throw
 * `NotAllowedError`, and a naive reading of the failure would report the file as missing.
 */
export async function probeProjectRow(row: ProjectLibraryRow): Promise<ProjectRowProbe> {
  const handle = row.handle;
  if (!handle) {
    return { permission: "unsupported", fileError: null };
  }

  const permission = await queryHandlePermission(handle, "read");
  if (permission !== "granted") {
    return { permission, fileError: null };
  }

  try {
    await handle.getFile();

    return { permission, fileError: null };
  } catch (error: unknown) {
    return { permission, fileError: classifyFileError(error) };
  }
}

export async function probeProjectRows(rows: readonly ProjectLibraryRow[]) {
  const probes = await Promise.all(
    rows.map(async (row) => [row.id, await probeProjectRow(row)] as const)
  );

  return new Map(probes);
}

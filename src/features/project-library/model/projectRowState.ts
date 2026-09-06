import { ProjectSession } from "../../../app/model/projectSession";
import { ProjectLibraryRow, ProjectRowStatus } from "../../../entities/project/model/types";
import { canRemoveFromDisk } from "../../../shared/lib/fileSystemAccess";
import { formatCountRu } from "../../../shared/lib/pluralizeRu";

export type FileProbeError = "missing" | "denied" | "unknown";

export type ProjectRowProbe = {
  permission: PermissionState | "unsupported";
  fileError: FileProbeError | null;
};

/** What the delete button can actually do for a given set of rows. */
export type DeleteCapability = "diskAndList" | "listOnly" | "mixed";

export type ActivationPlan =
  | { kind: "alreadyOpen" }
  | { kind: "savedProject"; buttons: readonly string[] }
  | { kind: "unsavedProject"; buttons: readonly string[] };

const PROJECT_FORMS = ["проект", "проекта", "проектов"] as const;

/**
 * `NotFoundError` means the file is gone. `NotAllowedError` and `SecurityError` mean the grant
 * lapsed — the file is fine. Conflating the two marks a healthy project as broken forever, which
 * is the easiest bug to write here and the hardest to notice.
 */
export function classifyFileError(error: unknown): FileProbeError {
  if (error instanceof DOMException) {
    if (error.name === "NotFoundError") {
      return "missing";
    }
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "denied";
    }
  }

  return "unknown";
}

export function getProjectRowStatus(
  row: ProjectLibraryRow,
  probe: ProjectRowProbe | undefined
): ProjectRowStatus {
  if (!row.handle) {
    return "noHandle";
  }
  if (!probe) {
    return "ready";
  }
  if (probe.permission === "prompt") {
    return "needsPermission";
  }
  if (probe.fileError === "missing") {
    return "missing";
  }
  if (probe.permission === "denied" || probe.fileError === "denied") {
    return "needsPermission";
  }

  return "ready";
}

export function isRowActivatable(status: ProjectRowStatus) {
  return status !== "missing";
}

export function isRowDeleteOnly(status: ProjectRowStatus) {
  return status === "missing";
}

export function getProjectRowLabel(row: ProjectLibraryRow) {
  return row.projectName.trim() || row.fileName;
}

/** Rows that point at a file, and rows the browser cannot link — shown as separate sections. */
export function sortProjectRows(rows: readonly ProjectLibraryRow[]) {
  const linked: ProjectLibraryRow[] = [];
  const unlinked: ProjectLibraryRow[] = [];
  for (const row of rows) {
    if (row.handle) {
      linked.push(row);
    } else {
      unlinked.push(row);
    }
  }

  return { linked, unlinked };
}

export function getDeleteCapability(rows: readonly ProjectLibraryRow[]): DeleteCapability {
  const removable = rows.filter((row) => canRemoveFromDisk(row.handle)).length;
  if (removable === 0) {
    return "listOnly";
  }

  return removable === rows.length ? "diskAndList" : "mixed";
}

/**
 * The confirmation must never promise a disk deletion that will not happen. Only Chromium 110+ can
 * delete a file it was handed; everywhere else the row disappears and the file stays.
 */
export function getDeleteConfirmText(
  rows: readonly ProjectLibraryRow[],
  capability: DeleteCapability
) {
  const first = rows[0];
  if (!first) {
    return "";
  }

  if (rows.length === 1) {
    const label = getProjectRowLabel(first);

    return capability === "diskAndList"
      ? `Удалить проект "${label}"? Файл будет удалён с диска.`
      : `Удалить проект "${label}" из списка? Файл на диске останется — этот браузер не умеет удалять файлы.`;
  }

  const count = formatCountRu(rows.length, PROJECT_FORMS);
  if (capability === "diskAndList") {
    return `Удалить ${count}? Файлы будут удалены с диска.`;
  }
  if (capability === "listOnly") {
    return `Удалить ${count} из списка? Файлы на диске останутся.`;
  }

  const removable = rows.filter((row) => canRemoveFromDisk(row.handle)).length;

  return `Удалить ${count}? С диска будет удалено: ${String(removable)}. Остальные исчезнут только из списка.`;
}

export const ACTIVATION_BUTTON_OPEN = "Открыть";
export const ACTIVATION_BUTTON_SAVE_AND_OPEN = "Сохранить и открыть";
export const ACTIVATION_BUTTON_DISCARD = "Без сохранения";
export const ACTIVATION_BUTTON_CANCEL = "Отмена";

/**
 * A project saved earlier but edited since counts as unsaved: it is the only reading where the user
 * cannot lose work by answering the dialog quickly.
 */
export function getActivationPlan(session: ProjectSession, row: ProjectLibraryRow): ActivationPlan {
  if (row.id === session.projectId && !session.dirty) {
    return { kind: "alreadyOpen" };
  }

  if (!session.saved || session.dirty) {
    return {
      kind: "unsavedProject",
      buttons: [
        ACTIVATION_BUTTON_SAVE_AND_OPEN,
        ACTIVATION_BUTTON_DISCARD,
        ACTIVATION_BUTTON_CANCEL
      ]
    };
  }

  return { kind: "savedProject", buttons: [ACTIVATION_BUTTON_OPEN, ACTIVATION_BUTTON_CANCEL] };
}

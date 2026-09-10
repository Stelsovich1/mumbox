/**
 * One typed failure for everything that can go wrong with a project file.
 *
 * Mirrors the precedent in `projectRowState.ts`, where `classifyFileError` exists because
 * conflating `NotFoundError` with `NotAllowedError` marked a healthy project broken forever. The
 * same reasoning applies here: "could not read the file" and "the file is corrupt" lead the user to
 * different actions, and only one of them is worth re-picking the file for.
 */

export type ProjectFileFailureKind =
  | "not-a-project"
  | "corrupt"
  | "unreadable"
  | "no-space"
  | "too-large"
  | "unknown";

export class ProjectFileError extends Error {
  readonly kind: ProjectFileFailureKind;
  readonly detail: string;

  constructor(kind: ProjectFileFailureKind, detail: string) {
    super(`${kind}: ${detail}`);
    this.name = "ProjectFileError";
    this.kind = kind;
    this.detail = detail;
  }
}

function isProjectFileError(value: unknown): value is ProjectFileError {
  return value instanceof ProjectFileError;
}

export function classifyProjectFileError(error: unknown): ProjectFileFailureKind {
  if (isProjectFileError(error)) {
    return error.kind;
  }
  if (error instanceof DOMException) {
    if (error.name === "NotReadableError" || error.name === "NotFoundError") {
      return "unreadable";
    }
    if (error.name === "QuotaExceededError") {
      return "no-space";
    }
  }
  // Not every engine throws a DOMException for a full store; idb-keyval surfaces whatever the
  // request produced.
  if (error instanceof Error && error.name === "QuotaExceededError") {
    return "no-space";
  }
  return "unknown";
}

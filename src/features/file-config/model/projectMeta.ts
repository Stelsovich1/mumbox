/**
 * Project name and description, carried inside the `.mumbox` manifest.
 *
 * Living in the file rather than only in a browser-side list is what lets a re-picked file restore
 * its own identity — the only way the projects list works on Safari and iOS, where a file handle
 * cannot be stored at all.
 */

export type ProjectMeta = {
  name?: string;
  description?: string;
  savedAt?: string;
};

const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;

function asTrimmedString(value: unknown, maxLength: number) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();

  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

/**
 * Tolerates anything: a manifest written before `meta` existed, a hand-edited file, wrong types.
 * Never throws — a malformed name must not make a valid project unopenable.
 */
export function normalizeProjectMeta(value: unknown): ProjectMeta {
  if (!value || typeof value !== "object") {
    return {};
  }

  const candidate = value as Record<string, unknown>;
  const meta: ProjectMeta = {};
  const name = asTrimmedString(candidate.name, MAX_NAME_LENGTH);
  const description = asTrimmedString(candidate.description, MAX_DESCRIPTION_LENGTH);
  const savedAt = asTrimmedString(candidate.savedAt, MAX_NAME_LENGTH);

  if (name) {
    meta.name = name;
  }
  if (description) {
    meta.description = description;
  }
  if (savedAt) {
    meta.savedAt = savedAt;
  }

  return meta;
}

const PROJECT_FILE_EXTENSION = ".mumbox";
const DEFAULT_PROJECT_FILE_NAME = "mumbox-project";
// Everything Windows, macOS and Linux agree is unusable in a file name. Spaces and dashes stay:
// stripping them would turn "Мой проект" into "Мойпроект".
const UNSAFE_FILE_NAME_CHARS = /["*/:<>?\\|]/g;

/** Turns whatever the user typed into a usable `.mumbox` file name. */
export function toProjectFileName(requested: string) {
  const withoutExtension = requested.trim().replace(/\.mumbox$/i, "");
  const safe = withoutExtension.replace(UNSAFE_FILE_NAME_CHARS, "").trim();

  return `${safe || DEFAULT_PROJECT_FILE_NAME}${PROJECT_FILE_EXTENSION}`;
}

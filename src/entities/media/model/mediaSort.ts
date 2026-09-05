import { CELL_COLORS } from "../../../shared/config/colorPalette";
import { Comparator } from "../../../shared/lib/tableSort";
import { MediaAsset } from "./types";

export type MediaSortKey = "fileName" | "alias" | "durationMs" | "createdAt" | "color";

export const MEDIA_SORT_KEYS: readonly MediaSortKey[] = [
  "fileName",
  "alias",
  "durationMs",
  "createdAt",
  "color"
];

/** What the user actually sees for a media asset: its alias, or the file name when none is set. */
export function getMediaLabel(media: Pick<MediaAsset, "alias" | "fileName">) {
  return media.alias.trim() || media.fileName;
}

export function getCreatedAtTime(value: string | undefined | null) {
  if (!value) {
    return null;
  }
  const time = new Date(value).getTime();

  return Number.isNaN(time) ? null : time;
}

// Missing values sort last ascending. Descending is a plain negation of the ascending comparator,
// so they land first there; that keeps every comparator direction-agnostic and `sortRows` a one-liner.
function compareNullable(first: number | null, second: number | null) {
  if (first === null && second === null) {
    return 0;
  }
  if (first === null) {
    return 1;
  }
  if (second === null) {
    return -1;
  }

  return first - second;
}

function compareText(first: string, second: string) {
  return first.localeCompare(second, "ru", { numeric: true, sensitivity: "base" });
}

/** `numeric: true` so `track-2.wav` precedes `track-10.wav`, which matters for folder imports. */
export function compareMediaByFileName(first: MediaAsset, second: MediaAsset) {
  return compareText(first.fileName, second.fileName);
}

/**
 * Compares on the visible label, not the raw alias: sorting by raw alias clumps every blank-alias
 * row together, and in this app most aliases are blank.
 */
export function compareMediaByAlias(first: MediaAsset, second: MediaAsset) {
  return compareText(getMediaLabel(first), getMediaLabel(second));
}

export function compareMediaByDuration(first: MediaAsset, second: MediaAsset) {
  return compareNullable(first.durationMs, second.durationMs);
}

export function compareMediaByCreatedAt(first: MediaAsset, second: MediaAsset) {
  return compareNullable(getCreatedAtTime(first.createdAt), getCreatedAtTime(second.createdAt));
}

/** Palette order, not hex order. A colour outside the palette sorts last. */
export function compareMediaByColor(first: MediaAsset, second: MediaAsset) {
  const palette: readonly string[] = CELL_COLORS;
  const firstIndex = palette.indexOf(first.color);
  const secondIndex = palette.indexOf(second.color);

  return compareNullable(
    firstIndex < 0 ? null : firstIndex,
    secondIndex < 0 ? null : secondIndex
  );
}

export const MEDIA_COMPARATORS: Readonly<Record<MediaSortKey, Comparator<MediaAsset>>> = {
  fileName: compareMediaByFileName,
  alias: compareMediaByAlias,
  durationMs: compareMediaByDuration,
  createdAt: compareMediaByCreatedAt,
  color: compareMediaByColor
};

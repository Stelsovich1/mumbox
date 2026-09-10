/**
 * What a `.mumbox` manifest must contain before the reducer is allowed to see it.
 *
 * The old predicate checked four things — `kind`, `version`, `Boolean(state)` and
 * `Array.isArray(mediaBlobs)` — and then handed the object to `sanitizeImportedState`, which
 * immediately reads `state.panels.length`. A hand-edited or corrupt manifest therefore threw a
 * `TypeError` inside the reducer, where there was no boundary to catch it and, worse, where the old
 * blobs had already been deleted.
 *
 * The rule for what to require is NOT "validate everything". `version` is frozen at 2 precisely so
 * an older build can read a newer file, and a predicate that rejected an unknown optional field
 * would break that in both directions. So: require exactly what the sanitizer would throw on, and
 * tolerate everything it tolerates. The table below is that enumeration, walked through
 * `normalizePanelCellIds`, `remapLegacyCells`, `ensurePanelCells`, `preserveHiddenCells` and
 * `ensureMedia`.
 */
import type { SerializableAppState } from "../../../app/model/appState";
import { GRID_SIZES } from "../../../entities/panel/model/hiddenCells";
import type { ProjectMeta } from "./projectMeta";

export type ProjectMediaBlob = {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  contentHash?: string;
};

export type ProjectFile = {
  kind: "mumbox-project";
  /**
   * Frozen at 2 and compared exactly.
   *
   * The app is a PWA with `registerType: "prompt"`, so a user can stay on an old build for weeks. A
   * bump makes that build refuse files the current one writes. New fields go in as optional, which
   * is what `meta` is.
   */
  version: 2;
  exportedAt: string;
  meta?: ProjectMeta;
  state: SerializableAppState;
  mediaBlobs: ProjectMediaBlob[];
};

export type ManifestFailure =
  | "not-an-object"
  | "wrong-kind"
  | "wrong-version"
  | "bad-panels"
  | "bad-cells"
  | "bad-volume"
  | "bad-media-blobs";

export type ManifestResult =
  | { ok: true; value: ProjectFile }
  | { ok: false; reason: ManifestFailure };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGridSize(value: unknown): boolean {
  return typeof value === "number" && (GRID_SIZES as readonly number[]).includes(value);
}

/**
 * Every field the sanitizer would throw on, and nothing more.
 *
 * Deliberately NOT required, because the sanitizer already tolerates them and rejecting them would
 * break the frozen-version contract: `state.media` (`ensureMedia` accepts anything, including a
 * non-array), `activePanelId` (falls back to the first panel), `masterMuted` / `monoPlayback` /
 * `stopOthers` (optional by type), unknown extra keys anywhere, and individual cell fields beyond
 * `mediaId` — that last one is a real remaining hole, and it wants a `normalizeCell` beside
 * `ensureMedia` rather than a predicate.
 *
 * `panels: []` MUST be accepted: `sanitizeImportedState` explicitly substitutes a default panel for
 * it, so a predicate that rejected it would refuse a legitimate file.
 */
function isValidPanel(panel: unknown): boolean {
  if (!isObject(panel)) {
    return false;
  }
  if (typeof panel.id !== "string" || typeof panel.name !== "string") {
    return false;
  }
  // A non-number here does not throw — it makes `Array.from({length: NaN})` produce an empty panel,
  // silently losing every cue in it. That is worse than a throw, so it is checked.
  if (!isGridSize(panel.gridSize)) {
    return false;
  }
  return Array.isArray(panel.cellIds) && panel.cellIds.every((id) => typeof id === "string");
}

function isValidCellRecord(cells: unknown): boolean {
  if (!isObject(cells)) {
    return false;
  }
  return Object.values(cells).every((cell) => {
    if (!isObject(cell)) {
      return false;
    }
    const mediaId = cell.mediaId;
    return mediaId === null || mediaId === undefined || typeof mediaId === "string";
  });
}

export function isSerializableAppState(value: unknown): value is SerializableAppState {
  if (!isObject(value)) {
    return false;
  }
  // `state.panels.length` is the first thing the sanitizer touches.
  if (!Array.isArray(value.panels) || !value.panels.every((panel) => isValidPanel(panel))) {
    return false;
  }
  if (!isObject(value.cellsByPanel)) {
    return false;
  }
  if (!Object.values(value.cellsByPanel).every((cells) => isValidCellRecord(cells))) {
    return false;
  }
  // Reaches `masterVolume / 100` and then a gain node, where a NaN throws far from here.
  return typeof value.masterVolume === "number" && Number.isFinite(value.masterVolume);
}

function isMediaBlobList(value: unknown): value is ProjectMediaBlob[] {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every((item) => {
    if (!isObject(item)) {
      return false;
    }
    // The reader looks entries up as `media/${id}` and stamps `mimeType` onto a Blob, so both have
    // to be strings before either is used.
    return (
      typeof item.id === "string" &&
      item.id.length > 0 &&
      typeof item.fileName === "string" &&
      typeof item.mimeType === "string"
    );
  });
}

export function parseProjectManifest(value: unknown): ManifestResult {
  if (!isObject(value)) {
    return { ok: false, reason: "not-an-object" };
  }
  if (value.kind !== "mumbox-project") {
    return { ok: false, reason: "wrong-kind" };
  }
  // Exactly 2, never a range. See the note on the field.
  if (value.version !== 2) {
    return { ok: false, reason: "wrong-version" };
  }
  if (!isMediaBlobList(value.mediaBlobs)) {
    return { ok: false, reason: "bad-media-blobs" };
  }
  const state = value.state;
  if (!isObject(state)) {
    return { ok: false, reason: "bad-panels" };
  }
  if (!Array.isArray(state.panels)) {
    return { ok: false, reason: "bad-panels" };
  }
  if (!isObject(state.cellsByPanel)) {
    return { ok: false, reason: "bad-cells" };
  }
  if (typeof state.masterVolume !== "number" || !Number.isFinite(state.masterVolume)) {
    return { ok: false, reason: "bad-volume" };
  }
  // Split rather than inferred from a heuristic: a panel with a bad `gridSize` and a cell record
  // with a null entry are different repairs, and telling them apart in diagnostics is the only
  // reason the reasons are typed at all.
  if (!state.panels.every((panel) => isValidPanel(panel))) {
    return { ok: false, reason: "bad-panels" };
  }
  if (!Object.values(state.cellsByPanel).every((cells) => isValidCellRecord(cells))) {
    return { ok: false, reason: "bad-cells" };
  }
  if (!isSerializableAppState(state)) {
    return { ok: false, reason: "bad-panels" };
  }
  return { ok: true, value: value as unknown as ProjectFile };
}

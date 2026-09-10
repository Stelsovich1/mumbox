/**
 * A `.mumbox` built in Node from the real MP3 corpus, with every playback shape on it.
 *
 * Why it exists: the only project-import coverage was `project-integrity.spec.ts`, which imports a
 * ONE-CELL project holding a 0.25 s WAV. That pins the reader's acceptance rules and says nothing
 * about cost — and cost is what a user feels, on a project of sixteen multi-megabyte MP3s where the
 * write stage takes long enough to look hung. A fixture built from `__mock__` is the same material
 * the complaint was made about.
 *
 * The archive is written here rather than exported through the UI (`buildProject` in
 * `project-integrity.spec.ts` does that) because driving sixteen imports and eighteen cell dialogs
 * through the interface costs minutes per run and would measure the UI, not the import.
 *
 * Cells cover the combinations that change which decode path a cell takes: untrimmed and trimmed,
 * `once` and `loop`, fade in, fade out, both. Loops are excluded from streaming by design, an
 * untrimmed long track streams, and a trimmed window is range-read — so a fixture with only one of
 * those shapes cannot show a regression in the other two.
 */
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

import { buildZip } from "./zipFixtures";
import { listMp3Fixtures, MP3_FIXTURE_DIR, truncateToFrames } from "./mp3Fixtures";

/**
 * Nominal bitrate of the corpus, used to derive `durationMs` without parsing frame headers.
 *
 * The corpus is 192 kbps MPEG-1 Layer III throughout (`mp3Fixtures.ts` documents the measurement),
 * so size / bitrate is within a frame of the truth. It has to be roughly right rather than exact:
 * `isPartialPathLikely` and `getClampedPlaybackRange` judge the window against it, and the app
 * itself stores a duration measured at import for the same purpose.
 */
const NOMINAL_BITS_PER_SECOND = 192_000;

/**
 * Trims are FRACTIONS of the media's own duration, not milliseconds.
 *
 * The same fixture is built from whole 200-400 s files for a cost measurement and from 40 s
 * truncations for a test that runs on every push. A trim of "30 s to 45 s" means a mid-file window
 * in one and is past the end in the other, and clamping would silently turn it into a different
 * shape — so the shape is expressed in the only terms that survive both.
 */
export type MockCellShape = {
  label: string;
  playbackMode: "once" | "loop";
  trimStartRatio: number | null;
  trimEndRatio: number | null;
  fadeInEnabled: boolean;
  fadeInMs: number;
  fadeOutEnabled: boolean;
  fadeOutMs: number;
};

function shape(
  label: string,
  overrides: Partial<Omit<MockCellShape, "label">> = {}
): MockCellShape {
  return {
    label,
    playbackMode: "once",
    trimStartRatio: null,
    trimEndRatio: null,
    fadeInEnabled: false,
    fadeInMs: 0,
    fadeOutEnabled: false,
    fadeOutMs: 0,
    ...overrides
  };
}

/**
 * Nine shapes per panel, in a fixed order so a failure names the same cell every run.
 *
 * `whole` is the shape the memory work is about — an untrimmed long track, which streams. `window`
 * is the shape the range read is about. `loop-whole` is the one that legitimately declines and pays
 * a full decode, and it is here precisely so that cost stays visible in the numbers.
 */
export const MOCK_CELL_SHAPES: readonly MockCellShape[] = [
  shape("whole"),
  shape("whole-fade-in", { fadeInEnabled: true, fadeInMs: 1200 }),
  shape("whole-fade-out", { fadeOutEnabled: true, fadeOutMs: 1800 }),
  shape("whole-fade-both", {
    fadeInEnabled: true,
    fadeInMs: 800,
    fadeOutEnabled: true,
    fadeOutMs: 2500
  }),
  shape("window", { trimStartRatio: 0.4, trimEndRatio: 0.6 }),
  shape("window-fade", {
    trimStartRatio: 0.2,
    trimEndRatio: 0.35,
    fadeInEnabled: true,
    fadeInMs: 500,
    fadeOutEnabled: true,
    fadeOutMs: 500
  }),
  shape("tail", { trimStartRatio: 0.7, trimEndRatio: null }),
  shape("head", { trimStartRatio: null, trimEndRatio: 0.25 }),
  shape("loop-whole", { playbackMode: "loop" })
];

const CELL_COLORS = ["#ffcc66", "#6df7a5", "#7fd1ff", "#ff8fb1", "#c6a0ff", "#ffd7a1"];
const MAX_GRID_SIZE = 12;

function cellId(index: number): string {
  const row = Math.floor(index / MAX_GRID_SIZE);
  return `cell-${String(row * MAX_GRID_SIZE + (index % MAX_GRID_SIZE))}`;
}

export type MockProjectPlan = {
  /** Panels to build; each gets `MOCK_CELL_SHAPES.length` filled cells. */
  panels: number;
  gridSize: 6 | 8 | 10 | 12;
  /** How many corpus files to use. Cells are assigned round-robin over them. */
  mediaCount: number;
  /**
   * Truncate each file to this many frames, keeping it a valid MP3.
   *
   * The corpus is 192-417 s per file, which is right for measuring what a user's project costs and
   * wrong for a test that runs on every push: sixteen whole files are ~110 MB to import and then
   * eighteen cells to warm. Truncating keeps every property the paths under test depend on — real
   * frame headers, real LAME delay, real bit reservoir — at a fraction of the bytes. Omit it for
   * the full-size measurement.
   */
  maxFrames?: number;
};

export type MockProject = {
  path: string;
  bytes: number;
  mediaCount: number;
  cellCount: number;
  /** Total audio bytes, which is what the import actually has to move. */
  audioBytes: number;
};

/**
 * Builds the archive and returns its path plus the sizes a cost assertion needs.
 *
 * Throws when the corpus is missing; the caller is expected to skip on `hasMp3Fixtures()` first,
 * the same way the MP3 specs do.
 */
export function buildMockProject(plan: MockProjectPlan): MockProject {
  // `listMp3Fixtures` returns names, not paths.
  const names = listMp3Fixtures().slice(0, plan.mediaCount);
  if (names.length === 0) {
    throw new Error("No MP3 fixtures available");
  }

  const media = names.map((fileName, index) => {
    const whole = readFileSync(join(MP3_FIXTURE_DIR, fileName));
    const bytes =
      plan.maxFrames === undefined ? whole : truncateToFrames(whole, plan.maxFrames);
    return {
      id: `media-mock-${String(index).padStart(4, "0")}`,
      fileName,
      alias: `Mock ${String(index)}`,
      color: CELL_COLORS[index % CELL_COLORS.length] ?? "#ffcc66",
      mimeType: "audio/mpeg",
      size: bytes.byteLength,
      durationMs: Math.round((bytes.byteLength * 8 * 1000) / NOMINAL_BITS_PER_SECOND),
      createdAt: new Date(0).toISOString(),
      bytes
    };
  });

  const panels: unknown[] = [];
  const cellsByPanel: Record<string, Record<string, unknown>> = {};
  const panelIds: string[] = [];
  let assignCursor = 0;
  let cellCount = 0;

  for (let panelIndex = 0; panelIndex < plan.panels; panelIndex += 1) {
    const panelId = `panel-mock-${String(panelIndex)}`;
    const cellIds = Array.from(
      { length: plan.gridSize * plan.gridSize },
      (_, index) => cellId(index)
    );
    const cells: Record<string, unknown> = {};

    for (const [index, id] of cellIds.entries()) {
      const shapeAt = MOCK_CELL_SHAPES[index];
      const asset = media[assignCursor % media.length];
      if (shapeAt && asset) {
        assignCursor += 1;
        cellCount += 1;
        cells[id] = {
          id,
          mediaId: asset.id,
          aliasOverride: "",
          colorOverride: null,
          playbackMode: shapeAt.playbackMode,
          volumeOffset: 0,
          hotkey: "",
          trimStartMs:
            shapeAt.trimStartRatio === null
              ? null
              : Math.round(asset.durationMs * shapeAt.trimStartRatio),
          trimEndMs:
            shapeAt.trimEndRatio === null
              ? null
              : Math.round(asset.durationMs * shapeAt.trimEndRatio),
          fadeInEnabled: shapeAt.fadeInEnabled,
          fadeInMs: shapeAt.fadeInMs,
          fadeOutEnabled: shapeAt.fadeOutEnabled,
          fadeOutMs: shapeAt.fadeOutMs
        };
        continue;
      }
      cells[id] = {
        id,
        mediaId: null,
        aliasOverride: "",
        colorOverride: null,
        playbackMode: "once",
        volumeOffset: 0,
        hotkey: "",
        trimStartMs: null,
        trimEndMs: null,
        fadeInEnabled: false,
        fadeInMs: 0,
        fadeOutEnabled: false,
        fadeOutMs: 0
      };
    }

    panelIds.push(panelId);
    cellsByPanel[panelId] = cells;
    panels.push({
      id: panelId,
      name: `Мок ${String(panelIndex + 1)}`,
      gridSize: plan.gridSize,
      cellIds
    });
  }

  const manifest = {
    kind: "mumbox-project",
    version: 2,
    exportedAt: new Date(0).toISOString(),
    meta: { name: "Мок-проект", description: "Реальные MP3 из __mock__", savedAt: new Date(0).toISOString() },
    state: {
      panels,
      activePanelId: panelIds[0] ?? "",
      cellsByPanel,
      media: media.map((asset) => ({
        id: asset.id,
        fileName: asset.fileName,
        alias: asset.alias,
        color: asset.color,
        mimeType: asset.mimeType,
        size: asset.size,
        durationMs: asset.durationMs,
        createdAt: asset.createdAt
      })),
      masterVolume: 80,
      masterMuted: false,
      stopOthers: false
    },
    mediaBlobs: media.map((asset) => ({
      id: asset.id,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      size: asset.size
    }))
  };

  const fixture = buildZip([
    { name: "project.json", bytes: new TextEncoder().encode(JSON.stringify(manifest)) },
    ...media.map((asset) => ({
      name: `media/${asset.id}`,
      bytes: new Uint8Array(asset.bytes.buffer, asset.bytes.byteOffset, asset.bytes.byteLength)
    }))
  ]);

  const path = join(
    tmpdir(),
    `mumbox-mock-${String(Date.now())}-${String(Math.random()).slice(2)}.mumbox`
  );
  writeFileSync(path, fixture.bytes);

  return {
    path,
    bytes: fixture.bytes.byteLength,
    mediaCount: media.length,
    cellCount,
    audioBytes: media.reduce((sum, asset) => sum + asset.size, 0)
  };
}

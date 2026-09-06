import { expect, test } from "@playwright/test";

import { applyCellAssignments, assignCellMedia } from "../../src/entities/cell/model/assignCells";
import { makeCell } from "../../src/entities/cell/model/makeCell";
import { GridCell } from "../../src/entities/cell/model/types";

const PANEL_CELL_IDS = ["cell-0", "cell-1", "cell-2"];

function makeCells(...ids: string[]): Record<string, GridCell> {
  return Object.fromEntries(ids.map((id) => [id, makeCell(id)]));
}

test.describe("assignCellMedia", () => {
  test("sets the media and keeps every other field", () => {
    const cell: GridCell = { ...makeCell("cell-0"), hotkey: "L", volumeOffset: -3 };
    const next = assignCellMedia(cell, "media-a");

    expect(next.mediaId).toBe("media-a");
    expect(next.hotkey).toBe("L");
    expect(next.volumeOffset).toBe(-3);
  });

  test("keeps the existing playback mode unless one is given", () => {
    const cell: GridCell = { ...makeCell("cell-0"), playbackMode: "loop" };

    expect(assignCellMedia(cell, "media-a").playbackMode).toBe("loop");
    expect(assignCellMedia(cell, "media-a", "gate").playbackMode).toBe("gate");
  });
});

test.describe("applyCellAssignments", () => {
  test("applies every assignment that names a cell of the panel", () => {
    const { cells, changed } = applyCellAssignments(makeCells(...PANEL_CELL_IDS), PANEL_CELL_IDS, [
      { cellId: "cell-0", mediaId: "media-a" },
      { cellId: "cell-2", mediaId: "media-b" }
    ]);

    expect(changed).toBe(true);
    expect(cells["cell-0"]?.mediaId).toBe("media-a");
    expect(cells["cell-1"]?.mediaId).toBeNull();
    expect(cells["cell-2"]?.mediaId).toBe("media-b");
  });

  test("drops an assignment naming a cell the panel does not have", () => {
    // Mirrors the membership guards in `cell/move` and `cell/copy`: a stale id from a resized grid
    // must not conjure a cell that no panel renders.
    const { cells, changed } = applyCellAssignments(makeCells(...PANEL_CELL_IDS), PANEL_CELL_IDS, [
      { cellId: "cell-99", mediaId: "media-a" }
    ]);

    expect(changed).toBe(false);
    expect(cells["cell-99"]).toBeUndefined();
    expect(Object.keys(cells).sort()).toEqual(PANEL_CELL_IDS);
  });

  test("keeps the valid part of a mixed batch", () => {
    const { cells, changed } = applyCellAssignments(makeCells(...PANEL_CELL_IDS), PANEL_CELL_IDS, [
      { cellId: "cell-99", mediaId: "media-a" },
      { cellId: "cell-1", mediaId: "media-b" }
    ]);

    expect(changed).toBe(true);
    expect(cells["cell-1"]?.mediaId).toBe("media-b");
    expect(cells["cell-99"]).toBeUndefined();
  });

  test("creates a cell the record does not carry yet", () => {
    const { cells, changed } = applyCellAssignments({}, PANEL_CELL_IDS, [
      { cellId: "cell-1", mediaId: "media-a" }
    ]);

    expect(changed).toBe(true);
    expect(cells["cell-1"]?.mediaId).toBe("media-a");
    expect(cells["cell-1"]?.id).toBe("cell-1");
  });

  test("reports no change for an empty batch", () => {
    expect(applyCellAssignments(makeCells("cell-0"), PANEL_CELL_IDS, []).changed).toBe(false);
  });

  test("does not mutate the cells it was given", () => {
    const original = makeCells(...PANEL_CELL_IDS);
    applyCellAssignments(original, PANEL_CELL_IDS, [{ cellId: "cell-0", mediaId: "media-a" }]);

    expect(original["cell-0"]?.mediaId).toBeNull();
  });
});

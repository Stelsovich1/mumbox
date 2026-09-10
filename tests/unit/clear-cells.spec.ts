import { expect, test } from "@playwright/test";

import { clearPanelCells } from "../../src/entities/cell/model/clearCells";
import { isConfiguredCell } from "../../src/entities/cell/model/isConfiguredCell";
import { makeCell } from "../../src/entities/cell/model/makeCell";
import { GridCell } from "../../src/entities/cell/model/types";

function filled(id: string, patch: Partial<GridCell> = {}): GridCell {
  return { ...makeCell(id), mediaId: "media-1", ...patch };
}

test.describe("isConfiguredCell", () => {
  test("a freshly made cell is not configured", () => {
    expect(isConfiguredCell(makeCell("cell-0"))).toBe(false);
  });

  test("every field of makeCell is watched", () => {
    const variants: Partial<GridCell>[] = [
      { mediaId: "media-1" },
      { aliasOverride: "a" },
      { colorOverride: "#fff" },
      { hotkey: "Q" },
      { playbackMode: "loop" },
      { volumeOffset: -3 },
      { trimStartMs: 0 },
      { trimEndMs: 10 },
      { fadeInEnabled: true },
      { fadeInMs: 40 },
      { fadeOutEnabled: true },
      { fadeOutMs: 40 }
    ];

    for (const patch of variants) {
      expect(isConfiguredCell({ ...makeCell("cell-0"), ...patch })).toBe(true);
    }
  });

  test("trimStartMs of 0 counts, because null is the unset value", () => {
    expect(isConfiguredCell({ ...makeCell("cell-0"), trimStartMs: 0 })).toBe(true);
  });
});

test.describe("clearPanelCells", () => {
  const panelCellIds = ["cell-0", "cell-1", "cell-2"];

  test("resets the listed cells to makeCell", () => {
    const result = clearPanelCells(
      { "cell-0": filled("cell-0", { hotkey: "Q" }), "cell-1": filled("cell-1") },
      panelCellIds,
      ["cell-0"]
    );

    expect(result.changed).toBe(true);
    expect(result.cells["cell-0"]).toEqual(makeCell("cell-0"));
    expect(result.cells["cell-1"]?.mediaId).toBe("media-1");
  });

  test("clears several cells in one pass", () => {
    const result = clearPanelCells(
      { "cell-0": filled("cell-0"), "cell-1": filled("cell-1"), "cell-2": filled("cell-2") },
      panelCellIds,
      ["cell-0", "cell-2"]
    );

    expect(result.cells["cell-0"]?.mediaId).toBeNull();
    expect(result.cells["cell-1"]?.mediaId).toBe("media-1");
    expect(result.cells["cell-2"]?.mediaId).toBeNull();
  });

  test("does not mutate the input record", () => {
    const cells: Record<string, GridCell> = { "cell-0": filled("cell-0") };
    const result = clearPanelCells(cells, panelCellIds, ["cell-0"]);

    expect(result.cells).not.toBe(cells);
    expect(cells["cell-0"]?.mediaId).toBe("media-1");
  });

  test("drops ids the panel does not have, so a stale selection cannot resurrect a hidden cell", () => {
    const cells = { "cell-0": filled("cell-0"), "cell-99": filled("cell-99") };
    const result = clearPanelCells(cells, panelCellIds, ["cell-99"]);

    expect(result.changed).toBe(false);
    expect(result.cells["cell-99"]?.mediaId).toBe("media-1");
  });

  test("reports no change for an already empty cell", () => {
    const result = clearPanelCells({ "cell-0": makeCell("cell-0") }, panelCellIds, ["cell-0"]);

    expect(result.changed).toBe(false);
  });

  test("reports no change for a cell missing from the record", () => {
    const result = clearPanelCells({}, panelCellIds, ["cell-0"]);

    expect(result.changed).toBe(false);
    expect(result.cells["cell-0"]).toBeUndefined();
  });

  test("an empty id list changes nothing", () => {
    const result = clearPanelCells({ "cell-0": filled("cell-0") }, panelCellIds, []);

    expect(result.changed).toBe(false);
  });

  test("a duplicated id is harmless", () => {
    const result = clearPanelCells({ "cell-0": filled("cell-0") }, panelCellIds, [
      "cell-0",
      "cell-0"
    ]);

    expect(result.changed).toBe(true);
    expect(result.cells["cell-0"]).toEqual(makeCell("cell-0"));
  });

  test("a configured cell holding no media is still cleared", () => {
    const result = clearPanelCells(
      { "cell-0": { ...makeCell("cell-0"), hotkey: "Q" } },
      panelCellIds,
      ["cell-0"]
    );

    expect(result.changed).toBe(true);
    expect(result.cells["cell-0"]?.hotkey).toBe("");
  });
});

import { expect, test } from "@playwright/test";

import {
  copyAliasFor,
  copyCellInto,
  getFreeCellIds,
  planCellCopy
} from "../../src/entities/cell/model/copyCells";
import { makeCell } from "../../src/entities/cell/model/makeCell";
import { GridCell } from "../../src/entities/cell/model/types";

function filled(id: string, patch: Partial<GridCell> = {}): GridCell {
  return { ...makeCell(id), mediaId: "media-1", ...patch };
}

const labelFor = () => "bell.mp3";

test.describe("copyCellInto", () => {
  test("carries every setting over, takes the given alias and drops the hotkey", () => {
    const source = filled("cell-0", {
      hotkey: "Q",
      volumeOffset: -4,
      trimStartMs: 120,
      colorOverride: "#f97316",
      playbackMode: "loop",
      fadeInEnabled: true,
      fadeInMs: 250
    });
    const copy = copyCellInto(source, "cell-5", "bell.mp3_copy");

    expect(copy).toEqual({
      ...source,
      id: "cell-5",
      aliasOverride: "bell.mp3_copy",
      hotkey: ""
    });
  });
});

test.describe("copyAliasFor", () => {
  test("onto another panel the override travels verbatim", () => {
    expect(copyAliasFor(filled("cell-0", { aliasOverride: "Гром" }), false, labelFor)).toBe("Гром");
  });

  test("onto another panel an empty override stays empty so the media alias still shows", () => {
    // The old rule produced `bell.mp3_copy` here, skipping the media alias the source displayed.
    expect(copyAliasFor(filled("cell-0"), false, labelFor)).toBe("");
  });

  test("onto the same panel the override gains a _copy suffix", () => {
    expect(copyAliasFor(filled("cell-0", { aliasOverride: "Гром" }), true, labelFor)).toBe("Гром_copy");
  });

  test("onto the same panel a blank override falls back to the visible media label", () => {
    expect(copyAliasFor(filled("cell-0", { aliasOverride: "  " }), true, labelFor)).toBe(
      "bell.mp3_copy"
    );
    expect(copyAliasFor(filled("cell-0"), true, () => "")).toBe("");
  });
});

test.describe("getFreeCellIds", () => {
  test("counts a cell missing from the record as free", () => {
    expect(getFreeCellIds({ "cell-1": filled("cell-1") }, ["cell-0", "cell-1", "cell-2"])).toEqual([
      "cell-0",
      "cell-2"
    ]);
  });

  test("a configured cell without media is still free", () => {
    const cells = { "cell-0": { ...makeCell("cell-0"), hotkey: "Q" } };

    expect(getFreeCellIds(cells, ["cell-0"])).toEqual(["cell-0"]);
  });
});

test.describe("planCellCopy", () => {
  const targetPanelCellIds = ["cell-0", "cell-1", "cell-2", "cell-3"];

  test("fills the first free target cells in lattice order", () => {
    const plan = planCellCopy({
      sourceCells: { "cell-4": filled("cell-4"), "cell-2": filled("cell-2") },
      sourceCellIds: ["cell-4", "cell-2"],
      targetCells: { "cell-0": filled("cell-0") },
      targetPanelCellIds,
      samePanel: false,
      labelFor
    });

    // Sources are ordered by lattice index, not by the order they were selected in.
    expect(plan.pairs).toEqual([
      { fromCellId: "cell-2", toCellId: "cell-1" },
      { fromCellId: "cell-4", toCellId: "cell-2" }
    ]);
    expect(plan.skippedCount).toBe(0);
    expect(plan.cells["cell-0"]?.mediaId).toBe("media-1");
  });

  test("copies as many as fit and reports the rest instead of refusing the batch", () => {
    const plan = planCellCopy({
      sourceCells: { "cell-0": filled("cell-0"), "cell-1": filled("cell-1") },
      sourceCellIds: ["cell-0", "cell-1"],
      targetCells: { "cell-0": filled("cell-0") },
      targetPanelCellIds: ["cell-0", "cell-1"],
      samePanel: false,
      labelFor
    });

    expect(plan.pairs).toEqual([{ fromCellId: "cell-0", toCellId: "cell-1" }]);
    expect(plan.skippedCount).toBe(1);
  });

  test("never overwrites an occupied target", () => {
    const target = filled("cell-0", { mediaId: "media-target" });
    const plan = planCellCopy({
      sourceCells: { "cell-0": filled("cell-0") },
      sourceCellIds: ["cell-0"],
      targetCells: { "cell-0": target },
      targetPanelCellIds: ["cell-0"],
      samePanel: false,
      labelFor
    });

    expect(plan.pairs).toEqual([]);
    expect(plan.skippedCount).toBe(1);
    expect(plan.cells["cell-0"]?.mediaId).toBe("media-target");
  });

  test("ignores sources without media rather than counting them as skipped", () => {
    const plan = planCellCopy({
      sourceCells: { "cell-0": makeCell("cell-0") },
      sourceCellIds: ["cell-0"],
      targetCells: {},
      targetPanelCellIds,
      samePanel: false,
      labelFor
    });

    expect(plan.pairs).toEqual([]);
    expect(plan.skippedCount).toBe(0);
  });

  test("ignores a source id the source panel does not hold", () => {
    const plan = planCellCopy({
      sourceCells: {},
      sourceCellIds: ["cell-77"],
      targetCells: {},
      targetPanelCellIds,
      samePanel: false,
      labelFor
    });

    expect(plan.pairs).toEqual([]);
    expect(plan.skippedCount).toBe(0);
  });

  test("a duplicated source id is copied once", () => {
    const plan = planCellCopy({
      sourceCells: { "cell-0": filled("cell-0") },
      sourceCellIds: ["cell-0", "cell-0"],
      targetCells: {},
      targetPanelCellIds,
      samePanel: false,
      labelFor
    });

    expect(plan.pairs).toEqual([{ fromCellId: "cell-0", toCellId: "cell-0" }]);
  });

  test("does not mutate the target record", () => {
    const targetCells: Record<string, GridCell> = { "cell-0": filled("cell-0") };
    const plan = planCellCopy({
      sourceCells: { "cell-1": filled("cell-1") },
      sourceCellIds: ["cell-1"],
      targetCells,
      targetPanelCellIds,
      samePanel: false,
      labelFor
    });

    expect(plan.cells).not.toBe(targetCells);
    expect(targetCells["cell-1"]).toBeUndefined();
  });

  test("onto another panel the alias and colour travel untouched", () => {
    const plan = planCellCopy({
      sourceCells: {
        "cell-0": filled("cell-0", { aliasOverride: " kick ", colorOverride: "#f97316" }),
        "cell-1": filled("cell-1")
      },
      sourceCellIds: ["cell-0", "cell-1"],
      targetCells: {},
      targetPanelCellIds,
      samePanel: false,
      labelFor
    });

    expect(plan.cells["cell-0"]?.aliasOverride).toBe(" kick ");
    expect(plan.cells["cell-0"]?.colorOverride).toBe("#f97316");
    // No override on the source: none on the copy, so both keep showing the media label.
    expect(plan.cells["cell-1"]?.aliasOverride).toBe("");
  });

  test("onto the same panel the copy is suffixed so it can be told from its source", () => {
    const plan = planCellCopy({
      sourceCells: { "cell-0": filled("cell-0", { aliasOverride: " kick " }) },
      sourceCellIds: ["cell-0"],
      targetCells: { "cell-0": filled("cell-0", { aliasOverride: " kick " }) },
      targetPanelCellIds,
      samePanel: true,
      labelFor
    });

    expect(plan.cells["cell-1"]?.aliasOverride).toBe("kick_copy");
  });

  test("copying onto the same panel does not chain into cells it just filled", () => {
    const plan = planCellCopy({
      sourceCells: { "cell-0": filled("cell-0") },
      sourceCellIds: ["cell-0"],
      targetCells: { "cell-0": filled("cell-0") },
      targetPanelCellIds,
      samePanel: true,
      labelFor
    });

    expect(plan.pairs).toEqual([{ fromCellId: "cell-0", toCellId: "cell-1" }]);
    expect(plan.cells["cell-2"]?.mediaId).toBeUndefined();
  });
});

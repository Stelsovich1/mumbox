import { expect, test } from "@playwright/test";

import { makeCell } from "../../src/entities/cell/model/makeCell";
import { GridCell } from "../../src/entities/cell/model/types";
import {
  countHiddenMediaCells,
  getCellPosition,
  getHiddenMediaCellIds,
  getMinGridSizeForMedia,
  isCellWithinGrid,
  preserveHiddenCells
} from "../../src/entities/panel/model/hiddenCells";
import {
  ensurePanelCells,
  getLegacyPanelCellIds,
  getPanelCellIds
} from "../../src/entities/panel/model/panelCells";
import { Panel } from "../../src/entities/panel/model/types";

/**
 * Shrinking the grid keeps the cells it stops rendering, so a cue can be present, audible from a
 * hotkey, and invisible at the same time. These are the rules the size control paints itself from.
 */

function cellAt(row: number, column: number, mediaId: string | null): [string, GridCell] {
  const cellId = `cell-${String(row * 12 + column)}`;
  return [cellId, { ...makeCell(cellId), mediaId }];
}

function panelCells(...entries: [string, GridCell][]): Record<string, GridCell> {
  return Object.fromEntries(entries);
}

test("reads a position off the 12x12 lattice", () => {
  expect(getCellPosition("cell-0")).toEqual({ row: 0, column: 0 });
  expect(getCellPosition("cell-11")).toEqual({ row: 0, column: 11 });
  expect(getCellPosition("cell-12")).toEqual({ row: 1, column: 0 });
  expect(getCellPosition("cell-143")).toEqual({ row: 11, column: 11 });
});

test("refuses ids that name no position", () => {
  expect(getCellPosition("cell-144")).toBeNull();
  expect(getCellPosition("cell-x")).toBeNull();
  expect(getCellPosition("panel-3")).toBeNull();
  expect(getCellPosition("")).toBeNull();
});

test("a cell is inside a grid only when both coordinates are", () => {
  // cell-66 is row 5, column 6: inside 12x12 and 8x8, outside 6x6 by its column alone.
  expect(isCellWithinGrid("cell-66", 12)).toBe(true);
  expect(isCellWithinGrid("cell-66", 8)).toBe(true);
  expect(isCellWithinGrid("cell-66", 6)).toBe(false);
  // cell-72 is row 6, column 0: outside 6x6 by its row alone.
  expect(isCellWithinGrid("cell-72", 6)).toBe(false);
  expect(isCellWithinGrid("cell-71", 6)).toBe(false);
  expect(isCellWithinGrid("cell-65", 6)).toBe(true);
});

test("counts only cells that both hold media and fall outside the grid", () => {
  const cells = panelCells(
    cellAt(0, 0, "media-a"),
    cellAt(5, 5, "media-b"),
    // Outside 6x6, but empty: nothing is missing.
    cellAt(7, 7, null),
    cellAt(11, 11, "media-c")
  );

  expect(countHiddenMediaCells(cells, 12)).toBe(0);
  expect(countHiddenMediaCells(cells, 6)).toBe(1);
  expect(getHiddenMediaCellIds(cells, 6)).toEqual(["cell-143"]);
  expect(countHiddenMediaCells(undefined, 6)).toBe(0);
});

test("a full 12x12 panel hides everything outside a 6x6 window", () => {
  const entries: [string, GridCell][] = [];
  for (let row = 0; row < 12; row += 1) {
    for (let column = 0; column < 12; column += 1) {
      entries.push(cellAt(row, column, "media-a"));
    }
  }
  const cells = panelCells(...entries);

  expect(countHiddenMediaCells(cells, 12)).toBe(0);
  expect(countHiddenMediaCells(cells, 10)).toBe(144 - 100);
  expect(countHiddenMediaCells(cells, 6)).toBe(144 - 36);
});

test("names the smallest size that shows every cue", () => {
  expect(getMinGridSizeForMedia(panelCells(cellAt(0, 0, "media-a")))).toBe(6);
  expect(getMinGridSizeForMedia(panelCells(cellAt(5, 5, "media-a")))).toBe(6);
  expect(getMinGridSizeForMedia(panelCells(cellAt(6, 0, "media-a")))).toBe(8);
  expect(getMinGridSizeForMedia(panelCells(cellAt(0, 8, "media-a")))).toBe(10);
  expect(getMinGridSizeForMedia(panelCells(cellAt(11, 11, "media-a")))).toBe(12);
});

test("no assigned media means no size to recommend", () => {
  expect(getMinGridSizeForMedia(panelCells(cellAt(11, 11, null)))).toBeNull();
  expect(getMinGridSizeForMedia({})).toBeNull();
  expect(getMinGridSizeForMedia(undefined)).toBeNull();
});

test("an unreachable id is never reported as hidden", () => {
  // No grid size would bring it back, so a warning about it would be advice nobody can act on.
  const cells = panelCells(["cell-999", { ...makeCell("cell-999"), mediaId: "media-a" }]);

  expect(countHiddenMediaCells(cells, 6)).toBe(0);
  expect(getMinGridSizeForMedia(cells)).toBeNull();
});

test("re-attaches hidden cues that the grid no longer lists", () => {
  const panel: Panel = {
    id: "panel-1",
    name: "Wide",
    gridSize: 6,
    cellIds: getPanelCellIds(6)
  };
  const source = panelCells(cellAt(0, 0, "media-a"), cellAt(11, 11, "media-b"));
  const ensured = ensurePanelCells(panel, source);

  // What `ensurePanelCells` alone produces: the hidden cue is gone.
  expect(ensured["cell-143"]).toBeUndefined();

  const preserved = preserveHiddenCells(panel, ensured, source);
  expect(preserved["cell-143"]?.mediaId).toBe("media-b");
  expect(preserved["cell-0"]?.mediaId).toBe("media-a");
  expect(Object.keys(preserved)).toHaveLength(37);
});

test("does not re-attach empty cells or unreachable ids", () => {
  const panel: Panel = { id: "panel-1", name: "Wide", gridSize: 6, cellIds: getPanelCellIds(6) };
  const source = panelCells(
    cellAt(11, 11, null),
    ["cell-999", { ...makeCell("cell-999"), mediaId: "media-a" }]
  );

  const preserved = preserveHiddenCells(panel, ensurePanelCells(panel, source), source);
  expect(Object.keys(preserved)).toHaveLength(36);
});

test("leaves a legacy panel alone", () => {
  // Legacy ids are flat for the panel's own size, so an id outside the grid names no position:
  // reading it as one would move the cue somewhere it never was.
  const panel: Panel = {
    id: "panel-1",
    name: "Legacy",
    gridSize: 6,
    cellIds: getLegacyPanelCellIds(6)
  };
  const source = panelCells(cellAt(11, 11, "media-b"));

  const preserved = preserveHiddenCells(panel, ensurePanelCells(panel, source), source);
  expect(preserved["cell-143"]).toBeUndefined();
});

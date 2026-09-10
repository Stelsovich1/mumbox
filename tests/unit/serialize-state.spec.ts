import { expect, test } from "@playwright/test";

import { makeCell } from "../../src/entities/cell/model/makeCell";
import { ensurePanelCells } from "../../src/entities/panel/model/panelCells";
import { isDefaultCell, serializeState } from "../../src/app/model/serializeState";

/**
 * The payload written on every reducer action, and the one embedded in every `.mumbox` file.
 *
 * `ensurePanelCells` materialises every cell of a panel whether or not it holds anything, so an
 * empty 12x12 panel cost about 35 KB of JSON and a 20-panel project about 0.78 MiB — re-stringified
 * synchronously on every action, including each `pointermove` of the volume slider.
 */

function panel(id: string, gridSize: 6 | 8 | 10 | 12) {
  return { id, name: id, gridSize, cellIds: [] as string[] };
}

function baseState(cellsByPanel: Record<string, Record<string, ReturnType<typeof makeCell>>>) {
  return {
    panels: [panel("panel-1", 8)],
    activePanelId: "panel-1",
    cellsByPanel,
    media: [],
    masterVolume: 80,
    masterMuted: false,
    stopOthers: false,
    monoPlayback: false
  };
}

test("a fresh cell carries no information", () => {
  expect(isDefaultCell(makeCell("cell-0"))).toBe(true);
});

test("any single edit makes a cell worth keeping", () => {
  // Every field, because omitting one that a user had actually set would lose their work.
  const edits: Partial<ReturnType<typeof makeCell>>[] = [
    { mediaId: "media-1" },
    { aliasOverride: "x" },
    { colorOverride: "#ffffff" },
    { playbackMode: "loop" },
    { volumeOffset: 10 },
    { hotkey: "F1" },
    { trimStartMs: 0 },
    { trimEndMs: 100 },
    { fadeInEnabled: true },
    { fadeInMs: 50 },
    { fadeOutEnabled: true },
    { fadeOutMs: 50 }
  ];
  for (const edit of edits) {
    expect(isDefaultCell({ ...makeCell("cell-0"), ...edit })).toBe(false);
  }
});

test("omits default cells and keeps every edited one", () => {
  const grid = panel("panel-1", 12);
  const cells = ensurePanelCells({ ...grid, cellIds: ["cell-0", "cell-1", "cell-2"] }, undefined);
  const filled = { ...cells, "cell-1": { ...makeCell("cell-1"), mediaId: "media-1" } };

  const result = serializeState(baseState({ "panel-1": filled }));
  expect(Object.keys(result.cellsByPanel["panel-1"] ?? {})).toEqual(["cell-1"]);
});

test("the panel key survives even when every cell is default", () => {
  // The record must still exist, or the load path would treat the panel as unknown rather than as
  // empty.
  const cells = ensurePanelCells({ ...panel("panel-1", 6), cellIds: ["cell-0"] }, undefined);
  const result = serializeState(baseState({ "panel-1": cells }));
  expect(result.cellsByPanel["panel-1"]).toEqual({});
});

test("omitted cells are rebuilt identically on the way back in", () => {
  // This is the whole compatibility argument, and it holds for an OLDER build too: the load path
  // and a `.mumbox` import both run `ensurePanelCells`, which spreads `makeCell` first.
  const grid = { ...panel("panel-1", 6), cellIds: ["cell-0", "cell-1"] };
  const before = ensurePanelCells(grid, undefined);
  const serialized = serializeState(baseState({ "panel-1": before }));
  const after = ensurePanelCells(grid, serialized.cellsByPanel["panel-1"]);
  expect(after).toEqual(before);
});

test("global settings pass through untouched, and into the right fields", () => {
  // The booleans carry DIFFERENT values on purpose. Setting all three to true made a swap
  // between two of them invisible - found by a mutation round, where exchanging `stopOthers`
  // and `monoPlayback` survived every command. A user would see both settings flip on each
  // reload, and travel swapped inside every project file.
  const result = serializeState({
    ...baseState({}),
    masterVolume: 42,
    masterMuted: true,
    stopOthers: true,
    monoPlayback: false
  });
  expect(result.masterVolume).toBe(42);
  expect(result.masterMuted).toBe(true);
  expect(result.stopOthers).toBe(true);
  expect(result.monoPlayback).toBe(false);

  const flipped = serializeState({
    ...baseState({}),
    masterMuted: false,
    stopOthers: false,
    monoPlayback: true
  });
  expect(flipped.masterMuted).toBe(false);
  expect(flipped.stopOthers).toBe(false);
  expect(flipped.monoPlayback).toBe(true);
});

test("a full 12x12 panel of empty cells serializes to almost nothing", () => {
  const grid = {
    ...panel("panel-1", 12),
    cellIds: Array.from({ length: 144 }, (_, index) => `cell-${String(index)}`)
  };
  const cells = ensurePanelCells(grid, undefined);
  const before = JSON.stringify({ cellsByPanel: { "panel-1": cells } }).length;
  const after = JSON.stringify(serializeState(baseState({ "panel-1": cells })).cellsByPanel).length;
  expect(before).toBeGreaterThan(30_000);
  expect(after).toBeLessThan(100);
});

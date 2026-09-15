import { expect, test } from "@playwright/test";

import { reorderPanels } from "../../src/entities/panel/model/reorderPanels";
import { Panel } from "../../src/entities/panel/model/types";

function panel(id: string): Panel {
  return { id, name: id, gridSize: 6, cellIds: [] };
}

const panels = [panel("a"), panel("b"), panel("c"), panel("d")];
const ids = (list: readonly Panel[]) => list.map((item) => item.id);

test("moves a panel forward to the index it lands on", () => {
  expect(ids(reorderPanels(panels, "a", 2))).toEqual(["b", "c", "a", "d"]);
});

test("moves a panel backward to the index it lands on", () => {
  expect(ids(reorderPanels(panels, "d", 0))).toEqual(["d", "a", "b", "c"]);
});

test("keeps the other panels in their relative order", () => {
  expect(ids(reorderPanels(panels, "b", 3))).toEqual(["a", "c", "d", "b"]);
});

test("returns the same array when nothing would change", () => {
  expect(reorderPanels(panels, "b", 1)).toBe(panels);
  expect(reorderPanels(panels, "zzz", 0)).toBe(panels);
  expect(reorderPanels(panels, "a", -1)).toBe(panels);
  expect(reorderPanels(panels, "a", 4)).toBe(panels);
  expect(reorderPanels(panels, "a", 1.5)).toBe(panels);
});

test("does not mutate the input", () => {
  const before = ids(panels);
  reorderPanels(panels, "a", 3);
  expect(ids(panels)).toEqual(before);
});

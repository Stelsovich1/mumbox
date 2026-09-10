import { expect, test } from "@playwright/test";

import { makeCell } from "../../src/entities/cell/model/makeCell";
import { GridCell } from "../../src/entities/cell/model/types";
import { planPanelDeletion } from "../../src/entities/panel/model/deletePanels";
import { Panel } from "../../src/entities/panel/model/types";

function panel(id: string): Panel {
  return { id, name: id, gridSize: 6, cellIds: ["cell-0"] };
}

function cellsFor(ids: readonly string[]): Record<string, Record<string, GridCell>> {
  return Object.fromEntries(ids.map((id) => [id, { "cell-0": makeCell("cell-0") }]));
}

const panels = [panel("p1"), panel("p2"), panel("p3"), panel("p4")];
const cellsByPanel = cellsFor(["p1", "p2", "p3", "p4"]);

test.describe("planPanelDeletion", () => {
  test("removes the listed panels and their cells", () => {
    const plan = planPanelDeletion({
      panels,
      cellsByPanel,
      activePanelId: "p1",
      panelIds: ["p2", "p4"]
    });

    expect(plan?.panels.map((item) => item.id)).toEqual(["p1", "p3"]);
    expect(Object.keys(plan?.cellsByPanel ?? {})).toEqual(["p1", "p3"]);
    expect(plan?.activePanelId).toBe("p1");
    expect(plan?.refusedPanelIds).toEqual([]);
  });

  test("refuses the first panel and reports it", () => {
    const plan = planPanelDeletion({
      panels,
      cellsByPanel,
      activePanelId: "p1",
      panelIds: ["p1", "p2"]
    });

    expect(plan?.panels.map((item) => item.id)).toEqual(["p1", "p3", "p4"]);
    expect(plan?.refusedPanelIds).toEqual(["p1"]);
  });

  test("selecting every panel still leaves the first one", () => {
    const plan = planPanelDeletion({
      panels,
      cellsByPanel,
      activePanelId: "p3",
      panelIds: ["p1", "p2", "p3", "p4"]
    });

    expect(plan?.panels.map((item) => item.id)).toEqual(["p1"]);
    expect(plan?.activePanelId).toBe("p1");
    expect(plan?.refusedPanelIds).toEqual(["p1"]);
  });

  test("the active panel falls back to the one before the first deletion", () => {
    const plan = planPanelDeletion({
      panels,
      cellsByPanel,
      activePanelId: "p3",
      panelIds: ["p2", "p3"]
    });

    expect(plan?.panels.map((item) => item.id)).toEqual(["p1", "p4"]);
    expect(plan?.activePanelId).toBe("p1");
  });

  test("an untouched active panel keeps its identity", () => {
    const plan = planPanelDeletion({
      panels,
      cellsByPanel,
      activePanelId: "p4",
      panelIds: ["p2"]
    });

    expect(plan?.activePanelId).toBe("p4");
  });

  test("returns null when only the first panel was asked for", () => {
    expect(
      planPanelDeletion({ panels, cellsByPanel, activePanelId: "p1", panelIds: ["p1"] })
    ).toBeNull();
  });

  test("returns null for an empty selection", () => {
    expect(
      planPanelDeletion({ panels, cellsByPanel, activePanelId: "p1", panelIds: [] })
    ).toBeNull();
  });

  test("ignores ids naming no panel, and does not report them as refused", () => {
    const plan = planPanelDeletion({
      panels,
      cellsByPanel,
      activePanelId: "p1",
      panelIds: ["ghost", "p2"]
    });

    expect(plan?.panels.map((item) => item.id)).toEqual(["p1", "p3", "p4"]);
    expect(plan?.refusedPanelIds).toEqual([]);
  });

  test("returns null when every id is a ghost", () => {
    expect(
      planPanelDeletion({ panels, cellsByPanel, activePanelId: "p1", panelIds: ["ghost"] })
    ).toBeNull();
  });

  test("returns null for a project of one panel", () => {
    expect(
      planPanelDeletion({
        panels: [panel("p1")],
        cellsByPanel: cellsFor(["p1"]),
        activePanelId: "p1",
        panelIds: ["p1"]
      })
    ).toBeNull();
  });

  test("returns null for no panels at all", () => {
    expect(
      planPanelDeletion({ panels: [], cellsByPanel: {}, activePanelId: "", panelIds: ["p1"] })
    ).toBeNull();
  });

  test("does not mutate the inputs", () => {
    const plan = planPanelDeletion({
      panels,
      cellsByPanel,
      activePanelId: "p1",
      panelIds: ["p2"]
    });

    expect(plan?.panels).not.toBe(panels);
    expect(panels.map((item) => item.id)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(Object.keys(cellsByPanel)).toEqual(["p1", "p2", "p3", "p4"]);
  });

  test("a duplicated id deletes once", () => {
    const plan = planPanelDeletion({
      panels,
      cellsByPanel,
      activePanelId: "p1",
      panelIds: ["p2", "p2"]
    });

    expect(plan?.panels.map((item) => item.id)).toEqual(["p1", "p3", "p4"]);
  });
});

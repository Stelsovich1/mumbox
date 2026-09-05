import { expect, test } from "@playwright/test";

import { makeUniquePanelName } from "../../src/entities/panel/model/panelName";
import { Panel } from "../../src/entities/panel/model/types";

function panels(...names: string[]): Panel[] {
  return names.map((name, index) => ({
    id: `panel-${String(index)}`,
    name,
    gridSize: 8,
    cellIds: []
  }));
}

test("falls back to Panel_copy for a blank requested name", () => {
  expect(makeUniquePanelName(panels(), "")).toBe("Panel_copy");
  expect(makeUniquePanelName(panels(), "   ")).toBe("Panel_copy");
});

test("keeps the requested name when nothing collides", () => {
  expect(makeUniquePanelName(panels("Panel 1"), "Panel 2")).toBe("Panel 2");
});

test("appends _2 on the first collision", () => {
  expect(makeUniquePanelName(panels("Panel 1"), "Panel 1")).toBe("Panel 1_2");
});

test("skips to _3 when _2 is taken", () => {
  expect(makeUniquePanelName(panels("Panel 1", "Panel 1_2"), "Panel 1")).toBe("Panel 1_3");
});

test("trims the requested name before comparing", () => {
  expect(makeUniquePanelName(panels("Panel 1"), "  Panel 1  ")).toBe("Panel 1_2");
});

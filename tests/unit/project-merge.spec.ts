import { expect, test } from "@playwright/test";

import type { SerializableAppState } from "../../src/app/model/appState";
import { makeCell } from "../../src/entities/cell/model/makeCell";
import { MediaAsset } from "../../src/entities/media/model/types";
import { getPanelCellIds } from "../../src/entities/panel/model/panelCells";
import { GridSize } from "../../src/entities/panel/model/types";
import { mergeProjectState } from "../../src/features/project-merge/model/mergeProjects";

function makeMedia(id: string): MediaAsset {
  return {
    id,
    fileName: `${id}.wav`,
    alias: "",
    color: "#ec5aa7",
    mimeType: "audio/wav",
    durationMs: 1000,
    createdAt: "2024-01-05T09:07:00.000Z"
  };
}

type PanelSpec = {
  id: string;
  name: string;
  gridSize?: GridSize;
  /** Media id per cell, in cell order. */
  cellMedia?: (string | null)[];
  /** Use the pre-stable flat `cell-${index}` scheme. */
  legacyCellIds?: boolean;
};

function makeState(panels: PanelSpec[], media: MediaAsset[] = []): SerializableAppState {
  const state: SerializableAppState = {
    panels: [],
    activePanelId: panels[0]?.id ?? "",
    cellsByPanel: {},
    media,
    masterVolume: 80,
    masterMuted: false,
    stopOthers: false,
    monoPlayback: false
  };

  for (const spec of panels) {
    const gridSize = spec.gridSize ?? 6;
    const cellIds = spec.legacyCellIds
      ? Array.from({ length: gridSize * gridSize }, (_, index) => `cell-${String(index)}`)
      : getPanelCellIds(gridSize);

    state.panels.push({ id: spec.id, name: spec.name, gridSize, cellIds });
    state.cellsByPanel[spec.id] = Object.fromEntries(
      cellIds.map((cellId, index) => [
        cellId,
        { ...makeCell(cellId), mediaId: spec.cellMedia?.[index] ?? null }
      ])
    );
  }

  return state;
}

function makeIdFactory() {
  let counter = 0;

  return () => {
    counter += 1;

    return `panel-new-${String(counter)}`;
  };
}

test("appends incoming panels after the current ones, in order", () => {
  const result = mergeProjectState({
    current: makeState([{ id: "cur", name: "Panel 1" }]),
    incoming: makeState([
      { id: "inc-1", name: "Drums" },
      { id: "inc-2", name: "Bass" }
    ]),
    mediaIdMap: new Map(),
    addedMedia: [],
    createPanelId: makeIdFactory()
  });

  expect(result.state.panels.map((panel) => panel.name)).toEqual(["Panel 1", "Drums", "Bass"]);
  expect(result.addedPanelIds).toEqual(["panel-new-1", "panel-new-2"]);
});

test("regenerates every incoming panel id", () => {
  const result = mergeProjectState({
    current: makeState([{ id: "shared-id", name: "Panel 1" }]),
    incoming: makeState([{ id: "shared-id", name: "Drums" }]),
    mediaIdMap: new Map(),
    addedMedia: [],
    createPanelId: makeIdFactory()
  });

  // A colliding id would silently overwrite the current panel's cells.
  expect(result.state.panels.map((panel) => panel.id)).toEqual(["shared-id", "panel-new-1"]);
  expect(Object.keys(result.state.cellsByPanel).sort()).toEqual(["panel-new-1", "shared-id"]);
});

test("resolves colliding names to _2 and _3", () => {
  const result = mergeProjectState({
    current: makeState([{ id: "cur", name: "Panel 1" }]),
    incoming: makeState([
      { id: "inc-1", name: "Panel 1" },
      { id: "inc-2", name: "Panel 1" }
    ]),
    mediaIdMap: new Map(),
    addedMedia: [],
    createPanelId: makeIdFactory()
  });

  expect(result.state.panels.map((panel) => panel.name)).toEqual([
    "Panel 1",
    "Panel 1_2",
    "Panel 1_3"
  ]);
  expect(result.renamedPanels).toEqual([
    { from: "Panel 1", to: "Panel 1_2" },
    { from: "Panel 1", to: "Panel 1_3" }
  ]);
});

test("remaps cell media through the map and empties what it cannot resolve", () => {
  const result = mergeProjectState({
    current: makeState([{ id: "cur", name: "Panel 1" }]),
    incoming: makeState([
      { id: "inc", name: "Drums", cellMedia: ["inc-media", null, "unmapped"] }
    ]),
    mediaIdMap: new Map([["inc-media", "cur-media"]]),
    addedMedia: [],
    createPanelId: makeIdFactory()
  });

  const cells = result.state.cellsByPanel["panel-new-1"];
  expect(cells?.["cell-0"]?.mediaId).toBe("cur-media");
  expect(cells?.["cell-1"]?.mediaId).toBeNull();
  expect(cells?.["cell-2"]?.mediaId).toBeNull();
});

test("appends the surviving media to the library", () => {
  const result = mergeProjectState({
    current: makeState([{ id: "cur", name: "Panel 1" }], [makeMedia("cur-media")]),
    incoming: makeState([{ id: "inc", name: "Drums" }], [makeMedia("inc-media")]),
    mediaIdMap: new Map(),
    addedMedia: [makeMedia("kept-media")],
    createPanelId: makeIdFactory()
  });

  expect(result.state.media.map((media) => media.id)).toEqual(["cur-media", "kept-media"]);
});

test("keeps the current project's global settings", () => {
  const current = makeState([{ id: "cur", name: "Panel 1" }]);
  const incoming = makeState([{ id: "inc", name: "Drums" }]);
  const result = mergeProjectState({
    current: { ...current, masterVolume: 42, stopOthers: true, monoPlayback: true },
    incoming: {
      ...incoming,
      masterVolume: 99,
      masterMuted: true,
      stopOthers: false,
      monoPlayback: false,
      activePanelId: "inc"
    },
    mediaIdMap: new Map(),
    addedMedia: [],
    createPanelId: makeIdFactory()
  });

  expect(result.state.masterVolume).toBe(42);
  expect(result.state.stopOthers).toBe(true);
  expect(result.state.monoPlayback).toBe(true);
  expect(result.state.activePanelId).toBe("cur");
});

test("migrates an incoming panel that uses the legacy flat cell ids", () => {
  const result = mergeProjectState({
    current: makeState([{ id: "cur", name: "Panel 1" }]),
    incoming: makeState([
      { id: "inc", name: "Drums", legacyCellIds: true, cellMedia: [null, null, null, null, null, null, "inc-media"] }
    ]),
    mediaIdMap: new Map([["inc-media", "inc-media"]]),
    addedMedia: [],
    createPanelId: makeIdFactory()
  });

  const panel = result.state.panels[1];
  expect(panel?.cellIds).toEqual(getPanelCellIds(6));
  // Flat index 6 is the start of the second row, which is `cell-12` under the stable scheme.
  expect(result.state.cellsByPanel["panel-new-1"]?.["cell-12"]?.mediaId).toBe("inc-media");
});

test("merging into an empty project reproduces the incoming layout", () => {
  const result = mergeProjectState({
    current: makeState([]),
    incoming: makeState([{ id: "inc", name: "Drums", cellMedia: ["inc-media"] }]),
    mediaIdMap: new Map([["inc-media", "inc-media"]]),
    addedMedia: [makeMedia("inc-media")],
    createPanelId: makeIdFactory()
  });

  expect(result.state.panels.map((panel) => panel.name)).toEqual(["Drums"]);
  expect(result.state.cellsByPanel["panel-new-1"]?.["cell-0"]?.mediaId).toBe("inc-media");
});

test("does not mutate the current state", () => {
  const current = makeState([{ id: "cur", name: "Panel 1" }]);
  mergeProjectState({
    current,
    incoming: makeState([{ id: "inc", name: "Drums" }]),
    mediaIdMap: new Map(),
    addedMedia: [],
    createPanelId: makeIdFactory()
  });

  expect(current.panels).toHaveLength(1);
  expect(Object.keys(current.cellsByPanel)).toEqual(["cur"]);
});

import { expect, test } from "@playwright/test";

import {
  clearProgress,
  readProgress,
  registerCell,
  resetCellVisuals,
  writeProgress
} from "../../src/shared/lib/cellVisuals";

/**
 * The registry that lets playback progress reach the DOM without going through React.
 *
 * Progress used to be `useState` inside `useAudioEngine`, which `AppShell` calls — so twenty pushes
 * a second re-rendered the toolbar, the tabs and the 144-element grid map for as long as anything
 * played.
 */

type Fake = {
  attributes: Record<string, string>;
  properties: Record<string, string>;
  setAttribute: (name: string, value: string) => void;
  style: { setProperty: (name: string, value: string) => void };
};

function fakeTarget(): Fake {
  const attributes: Record<string, string> = {};
  const properties: Record<string, string> = {};
  return {
    attributes,
    properties,
    setAttribute: (name, value) => {
      attributes[name] = value;
    },
    style: {
      setProperty: (name, value) => {
        properties[name] = value;
      }
    }
  };
}

test.beforeEach(() => {
  resetCellVisuals();
});

test("writes both the attribute and the custom property", () => {
  // Two consumers: e2e assertions read the attribute, the markers read the property.
  const target = fakeTarget();
  registerCell("panel:cell-0", target);
  writeProgress("panel:cell-0", 0.5);
  expect(target.attributes["data-progress"]).toBe("0.5000");
  expect(target.properties["--cell-progress"]).toBe("0.5000");
});

test("replays the last value when a cell registers", () => {
  // A cell remounting mid-playback — a grid resize, a panel switched back — must not show a marker
  // frozen at zero. It is also what makes a test reading the attribute right after `data-playing`
  // see a real number.
  writeProgress("panel:cell-1", 0.25);
  const target = fakeTarget();
  registerCell("panel:cell-1", target);
  expect(target.attributes["data-progress"]).toBe("0.2500");
});

test("registering a cell that has never played shows rest", () => {
  const target = fakeTarget();
  registerCell("panel:cell-2", target);
  expect(target.attributes["data-progress"]).toBe("0.0000");
});

test("skips a write whose formatted value has not changed", () => {
  // The dedupe is on the string that would reach the DOM, so it is exact rather than a tolerance.
  let writes = 0;
  const target = fakeTarget();
  const counting = {
    ...target,
    setAttribute: (name: string, value: string) => {
      writes += 1;
      target.setAttribute(name, value);
    }
  };
  registerCell("panel:cell-3", counting);
  const initial = writes;
  writeProgress("panel:cell-3", 0.1);
  writeProgress("panel:cell-3", 0.10001);
  expect(writes).toBe(initial + 1);
});

test("clamps out-of-range values", () => {
  const target = fakeTarget();
  registerCell("panel:cell-4", target);
  writeProgress("panel:cell-4", -1);
  expect(target.attributes["data-progress"]).toBe("0.0000");
  writeProgress("panel:cell-4", 5);
  expect(target.attributes["data-progress"]).toBe("1.0000");
});

test("a write for an unregistered cell is remembered, not lost", () => {
  // The engine starts a cue before React has committed the cell that will show it.
  writeProgress("panel:cell-5", 0.75);
  expect(readProgress("panel:cell-5")).toBe("0.7500");
  const target = fakeTarget();
  registerCell("panel:cell-5", target);
  expect(target.attributes["data-progress"]).toBe("0.7500");
});

test("replays across an unregister and re-register cycle", () => {
  // The documented case - a grid resize, or a panel switched away and back - as opposed to a
  // cell that was never registered. Forgetting the value on unregister survived a mutation
  // round because only the never-registered case was covered.
  const first = fakeTarget();
  registerCell("panel:cycle", first);
  writeProgress("panel:cycle", 0.42);
  registerCell("panel:cycle", null);

  const second = fakeTarget();
  registerCell("panel:cycle", second);
  expect(second.attributes["data-progress"]).toBe("0.4200");
});

test("unregistering stops writes reaching the old node", () => {
  const target = fakeTarget();
  registerCell("panel:cell-6", target);
  registerCell("panel:cell-6", null);
  writeProgress("panel:cell-6", 0.9);
  expect(target.attributes["data-progress"]).toBe("0.0000");
});

test("clearing returns a cell to rest", () => {
  const target = fakeTarget();
  registerCell("panel:cell-7", target);
  writeProgress("panel:cell-7", 0.6);
  clearProgress("panel:cell-7");
  expect(target.attributes["data-progress"]).toBe("0.0000");
});

test("cells are independent", () => {
  const first = fakeTarget();
  const second = fakeTarget();
  registerCell("panel:a", first);
  registerCell("panel:b", second);
  writeProgress("panel:a", 0.3);
  expect(first.attributes["data-progress"]).toBe("0.3000");
  expect(second.attributes["data-progress"]).toBe("0.0000");
});

test("clearing a cell releases its retained value", () => {
  // Keys carry the panel id, and `panel/add`, `panel/copy`, an import and a merge all mint fresh
  // ones - so an entry per cell key that is never removed grows for as long as an editing session
  // runs. Rest is the default `registerCell` already replays for an absent key, so keeping the
  // entry bought nothing.
  const target = fakeTarget();
  registerCell("panel:release", target);
  writeProgress("panel:release", 0.5);
  expect(readProgress("panel:release")).toBe("0.5000");

  clearProgress("panel:release");
  expect(target.attributes["data-progress"]).toBe("0.0000");
  expect(readProgress("panel:release")).toBeNull();

  // And a cell registered afterwards still starts at rest rather than at the old value.
  const later = fakeTarget();
  registerCell("panel:release", later);
  expect(later.attributes["data-progress"]).toBe("0.0000");
});

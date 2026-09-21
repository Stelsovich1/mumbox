import { expect, test } from "@playwright/test";

import { findUnusedMediaIds } from "../../src/entities/media/model/unusedMedia";
import { planOrphanMediaKeys } from "../../src/shared/lib/mediaOrphans";

const media = [{ id: "a" }, { id: "b" }, { id: "c" }];

test("media assigned anywhere is not unused", () => {
  const unused = findUnusedMediaIds(media, {
    "panel-1": { "cell-0": { mediaId: "a" }, "cell-1": { mediaId: null } },
    "panel-2": { "cell-0": { mediaId: "b" } }
  });

  expect(unused).toEqual(["c"]);
});

test("a cue hidden by a grid shrink still counts as used", () => {
  // `cell-100` is outside a 6x6 grid, so it is not rendered and not in `panel.cellIds` — but it is
  // still in the cell record, and its media is still going to play once the grid grows back.
  // A scan driven by the visible lattice would offer to delete it.
  const unused = findUnusedMediaIds(media, {
    "panel-1": { "cell-0": { mediaId: "a" }, "cell-100": { mediaId: "b" } }
  });

  expect(unused).toEqual(["c"]);
});

test("an empty or missing panel record does not make everything unused by accident", () => {
  expect(findUnusedMediaIds(media, {})).toEqual(["a", "b", "c"]);
  expect(findUnusedMediaIds(media, { "panel-1": undefined })).toEqual(["a", "b", "c"]);
  expect(findUnusedMediaIds([], { "panel-1": { "cell-0": { mediaId: "a" } } })).toEqual([]);
});

test("orphan keys are the stored ones the project does not name, prefix-scoped", () => {
  const keys = [
    "mumbox:media:a",
    "mumbox:media:gone",
    // Another key living in the same store. A scan that ignored the prefix would report it.
    "mumbox:something-else",
    "unrelated"
  ];

  expect(planOrphanMediaKeys(keys, ["a"], "mumbox:media:")).toEqual(["mumbox:media:gone"]);
});

test("nothing is an orphan when every stored key is named", () => {
  expect(planOrphanMediaKeys(["mumbox:media:a"], ["a", "b"], "mumbox:media:")).toEqual([]);
});

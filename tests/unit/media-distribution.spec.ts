import { expect, test } from "@playwright/test";

import {
  buildDistributionMessage,
  planMediaDistribution,
  resolveDraggedMediaIds
} from "../../src/shared/lib/mediaDistribution";

/** The real 6x6 shape: row-major with a stride of 12, so ids are not consecutive. */
const SIX_BY_SIX = Array.from({ length: 36 }, (_, index) => {
  const row = Math.floor(index / 6);
  const column = index % 6;

  return `cell-${String(row * 12 + column)}`;
});

test.describe("resolveDraggedMediaIds", () => {
  test("carries only the dragged row when it is not selected", () => {
    expect(
      resolveDraggedMediaIds({
        draggedMediaId: "media-c",
        selectedMediaIds: new Set(["media-a", "media-b"]),
        displayOrder: ["media-a", "media-b", "media-c"]
      })
    ).toEqual(["media-c"]);
  });

  test("carries the whole selection with the dragged id first", () => {
    expect(
      resolveDraggedMediaIds({
        draggedMediaId: "media-c",
        selectedMediaIds: new Set(["media-a", "media-b", "media-c"]),
        displayOrder: ["media-a", "media-b", "media-c"]
      })
    ).toEqual(["media-c", "media-a", "media-b"]);
  });

  test("never repeats the dragged id", () => {
    const resolved = resolveDraggedMediaIds({
      draggedMediaId: "media-a",
      selectedMediaIds: new Set(["media-a", "media-b"]),
      displayOrder: ["media-a", "media-b"]
    });

    expect(resolved).toEqual(["media-a", "media-b"]);
  });

  test("excludes selected ids the filter is hiding", () => {
    expect(
      resolveDraggedMediaIds({
        draggedMediaId: "media-a",
        selectedMediaIds: new Set(["media-a", "media-hidden"]),
        displayOrder: ["media-a", "media-b"]
      })
    ).toEqual(["media-a"]);
  });

  test("carries the dragged row alone when nothing is selected", () => {
    expect(
      resolveDraggedMediaIds({
        draggedMediaId: "media-a",
        selectedMediaIds: new Set(),
        displayOrder: ["media-a", "media-b"]
      })
    ).toEqual(["media-a"]);
  });
});

test.describe("planMediaDistribution", () => {
  test("assigns one media to a free target", () => {
    expect(
      planMediaDistribution({
        cellIds: SIX_BY_SIX,
        occupiedCellIds: new Set(),
        targetCellId: "cell-2",
        mediaIds: ["media-a"]
      })
    ).toEqual({ assignments: [{ cellId: "cell-2", mediaId: "media-a" }], overflowCount: 0 });
  });

  test("refuses a target that is not part of the panel", () => {
    expect(
      planMediaDistribution({
        cellIds: SIX_BY_SIX,
        occupiedCellIds: new Set(),
        targetCellId: "cell-999",
        mediaIds: ["media-a", "media-b"]
      })
    ).toEqual({ assignments: [], overflowCount: 2 });
  });

  test("slides forward when the target is occupied", () => {
    expect(
      planMediaDistribution({
        cellIds: SIX_BY_SIX,
        occupiedCellIds: new Set(["cell-2"]),
        targetCellId: "cell-2",
        mediaIds: ["media-a"]
      })
    ).toEqual({ assignments: [{ cellId: "cell-3", mediaId: "media-a" }], overflowCount: 0 });
  });

  test("skips occupied cells along the way without overwriting them", () => {
    expect(
      planMediaDistribution({
        cellIds: SIX_BY_SIX,
        occupiedCellIds: new Set(["cell-3"]),
        targetCellId: "cell-2",
        mediaIds: ["media-a", "media-b", "media-c"]
      })
    ).toEqual({
      assignments: [
        { cellId: "cell-2", mediaId: "media-a" },
        { cellId: "cell-4", mediaId: "media-b" },
        { cellId: "cell-5", mediaId: "media-c" }
      ],
      overflowCount: 0
    });
  });

  test("walks the array order, not the numeric id order", () => {
    // `cell-5` is the last cell of the first row; the next one is `cell-12`, not `cell-6`.
    expect(
      planMediaDistribution({
        cellIds: SIX_BY_SIX,
        occupiedCellIds: new Set(),
        targetCellId: "cell-5",
        mediaIds: ["media-a", "media-b"]
      })
    ).toEqual({
      assignments: [
        { cellId: "cell-5", mediaId: "media-a" },
        { cellId: "cell-12", mediaId: "media-b" }
      ],
      overflowCount: 0
    });
  });

  test("reports the media that did not fit", () => {
    const occupied = new Set(SIX_BY_SIX.slice(2));
    occupied.delete("cell-2");

    expect(
      planMediaDistribution({
        cellIds: SIX_BY_SIX,
        occupiedCellIds: occupied,
        targetCellId: "cell-2",
        mediaIds: ["media-a", "media-b", "media-c"]
      })
    ).toEqual({ assignments: [{ cellId: "cell-2", mediaId: "media-a" }], overflowCount: 2 });
  });

  test("never wraps around to free cells before the target", () => {
    const occupied = new Set(SIX_BY_SIX.slice(2));

    expect(
      planMediaDistribution({
        cellIds: SIX_BY_SIX,
        occupiedCellIds: occupied,
        targetCellId: "cell-2",
        mediaIds: ["media-a"]
      })
    ).toEqual({ assignments: [], overflowCount: 1 });
  });

  test("handles an empty drag", () => {
    expect(
      planMediaDistribution({
        cellIds: SIX_BY_SIX,
        occupiedCellIds: new Set(),
        targetCellId: "cell-0",
        mediaIds: []
      })
    ).toEqual({ assignments: [], overflowCount: 0 });
  });

  test("passes duplicate media through, since one media may fill two cells", () => {
    expect(
      planMediaDistribution({
        cellIds: SIX_BY_SIX,
        occupiedCellIds: new Set(),
        targetCellId: "cell-0",
        mediaIds: ["media-a", "media-a"]
      })
    ).toEqual({
      assignments: [
        { cellId: "cell-0", mediaId: "media-a" },
        { cellId: "cell-1", mediaId: "media-a" }
      ],
      overflowCount: 0
    });
  });
});

test.describe("buildDistributionMessage", () => {
  test("stays silent when everything fit", () => {
    expect(
      buildDistributionMessage({ assignments: [{ cellId: "cell-0", mediaId: "a" }], overflowCount: 0 })
    ).toBe("");
  });

  test("reports a partial fit", () => {
    expect(
      buildDistributionMessage({ assignments: [{ cellId: "cell-0", mediaId: "a" }], overflowCount: 2 })
    ).toBe("Назначено ячеек: 1, не поместилось: 2");
  });

  test("reports a grid with no room at all", () => {
    expect(buildDistributionMessage({ assignments: [], overflowCount: 3 })).toBe(
      "Нет свободных ячеек"
    );
  });
});

import { expect, test } from "@playwright/test";

import { countCellsUsingMedia } from "../../src/entities/cell/model/cellUsage";
import {
  buildAffectedCellsNote,
  buildMediaDeletionHeadline
} from "../../src/entities/media/model/mediaDeletion";

test.describe("buildMediaDeletionHeadline", () => {
  test("returns an empty string with no targets", () => {
    expect(buildMediaDeletionHeadline([])).toBe("");
  });

  test("names a single target by its alias", () => {
    expect(
      buildMediaDeletionHeadline([{ id: "a", alias: "Мой звук", fileName: "sound.wav" }])
    ).toBe('Вы действительно хотите удалить "Мой звук" из медиатеки?');
  });

  test("falls back to the file name when the alias is blank", () => {
    expect(buildMediaDeletionHeadline([{ id: "a", alias: "  ", fileName: "alarm.mp3" }])).toBe(
      'Вы действительно хотите удалить "alarm.mp3" из медиатеки?'
    );
  });

  test("counts several targets with correct Russian agreement", () => {
    const targets = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `media-${String(index)}`,
        alias: "",
        fileName: `sound-${String(index)}.wav`
      }));

    expect(buildMediaDeletionHeadline(targets(2))).toBe("Удалить 2 записи из медиатеки");
    expect(buildMediaDeletionHeadline(targets(5))).toBe("Удалить 5 записей из медиатеки");
  });
});

test.describe("buildAffectedCellsNote", () => {
  test("says nothing when no cell is affected", () => {
    expect(buildAffectedCellsNote(0)).toBe("");
    expect(buildAffectedCellsNote(-1)).toBe("");
  });

  test("reports the count", () => {
    expect(buildAffectedCellsNote(12)).toBe("Будет очищено ячеек: 12");
  });
});

test.describe("countCellsUsingMedia", () => {
  const cellsByPanel = {
    "panel-1": {
      "cell-0": { mediaId: "media-a" },
      "cell-1": { mediaId: "media-a" },
      "cell-2": { mediaId: null }
    },
    "panel-2": {
      "cell-0": { mediaId: "media-b" },
      "cell-1": { mediaId: "media-c" }
    }
  };

  test("counts across every panel", () => {
    expect(countCellsUsingMedia(cellsByPanel, ["media-a", "media-b"])).toBe(3);
  });

  test("counts several cells sharing one media", () => {
    expect(countCellsUsingMedia(cellsByPanel, ["media-a"])).toBe(2);
  });

  test("ignores empty cells and media that is not selected", () => {
    expect(countCellsUsingMedia(cellsByPanel, ["media-missing"])).toBe(0);
  });

  test("returns zero for an empty selection", () => {
    expect(countCellsUsingMedia(cellsByPanel, [])).toBe(0);
  });
});

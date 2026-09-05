import { expect, test } from "@playwright/test";

import {
  compareMediaByAlias,
  compareMediaByColor,
  compareMediaByCreatedAt,
  compareMediaByDuration,
  compareMediaByFileName,
  getMediaLabel,
  MEDIA_COMPARATORS,
  MEDIA_SORT_KEYS
} from "../../src/entities/media/model/mediaSort";
import { MediaAsset } from "../../src/entities/media/model/types";
import { CELL_COLORS } from "../../src/shared/config/colorPalette";

function makeMedia(patch: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: "media-1",
    fileName: "sound.wav",
    alias: "",
    color: CELL_COLORS[0],
    mimeType: "audio/wav",
    durationMs: 1000,
    createdAt: "2024-01-05T09:07:00.000Z",
    ...patch
  };
}

test.describe("getMediaLabel", () => {
  test("prefers the alias", () => {
    expect(getMediaLabel({ alias: "Мой звук", fileName: "sound.wav" })).toBe("Мой звук");
  });

  test("falls back to the file name for an empty alias", () => {
    expect(getMediaLabel({ alias: "", fileName: "sound.wav" })).toBe("sound.wav");
  });

  test("falls back to the file name for a whitespace-only alias", () => {
    expect(getMediaLabel({ alias: "   ", fileName: "sound.wav" })).toBe("sound.wav");
  });
});

test.describe("compareMediaByFileName", () => {
  test("orders numeric suffixes naturally", () => {
    const second = makeMedia({ fileName: "track-2.wav" });
    const tenth = makeMedia({ fileName: "track-10.wav" });

    expect(compareMediaByFileName(second, tenth)).toBeLessThan(0);
  });

  test("orders Cyrillic names alphabetically", () => {
    expect(
      compareMediaByFileName(makeMedia({ fileName: "альфа" }), makeMedia({ fileName: "бета" }))
    ).toBeLessThan(0);
  });
});

test("compareMediaByAlias falls back to the file name so blank aliases interleave", () => {
  const blank = makeMedia({ alias: "", fileName: "аврора.wav" });
  const named = makeMedia({ alias: "бета", fileName: "zzz.wav" });

  expect(compareMediaByAlias(blank, named)).toBeLessThan(0);
});

test.describe("compareMediaByDuration", () => {
  test("orders by length", () => {
    expect(
      compareMediaByDuration(makeMedia({ durationMs: 100 }), makeMedia({ durationMs: 200 }))
    ).toBeLessThan(0);
  });

  test("sorts an unknown duration last ascending", () => {
    expect(
      compareMediaByDuration(makeMedia({ durationMs: null }), makeMedia({ durationMs: 200 }))
    ).toBeGreaterThan(0);
  });

  test("treats two unknown durations as equal", () => {
    expect(
      compareMediaByDuration(makeMedia({ durationMs: null }), makeMedia({ durationMs: null }))
    ).toBe(0);
  });
});

test.describe("compareMediaByCreatedAt", () => {
  test("orders chronologically", () => {
    expect(
      compareMediaByCreatedAt(
        makeMedia({ createdAt: "2024-01-01T00:00:00.000Z" }),
        makeMedia({ createdAt: "2024-02-01T00:00:00.000Z" })
      )
    ).toBeLessThan(0);
  });

  test("sorts a missing or unparseable date last ascending", () => {
    const valid = makeMedia({ createdAt: "2024-01-01T00:00:00.000Z" });

    expect(compareMediaByCreatedAt(makeMedia({ createdAt: "" }), valid)).toBeGreaterThan(0);
    expect(compareMediaByCreatedAt(makeMedia({ createdAt: "not-a-date" }), valid)).toBeGreaterThan(0);
  });
});

test.describe("compareMediaByColor", () => {
  test("orders by palette index, not hex value", () => {
    const first = makeMedia({ color: CELL_COLORS[0] });
    const third = makeMedia({ color: CELL_COLORS[2] });

    expect(compareMediaByColor(first, third)).toBeLessThan(0);
  });

  test("sorts a colour outside the palette last", () => {
    const known = makeMedia({ color: CELL_COLORS[0] });
    const unknown = makeMedia({ color: "#123456" });

    expect(compareMediaByColor(unknown, known)).toBeGreaterThan(0);
  });
});

test("every sort key has a comparator and every comparator has a key", () => {
  expect([...MEDIA_SORT_KEYS].sort()).toEqual(Object.keys(MEDIA_COMPARATORS).sort());
});

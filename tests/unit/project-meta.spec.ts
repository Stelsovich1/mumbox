import { expect, test } from "@playwright/test";

import {
  normalizeProjectMeta,
  toProjectFileName
} from "../../src/features/file-config/model/projectMeta";

test.describe("normalizeProjectMeta", () => {
  test("returns an empty meta for a manifest written before the field existed", () => {
    expect(normalizeProjectMeta(undefined)).toEqual({});
    expect(normalizeProjectMeta(null)).toEqual({});
  });

  test("keeps the fields it recognises", () => {
    expect(
      normalizeProjectMeta({
        name: "Мой проект",
        description: "Для выезда",
        savedAt: "2024-01-05T09:07:00.000Z"
      })
    ).toEqual({
      name: "Мой проект",
      description: "Для выезда",
      savedAt: "2024-01-05T09:07:00.000Z"
    });
  });

  test("trims and drops blank values", () => {
    expect(normalizeProjectMeta({ name: "  Проект  ", description: "   " })).toEqual({
      name: "Проект"
    });
  });

  test("drops wrong types instead of throwing", () => {
    expect(normalizeProjectMeta({ name: 42, description: [], savedAt: {} })).toEqual({});
    expect(normalizeProjectMeta("nope")).toEqual({});
    expect(normalizeProjectMeta(7)).toEqual({});
  });

  test("caps absurdly long values", () => {
    const meta = normalizeProjectMeta({
      name: "x".repeat(500),
      description: "y".repeat(5000)
    });

    expect(meta.name).toHaveLength(200);
    expect(meta.description).toHaveLength(2000);
  });
});

test.describe("toProjectFileName", () => {
  test("falls back to the default name", () => {
    expect(toProjectFileName("")).toBe("mumbox-project.mumbox");
    expect(toProjectFileName("   ")).toBe("mumbox-project.mumbox");
  });

  test("appends the extension once", () => {
    expect(toProjectFileName("выезд")).toBe("выезд.mumbox");
    expect(toProjectFileName("выезд.mumbox")).toBe("выезд.mumbox");
    expect(toProjectFileName("выезд.MUMBOX")).toBe("выезд.mumbox");
  });

  test("strips characters no filesystem accepts", () => {
    expect(toProjectFileName('a/b\\c:d*e?f"g<h>i|j')).toBe("abcdefghij.mumbox");
  });

  test("keeps spaces and dashes", () => {
    expect(toProjectFileName("Мой проект-2")).toBe("Мой проект-2.mumbox");
  });

  test("falls back when nothing usable is left", () => {
    expect(toProjectFileName("///")).toBe("mumbox-project.mumbox");
  });
});

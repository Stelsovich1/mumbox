import { expect, test } from "@playwright/test";

import {
  countSelected,
  getSelectAllState,
  pruneSelection,
  setSelection,
  toggleSelection
} from "../../src/shared/lib/rowSelection";

test.describe("toggleSelection", () => {
  test("adds an id that is not selected", () => {
    expect([...toggleSelection(new Set(["a"]), "b")]).toEqual(["a", "b"]);
  });

  test("removes an id that is selected", () => {
    expect([...toggleSelection(new Set(["a", "b"]), "a")]).toEqual(["b"]);
  });

  test("returns a new set and does not mutate the input", () => {
    const original = new Set(["a"]);
    const next = toggleSelection(original, "b");

    expect(next).not.toBe(original);
    expect([...original]).toEqual(["a"]);
  });
});

test.describe("setSelection", () => {
  test("adds only the listed ids and preserves ids outside the filter", () => {
    const next = setSelection(new Set(["hidden"]), ["a", "b"], true);

    expect([...next].sort()).toEqual(["a", "b", "hidden"]);
  });

  test("removes only the listed ids and preserves ids outside the filter", () => {
    const next = setSelection(new Set(["hidden", "a", "b"]), ["a", "b"], false);

    expect([...next]).toEqual(["hidden"]);
  });

  test("is a no-op for an empty id list", () => {
    expect([...setSelection(new Set(["a"]), [], true)]).toEqual(["a"]);
    expect([...setSelection(new Set(["a"]), [], false)]).toEqual(["a"]);
  });
});

test.describe("countSelected", () => {
  test("ignores selected ids that are absent from the given list", () => {
    expect(countSelected(new Set(["a", "hidden"]), ["a", "b"])).toBe(1);
  });

  test("counts nothing for an empty selection", () => {
    expect(countSelected(new Set(), ["a", "b"])).toBe(0);
  });
});

test.describe("getSelectAllState", () => {
  test("reports none when nothing in the list is selected", () => {
    expect(getSelectAllState(new Set(["hidden"]), ["a", "b"])).toBe("none");
  });

  test("reports some for a partial selection", () => {
    expect(getSelectAllState(new Set(["a"]), ["a", "b"])).toBe("some");
  });

  test("reports all when every listed id is selected", () => {
    expect(getSelectAllState(new Set(["a", "b", "hidden"]), ["a", "b"])).toBe("all");
  });

  test("reports none for an empty id list even with a non-empty selection", () => {
    expect(getSelectAllState(new Set(["hidden"]), [])).toBe("none");
  });
});

test.describe("pruneSelection", () => {
  test("drops ids that no longer exist and keeps the rest", () => {
    expect([...pruneSelection(new Set(["a", "gone"]), ["a", "b"])]).toEqual(["a"]);
  });

  test("empties the selection when nothing exists any more", () => {
    expect(pruneSelection(new Set(["a"]), []).size).toBe(0);
  });
});

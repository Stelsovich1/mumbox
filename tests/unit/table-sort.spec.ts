import { expect, test } from "@playwright/test";

import { Comparator, cycleSortState, getAriaSort, sortRows } from "../../src/shared/lib/tableSort";

type Row = { id: string; value: number };

const byValue: Comparator<Row> = (first, second) => first.value - second.value;
const comparators = { value: byValue } as const;

const rows: Row[] = [
  { id: "b", value: 2 },
  { id: "a", value: 1 },
  { id: "c", value: 3 }
];

test.describe("cycleSortState", () => {
  test("cycles null to asc to desc and back to null", () => {
    const first = cycleSortState(null, "value");
    expect(first).toEqual({ key: "value", direction: "asc" });

    const second = cycleSortState(first, "value");
    expect(second).toEqual({ key: "value", direction: "desc" });

    expect(cycleSortState(second, "value")).toBeNull();
  });

  test("restarts at asc when a different key is clicked from any state", () => {
    expect(cycleSortState({ key: "value", direction: "asc" }, "other")).toEqual({
      key: "other",
      direction: "asc"
    });
    expect(cycleSortState({ key: "value", direction: "desc" }, "other")).toEqual({
      key: "other",
      direction: "asc"
    });
  });
});

test.describe("getAriaSort", () => {
  test("maps the active column direction", () => {
    expect(getAriaSort({ key: "value", direction: "asc" }, "value")).toBe("ascending");
    expect(getAriaSort({ key: "value", direction: "desc" }, "value")).toBe("descending");
  });

  test("reports none for an inactive column and for no sort at all", () => {
    expect(getAriaSort({ key: "value", direction: "asc" }, "other")).toBe("none");
    expect(getAriaSort(null, "value")).toBe("none");
  });
});

test.describe("sortRows", () => {
  test("returns the identical array reference when there is no sort", () => {
    expect(sortRows(rows, null, comparators)).toBe(rows);
  });

  test("sorts ascending and does not mutate the input", () => {
    const sorted = sortRows(rows, { key: "value", direction: "asc" }, comparators);

    expect(sorted.map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(rows.map((row) => row.id)).toEqual(["b", "a", "c"]);
  });

  test("descending is the exact reverse of ascending for distinct keys", () => {
    const ascending = sortRows(rows, { key: "value", direction: "asc" }, comparators);
    const descending = sortRows(rows, { key: "value", direction: "desc" }, comparators);

    expect(descending.map((row) => row.id)).toEqual([...ascending].reverse().map((row) => row.id));
  });

  test("is stable for equal keys", () => {
    const tied: Row[] = [
      { id: "first", value: 1 },
      { id: "second", value: 1 },
      { id: "third", value: 1 }
    ];

    expect(
      sortRows(tied, { key: "value", direction: "asc" }, comparators).map((row) => row.id)
    ).toEqual(["first", "second", "third"]);
  });

  test("returns rows unchanged when the key has no comparator", () => {
    const partial: Readonly<Partial<Record<"value" | "unknown", Comparator<Row>>>> = {
      value: byValue
    };

    expect(sortRows(rows, { key: "unknown", direction: "asc" }, partial)).toBe(rows);
  });
});

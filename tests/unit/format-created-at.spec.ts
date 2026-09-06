import { expect, test } from "@playwright/test";

import {
  formatCreatedAt,
  formatCreatedAtParts,
  MISSING_DATE_LABEL
} from "../../src/shared/lib/formatDate";

test("formats a date as dd.MM.yyyy HH:mm in local time", () => {
  // Constructed locally so the expectation is independent of the runner's timezone.
  const local = new Date(2024, 0, 5, 9, 7);

  expect(formatCreatedAt(local.toISOString())).toBe("05.01.2024 09:07");
});

test("pads single-digit day, month, hour and minute", () => {
  const local = new Date(2024, 2, 3, 4, 5);

  expect(formatCreatedAt(local.toISOString())).toBe("03.03.2024 04:05");
});

test("keeps a four-digit year for a pre-2000 date", () => {
  const local = new Date(1999, 11, 31, 23, 59);

  expect(formatCreatedAt(local.toISOString())).toBe("31.12.1999 23:59");
});

test("returns a dash for a missing value", () => {
  expect(formatCreatedAt(undefined)).toBe(MISSING_DATE_LABEL);
  expect(formatCreatedAt(null)).toBe(MISSING_DATE_LABEL);
  expect(formatCreatedAt("")).toBe(MISSING_DATE_LABEL);
});

test("returns a dash for an unparseable value", () => {
  expect(formatCreatedAt("garbage")).toBe(MISSING_DATE_LABEL);
});

test.describe("formatCreatedAtParts", () => {
  test("splits the value into a date line and a time line", () => {
    const local = new Date(2024, 0, 5, 9, 7);

    expect(formatCreatedAtParts(local.toISOString())).toEqual({
      date: "05.01.2024",
      time: "09:07"
    });
  });

  test("pads both halves and keeps a four-digit year", () => {
    expect(formatCreatedAtParts(new Date(1999, 11, 31, 3, 4).toISOString())).toEqual({
      date: "31.12.1999",
      time: "03:04"
    });
  });

  test("returns null when there is nothing to show, so the caller renders the dash", () => {
    expect(formatCreatedAtParts(undefined)).toBeNull();
    expect(formatCreatedAtParts(null)).toBeNull();
    expect(formatCreatedAtParts("")).toBeNull();
    expect(formatCreatedAtParts("garbage")).toBeNull();
  });

  test("agrees with the single-line formatter", () => {
    const iso = new Date(2024, 5, 30, 23, 59).toISOString();
    const parts = formatCreatedAtParts(iso);

    expect(`${parts?.date ?? ""} ${parts?.time ?? ""}`).toBe(formatCreatedAt(iso));
  });
});

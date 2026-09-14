import { expect, test } from "@playwright/test";

import { formatDecimalRu, parseDecimalInput } from "../../src/shared/lib/decimalInput";

test.describe("formatDecimalRu", () => {
  test("always shows at least one fraction digit, comma-separated", () => {
    expect(formatDecimalRu(34)).toBe("34,0");
    expect(formatDecimalRu(0)).toBe("0,0");
    expect(formatDecimalRu(1.2)).toBe("1,2");
    expect(formatDecimalRu(1.25)).toBe("1,25");
  });

  test("rounds to millisecond resolution and drops trailing zeros beyond the first", () => {
    expect(formatDecimalRu(1.2346)).toBe("1,235");
    expect(formatDecimalRu(7.4)).toBe("7,4");
    expect(formatDecimalRu(0.1 + 0.2)).toBe("0,3");
  });

  test("renders a non-finite value as zero rather than NaN", () => {
    expect(formatDecimalRu(Number.NaN)).toBe("0,0");
    expect(formatDecimalRu(Number.POSITIVE_INFINITY)).toBe("0,0");
  });

  test("keeps a negative sign", () => {
    expect(formatDecimalRu(-2.5)).toBe("-2,5");
  });
});

test.describe("parseDecimalInput", () => {
  test("accepts either separator", () => {
    expect(parseDecimalInput("1,2")).toBe(1.2);
    expect(parseDecimalInput("1.2")).toBe(1.2);
    expect(parseDecimalInput("34,0")).toBe(34);
  });

  test("reads a trailing separator as the whole part while the fraction is being typed", () => {
    expect(parseDecimalInput("34,")).toBe(34);
    expect(parseDecimalInput("34.")).toBe(34);
  });

  test("tolerates whitespace and a leading separator", () => {
    expect(parseDecimalInput(" 0,5 ")).toBe(0.5);
    expect(parseDecimalInput(",5")).toBe(0.5);
  });

  test("returns null for text that is not a number yet", () => {
    expect(parseDecimalInput("")).toBeNull();
    expect(parseDecimalInput("-")).toBeNull();
    expect(parseDecimalInput(",")).toBeNull();
    expect(parseDecimalInput("abc")).toBeNull();
    expect(parseDecimalInput("1,2,3")).toBeNull();
    expect(parseDecimalInput("1e3")).toBeNull();
  });
});

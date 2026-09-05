import { expect, test } from "@playwright/test";

import { formatCountRu, pluralizeRu } from "../../src/shared/lib/pluralizeRu";

const forms = ["запись", "записи", "записей"] as const;

test("uses the singular form for numbers ending in one, except the teens", () => {
  expect(pluralizeRu(1, forms)).toBe("запись");
  expect(pluralizeRu(21, forms)).toBe("запись");
  expect(pluralizeRu(101, forms)).toBe("запись");
  expect(pluralizeRu(11, forms)).toBe("записей");
});

test("uses the few form for numbers ending in two to four, except the teens", () => {
  expect(pluralizeRu(2, forms)).toBe("записи");
  expect(pluralizeRu(3, forms)).toBe("записи");
  expect(pluralizeRu(4, forms)).toBe("записи");
  expect(pluralizeRu(22, forms)).toBe("записи");
  expect(pluralizeRu(12, forms)).toBe("записей");
  expect(pluralizeRu(112, forms)).toBe("записей");
});

test("uses the many form for everything else", () => {
  expect(pluralizeRu(0, forms)).toBe("записей");
  expect(pluralizeRu(5, forms)).toBe("записей");
  expect(pluralizeRu(100, forms)).toBe("записей");
});

test("formatCountRu prefixes the number", () => {
  expect(formatCountRu(1, forms)).toBe("1 запись");
  expect(formatCountRu(2, forms)).toBe("2 записи");
  expect(formatCountRu(5, forms)).toBe("5 записей");
});

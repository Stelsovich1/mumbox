import { expect, test } from "@playwright/test";

import { computeContentHash, CONTENT_HASH_PATTERN, toHex } from "../../src/shared/lib/contentHash";

// SHA-256 of the three bytes "abc", the canonical NIST test vector.
const ABC_DIGEST = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

test("hashes known bytes to the known digest", async () => {
  expect(await computeContentHash(new Blob(["abc"]))).toBe(ABC_DIGEST);
});

test("hashes an empty blob", async () => {
  expect(await computeContentHash(new Blob([]))).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );
});

test("produces a digest matching the stored-hash pattern", async () => {
  const hash = await computeContentHash(new Blob(["mumbox"]));

  expect(hash).not.toBeNull();
  expect(CONTENT_HASH_PATTERN.test(hash ?? "")).toBe(true);
});

test("returns null when crypto.subtle is unavailable", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis.crypto, "subtle");
  Object.defineProperty(globalThis.crypto, "subtle", { value: undefined, configurable: true });

  try {
    expect(await computeContentHash(new Blob(["abc"]))).toBeNull();
  } finally {
    if (original) {
      Object.defineProperty(globalThis.crypto, "subtle", original);
    }
  }
});

test("toHex pads every byte to two characters", () => {
  expect(toHex(new Uint8Array([0, 15, 16, 255]))).toBe("000f10ff");
});

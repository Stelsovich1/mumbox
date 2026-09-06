import { expect, test } from "@playwright/test";

import { getCrc32 } from "../../src/shared/lib/crc32";

/**
 * The shape `getCrc32` had while it lived inside `file-config`. Kept here as the oracle: the
 * optimisation is only allowed to change speed, so every buffer must hash to the same value under
 * both loops. Nothing in the app verifies a CRC on read, so a drift here would surface only in a
 * third-party archiver.
 */
function referenceCrc32(bytes: Uint8Array) {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }

  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function makeBytes(length: number, seed: number) {
  const bytes = new Uint8Array(length);
  let state = seed;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1_103_515_245 + 12_345) >>> 0;
    bytes[index] = (state >>> 16) & 0xff;
  }

  return bytes;
}

test("hashes the standard check vector", () => {
  // CRC-32/ISO-HDLC check value for the ASCII string "123456789".
  expect(getCrc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
});

test("hashes an empty buffer to zero", () => {
  expect(getCrc32(new Uint8Array(0))).toBe(0);
});

test("returns an unsigned 32-bit value", () => {
  // A signed result would be written to the ZIP header as a different four bytes.
  const crc = getCrc32(makeBytes(1024, 7));

  expect(crc).toBeGreaterThanOrEqual(0);
  expect(crc).toBeLessThanOrEqual(0xffffffff);
  expect(Number.isInteger(crc)).toBe(true);
});

test("matches the reference implementation at table and loop boundaries", () => {
  for (const length of [0, 1, 2, 3, 255, 256, 257, 4096, 100_000]) {
    const bytes = makeBytes(length, length + 1);

    expect(getCrc32(bytes)).toBe(referenceCrc32(bytes));
  }
});

test("matches the reference implementation on varied buffers", () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const bytes = makeBytes((seed * 37) % 5_000, seed);

    expect(getCrc32(bytes)).toBe(referenceCrc32(bytes));
  }
});

test("hashes a view offset into a larger buffer", () => {
  // `slice` and `subarray` both appear around the ZIP reader; indexing must stay view-relative.
  const backing = makeBytes(512, 99);
  const view = backing.subarray(128, 384);

  expect(getCrc32(view)).toBe(referenceCrc32(view));
  expect(getCrc32(view)).toBe(getCrc32(backing.slice(128, 384)));
});

test("distinguishes buffers that differ in one byte", () => {
  const bytes = makeBytes(2048, 11);
  const flipped = Uint8Array.from(bytes);
  flipped[1023] = (flipped[1023] ?? 0) ^ 0x01;

  expect(getCrc32(flipped)).not.toBe(getCrc32(bytes));
});

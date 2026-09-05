import { expect, test } from "@playwright/test";

import { createWaveformPeakCache } from "../../src/features/audio-editor/model/waveformCache";

function peaks(value: number) {
  return new Float32Array([value, value + 0.5]);
}

test("waveform peak cache returns stored peaks by identity", () => {
  const cache = createWaveformPeakCache(2);
  const first = peaks(1);

  cache.set("media-1", first);

  expect(cache.get("media-1")).toBe(first);
  expect(cache.size()).toBe(1);
});

test("waveform peak cache evicts the least recently used item", () => {
  const cache = createWaveformPeakCache(2);
  const first = peaks(1);
  const second = peaks(2);
  const third = peaks(3);

  cache.set("media-1", first);
  cache.set("media-2", second);
  expect(cache.get("media-1")).toBe(first);
  cache.set("media-3", third);

  expect(cache.get("media-2")).toBeNull();
  expect(cache.get("media-1")).toBe(first);
  expect(cache.get("media-3")).toBe(third);
  expect(cache.size()).toBe(2);
});

test("waveform peak cache replaces an existing entry without growing", () => {
  const cache = createWaveformPeakCache(2);
  const first = peaks(1);
  const replacement = peaks(4);

  cache.set("media-1", first);
  cache.set("media-1", replacement);

  expect(cache.get("media-1")).toBe(replacement);
  expect(cache.size()).toBe(1);
});

test("waveform peak cache supports explicit deletion and clearing", () => {
  const cache = createWaveformPeakCache(3);

  cache.set("media-1", peaks(1));
  cache.set("media-2", peaks(2));
  cache.delete("media-1");

  expect(cache.get("media-1")).toBeNull();
  expect(cache.size()).toBe(1);

  cache.clear();

  expect(cache.get("media-2")).toBeNull();
  expect(cache.size()).toBe(0);
});

test("waveform peak cache keeps a usable one-entry limit for invalid limits", () => {
  const cache = createWaveformPeakCache(0);
  const first = peaks(1);
  const second = peaks(2);

  cache.set("media-1", first);
  cache.set("media-2", second);

  expect(cache.get("media-1")).toBeNull();
  expect(cache.get("media-2")).toBe(second);
  expect(cache.size()).toBe(1);
});

import { expect, test } from "@playwright/test";

import {
  DEFAULT_ENGINE_SAMPLE_RATE,
  getEngineSampleRate,
  readRequestedSampleRate,
  resetEngineSampleRate,
  setEngineSampleRate,
  shouldUseNativeRateForWav
} from "../../src/features/playback/model/playbackRate";

/**
 * The module had no test in any tier, and every branch in it decides something a fixture cannot
 * show: every fixture in this repo is a 44.1 kHz WAV and the default engine rate is 44 100, so the
 * two are always equal and the interesting branches are never taken. `shouldUseNativeRateForWav`
 * could be replaced by `() => true` with the whole suite green, while a 48 kHz Android played a
 * 44.1 kHz WAV through a range path that builds the buffer at the FILE's rate — the fall-through to
 * the full decode this function exists to force would simply not happen.
 */

test.afterEach(() => {
  // A module-level singleton, and the unit tier shares a worker across spec files.
  resetEngineSampleRate();
});

test("the WAV range path is refused when the file rate is not the engine's", () => {
  expect(shouldUseNativeRateForWav(DEFAULT_ENGINE_SAMPLE_RATE)).toBe(true);
  expect(shouldUseNativeRateForWav(48_000)).toBe(false);

  setEngineSampleRate(48_000);
  expect(shouldUseNativeRateForWav(48_000)).toBe(true);
  // The case a 48 kHz device hits with this repo's own fixtures.
  expect(shouldUseNativeRateForWav(44_100)).toBe(false);
});

test("setting the rate reports whether it changed", () => {
  // The boolean is what invalidates the buffer cache, so a version that always returned true would
  // clear every decoded buffer on each context creation and re-warm the whole panel.
  expect(setEngineSampleRate(DEFAULT_ENGINE_SAMPLE_RATE)).toBe(false);
  expect(setEngineSampleRate(48_000)).toBe(true);
  expect(setEngineSampleRate(48_000)).toBe(false);
  expect(getEngineSampleRate()).toBe(48_000);
});

test("a nonsensical rate is ignored rather than adopted", () => {
  // A rejected reading must leave the previous value standing: decoding at 0 or at NaN produces no
  // audio at all, and there is no error anywhere to notice.
  for (const rate of [0, -1, 1, Number.NaN, Number.POSITIVE_INFINITY, 1_000_000]) {
    expect(setEngineSampleRate(rate)).toBe(false);
  }
  expect(getEngineSampleRate()).toBe(DEFAULT_ENGINE_SAMPLE_RATE);
});

test("a fractional rate is rounded, not rejected", () => {
  // Reported rates are integers in practice, but the value is compared for equality against file
  // rates, so a stored 47999.999 would make every comparison false forever.
  expect(setEngineSampleRate(47_999.6)).toBe(true);
  expect(getEngineSampleRate()).toBe(48_000);
});

test("?rate=N is read, and only inside the plausible range", () => {
  expect(readRequestedSampleRate("?rate=48000")).toBe(48_000);
  expect(readRequestedSampleRate("rate=44100&diag=1")).toBe(44_100);
  expect(readRequestedSampleRate("?diag=1")).toBeNull();
  expect(readRequestedSampleRate("")).toBeNull();
  // Out of range is null rather than clamped: the switch is a debugging aid, and passing 1 to
  // `new AudioContext({sampleRate: 1})` throws on every engine that accepts the option at all.
  expect(readRequestedSampleRate("?rate=1")).toBeNull();
  expect(readRequestedSampleRate("?rate=999999")).toBeNull();
  expect(readRequestedSampleRate("?rate=abc")).toBeNull();
});

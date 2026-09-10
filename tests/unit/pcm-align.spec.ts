import { expect, test } from "@playwright/test";

import {
  findAlignmentOffset,
  getMaxAbsStep,
  isSeamContinuous,
  residualRms,
  rms
} from "../../src/features/playback/model/pcmAlign";

/**
 * These back two very different jobs, and the tests are split accordingly.
 *
 * `findAlignmentOffset` measures a per-media decoder offset ONCE, during warm-up. The step-0 probe
 * measured 2257 samples on a real LAME file — one preamble frame (1152) plus LAME's encoder delay
 * (1105) — so the offset is a property of the file and cannot come from a constant.
 *
 * The periodic-signal tests are the important ones: a pure tone matches at every multiple of its
 * period, so a naive "highest correlation wins" search would return an arbitrary multiple as the
 * encoder delay. Music soundboards are full of sustained tones.
 */

function makeNoise(length: number, seed: number): Float32Array {
  const out = new Float32Array(length);
  let state = seed;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    out[index] = (state / 0x7fffffff) * 2 - 1;
  }
  return out;
}

function makeTone(length: number, periodSamples: number): Float32Array {
  const out = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    out[index] = Math.sin((index / periodSamples) * 2 * Math.PI);
  }
  return out;
}

test.describe("rms and getMaxAbsStep", () => {
  test("rms of a constant is that constant", () => {
    expect(rms(new Float32Array([0.5, 0.5, 0.5, 0.5]))).toBeCloseTo(0.5, 10);
  });

  test("rms of silence is zero, and of an empty window is zero", () => {
    expect(rms(new Float32Array(64))).toBe(0);
    expect(rms(new Float32Array(0))).toBe(0);
  });

  test("getMaxAbsStep finds the largest jump between neighbours", () => {
    expect(getMaxAbsStep(new Float32Array([0, 0.1, 0.2, 0.9, 0.95]))).toBeCloseTo(0.7, 6);
  });

  test("getMaxAbsStep of a smooth ramp is the ramp's own step", () => {
    const ramp = new Float32Array(100);
    for (let index = 0; index < ramp.length; index += 1) {
      ramp[index] = index / 100;
    }
    expect(getMaxAbsStep(ramp)).toBeCloseTo(0.01, 6);
  });

  test("a single sample has no step", () => {
    expect(getMaxAbsStep(new Float32Array([0.7]))).toBe(0);
  });
});

test.describe("residualRms", () => {
  test("identical samples give exactly zero", () => {
    const signal = makeNoise(256, 7);
    expect(residualRms(signal, signal, 0)).toBe(0);
  });

  test("finds the reference inside a haystack at the right offset", () => {
    const haystack = makeNoise(2048, 11);
    const reference = haystack.slice(500, 756);
    expect(residualRms(reference, haystack, 500)).toBe(0);
    expect(residualRms(reference, haystack, 501)).toBeGreaterThan(0);
  });

  test("a window running past the end is infinite, not silently short", () => {
    // Returning a small number here would let an out-of-range comparison look like a good match.
    const haystack = makeNoise(100, 3);
    expect(residualRms(makeNoise(50, 4), haystack, 80)).toBe(Number.POSITIVE_INFINITY);
  });
});

test.describe("findAlignmentOffset", () => {
  test("measures a known shift on aperiodic material", () => {
    const haystack = makeNoise(8192, 21);
    // The reference really sits 2257 samples earlier than its nominal position — the exact offset
    // the step-0 probe measured on a real 192 kbps LAME file.
    const reference = haystack.slice(4000, 4000 + 1024);
    const result = findAlignmentOffset({
      reference,
      haystack,
      nominalOffset: 4000 + 2257,
      searchRadius: 4096,
      // `peakCorrelation` below is a survey-only statistic: production reads `lag` alone, so the
      // default search stops at the first acceptance and never computes a correlation.
      survey: true
    });
    expect(result.lag).toBe(-2257);
    expect(result.residual).toBe(0);
    expect(result.peakCorrelation).toBeCloseTo(1, 6);
    expect(result.acceptedCount).toBe(1);
  });

  test("reports a lag of zero when nothing shifted", () => {
    const haystack = makeNoise(4096, 33);
    const reference = haystack.slice(1000, 1512);
    const result = findAlignmentOffset({
      reference,
      haystack,
      nominalOffset: 1000,
      searchRadius: 512
    });
    expect(result.lag).toBe(0);
    expect(result.acceptedCount).toBe(1);
  });

  test("a periodic tone matches at many lags, and that is reported rather than hidden", () => {
    // Period 200.5 samples is a 220 Hz tone at 44.1 kHz — an organ pad or a sustained synth. A
    // +/-2048 search contains about twenty matches, so one window cannot tell a period from a
    // delay. `acceptedCount > 1` is the caller's signal to measure another window and require
    // agreement.
    const haystack = makeTone(8192, 200);
    const reference = haystack.slice(4000, 4000 + 1024);
    const result = findAlignmentOffset({
      reference,
      haystack,
      nominalOffset: 4000,
      searchRadius: 2048,
      // Counting every match is what `survey` is for; the default stops at the first one.
      survey: true
    });
    expect(result.acceptedCount).toBeGreaterThan(1);
    // And among all those matches the one closest to zero wins, so the measurement does not drift
    // by an arbitrary multiple of the period.
    expect(result.lag).toBe(0);
  });

  test("on a periodic tone with a real shift, the nearest match to zero still wins", () => {
    const haystack = makeTone(8192, 200);
    const reference = haystack.slice(4000, 4000 + 1024);
    const result = findAlignmentOffset({
      reference,
      haystack,
      // Nominal is 600 samples late, i.e. three full periods plus nothing — so lags of -600, -400,
      // -800 all match. The nearest to zero is what a delay measurement must not return blindly,
      // which is exactly why the caller cross-checks windows.
      nominalOffset: 4600,
      searchRadius: 2048,
      survey: true
    });
    expect(result.acceptedCount).toBeGreaterThan(1);
    expect(result.lag).not.toBeNull();
    expect(Math.abs(result.lag ?? 0) % 200).toBe(0);
  });

  test("returns null when nothing is within tolerance", () => {
    const result = findAlignmentOffset({
      reference: makeNoise(512, 5),
      haystack: makeNoise(4096, 99),
      nominalOffset: 1000,
      searchRadius: 256
    });
    expect(result.lag).toBeNull();
    expect(result.acceptedCount).toBe(0);
    expect(result.residual).toBe(Number.POSITIVE_INFINITY);
  });

  test("an empty reference cannot match anything", () => {
    const result = findAlignmentOffset({
      reference: new Float32Array(0),
      haystack: makeNoise(1024, 1),
      nominalOffset: 0,
      searchRadius: 16
    });
    expect(result.lag).toBeNull();
  });

  test("a search that would run off either end of the haystack is skipped, not clamped", () => {
    const haystack = makeNoise(1024, 17);
    const reference = haystack.slice(0, 256);
    const result = findAlignmentOffset({
      reference,
      haystack,
      nominalOffset: 0,
      searchRadius: 4096
    });
    // Only lags keeping the window inside the haystack are considered, so the true lag 0 is found
    // rather than an out-of-range read producing a false match.
    expect(result.lag).toBe(0);
  });

  test("the tolerance is honoured", () => {
    const haystack = makeNoise(4096, 41);
    const reference = haystack.slice(1000, 1256).map((value) => value + 0.01) as Float32Array;
    const strict = findAlignmentOffset({
      reference,
      haystack,
      nominalOffset: 1000,
      searchRadius: 64,
      maxResidual: 1e-6
    });
    const loose = findAlignmentOffset({
      reference,
      haystack,
      nominalOffset: 1000,
      searchRadius: 64,
      maxResidual: 0.02
    });
    expect(strict.lag).toBeNull();
    expect(loose.lag).toBe(0);
  });
});

test.describe("isSeamContinuous", () => {
  test("a smooth join passes", () => {
    const ramp = new Float32Array(64);
    for (let index = 0; index < ramp.length; index += 1) {
      ramp[index] = index / 64;
    }
    expect(isSeamContinuous({ seamWindow: ramp, referenceMaxStep: 1 / 64 })).toBe(true);
  });

  test("a click fails", () => {
    const window = new Float32Array(64);
    for (let index = 0; index < window.length; index += 1) {
      window[index] = index < 32 ? 0.5 : -0.5;
    }
    expect(isSeamContinuous({ seamWindow: window, referenceMaxStep: 0.01 })).toBe(false);
  });

  test("silence next to silence passes, and a step inside silence does not", () => {
    // Dividing by a zero reference step would make every seam pass in a silent passage.
    expect(isSeamContinuous({ seamWindow: new Float32Array(64), referenceMaxStep: 0 })).toBe(true);
    const blip = new Float32Array(64);
    blip[32] = 0.3;
    expect(isSeamContinuous({ seamWindow: blip, referenceMaxStep: 0 })).toBe(false);
  });

  test("the tolerance multiplies the reference step", () => {
    const window = new Float32Array([0, 0.2, 0.4]);
    expect(isSeamContinuous({ seamWindow: window, referenceMaxStep: 0.1, tolerance: 1.5 })).toBe(false);
    expect(isSeamContinuous({ seamWindow: window, referenceMaxStep: 0.2, tolerance: 1.5 })).toBe(true);
  });
});

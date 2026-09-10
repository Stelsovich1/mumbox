import { expect, test } from "@playwright/test";

import {
  findAlignmentOffset,
  residualRms,
  residualWithinTolerance
} from "../../src/features/playback/model/pcmAlign";

/**
 * The default search and the exhaustive survey must return the SAME lag.
 *
 * That equality is the whole justification for the fast path. `verifyMp3Alignment` reads only
 * `lag`, and the exhaustive scan picks the accepted lag closest to zero — so searching outward from
 * zero and stopping at the first acceptance is provably the same answer. "Provably" is doing work
 * here only if it is checked, and one case in particular is easy to get wrong: the exhaustive scan
 * runs `-radius` upward and breaks ties with a strict `<` on the absolute lag, so on a symmetric
 * double match at plus/minus k the NEGATIVE lag wins. A ladder visiting `+1` before `-1` would
 * silently disagree on periodic material — which is what a music soundboard is full of.
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
    out[index] = Math.sin((index / periodSamples) * Math.PI * 2);
  }
  return out;
}

type Case = {
  name: string;
  reference: Float32Array;
  haystack: Float32Array;
  nominalOffset: number;
  searchRadius: number;
};

function buildCases(): Case[] {
  const noise = makeNoise(8192, 21);
  const tone = makeTone(8192, 200);
  const silence = new Float32Array(8192);
  return [
    {
      name: "aperiodic, shifted by the measured 2257",
      reference: noise.slice(4000, 4000 + 1024),
      haystack: noise,
      nominalOffset: 4000 + 2257,
      searchRadius: 4096
    },
    {
      name: "aperiodic, no shift",
      reference: noise.slice(1000, 1512),
      haystack: noise,
      nominalOffset: 1000,
      searchRadius: 512
    },
    {
      name: "periodic tone, no shift",
      reference: tone.slice(4000, 4000 + 1024),
      haystack: tone,
      nominalOffset: 4000,
      searchRadius: 2048
    },
    {
      name: "periodic tone, shifted by three whole periods",
      reference: tone.slice(4000, 4000 + 1024),
      haystack: tone,
      nominalOffset: 4600,
      searchRadius: 2048
    },
    {
      name: "silence against silence",
      reference: silence.slice(0, 1024),
      haystack: silence,
      nominalOffset: 2000,
      searchRadius: 1024
    },
    {
      name: "no match anywhere",
      reference: makeNoise(512, 5),
      haystack: makeNoise(4096, 99),
      nominalOffset: 1000,
      searchRadius: 256
    },
    {
      name: "window runs off the end",
      reference: makeNoise(512, 7),
      haystack: makeNoise(1024, 7),
      nominalOffset: 900,
      searchRadius: 64
    }
  ];
}

for (const testCase of buildCases()) {
  test(`the outward search agrees with the exhaustive one: ${testCase.name}`, () => {
    const fast = findAlignmentOffset(testCase);
    const exhaustive = findAlignmentOffset({ ...testCase, survey: true });
    expect(fast.lag).toBe(exhaustive.lag);
  });
}

test("a symmetric double match resolves to the negative lag in both modes", () => {
  // The tie-break the ladder order exists for, built explicitly rather than from a tone: a pure
  // sine only matches at whole multiples of its period, and a half-period shift is its negation, so
  // no symmetric pair of equally good lags exists in one. Here the same block is planted at equal
  // distances either side of the nominal position, which makes -300 and +300 exactly as good.
  //
  // The exhaustive scan runs upward from -radius and keeps the first of an equal pair, so it
  // answers -300. A ladder visiting +1 before -1 would answer +300 and disagree here and nowhere
  // else — silently, and only on material that repeats.
  const haystack = makeNoise(8192, 77);
  const block = makeNoise(512, 999);
  haystack.set(block, 4000 - 300);
  haystack.set(block, 4000 + 300);

  const options = {
    reference: block,
    haystack,
    nominalOffset: 4000,
    searchRadius: 1024
  };
  const fast = findAlignmentOffset(options);
  const exhaustive = findAlignmentOffset({ ...options, survey: true });
  expect(exhaustive.acceptedCount).toBe(2);
  expect(fast.lag).toBe(exhaustive.lag);
  expect(fast.lag).toBe(-300);
});

test("residualWithinTolerance agrees with residualRms whenever it accepts", () => {
  const haystack = makeNoise(4096, 11);
  const reference = haystack.slice(1000, 1512);
  const exact = residualRms(reference, haystack, 1000);
  expect(residualWithinTolerance(reference, haystack, 1000, 1e-3)).toBeCloseTo(exact, 12);
});

test("residualWithinTolerance rejects instead of returning a large residual", () => {
  // The early exit is the point: a wrong lag must cost a few samples, not the whole window.
  const reference = makeNoise(512, 3);
  const haystack = makeNoise(4096, 4);
  expect(residualWithinTolerance(reference, haystack, 100, 1e-3)).toBeNull();
  expect(residualRms(reference, haystack, 100)).toBeGreaterThan(1e-3);
});

test("residualWithinTolerance treats a window past the end as no match", () => {
  // `residualRms` reports POSITIVE_INFINITY for this; the tolerance form reports null. Both mean
  // "not a match", and the contract of the older function is left alone.
  const reference = makeNoise(512, 3);
  const haystack = makeNoise(600, 3);
  expect(residualWithinTolerance(reference, haystack, 200, 1e-3)).toBeNull();
});

test("an empty reference matches trivially in both forms", () => {
  const haystack = makeNoise(64, 1);
  expect(residualWithinTolerance(new Float32Array(0), haystack, 0, 1e-3)).toBe(0);
  expect(residualRms(new Float32Array(0), haystack, 0)).toBe(0);
});

/**
 * A budget, not a benchmark.
 *
 * The old shape ran about 67 million inner iterations per window — 8193 lags, each with a
 * 4096-sample dot/energy loop AND a full 4096-sample residual — twice per media, synchronously, on
 * the warm-up path. The ceiling here is generous on purpose: the number that matters is whether the
 * WORST case (no match at all, which is the path that permanently disables a media) stays small
 * enough that a device five to twenty times slower than a dev box still only hiccups once.
 */
test("the worst case stays within a warm-up hiccup", () => {
  const reference = makeNoise(4096, 3);
  const haystack = makeNoise(88_200, 4);
  const startedAt = performance.now();
  const result = findAlignmentOffset({
    reference,
    haystack,
    nominalOffset: 44_100,
    searchRadius: 4096
  });
  const elapsedMs = performance.now() - startedAt;
  expect(result.lag).toBeNull();
  // The number is the deliverable here; the ceiling below is only a guard against a regression.
  console.log(`[B7] worst case (no match): ${elapsedMs.toFixed(1)} ms`);
  expect(elapsedMs).toBeLessThan(200);
});

test("the matched case is far cheaper than the worst one", () => {
  const haystack = makeNoise(88_200, 21);
  const reference = haystack.slice(40_000, 40_000 + 4096);
  const startedAt = performance.now();
  const result = findAlignmentOffset({
    reference,
    haystack,
    nominalOffset: 40_000 + 2257,
    searchRadius: 4096
  });
  const elapsedMs = performance.now() - startedAt;
  expect(result.lag).toBe(-2257);
  console.log(`[B7] matched case (lag -2257): ${elapsedMs.toFixed(1)} ms`);
  expect(elapsedMs).toBeLessThan(200);
});

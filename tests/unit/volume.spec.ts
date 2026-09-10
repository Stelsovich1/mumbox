import { expect, test } from "@playwright/test";

import {
  getCellGainValue,
  getEffectiveVolume,
  getMasterGainValue,
  MAX_EFFECTIVE_VOLUME
} from "../../src/features/playback/model/volume";

/**
 * Master volume moved onto a shared gain node so a change writes once instead of once per playing
 * route on every animation frame. That is only safe if splitting the product across two nodes
 * reproduces the single-node value exactly — otherwise the change would quietly alter how loud
 * things are, which is the one thing a soundboard must not do behind the user's back.
 */

const MASTER_VALUES = [0, 1, 37, 50, 80, 99, 100];
const OFFSET_VALUES = [-100, -99, -50, -1, 0, 1, 50, 100, 200, 299, 300];

test("the split reproduces the combined value across the whole reachable lattice", () => {
  // `masterVolume` is 0..100 and `volumeOffset` is -100..+300, so the product never exceeds 4 and
  // the clamp in the combined form never binds. Asserting it here turns that from an argument into
  // a fact, and would fail loudly if either range were ever widened.
  for (const master of MASTER_VALUES) {
    for (const offset of OFFSET_VALUES) {
      const combined = getEffectiveVolume(master, offset);
      const split = getMasterGainValue(master, false) * getCellGainValue(offset);
      expect(split).toBeCloseTo(combined, 12);
    }
  }
});

test("a full-range boost survives the split", () => {
  // The headline case: +300 % on one cell is deliberate behaviour, and the shared node must not cap
  // it. At the default master of 80 that is 0.8 x 4 = 3.2.
  expect(getMasterGainValue(80, false) * getCellGainValue(300)).toBeCloseTo(3.2, 12);
  expect(getEffectiveVolume(80, 300)).toBeCloseTo(3.2, 12);
});

test("mute is carried by the master node alone", () => {
  expect(getMasterGainValue(100, true)).toBe(0);
  // And it does not touch the cell term, so unmuting restores the boost rather than resetting it.
  expect(getCellGainValue(300)).toBe(4);
});

test("the cell term floors at silence and ceils at the maximum", () => {
  expect(getCellGainValue(-100)).toBe(0);
  expect(getCellGainValue(-1000)).toBe(0);
  expect(getCellGainValue(100_000)).toBe(MAX_EFFECTIVE_VOLUME);
});

test("the master term is a plain fraction", () => {
  expect(getMasterGainValue(0, false)).toBe(0);
  expect(getMasterGainValue(50, false)).toBeCloseTo(0.5, 12);
  expect(getMasterGainValue(100, false)).toBe(1);
  // Out-of-range input cannot push the shared node above unity, which would scale every route.
  expect(getMasterGainValue(400, false)).toBe(1);
});

test("the combined form is clamped even outside the UI range", () => {
  // `getMasterGainValue` was pinned at an out-of-range input and `getEffectiveVolume` was not, so
  // removing its ceiling survived a mutation round. Reachable rather than hypothetical: a
  // hand-edited project file may carry any finite master volume, and the media-element fallback
  // route uses this combined form because the shared master bus cannot reach it.
  expect(getEffectiveVolume(400, 300)).toBe(MAX_EFFECTIVE_VOLUME);
  expect(getEffectiveVolume(100, 100_000)).toBe(MAX_EFFECTIVE_VOLUME);
  expect(getEffectiveVolume(-100, 50)).toBe(0);
});

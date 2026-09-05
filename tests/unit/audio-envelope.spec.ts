import { expect, test } from "@playwright/test";

import {
  getEnvelopeValue,
  getTrimEndSeconds,
  getTrimStartSeconds,
  scheduleEnvelope
} from "../../src/features/playback/model/audioEnvelope";
import type { AudioEnvelopeSettings } from "../../src/features/playback/model/audioEnvelope";

const HALF_FADE = Math.sin(Math.PI / 4); // 0.7071067811865476

function makeSettings(overrides: Partial<AudioEnvelopeSettings> = {}): AudioEnvelopeSettings {
  return {
    trimStartMs: null,
    trimEndMs: null,
    fadeInEnabled: false,
    fadeInMs: 0,
    fadeOutEnabled: false,
    fadeOutMs: 0,
    ...overrides
  };
}

type ParamCall =
  | { kind: "cancel"; startTime: number }
  | { kind: "setValue"; value: number; startTime: number }
  | { kind: "curve"; curve: Float32Array; startTime: number; duration: number };

function makeGain(currentTime: number, options: { throwOnCurve?: boolean } = {}) {
  const calls: ParamCall[] = [];
  const gain = {
    context: { currentTime },
    gain: {
      value: 1,
      cancelScheduledValues(startTime: number) {
        calls.push({ kind: "cancel", startTime });
      },
      setValueAtTime(value: number, startTime: number) {
        calls.push({ kind: "setValue", value, startTime });
      },
      setValueCurveAtTime(curve: Float32Array, startTime: number, duration: number) {
        if (options.throwOnCurve) {
          const error = new Error("overlap");
          error.name = "InvalidStateError";
          throw error;
        }
        calls.push({ kind: "curve", curve, startTime, duration });
      }
    }
  };

  return {
    node: gain as unknown as GainNode,
    calls,
    curve() {
      const entry = calls.find((call) => call.kind === "curve");
      return entry?.kind === "curve" ? entry : null;
    }
  };
}

test.describe("getTrimStartSeconds / getTrimEndSeconds", () => {
  test("null trim start resolves to 0 and null trim end resolves to the full duration", () => {
    expect(getTrimStartSeconds(makeSettings())).toBe(0);
    expect(getTrimEndSeconds(makeSettings(), 12.5)).toBe(12.5);
  });

  test("millisecond values convert to seconds", () => {
    expect(getTrimStartSeconds(makeSettings({ trimStartMs: 2500 }))).toBe(2.5);
    expect(getTrimEndSeconds(makeSettings({ trimEndMs: 7400 }), 30)).toBe(7.4);
  });

  test("a zero trim start is not treated as absent", () => {
    expect(getTrimStartSeconds(makeSettings({ trimStartMs: 0 }))).toBe(0);
    expect(getTrimEndSeconds(makeSettings({ trimEndMs: 0 }), 30)).toBe(0);
  });
});

test.describe("getEnvelopeValue", () => {
  test("returns exactly 1 with no fades, at and outside the playback range", () => {
    const settings = makeSettings();
    expect(getEnvelopeValue(settings, 0, 10)).toBe(1);
    expect(getEnvelopeValue(settings, 5, 10)).toBe(1);
    expect(getEnvelopeValue(settings, 10, 10)).toBe(1);
    expect(getEnvelopeValue(settings, -3, 10)).toBe(1);
    expect(getEnvelopeValue(settings, 42, 10)).toBe(1);
  });

  test("an enabled fade of zero length returns 1, not NaN", () => {
    // Without the `fadeInMs > 0` guard this is 0/0 -> NaN, which propagates through
    // Math.sin/min/max and silently mutes the cue. `toBe` matters: NaN is not close to 1.
    const settings = makeSettings({ fadeInEnabled: true, fadeInMs: 0 });
    expect(getEnvelopeValue(settings, 0, 10)).toBe(1);
    expect(getEnvelopeValue(makeSettings({ fadeOutEnabled: true, fadeOutMs: 0 }), 10, 10)).toBe(1);
  });

  test("a disabled fade with a non-zero length has no effect", () => {
    const settings = makeSettings({ fadeInEnabled: false, fadeInMs: 500 });
    expect(getEnvelopeValue(settings, 0, 10)).toBe(1);
  });

  test("fade-in rises from 0 to 1 along a quarter sine", () => {
    const settings = makeSettings({ fadeInEnabled: true, fadeInMs: 1000 });
    expect(getEnvelopeValue(settings, 0, 10)).toBe(0);
    expect(getEnvelopeValue(settings, 0.5, 10)).toBeCloseTo(HALF_FADE, 12);
    expect(getEnvelopeValue(settings, 1, 10)).toBe(1);
    expect(getEnvelopeValue(settings, 5, 10)).toBe(1);
  });

  test("fade-in is anchored to the trim start, not to zero", () => {
    // This is the invariant that trim-aware slicing must not break: the envelope reads
    // positions in the ORIGINAL media file, never positions inside a sliced buffer.
    const settings = makeSettings({
      trimStartMs: 30_000,
      fadeInEnabled: true,
      fadeInMs: 1000
    });
    expect(getEnvelopeValue(settings, 30, 42)).toBe(0);
    expect(getEnvelopeValue(settings, 30.5, 42)).toBeCloseTo(HALF_FADE, 12);
    expect(getEnvelopeValue(settings, 31, 42)).toBe(1);
    // Buffer-relative time would land here and be silently clamped to 0 — the failure mode.
    expect(getEnvelopeValue(settings, 0.5, 42)).toBe(0);
  });

  test("fade-out falls from 1 to 0 along a quarter sine and is shift invariant", () => {
    const settings = makeSettings({ fadeOutEnabled: true, fadeOutMs: 1000 });
    expect(getEnvelopeValue(settings, 10, 10)).toBe(0);
    expect(getEnvelopeValue(settings, 9.5, 10)).toBeCloseTo(HALF_FADE, 12);
    expect(getEnvelopeValue(settings, 9, 10)).toBe(1);
    expect(getEnvelopeValue(settings, 4, 10)).toBe(1);

    const shifted = getEnvelopeValue(settings, 109.5, 110);
    expect(shifted).toBeCloseTo(HALF_FADE, 12);
  });

  test("overlapping fades take the minimum, not the last one evaluated", () => {
    const settings = makeSettings({
      fadeInEnabled: true,
      fadeInMs: 4000,
      fadeOutEnabled: true,
      fadeOutMs: 4000
    });
    // At t = 3 of a 4 s region: fade-in progress 0.75 (0.924), fade-out progress 0.25 (0.383).
    const value = getEnvelopeValue(settings, 3, 4);
    expect(value).toBeCloseTo(Math.sin((Math.PI / 2) * 0.25), 12);
    expect(value).toBeLessThan(Math.sin((Math.PI / 2) * 0.75));
  });

  test("clamps below 0 and above 1", () => {
    const fadeIn = makeSettings({ fadeInEnabled: true, fadeInMs: 1000 });
    expect(getEnvelopeValue(fadeIn, -5, 10)).toBe(0);
    expect(getEnvelopeValue(fadeIn, 500, 10)).toBe(1);
  });
});

test.describe("scheduleEnvelope", () => {
  test("anchors scheduling to the context clock, not to zero", () => {
    const gain = makeGain(7.5);
    scheduleEnvelope(gain.node, makeSettings(), 0, 10);

    const cancel = gain.calls.find((call) => call.kind === "cancel");
    expect(cancel?.kind === "cancel" ? cancel.startTime : null).toBe(7.5);
    const curve = gain.curve();
    expect(curve?.startTime).toBe(7.5);
    expect(curve?.duration).toBe(10);
  });

  test("schedules no curve at exactly the 0.01 s boundary but does just above it", () => {
    const atBoundary = makeGain(0);
    scheduleEnvelope(atBoundary.node, makeSettings(), 0, 0.01);
    expect(atBoundary.curve()).toBeNull();

    const aboveBoundary = makeGain(0);
    scheduleEnvelope(aboveBoundary.node, makeSettings(), 0, 0.0101);
    expect(aboveBoundary.curve()).not.toBeNull();
  });

  test("schedules no curve when the end is already behind the current position", () => {
    const gain = makeGain(3);
    scheduleEnvelope(gain.node, makeSettings(), 10, 4);
    expect(gain.curve()).toBeNull();
    // The clamp to 0 must survive: a negative duration would throw in a real AudioParam.
    expect(gain.calls.some((call) => call.kind === "setValue")).toBe(true);
  });

  test("the curve endpoints equal the analytic envelope at both ends", () => {
    const settings = makeSettings({
      fadeInEnabled: true,
      fadeInMs: 500,
      fadeOutEnabled: true,
      fadeOutMs: 500
    });
    const gain = makeGain(0);
    scheduleEnvelope(gain.node, settings, 0, 4);
    const curve = gain.curve();
    expect(curve).not.toBeNull();
    if (!curve) {
      return;
    }

    expect(curve.curve.length).toBe(256);
    expect(curve.curve[0]).toBe(getEnvelopeValue(settings, 0, 4));
    expect(curve.curve[curve.curve.length - 1]).toBe(getEnvelopeValue(settings, 4, 4));
    // A pure fade-out must actually reach silence at the end. `index / POINTS` instead of
    // `index / (POINTS - 1)` leaves the last sample short of the end and this fails.
    expect(curve.curve[curve.curve.length - 1]).toBe(0);
  });

  test("every scheduled sample is finite and inside [0, 1]", () => {
    const settings = makeSettings({
      trimStartMs: 1500,
      fadeInEnabled: true,
      fadeInMs: 900,
      fadeOutEnabled: true,
      fadeOutMs: 1200
    });
    const gain = makeGain(0);
    scheduleEnvelope(gain.node, settings, 1.5, 9.5);
    const curve = gain.curve();
    expect(curve).not.toBeNull();
    for (const value of curve?.curve ?? []) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  test("a pure fade-in curve is non-decreasing and a pure fade-out curve is non-increasing", () => {
    const fadeIn = makeGain(0);
    scheduleEnvelope(fadeIn.node, makeSettings({ fadeInEnabled: true, fadeInMs: 2000 }), 0, 4);
    const rising = Array.from(fadeIn.curve()?.curve ?? []);
    for (let index = 1; index < rising.length; index += 1) {
      expect(rising[index] ?? 0).toBeGreaterThanOrEqual(rising[index - 1] ?? 0);
    }

    const fadeOut = makeGain(0);
    scheduleEnvelope(fadeOut.node, makeSettings({ fadeOutEnabled: true, fadeOutMs: 2000 }), 0, 4);
    const falling = Array.from(fadeOut.curve()?.curve ?? []);
    for (let index = 1; index < falling.length; index += 1) {
      expect(falling[index] ?? 0).toBeLessThanOrEqual(falling[index - 1] ?? 0);
    }
  });

  test("a fade covering at least an eighth of the window is sampled smoothly", () => {
    // setValueCurveAtTime interpolates linearly between samples, so the audible requirement is
    // that consecutive samples stay close. The analytic bound for a fade of length f over a
    // window r with N points is about pi*r/(2*f*(N-1)); at f >= r/8 and N = 256 that is ~0.05.
    const settings = makeSettings({ fadeOutEnabled: true, fadeOutMs: 1000 });
    const gain = makeGain(0);
    scheduleEnvelope(gain.node, settings, 0, 8);
    const curve = Array.from(gain.curve()?.curve ?? []);
    let maxStep = 0;
    for (let index = 1; index < curve.length; index += 1) {
      maxStep = Math.max(maxStep, Math.abs((curve[index] ?? 0) - (curve[index - 1] ?? 0)));
    }
    expect(maxStep).toBeLessThanOrEqual(0.05);
  });

  test("a fade much shorter than the window is not stretched across the sampling grid", () => {
      // 500 ms fade-out on a 240 s cue. At a fixed 256 points the sample spacing would be
      // 240/255 = 0.94 s, so the whole fade fell between the last two samples and was rendered
      // as a 0.94 s linear ramp starting ~0.44 s early. The point count now scales to the
      // shortest enabled fade.
      const settings = makeSettings({ fadeOutEnabled: true, fadeOutMs: 500 });
      const gain = makeGain(0);
      scheduleEnvelope(gain.node, settings, 0, 240);
      const curve = Array.from(gain.curve()?.curve ?? []);
      let maxStep = 0;
      for (let index = 1; index < curve.length; index += 1) {
        maxStep = Math.max(maxStep, Math.abs((curve[index] ?? 0) - (curve[index - 1] ?? 0)));
      }
      expect(maxStep).toBeLessThanOrEqual(0.2);
      expect(curve.length).toBeGreaterThan(256);
  });

  test("does not schedule a redundant event at the curve's own start time", () => {
    // The interval [startTime, startTime + duration] is start-inclusive, so an event at exactly
    // `now` made setValueCurveAtTime illegal by construction.
    const gain = makeGain(2.25);
    scheduleEnvelope(gain.node, makeSettings({ fadeInEnabled: true, fadeInMs: 500 }), 0, 4);
    const curve = gain.curve();
    expect(curve).not.toBeNull();
    expect(gain.calls.filter((call) => call.kind === "setValue")).toHaveLength(0);
  });

  test("survives an InvalidStateError from setValueCurveAtTime", () => {
    const gain = makeGain(0, { throwOnCurve: true });
    const scheduled = scheduleEnvelope(
      gain.node,
      makeSettings({ fadeInEnabled: true, fadeInMs: 500 }),
      0,
      4
    );
    expect(scheduled).toBe(false);
    const setValue = gain.calls.filter((call) => call.kind === "setValue");
    expect(setValue).toHaveLength(1);
    expect(setValue[0]?.kind === "setValue" ? setValue[0].value : null).toBe(
      getEnvelopeValue(makeSettings({ fadeInEnabled: true, fadeInMs: 500 }), 0, 4)
    );
  });

  test("reports whether a curve was actually scheduled", () => {
    const withCurve = makeGain(0);
    expect(scheduleEnvelope(withCurve.node, makeSettings(), 0, 4)).toBe(true);

    const withoutCurve = makeGain(0);
    expect(scheduleEnvelope(withoutCurve.node, makeSettings(), 0, 0.005)).toBe(false);
  });
});

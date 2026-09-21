import { expect, test } from "@playwright/test";

import {
  AppSettings,
  DEFAULT_SETTINGS,
  LABEL_SCALE_FACTORS,
  MAX_PCM_BUDGET_MB,
  MAX_WARMUP_BUDGET_SECONDS,
  MIN_PCM_BUDGET_MB,
  MIN_WARMUP_BUDGET_SECONDS,
  parseSettings,
  resetSection,
  resolveLabelScaleFactor,
  resolvePcmBudget,
  resolveWarmthDisplay,
  resolveWarmupConcurrency,
  settingsEqual
} from "../../src/shared/lib/appSettings";

/**
 * The settings record comes out of storage, so every test here is really about what happens when it
 * is NOT what this build expects — a record from another version, a hand-edited one, a truncated
 * one. The resolution rules get the same treatment: each of them stands between a saved value and
 * something that can silence a pad or fill memory.
 */

function withPerformance(patch: Partial<AppSettings["performance"]>): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    performance: { ...DEFAULT_SETTINGS.performance, ...patch }
  };
}

test("a record from an unknown version resets rather than merging", () => {
  const parsed = parseSettings({
    version: 2,
    performance: { warmupMode: "on-press" },
    visuals: { flatGraphics: true }
  });

  // Merging fields out of a record whose meaning is unknown is how a future build's "on-press"
  // would silently become this build's, with whatever different behaviour it carries.
  expect(parsed).toEqual(DEFAULT_SETTINGS);
});

test("garbage of every shape parses to the defaults", () => {
  for (const raw of [null, undefined, 0, "", [], { version: 1 }, { version: "1" }]) {
    expect(parseSettings(raw)).toEqual(DEFAULT_SETTINGS);
  }
});

test("unknown enum values fall back field by field, keeping the valid ones", () => {
  const parsed = parseSettings({
    version: 1,
    performance: { warmupMode: "turbo", partialDecode: "force", warmupConcurrency: 3 },
    visuals: { labelScale: "xxl", flatGraphics: true },
    diagnostics: { overlay: "yes" }
  });

  expect(parsed.performance.warmupMode).toBe("full");
  // `force` is reachable only as a query flag: as a saved setting it would disable the byte-range
  // verdict permanently.
  expect(parsed.performance.partialDecode).toBe("auto");
  expect(parsed.performance.warmupConcurrency).toBe(3);
  expect(parsed.visuals.labelScale).toBe("md");
  expect(parsed.visuals.flatGraphics).toBe(true);
  expect(parsed.diagnostics.overlay).toBe(false);
});

test("numbers are clamped into their range instead of being taken at face value", () => {
  const low = parseSettings({
    version: 1,
    performance: {
      pcmBudget: { mode: "mb", mb: -5 },
      warmupBudgetSeconds: 0,
      warmupConcurrency: 99
    }
  });

  expect(low.performance.pcmBudget).toEqual({ mode: "mb", mb: MIN_PCM_BUDGET_MB });
  expect(low.performance.warmupBudgetSeconds).toBe(MIN_WARMUP_BUDGET_SECONDS);
  expect(low.performance.warmupConcurrency).toBe(4);

  const high = parseSettings({
    version: 1,
    performance: { pcmBudget: { mode: "mb", mb: 1e9 }, warmupBudgetSeconds: 1e9 }
  });
  expect(high.performance.pcmBudget).toEqual({ mode: "mb", mb: MAX_PCM_BUDGET_MB });
  // The upper bound matters as much as the lower one: an unbounded warm-up budget makes
  // `time-budget` behave exactly like `full`, which is the mode the user chose to get away from.
  expect(high.performance.warmupBudgetSeconds).toBe(MAX_WARMUP_BUDGET_SECONDS);
});

test("a budget that says megabytes without a number falls to the floor, not the ceiling", () => {
  // The dangerous direction: a truncated or hand-edited record yielding a 16 GiB cap reads as
  // "unlimited" on every device, which is the one value the mobile default exists to prevent.
  for (const mb of [undefined, null, "512", Number.NaN]) {
    expect(parseSettings({ version: 1, performance: { pcmBudget: { mode: "mb", mb } } })
      .performance.pcmBudget).toEqual({ mode: "mb", mb: MIN_PCM_BUDGET_MB });
  }
});

test("a non-finite number is not a number", () => {
  const parsed = parseSettings({
    version: 1,
    performance: { warmupBudgetSeconds: Number.NaN, warmupConcurrency: Number.POSITIVE_INFINITY }
  });

  expect(parsed.performance.warmupBudgetSeconds).toBe(
    DEFAULT_SETTINGS.performance.warmupBudgetSeconds
  );
  expect(parsed.performance.warmupConcurrency).toBeNull();
});

test("the budget keeps 'say nothing' and 'ask for no cap' apart", () => {
  // At runtime `null` bytes already means unlimited, so a single nullable number cannot express
  // "leave it to the device" — which is exactly the pair `readBudgetOverride` had to grow.
  expect(resolvePcmBudget(DEFAULT_SETTINGS)).toEqual({ present: false, bytes: null });
  expect(resolvePcmBudget(withPerformance({ pcmBudget: { mode: "unlimited" } }))).toEqual({
    present: true,
    bytes: null
  });
  expect(resolvePcmBudget(withPerformance({ pcmBudget: { mode: "mb", mb: 256 } }))).toEqual({
    present: true,
    bytes: 256 * 1024 * 1024
  });
});

test("warm-up concurrency falls back to the device figure and overrides it when set", () => {
  expect(resolveWarmupConcurrency(DEFAULT_SETTINGS, 4)).toBe(4);
  expect(resolveWarmupConcurrency(withPerformance({ warmupConcurrency: 1 }), 4)).toBe(1);
});

test("auto warmth follows the warm-up mode, explicit warmth does not", () => {
  // The whole point: dim means "a moment longer" only while the warm-up is going to reach the cell.
  expect(resolveWarmthDisplay(DEFAULT_SETTINGS)).toBe("full");
  expect(resolveWarmthDisplay(withPerformance({ warmupMode: "on-press" }))).toBe("off");
  expect(resolveWarmthDisplay(withPerformance({ warmupMode: "heads-only" }))).toBe("off");
  expect(resolveWarmthDisplay(withPerformance({ warmupMode: "time-budget" }))).toBe("off");

  const explicit: AppSettings = {
    ...withPerformance({ warmupMode: "on-press" }),
    visuals: { ...DEFAULT_SETTINGS.visuals, warmthDisplay: "full" }
  };
  expect(resolveWarmthDisplay(explicit)).toBe("full");
});

test("the label scale is 1 at md and monotonic across the scale", () => {
  expect(resolveLabelScaleFactor(DEFAULT_SETTINGS)).toBe(1);
  const factors = [
    LABEL_SCALE_FACTORS.xs,
    LABEL_SCALE_FACTORS.sm,
    LABEL_SCALE_FACTORS.md,
    LABEL_SCALE_FACTORS.lg,
    LABEL_SCALE_FACTORS.xl
  ];
  for (let index = 1; index < factors.length; index += 1) {
    expect(factors[index] ?? 0).toBeGreaterThan(factors[index - 1] ?? 0);
  }
});

test("resetting one section leaves the others alone", () => {
  const edited: AppSettings = {
    ...withPerformance({ warmupMode: "on-press" }),
    visuals: { ...DEFAULT_SETTINGS.visuals, flatGraphics: true, labelScale: "xl" }
  };

  const reset = resetSection(edited, "visuals");
  expect(reset.visuals).toEqual(DEFAULT_SETTINGS.visuals);
  expect(reset.performance.warmupMode).toBe("on-press");
});

test("equality is by value, so applying an unchanged draft is a no-op", () => {
  expect(settingsEqual(DEFAULT_SETTINGS, parseSettings(DEFAULT_SETTINGS))).toBe(true);
  expect(settingsEqual(DEFAULT_SETTINGS, withPerformance({ warmupMode: "on-press" }))).toBe(false);
});

test("every budget shape round-trips through parsing unchanged", () => {
  // All three variants, because only `mb` used to be covered — and `unlimited` is the one a user
  // chooses deliberately AGAINST the device default, so silently reading it back as `auto` would
  // restore the very cap they turned off, on the one device where the two differ.
  for (const pcmBudget of [
    { mode: "auto" as const },
    { mode: "unlimited" as const },
    { mode: "mb" as const, mb: 700 }
  ]) {
    const once = parseSettings({
      version: 1,
      performance: { pcmBudget, warmupMode: "time-budget" },
      visuals: { labelScale: "lg", reduceMotion: true },
      diagnostics: { overlay: true }
    });

    expect(once.performance.pcmBudget).toEqual(pcmBudget);
    // Key order is what `serializeSettings` compares on, so a second pass must not reorder anything.
    expect(settingsEqual(once, parseSettings(once))).toBe(true);
  }
});

test("the defaults ask for nothing, so every device rule still decides", () => {
  // The whole compatibility claim of this feature in one assertion. A shipped default that said
  // anything at all would silently replace the device rules it sits in front of: the PCM budget
  // (no cap on a fine pointer, 1 GiB on a coarse one), the warm-up pool width (two on a phone,
  // cores-2 elsewhere) and the byte-range mode the query flag owns.
  expect(resolvePcmBudget(DEFAULT_SETTINGS)).toEqual({ present: false, bytes: null });
  expect(resolveWarmupConcurrency(DEFAULT_SETTINGS, 4)).toBe(4);
  expect(resolveWarmupConcurrency(DEFAULT_SETTINGS, 2)).toBe(2);
  expect(DEFAULT_SETTINGS.performance.partialDecode).toBe("auto");
  expect(DEFAULT_SETTINGS.performance.warmupMode).toBe("full");
  // And the visuals are the ones that shipped: full warm indication, motion on, scale exactly 1 —
  // a factor of anything else would change every cell label on every device.
  expect(resolveWarmthDisplay(DEFAULT_SETTINGS)).toBe("full");
  expect(resolveLabelScaleFactor(DEFAULT_SETTINGS)).toBe(1);
  expect(DEFAULT_SETTINGS.visuals.flatGraphics).toBe(false);
  expect(DEFAULT_SETTINGS.visuals.reduceMotion).toBe(false);
  expect(DEFAULT_SETTINGS.diagnostics.overlay).toBe(false);
});

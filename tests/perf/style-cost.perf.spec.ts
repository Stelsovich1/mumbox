import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { SIZES } from "../support/audioFixtures";
import { seedProject } from "../support/seedProject";
import type { GridSize } from "../support/seedProject";
import { expectWithinBaseline } from "./support/baseline";
import {
  cellMountMs,
  installPerfInstrumentation,
  perfGoto,
  readStyleProbe,
  resetStyleProbe,
  scriptMsByChunk,
  setCpuThrottling
} from "./support/instrument";

/**
 * What the style system costs, and whether it grows without bound.
 *
 * Two questions, and they need different arms:
 *
 *   (a) What fraction of a full-panel mount is style serialization and insertion? Measured under
 *       CPU throttling, because the committed baseline was recorded on a 32-core Xeon where
 *       `fpsDuring8Plays` never drops below 54 — a decision about a phone app taken at 1x there
 *       would be right for the wrong reason. Two rates, not one: the Emotion FRACTION should be
 *       roughly rate-invariant, so a fraction that moves a lot between 4x and 6x is a validity
 *       check failing, not a finding.
 *
 *   (b) How many CSS rules does a minute of playback insert, and is the count bounded? The
 *       progress marker interpolates `left: ${progress * 100}%` into `sx`, so every distinct
 *       progress value serializes to a distinct rule and Emotion inserts it. Emotion never removes
 *       what it inserts. The `loop` arm is the control: in that mode the dot moves through SVG
 *       `cx`/`cy` attributes and inserts nothing, so if `once` grows while `loop` stays flat the
 *       growth is attributable to that one interpolation and not to "playing" in general.
 *
 * The rate lives in the SCENARIO KEY, never in a metric name. With it in the key a rate change adds
 * a baseline entry; in a metric name it would silently redefine a recorded value.
 *
 * Every timing here is `record`. These are the quantities being learned, and gating a number before
 * its spread is known is how a gate becomes noise — the same reasoning already written down for
 * `fpsDuring8Plays` in `grid-scale.perf.spec.ts`. The one exception is the rule-growth ceiling,
 * which is not a performance ratio but a correctness-shaped bound.
 */

const MOUNT_SETTLE_MS = 1500;
const PLAYBACK_SAMPLE_MS = 20_000;
const PLAYING_CELLS = 6;

type MountScenario = { id: string; gridSize: GridSize; cells: number; rate: number };

const MOUNT_SCENARIOS: MountScenario[] = [
  { id: "style-mount-grid144@1x", gridSize: 12, cells: 144, rate: 1 },
  { id: "style-mount-grid144@4x", gridSize: 12, cells: 144, rate: 4 },
  { id: "style-mount-grid144@6x", gridSize: 12, cells: 144, rate: 6 },
  // Not optional. A single 144-cell number has no denominator; the per-cell cost is
  // `(mount144 - mount36) / 108`, and that is the only form in which the A2 arithmetic can be done.
  { id: "style-mount-grid36@4x", gridSize: 6, cells: 36, rate: 4 }
];

for (const scenario of MOUNT_SCENARIOS) {
  test(`style: ${scenario.id}`, async ({ page }) => {
    await installPerfInstrumentation(page);
    await seedProject(page, {
      panels: 1,
      gridSize: scenario.gridSize,
      distinctMedia: 12,
      spec: SIZES.small,
      filledCellsPerPanel: scenario.cells
    });
    if (scenario.rate > 1) {
      await setCpuThrottling(page, scenario.rate);
    }

    await perfGoto(page, "/");
    // Generous on purpose: the layout is read from IndexedDB before the grid can render, and this
    // scenario runs the whole boot under a 6x CPU throttle, where the default 5 s expires while the
    // app is still legitimately starting.
    await expect(page.locator("[data-cell-id]")).toHaveCount(scenario.cells, { timeout: 60_000 });
    // Let the frame that laid the grid out finish reporting; LoAF entries arrive after the frame.
    await page.waitForTimeout(MOUNT_SETTLE_MS);

    const probe = await readStyleProbe(page);
    const chunks = scriptMsByChunk(probe);
    const mountMs = cellMountMs(probe, scenario.cells);

    // The grid is the only thing that produces this count, so a null here means the probe missed
    // the commit — a broken measurement, not a fast one.
    expect(mountMs).not.toBeNull();
    // Without LoAF there is no attribution at all and the whole scenario is decoration.
    expect(probe.loaf.supported).toBe(true);
    // Content-hashed chunk names: if this fails the grouping silently stopped attributing.
    expect(chunks.matched).toBe(true);

    expectWithinBaseline(scenario.id, {
      gridMountMs: { value: Math.round(mountMs ?? 0), unit: "ms", gate: "record" },
      emotionInsertRuleCalls: { value: probe.emotionInsertRuleCalls, unit: "count", gate: "record" },
      emotionInsertRuleMs: {
        value: Math.round(probe.emotionInsertRuleMs * 100) / 100,
        unit: "ms",
        gate: "record"
      },
      emotionRuleCount: { value: probe.emotionRuleCount, unit: "count", gate: "record" },
      loafBlockingMs: { value: Math.round(probe.loaf.blockingMs), unit: "ms", gate: "record" },
      styleAndLayoutMs: {
        value: Math.round(probe.loaf.styleAndLayoutMs),
        unit: "ms",
        gate: "record"
      },
      muiChunkScriptMs: { value: Math.round(chunks.muiMs), unit: "ms", gate: "record" },
      appChunkScriptMs: { value: Math.round(chunks.appMs), unit: "ms", gate: "record" },
      longTaskCount: { value: probe.longTasks.count, unit: "count", gate: "record" },
      longTaskMs: { value: Math.round(probe.longTasks.totalMs), unit: "ms", gate: "record" }
    });
  });
}

async function playCells(page: Page, cellIds: readonly string[]) {
  await page.evaluate((ids) => {
    for (const id of ids) {
      document.querySelector<HTMLElement>(`[data-cell-id="${id}"]`)?.click();
    }
  }, [...cellIds]);
  await expect(page.locator('[data-playing="true"]')).toHaveCount(cellIds.length);
}

/**
 * Both playback arms run at 1x deliberately. Throttling reduces the number of rAF ticks and
 * therefore the number of progress pushes, which would depress the very quantity being counted.
 * This is a counting experiment, not a timing one.
 */
for (const mode of ["once", "loop"] as const) {
  test(`style: style-playback-${mode}-6cells@1x`, async ({ page }) => {
    test.setTimeout(180_000);
    await installPerfInstrumentation(page);
    const seed = await seedProject(page, {
      panels: 1,
      gridSize: 6,
      distinctMedia: 6,
      // 30 s of audio so a 20 s sample never reaches the end of a `once` cue.
      spec: SIZES.medium,
      filledCellsPerPanel: PLAYING_CELLS,
      cellPatch: () => ({ playbackMode: mode })
    });

    await perfGoto(page, "/");
    await expect(page.locator('[data-warm-state="ready"]')).toHaveCount(PLAYING_CELLS, {
      timeout: 120_000
    });

    const cellIds = (seed.filledCellIdsByPanel[seed.panelIds[0] ?? ""] ?? []).slice(
      0,
      PLAYING_CELLS
    );
    await playCells(page, cellIds);

    // Reset AFTER the presses so mount and warm-up insertions are excluded: what is wanted is the
    // marginal cost of playing, not the cost of getting there.
    await resetStyleProbe(page);
    const before = (await readStyleProbe(page)).emotionRuleCount;
    await page.waitForTimeout(PLAYBACK_SAMPLE_MS);
    const probe = await readStyleProbe(page);

    expect(probe.emotionDistinctRulesCapped).toBe(false);
    const grownRules = probe.emotionRuleCount - before;
    const perMinute = Math.round((grownRules * 60_000) / PLAYBACK_SAMPLE_MS);

    expectWithinBaseline(`style-playback-${mode}-6cells@1x`, {
      /**
       * A `hard` ceiling, and the only gate in this file. Unbounded insertion is a defect of the
       * shape "correctness", not a ratio: nothing ever removes these rules, so the count is a
       * per-session leak. `hard` is also the only kind enforced with no baseline and on a machine
       * whose CPU does not match the recorded one.
       *
       * The arithmetic: 20 Hz of progress pushes x 6 playing cells x 60 s is ~7 200 rules a minute
       * when the interpolation is present, and ~0 when it is not. A ceiling of 60 clears the fixed
       * case by two orders of magnitude and fails the broken one by two.
       */
      emotionRulesPerMinutePlaying: {
        value: perMinute,
        unit: "count/min",
        gate: "hard",
        ceiling: 60
      },
      emotionRuleCountAfterPlayback: {
        value: probe.emotionRuleCount,
        unit: "count",
        gate: "soft",
        absFloor: 200
      },
      emotionInsertRuleCallsDuringPlayback: {
        value: probe.emotionInsertRuleCalls,
        unit: "count",
        gate: "record"
      },
      emotionInsertRuleMsDuringPlayback: {
        value: Math.round(probe.emotionInsertRuleMs * 100) / 100,
        unit: "ms",
        gate: "record"
      },
      loafBlockingMsDuringPlayback: {
        value: Math.round(probe.loaf.blockingMs),
        unit: "ms",
        gate: "record"
      },
      longTaskMsDuringPlayback: {
        value: Math.round(probe.longTasks.totalMs),
        unit: "ms",
        gate: "record"
      }
    });
  });
}

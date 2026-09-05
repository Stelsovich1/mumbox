import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { diagSnapshot } from "../support/diag";
import { seedProject } from "../support/seedProject";
import { expectWithinBaseline, median } from "./support/baseline";
import { installPerfInstrumentation } from "./support/instrument";

/**
 * The hard gate. Instant start with no artifact at the beginning of playback is the constraint
 * the whole memory change had to preserve, so this runs first and its ceilings are absolute.
 *
 * The trigger is dispatched inside the page, so no CDP round trip lands inside the measurement:
 * the number comes from the app's own `playCell` entry-to-`source.start` timing.
 */

const SPEC = { seconds: 8, channels: 2, freqHz: 220 } as const;
const SAMPLES = 6;
/** Under the point where a pad starts to feel sluggish. */
const WARM_CEILING_MS = 20;
/** Around the point where a triggered sound stops feeling like a consequence of the press. */
const COLD_CEILING_MS = 120;
/** One-time AudioContext construction and resume on the first trigger of a session. */
const FIRST_TAP_CEILING_MS = 150;

async function tapCell(page: Page, cellId: string) {
  await page.evaluate((id) => {
    document.querySelector<HTMLElement>(`[data-cell-id="${id}"]`)?.click();
  }, cellId);
}

async function readTimings(page: Page) {
  const snapshot = await diagSnapshot(page);
  return snapshot?.timeToFirstSoundMs ?? [];
}

test("time to first sound stays inside its ceilings", async ({ page }) => {
  await installPerfInstrumentation(page);
  const seed = await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: SAMPLES,
    spec: SPEC,
    filledCellsPerPanel: SAMPLES
  });
  await page.goto("/");
  await expect(page.locator('[data-warm-state="ready"]')).toHaveCount(SAMPLES, {
    timeout: 60_000
  });

  const cellIds = seed.filledCellIdsByPanel[seed.panelIds[0] ?? ""] ?? [];
  for (const cellId of cellIds) {
    await tapCell(page, cellId);
    await expect(page.locator(`[data-cell-id="${cellId}"]`)).toHaveAttribute(
      "data-playing",
      "true"
    );
    await tapCell(page, cellId);
    await expect(page.locator(`[data-cell-id="${cellId}"]`)).toHaveAttribute(
      "data-playing",
      "false"
    );
  }

  const warm = await readTimings(page);
  expect(warm.length).toBeGreaterThanOrEqual(SAMPLES);

  // The very first trigger of a session constructs and resumes the AudioContext, which costs tens
  // of milliseconds no matter how warm the buffer is. Gating it together with the rest would
  // either hide a real regression behind a loose ceiling or fail on an unavoidable one-time cost,
  // so it gets its own, looser ceiling and the steady-state taps keep the tight one.
  const [firstTap, ...steadyState] = warm;

  expectWithinBaseline("first-sound-warm", {
    timeToFirstSoundFirstTapMs: {
      value: firstTap ?? 0,
      unit: "ms",
      gate: "hard",
      ceiling: FIRST_TAP_CEILING_MS
    },
    // Gated on the worst sample, not the median: a one-in-six 200 ms start is exactly the failure
    // the constraint is about.
    timeToFirstSoundWarmMaxMs: {
      value: Math.max(...steadyState),
      unit: "ms",
      gate: "hard",
      ceiling: WARM_CEILING_MS
    },
    timeToFirstSoundWarmMedianMs: {
      value: median(steadyState),
      unit: "ms",
      gate: "soft",
      absFloor: 3
    }
  });
});

test("a cold trigger still starts within the cold ceiling", async ({ page }) => {
  await installPerfInstrumentation(page);
  const seed = await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: SAMPLES,
    spec: SPEC,
    filledCellsPerPanel: SAMPLES
  });
  // A budget this small makes the warm-up skip every media, so each tap pays a full decode —
  // a deterministic cold path rather than a race against the warm-up.
  await page.goto("/?pcmBudgetMb=0.0001");

  const cellIds = seed.filledCellIdsByPanel[seed.panelIds[0] ?? ""] ?? [];
  for (const cellId of cellIds) {
    await tapCell(page, cellId);
    await expect(page.locator(`[data-cell-id="${cellId}"]`)).toHaveAttribute(
      "data-playing",
      "true",
      { timeout: 20_000 }
    );
    await tapCell(page, cellId);
  }

  const cold = await readTimings(page);
  expect(cold.length).toBeGreaterThanOrEqual(SAMPLES);

  expectWithinBaseline("first-sound-cold", {
    timeToFirstSoundColdMaxMs: {
      value: Math.max(...cold),
      unit: "ms",
      gate: "hard",
      ceiling: COLD_CEILING_MS
    },
    timeToFirstSoundColdMedianMs: {
      value: median(cold),
      unit: "ms",
      gate: "soft",
      absFloor: 10
    }
  });
});

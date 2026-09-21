import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { diagSnapshot } from "../support/diag";
import { seedAppSettings, seedProject } from "../support/seedProject";
import { SIZES } from "../support/audioFixtures";
import { expectWithinBaseline } from "./support/baseline";
import {
  installPerfInstrumentation,
  perfGoto,
  sampleFrames,
  setCpuThrottling
} from "./support/instrument";

/**
 * What the cell state visuals cost, and therefore what «упрощённая графика» buys.
 *
 * The claim this pins is counter-intuitive enough to need a number in the repository rather than in
 * a commit message: on a large grid and a slow processor, the animations and transitions that show
 * a cell going from cold to ready cost MORE of the warm-up's wall clock than decoding does. The
 * decode work is identical in both arms — same fixtures, same count — so the difference is paint
 * and style, nothing else.
 *
 * The setting is SEEDED rather than set as an attribute from an init script, and the first version
 * of this spec got that wrong: the boot gate applies the stored settings, and the default record
 * removes the very attribute the script had set — so the "flat" arm measured the default one and
 * came out 8 % apart instead of three-fold. A visual setting can only be measured through the
 * record that survives boot.
 *
 * Throttled 6x because the effect is invisible on a desktop with headroom, which is precisely the
 * machine this setting does not exist for. Gates are `record`: the ratio is the point, and an
 * absolute ceiling recorded on one machine is how a perf tier becomes the thing everyone ignores.
 */

const THROTTLE_RATE = 6;
const FILLED_CELLS = 144;

async function warmAndSample(page: Page) {
  const startedAt = Date.now();
  // Frames are sampled WHILE the warm-up runs: that is the window where the state animations are
  // on, and the window a user describes as the app going sticky.
  const frames = sampleFrames(page, 4000);
  await expect
    .poll(async () => (await diagSnapshot(page))?.lastWarmupMs ?? null, { timeout: 300_000 })
    .not.toBeNull();
  const wallMs = Date.now() - startedAt;
  return { wallMs, frames: await frames, snapshot: await diagSnapshot(page) };
}

for (const arm of [
  { id: "visuals-default-grid144@6x", flat: false },
  { id: "visuals-flat-grid144@6x", flat: true }
]) {
  test(`visuals: ${arm.id}`, async ({ page }) => {
    test.setTimeout(300_000);
    await installPerfInstrumentation(page);
    await seedProject(page, {
      panels: 1,
      gridSize: 12,
      distinctMedia: 24,
      spec: SIZES.small,
      filledCellsPerPanel: FILLED_CELLS
    });
    if (arm.flat) {
      await seedAppSettings(page, {
        version: 1,
        visuals: { flatGraphics: true, warmthDisplay: "auto", reduceMotion: false, labelScale: "md" }
      });
    }
    await setCpuThrottling(page, THROTTLE_RATE);

    await perfGoto(page, "/");
    // A generous timeout, not the default five seconds: 144 cells mounting under a 6x CPU throttle
    // is exactly the work this spec exists to measure, so the boot itself is slow by construction.
    await expect(page.locator("[data-cell-id]")).toHaveCount(FILLED_CELLS, { timeout: 60_000 });

    const { wallMs, frames, snapshot } = await warmAndSample(page);

    expectWithinBaseline(arm.id, {
      // Exact, like the other decode counts: this is a fact about the code, and it is also what
      // makes the pair comparable at all — a different number of decodes would mean the two arms
      // measured different work.
      fullDecodeCount: { value: snapshot?.decodeCount ?? -1, unit: "count", gate: "exact" },
      warmupTotalMs: { value: Math.round(snapshot?.lastWarmupMs ?? -1), unit: "ms", gate: "record" },
      warmupWallMs: { value: wallMs, unit: "ms", gate: "record" },
      fps: { value: Math.round(frames.fps * 10) / 10, unit: "fps", gate: "record" },
      p95FrameMs: { value: Math.round(frames.p95IntervalMs), unit: "ms", gate: "record" }
    });

    await setCpuThrottling(page, 1);
  });
}

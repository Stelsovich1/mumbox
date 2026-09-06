import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { diagDecodeCount, diagPcmBytes, diagPcmBytesForActivePanel, diagSnapshot } from "../support/diag";
import { seedProject } from "../support/seedProject";
import type { GridSize, SeedResult } from "../support/seedProject";
import { SIZES } from "../support/audioFixtures";
import type { WavSpec } from "../support/audioFixtures";
import { expectWithinBaseline, median } from "./support/baseline";
import { installPerfInstrumentation, readJsHeapBytes, readPerfProbe, sampleFrames } from "./support/instrument";

/**
 * Grid-scale matrix.
 *
 * The full cross product is not runnable — 144 distinct large media is 8.7 GB of decoded PCM and
 * would OOM rather than produce a number. Instead a scenario seeds K distinct blobs and assigns
 * them round-robin, which is both how a soundboard is actually used and what exercises the
 * warm-up's media dedupe. One scenario deliberately uses 144 distinct small media to measure the
 * no-dedupe worst case honestly.
 */

type Scenario = {
  id: string;
  gridSize: GridSize;
  filledCells: number;
  distinctMedia: number;
  spec: WavSpec;
  panels: number;
  full?: boolean;
};

const SMOKE: Scenario[] = [
  { id: "grid12-small-1panel", gridSize: 6, filledCells: 12, distinctMedia: 12, spec: SIZES.small, panels: 1 },
  { id: "grid36-small-1panel", gridSize: 6, filledCells: 36, distinctMedia: 12, spec: SIZES.small, panels: 1 },
  { id: "grid144-small-distinct-1panel", gridSize: 12, filledCells: 144, distinctMedia: 144, spec: SIZES.small, panels: 1 },
  { id: "grid100-medium-1panel", gridSize: 10, filledCells: 100, distinctMedia: 12, spec: SIZES.medium, panels: 1 },
  { id: "grid36-medium-5panels", gridSize: 6, filledCells: 36, distinctMedia: 12, spec: SIZES.medium, panels: 5 }
];

const FULL: Scenario[] = [
  { id: "grid144-small-1panel", gridSize: 12, filledCells: 144, distinctMedia: 12, spec: SIZES.small, panels: 1, full: true },
  { id: "grid144-medium-5panels", gridSize: 12, filledCells: 144, distinctMedia: 12, spec: SIZES.medium, panels: 5, full: true }
];

const scenarios = process.env.PERF_FULL === "1" ? [...SMOKE, ...FULL] : SMOKE;

async function waitForWarmupToSettle(page: Page, expectedMedia: number) {
  await expect
    .poll(async () => diagDecodeCount(page), { timeout: 240_000 })
    .toBeGreaterThanOrEqual(Math.min(expectedMedia, 1));
  // The warm-up total is recorded after the final inter-decode gap.
  await expect.poll(async () => (await diagSnapshot(page))?.lastWarmupMs ?? null, {
    timeout: 240_000
  }).not.toBeNull();
}

async function measurePanelSwitch(page: Page, seed: SeedResult, index: number) {
  const startedAt = Date.now();
  await page.getByRole("tab", { name: `Panel ${String(index + 1)}` }).click();
  // Tight polling on purpose. At the default cadence this number is quantized to ~100 ms steps,
  // so it reports which polling tick happened to catch the value rather than how long the switch
  // took — the engine records 0.1 ms and the paint 8-15 ms behind a wall clock reading 180-260.
  // A moved poll boundary then looks exactly like a regression.
  await expect
    .poll(async () => (await diagSnapshot(page))?.lastPanelSwitchPaintMs ?? null, {
      timeout: 30_000,
      intervals: [5, 5, 10, 10, 25, 50]
    })
    .not.toBeNull();
  void seed;
  return Date.now() - startedAt;
}

for (const scenario of scenarios) {
  test(`scale: ${scenario.id}`, async ({ page }) => {
    await installPerfInstrumentation(page);
    const seed = await seedProject(page, {
      panels: scenario.panels,
      gridSize: scenario.gridSize,
      distinctMedia: scenario.distinctMedia,
      spec: scenario.spec,
      filledCellsPerPanel: scenario.filledCells
    });

    const loadStartedAt = Date.now();
    await page.goto("/");
    await expect(page.locator("[data-cell-id]")).toHaveCount(
      scenario.gridSize * scenario.gridSize
    );
    const firstPaintMs = Date.now() - loadStartedAt;

    await waitForWarmupToSettle(page, scenario.distinctMedia);
    const snapshot = await diagSnapshot(page);
    const probe = await readPerfProbe(page);

    const decodeMsPerMb = probe.decodes
      .filter((sample) => sample.settledAt !== null && sample.inputBytes > 0)
      .map((sample) => ((sample.settledAt ?? 0) - sample.startedAt) / (sample.inputBytes / 1e6));

    let panelSwitchFirstMs = 0;
    let panelSwitchRepeatMs = 0;
    if (scenario.panels > 1) {
      panelSwitchFirstMs = await measurePanelSwitch(page, seed, 1);
      await measurePanelSwitch(page, seed, 0);
      panelSwitchRepeatMs = await measurePanelSwitch(page, seed, 1);
    }

    // Eight simultaneous cells is the realistic worst case for the progress loop.
    const playable = (seed.filledCellIdsByPanel[seed.panelIds[0] ?? ""] ?? []).slice(0, 8);
    if (scenario.panels > 1) {
      await page.getByRole("tab", { name: "Panel 1" }).click();
    }
    await page.evaluate((ids) => {
      for (const id of ids) {
        document.querySelector<HTMLElement>(`[data-cell-id="${id}"]`)?.click();
      }
    }, playable);
    const frames = await sampleFrames(page, 3000);

    const heapBytes = await readJsHeapBytes(page);
    const activePanelBytes = await diagPcmBytesForActivePanel(page);
    const totalBytes = await diagPcmBytes(page);

    expectWithinBaseline(scenario.id, {
      // Exact, not soft. These are deterministic — the WAV fixtures decode without resampling —
      // so they are really correctness assertions that happen to live in the perf tier. It also
      // matters that they are the gate kind that still enforces on a machine whose CPU does not
      // match the recorded baseline; every soft gate degrades to a warning there, which would
      // otherwise leave this whole scenario matrix with nothing that can fail.
      cachedPcmBytesTotal: { value: totalBytes, unit: "bytes", gate: "exact" },
      cachedPcmBytesActive: { value: activePanelBytes, unit: "bytes", gate: "exact" },
      warmupSkippedCount: { value: snapshot?.lastWarmupSkipped ?? 0, unit: "count", gate: "exact" },
      // Wall clock of a bounded decode pool, so its spread is scheduler-bound — measured at about
      // 45 % run to run once the fixed inter-decode pause was removed. The ratio is set from that
      // spread rather than the default, so a real regression (a return to serial decoding is 3-6x)
      // still fails while ordinary scheduling noise does not.
      warmupTotalMs: {
        value: snapshot?.lastWarmupMs ?? 0,
        unit: "ms",
        gate: "soft",
        ratio: 2,
        absFloor: 250
      },
      // Recorded, not gated: one sample of a near-free WAV decode is dominated by scheduling.
      decodeMsPerMb: { value: median(decodeMsPerMb), unit: "ms/MB", gate: "record" },
      firstPaintMs: { value: firstPaintMs, unit: "ms", gate: "record" },
      panelSwitchFirstMs: { value: panelSwitchFirstMs, unit: "ms", gate: "soft", absFloor: 25 },
      panelSwitchRepeatMs: { value: panelSwitchRepeatMs, unit: "ms", gate: "soft", absFloor: 25 },
      // Recorded, not gated, for the same reason as decode throughput: one 3-second rAF sample on
      // a shared machine is scheduler-bound, and the frame interval is quantised to the refresh
      // period, so it steps 17 -> 33 ms in one go. A ratio gate on a quantised single sample flaps
      // by construction. Frame health is worth watching; gating it honestly would need many
      // samples, which this harness does not take.
      fpsDuring8Plays: { value: Math.round(frames.fps), unit: "fps", gate: "record" },
      frameIntervalP95Ms: { value: Math.round(frames.p95IntervalMs), unit: "ms", gate: "record" },
      jsHeapBytes: { value: heapBytes ?? 0, unit: "bytes", gate: "record" }
    });
  });
}

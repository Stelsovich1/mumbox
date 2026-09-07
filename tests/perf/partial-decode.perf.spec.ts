import { test } from "@playwright/test";

import { diagPartial, diagPcmBytes } from "../support/diag";
import { seedProject } from "../support/seedProject";
import { expectWithinBaseline } from "./support/baseline";
import { DecodeSample, installPerfInstrumentation, readPerfProbe } from "./support/instrument";

/**
 * The byte-range path against the real decoder.
 *
 * Three numbers were being conflated before this file existed, so they are reported separately:
 *
 * - **max single decode output** — how much PCM one `decodeAudioData` produced. This is what
 *   collapses for a trimmed window, and it is the transient that gets a mobile tab killed.
 * - **resident PCM for a warm panel** — what a warm cell costs. This is what collapses for a whole
 *   untrimmed track, from the entire track to a head.
 * - **peak concurrent decode bytes** — bounded by the shared semaphore. For an untrimmed streamed
 *   cell it is NOT expected to drop: head plus segments sum to the same PCM as one full decode, and
 *   pretending otherwise would be dishonest. It is gated `record` for exactly that reason.
 *
 * Every metric here is `exact` where it is machine-independent, because those are correctness
 * assertions that happen to live in the perf tier — the same reasoning `baseline.ts` already
 * applies to the cached-byte gates.
 */

const RATE = 44_100;
const HEAD_PLUS_MARGIN_SECONDS = 0.5 + 0.06;

async function waitForWarm(page: import("@playwright/test").Page, count: number) {
  await test
    .expect(page.locator('[data-warm-state="ready"]'))
    .toHaveCount(count, { timeout: 120_000 });
}

test("a trimmed window of a long media never decodes the whole file", async ({ page }) => {
  await installPerfInstrumentation(page);
  await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 12,
    spec: { seconds: 180, channels: 2, freqHz: 220 },
    filledCellsPerPanel: 12,
    trimStartMs: 0,
    trimEndMs: 5000
  });
  await page.goto("/");
  await waitForWarm(page, 12);

  const probe = await readPerfProbe(page);
  const maxSingleDecodeOutput = Math.max(
    0,
    ...probe.decodes.filter((entry) => entry.settledAt !== null).map((entry) => entry.outputBytes)
  );
  const partial = await diagPartial(page);

  expectWithinBaseline("partial-trimmed-12x180s", {
    // Twelve 5 s windows out of twelve 180 s files. Byte-for-byte what the full-decode path also
    // ended up caching — the win is in what was never decoded, not in what was kept.
    cachedPcmBytesTotal: {
      value: await diagPcmBytes(page),
      unit: "bytes",
      gate: "exact"
    },
    // The number the feature exists for: one 180 s stereo decode is 63 504 000 bytes, and no
    // decode of that size happens at all any more.
    maxSingleDecodeOutputBytes: {
      value: maxSingleDecodeOutput,
      unit: "bytes",
      gate: "exact"
    },
    fullDecodeCount: {
      value: probe.decodes.filter((entry) => entry.settledAt !== null).length,
      unit: "count",
      gate: "exact"
    },
    rangeReadBytes: {
      value: partial?.rangeReads.bytes ?? -1,
      unit: "bytes",
      gate: "soft",
      ratio: 1.1,
      absFloor: 1024 * 1024
    },
    warmupTotalMs: {
      value: await page.evaluate(() => window.__mumboxDiag?.lastWarmupMs() ?? -1),
      unit: "ms",
      gate: "soft",
      ratio: 2,
      absFloor: 250
    }
  });
});

test("a panel of whole long tracks warms to heads, not to tracks", async ({ page }) => {
  await installPerfInstrumentation(page);
  await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 12,
    spec: { seconds: 180, channels: 2, freqHz: 220 },
    filledCellsPerPanel: 12
  });
  await page.goto("/");
  await waitForWarm(page, 12);

  const probe = await readPerfProbe(page);
  const partial = await diagPartial(page);

  expectWithinBaseline("partial-streamed-12x180s", {
    // 12 x 180 s stereo would be 762 048 000 bytes resident — three quarters of a gigabyte, which
    // is why this panel could not be warmed at all before. Now it is twelve heads.
    cachedPcmBytesTotal: {
      value: await diagPcmBytes(page),
      unit: "bytes",
      gate: "exact"
    },
    headBytesPerCell: {
      value: Math.ceil(HEAD_PLUS_MARGIN_SECONDS * RATE) * 2 * 4,
      unit: "bytes",
      gate: "exact"
    },
    fullDecodeCount: {
      value: probe.decodes.filter((entry) => entry.settledAt !== null).length,
      unit: "count",
      gate: "exact"
    },
    streamedServed: {
      value: partial?.served.streamed ?? -1,
      unit: "count",
      gate: "exact"
    },
    // Not expected to fall for an untrimmed cell, and gated `record` so a flat number does not read
    // as a failure. What falls here is residency, not the concurrent transient.
    peakConcurrentDecodeBytes: {
      value: getPeakConcurrentBytes(probe.decodes),
      unit: "bytes",
      gate: "record"
    },
    segmentsMissed: {
      value: partial?.segments.missed ?? -1,
      unit: "count",
      gate: "exact"
    }
  });
});

test("the same panel with the partial path off records the pre-change numbers", async ({
  page
}) => {
  // The control. Its only job is to keep the pre-change figures in the same committed baseline, so
  // the improvement is auditable from one file instead of from a commit message.
  await installPerfInstrumentation(page);
  await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 12,
    spec: { seconds: 180, channels: 2, freqHz: 220 },
    filledCellsPerPanel: 12
  });
  await page.goto("/?partial=0");
  await waitForWarm(page, 12);

  const probe = await readPerfProbe(page);

  expectWithinBaseline("partial-off-12x180s", {
    cachedPcmBytesTotal: {
      value: await diagPcmBytes(page),
      unit: "bytes",
      gate: "exact"
    },
    maxSingleDecodeOutputBytes: {
      value: Math.max(
        0,
        ...probe.decodes.filter((entry) => entry.settledAt !== null).map((entry) => entry.outputBytes)
      ),
      unit: "bytes",
      gate: "record"
    },
    fullDecodeCount: {
      value: probe.decodes.filter((entry) => entry.settledAt !== null).length,
      unit: "count",
      gate: "exact"
    }
  });
});

test("a streamed cell answers a press as fast as a fully decoded one", async ({ page }) => {
  // The constraint the whole memory change had to preserve. A streamed route pays one render
  // quantum of scheduling lead that a classic route does not, so the claim "the response did not
  // regress" needs its own measurement rather than an argument.
  await installPerfInstrumentation(page);
  const seed = await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 6,
    spec: { seconds: 60, channels: 2, freqHz: 220 },
    filledCellsPerPanel: 6
  });
  await page.goto("/");
  await waitForWarm(page, 6);

  const panelId = seed.panelIds[0] ?? "";
  const cellIds = seed.filledCellIdsByPanel[panelId] ?? [];
  for (const cellId of cellIds) {
    await page.evaluate((id) => {
      document.querySelector<HTMLElement>(`[data-cell-id="${id}"]`)?.click();
    }, cellId);
    await page.waitForTimeout(120);
  }

  const timings = await page
    .evaluate(() => window.__mumboxDiag?.snapshot())
    .then((snapshot) => snapshot?.timeToFirstSoundMs ?? []);
  const warmTimings = timings.slice(1);
  const sorted = [...warmTimings].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? -1;

  expectWithinBaseline("partial-streamed-first-sound", {
    // The same absolute ceiling the classic path is held to. A streamed head is in the cache, so
    // the synchronous fast path in `playCell` applies to it exactly as it does to a full buffer.
    timeToFirstSoundWarmMaxMs: {
      value: Math.max(...warmTimings),
      unit: "ms",
      gate: "hard",
      ceiling: 20
    },
    timeToFirstSoundWarmMedianMs: {
      value: median,
      unit: "ms",
      gate: "soft",
      ratio: 2,
      absFloor: 5
    }
  });
});

test("144 cells of long tracks warm without decoding any of them whole", async ({ page }) => {
  // The shape that used to kill the tab: a full grid pointing at long media. 24 distinct 60 s
  // stereo tracks would be 24 x 21 168 000 = 508 032 000 bytes resident under the full-decode
  // path, before counting the transient of each decode.
  await installPerfInstrumentation(page);
  await seedProject(page, {
    panels: 1,
    gridSize: 12,
    distinctMedia: 24,
    spec: { seconds: 60, channels: 2, freqHz: 220 },
    filledCellsPerPanel: 144
  });
  await page.goto("/");
  await waitForWarm(page, 144);

  const probe = await readPerfProbe(page);
  const partial = await diagPartial(page);

  expectWithinBaseline("partial-144cells-long", {
    cachedPcmBytesTotal: {
      value: await diagPcmBytes(page),
      unit: "bytes",
      gate: "exact"
    },
    fullDecodeCount: {
      value: probe.decodes.filter((entry) => entry.settledAt !== null).length,
      unit: "count",
      gate: "exact"
    },
    streamedServed: {
      value: partial?.served.streamed ?? -1,
      unit: "count",
      gate: "exact"
    },
    warmupTotalMs: {
      value: await page.evaluate(() => window.__mumboxDiag?.lastWarmupMs() ?? -1),
      unit: "ms",
      gate: "soft",
      ratio: 2,
      absFloor: 500
    }
  });
});

/**
 * Peak simultaneous decode output, swept over the decode timeline the same way
 * `playback-memory.spec.ts` sweeps concurrency.
 */
function getPeakConcurrentBytes(
  decodes: DecodeSample[]
): number {
  const events: { at: number; delta: number }[] = [];
  for (const entry of decodes) {
    if (entry.settledAt === null) {
      continue;
    }
    events.push({ at: entry.startedAt, delta: entry.outputBytes });
    events.push({ at: entry.settledAt, delta: -entry.outputBytes });
  }
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);

  let current = 0;
  let peak = 0;
  for (const event of events) {
    current += event.delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

import { expect, test } from "@playwright/test";

import { advanceAudioClock, installBufferAudioMock, readProbe } from "../support/audioMock";
import {
  diagCacheKeys,
  diagClearCaches,
  diagDecodeCount,
  diagPartial,
  diagPcmBytes,
  diagSetPartialDecode
} from "../support/diag";
import { seedProject } from "../support/seedProject";

/**
 * The byte-range decode path.
 *
 * What separates it from the full-decode path in an observable way is the DECODE COUNT, not the
 * byte total: a trimmed window ends up the same size either way, but the full path reaches it by
 * decoding the whole file and slicing, while the range path never decodes the rest at all. So
 * `decodeCount` is the assertion that distinguishes them — `recordDecode` is only called from the
 * full-decode path.
 */

const RATE = 44_100;

async function waitForWarm(page: import("@playwright/test").Page, count: number) {
  await expect(page.locator('[data-warm-state="ready"]')).toHaveCount(count, { timeout: 30_000 });
}

test("a trimmed window of a long media is read as a byte range, not decoded whole", async ({
  page
}) => {
  await installBufferAudioMock(page);
  await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 1,
    spec: { seconds: 60, channels: 2, freqHz: 220 },
    filledCellsPerPanel: 1,
    trimStartMs: 0,
    trimEndMs: 5000
  });
  await page.goto("/");
  await waitForWarm(page, 1);

  // Same bytes the full path would have produced — the window is the window either way.
  expect(await diagPcmBytes(page)).toBe(5 * RATE * 2 * 4);
  // But nothing was fully decoded: 55 s of this file were never touched.
  expect(await diagDecodeCount(page)).toBe(0);
});

test("a short cue keeps the full-decode path, because a range read would not pay", async ({
  page
}) => {
  await installBufferAudioMock(page);
  await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 1,
    spec: { seconds: 2, channels: 1, freqHz: 220 },
    filledCellsPerPanel: 1
  });
  await page.goto("/");
  await waitForWarm(page, 1);

  expect(await diagDecodeCount(page)).toBe(1);
});

test("an untrimmed long media warms only its head, not the whole track", async ({ page }) => {
  // The dominant shape of a real project: a whole track dropped on a pad. A range read buys nothing
  // here — the window IS the file — so this is the case segment streaming exists for, and the
  // observable difference is that warming costs a head instead of the entire track.
  await installBufferAudioMock(page);
  await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 1,
    spec: { seconds: 30, channels: 2, freqHz: 220 },
    filledCellsPerPanel: 1
  });
  await page.goto("/");
  await waitForWarm(page, 1);

  // Head plus margin: 0.5 s + 0.06 s of stereo, against 30 s for the full decode — a 53x
  // difference in resident PCM for a warm cell. The frame count is derived the same way the range
  // reader derives it, `ceil` included, because 0.56 * 44100 is not an integer in binary
  // floating point.
  expect(await diagPcmBytes(page)).toBe(Math.ceil((0.5 + 0.06) * RATE) * 2 * 4);
  expect(await diagDecodeCount(page)).toBe(0);
});

test("a long window is streamed as a head plus segments that abut exactly", async ({ page }) => {
  await installBufferAudioMock(page);
  await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 1,
    spec: { seconds: 30, channels: 2, freqHz: 220 },
    filledCellsPerPanel: 1
  });
  await page.goto("/");
  await waitForWarm(page, 1);

  const cell = page.getByRole("button", { name: "Ячейка 1 Seed 0" });
  await cell.click();
  await expect(cell).toHaveAttribute("data-playing", "true");

  const probe = await readProbe(page);
  const head = probe.sources[0];
  expect(head).toBeDefined();
  const headStart = head?.startCalls[0];
  expect(headStart).toBeDefined();
  // Scheduled with an explicit time, not `start(0)`: the handoff time for the next segment is
  // derived from this number, and `start(0)` never reports where it actually landed.
  expect(headStart?.when).toBeGreaterThan(0);
  // No duration — the head is bounded by its `stop` at the handoff instead, which is
  // sample-accurate on both sides.
  expect(headStart?.duration).toBeNull();
  // And that stop is exactly one head-length after the start.
  expect(head?.stopCalls[0]).toBeCloseTo((headStart?.when ?? 0) + 0.5, 6);
});

test("the next segment starts exactly where the head stops", async ({ page }) => {
  // The seam, which is the one thing that can turn this feature into an audible click. The head
  // stops and the segment starts at the SAME absolute time, which is sample-accurate on both sides,
  // so there is neither a gap nor an overlap.
  await installBufferAudioMock(page);
  await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 1,
    spec: { seconds: 30, channels: 2, freqHz: 220 },
    filledCellsPerPanel: 1
  });
  await page.goto("/");
  await waitForWarm(page, 1);

  const cell = page.getByRole("button", { name: "Ячейка 1 Seed 0" });
  await cell.click();
  await expect(cell).toHaveAttribute("data-playing", "true");

  await expect
    .poll(async () => (await readProbe(page)).sources.length, { timeout: 20_000 })
    .toBeGreaterThan(1);

  const probe = await readProbe(page);
  const headStop = probe.sources[0]?.stopCalls[0];
  const tailStart = probe.sources[1]?.startCalls[0];
  expect(headStop).toBeDefined();
  expect(tailStart).toBeDefined();
  // Same absolute time on both sides of the join.
  expect(tailStart?.when).toBeCloseTo(headStop ?? -1, 9);
  // And the segment plays from the start of its own buffer: the buffer already begins at the
  // segment's source position, so `sliceStartSeconds` absorbs the conversion — the same mechanism
  // a trimmed single-buffer cue has always used.
  expect(tailStart?.offset).toBeCloseTo(0, 6);
});

test("a streamed cue reaches its end instead of hanging after the head", async ({ page }) => {
  // The failure this guards against is the one that reads as "the app has to be restarted": a chain
  // that never reaches its last segment leaves the cell playing forever and the rAF loop spinning.
  await installBufferAudioMock(page);
  await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 1,
    spec: { seconds: 30, channels: 2, freqHz: 220 },
    filledCellsPerPanel: 1,
    trimStartMs: 0,
    trimEndMs: 13_000
  });
  await page.goto("/");
  await waitForWarm(page, 1);

  const cell = page.getByRole("button", { name: "Ячейка 1 Seed 0" });
  await cell.click();
  await expect(cell).toHaveAttribute("data-playing", "true");

  // Let every segment be scheduled, then run the clock past the whole window.
  await expect
    .poll(async () => (await readProbe(page)).sources.length, { timeout: 20_000 })
    .toBeGreaterThan(2);

  // Advanced in steps rather than one jump, and that matters: the chain waits for each segment's
  // prefetch window to open before fetching it, on a real timer. A single 14 s jump of the audio
  // clock outruns the chain, the last segment is not scheduled yet, and the watchdog legitimately
  // steps in — which is correct behaviour for a clock that only a test can move that way, but tells
  // us nothing about the real path. Stepping lets the chain keep up, the way wall-clock time does.
  for (let elapsed = 0; elapsed < 12; elapsed += 2) {
    await advanceAudioClock(page, 2);
    await page.waitForTimeout(250);
    // Still playing: only the LAST segment ends the cue. Without this the test could not tell a
    // correct chain from one treating its first segment as final, which would cut a 13 s cue off
    // about four seconds in.
    await expect(cell).toHaveAttribute("data-playing", "true");
  }

  await advanceAudioClock(page, 3);
  await expect(cell).toHaveAttribute("data-playing", "false");

  // Ended by its own last segment, NOT by the safety net. Both produce the same sound, so the
  // mechanism has to be asserted directly: a broken `isLast` still ends the cue — the watchdog
  // covers for it — and would otherwise pass every timing-based assertion. Verified by a mutation
  // round, where exactly that mutation survived until this line existed.
  const partial = await diagPartial(page);
  expect(partial?.segments.watchdog).toBe(0);

  // And the pad works again afterwards — "has to be restarted" means the second press does nothing.
  await cell.click();
  await expect(cell).toHaveAttribute("data-playing", "true");
});

test("the envelope is scheduled once for the whole window and no segment cancels it", async ({
  page
}) => {
  // The fear this covers: a fade that ends in a burst instead of silence.
  //
  // The naive implementation calls `scheduleEnvelope` again when a segment is scheduled. That runs
  // `cancelScheduledValues(now)` on a curve mid-flight and then `setValueCurveAtTime` at `now`,
  // which the spec makes throw because the interval includes its own start; the catch falls through
  // to `setValueAtTime`, which throws too inside a running curve. The gain is then left wherever
  // the cancelled curve stopped — full scale — for the rest of the cue, and the fade never happens.
  //
  // One curve on the shared gain, anchored at the head's own start time, is what avoids all of it.
  await installBufferAudioMock(page);
  await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 1,
    spec: { seconds: 30, channels: 2, freqHz: 220 },
    filledCellsPerPanel: 1,
    trimStartMs: 1000,
    trimEndMs: 21_000,
    cellPatch: () => ({ fadeOutEnabled: true, fadeOutMs: 500, fadeInEnabled: true, fadeInMs: 300 })
  });
  await page.goto("/");
  await waitForWarm(page, 1);

  const cell = page.getByRole("button", { name: "Ячейка 1 Seed 0" });
  await cell.click();
  await expect(cell).toHaveAttribute("data-playing", "true");
  await expect
    .poll(async () => (await readProbe(page)).sources.length, { timeout: 20_000 })
    .toBeGreaterThan(1);

  const probe = await readProbe(page);
  // The envelope gain is the first gain created for the route.
  const envelope = probe.gains[0]?.gain;
  expect(envelope).toBeDefined();
  expect(envelope?.curves).toHaveLength(1);
  expect(envelope?.cancelCalls).toBe(1);
  // The whole 20 s window, not the head's 0.5 s.
  expect(envelope?.curves[0]?.duration).toBeCloseTo(20, 6);
  // Anchored to the head's scheduled start, so the fades line up with the sound rather than
  // running a render quantum ahead of it.
  expect(envelope?.curves[0]?.startTime).toBeCloseTo(
    probe.sources[0]?.startCalls[0]?.when ?? -1,
    9
  );
  // A pure fade-out reaches exactly zero at the end of the window.
  expect(envelope?.curves[0]?.curve.at(-1)).toBe(0);
});

test("diagnostics report what the partial path did, and range reads stay proportional", async ({
  page
}) => {
  // These counters are the only way to read this feature on a device CI cannot reach, so they are
  // asserted rather than assumed. `rangeReads.bytes` in particular is the standing check on the
  // assumption the whole design rests on: a slice of an IndexedDB blob reads only the slice.
  await installBufferAudioMock(page);
  await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 1,
    spec: { seconds: 60, channels: 2, freqHz: 220 },
    filledCellsPerPanel: 1,
    trimStartMs: 0,
    trimEndMs: 5000
  });
  await page.goto("/");
  await waitForWarm(page, 1);

  const partial = await diagPartial(page);
  expect(partial?.mode).toBe("auto");
  expect(partial?.probes.wav).toBeGreaterThan(0);
  expect(partial?.served.range).toBeGreaterThan(0);
  expect(partial?.rangeReads.count).toBeGreaterThan(0);

  // The file is 60 s of stereo 16-bit — about 10.6 MB. Reading the 5 s window plus a header probe
  // is well under a megabyte, so anything approaching the file size would mean slices are not lazy.
  const fileBytes = 44 + 60 * RATE * 2 * 2;
  expect(partial?.rangeReads.bytes ?? 0).toBeLessThan(fileBytes / 4);
});

test("__mumboxDiag can turn the partial path off at runtime", async ({ page }) => {
  await installBufferAudioMock(page);
  await seedProject(page, {
    panels: 2,
    gridSize: 6,
    distinctMedia: 2,
    spec: { seconds: 60, channels: 2, freqHz: 220 },
    filledCellsPerPanel: 1,
    trimStartMs: 0,
    trimEndMs: 5000
  });
  await page.goto("/");
  await waitForWarm(page, 1);
  expect(await diagDecodeCount(page)).toBe(0);

  // The switch that lets a bad device fall back without a redeploy.
  await diagSetPartialDecode(page, "off");
  await diagClearCaches(page);
  await page.getByRole("tab", { name: "Panel 2" }).click();
  await waitForWarm(page, 1);

  expect(await diagDecodeCount(page)).toBeGreaterThan(0);
});

test("a chain that cannot fetch a segment ends the cue and leaves the pad usable", async ({
  page
}) => {
  // The give-up path and the watchdog behind it. Both exist for exactly this: a segment that never
  // arrives. Without a failure injection neither can be exercised, and a mutation to either
  // survives every other test — verified by a mutation round.
  //
  // The read that fails is chosen to land after the head has been read and warmed, so the failure
  // hits a segment fetch rather than the warm-up itself.
  await installBufferAudioMock(page, { failNthRangeRead: 4 });
  await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 1,
    spec: { seconds: 30, channels: 2, freqHz: 220 },
    filledCellsPerPanel: 1,
    trimStartMs: 0,
    trimEndMs: 13_000
  });
  await page.goto("/");
  await waitForWarm(page, 1);

  const cell = page.getByRole("button", { name: "Ячейка 1 Seed 0" });
  await cell.click();

  // However the chain fails, the cue must not sit lit forever: either it ends on its own or the
  // watchdog ends it once the window is past. What is not acceptable is a pad stuck playing.
  await advanceAudioClock(page, 20);
  await expect(cell).toHaveAttribute("data-playing", "false", { timeout: 20_000 });

  // And it ended through the give-up path, not by the watchdog having to mop up: when a chain
  // cannot continue it is supposed to end the cue itself. If `promoteToLast` stopped marking the
  // segment, the cue would still end — the watchdog would catch it minutes later on a long track —
  // so the mechanism is asserted rather than the outcome.
  const partial = await diagPartial(page);
  expect(partial?.segments.missed).toBeGreaterThan(0);
  expect(partial?.segments.watchdog).toBe(0);

  // And the pad still works. "Приходится перезапускать приложение" means the next press does
  // nothing, so the next press is the assertion.
  await cell.click();
  await expect(cell).toHaveAttribute("data-playing", "true");
});

test("a short untrimmed cue is neither streamed nor range-read", async ({ page }) => {
  await installBufferAudioMock(page);
  await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 1,
    spec: { seconds: 4, channels: 2, freqHz: 220 },
    filledCellsPerPanel: 1
  });
  await page.goto("/");
  await waitForWarm(page, 1);

  // 4 s of stereo is 1.4 MB: one decode, no seam, exactly as before this feature existed. This is
  // what keeps every existing fixture's numbers unchanged.
  expect(await diagDecodeCount(page)).toBe(1);
  expect(await diagPcmBytes(page)).toBe(4 * RATE * 2 * 4);
});

test("a looping cue is not streamed, so its loop restart stays intact", async ({ page }) => {
  // A loop is heard over and over, so one full decode is the right price rather than re-streaming
  // the track on every iteration — and it keeps the existing loop restart path untouched.
  await installBufferAudioMock(page);
  await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 1,
    spec: { seconds: 30, channels: 2, freqHz: 220 },
    filledCellsPerPanel: 1,
    cellPatch: () => ({ playbackMode: "loop" })
  });
  await page.goto("/");
  await waitForWarm(page, 1);

  expect(await diagDecodeCount(page)).toBe(1);
  expect(await diagPcmBytes(page)).toBe(30 * RATE * 2 * 4);
});

test("?partial=0 restores the full-decode path exactly", async ({ page }) => {
  await installBufferAudioMock(page);
  const seed = await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 1,
    spec: { seconds: 60, channels: 2, freqHz: 220 },
    filledCellsPerPanel: 1,
    trimStartMs: 0,
    trimEndMs: 5000
  });
  await page.goto("/?partial=0");
  await waitForWarm(page, 1);

  // The escape hatch has to give back today's behaviour, byte for byte and decode for decode.
  expect(await diagDecodeCount(page)).toBe(1);
  expect(await diagPcmBytes(page)).toBe(5 * RATE * 2 * 4);
  expect(await diagCacheKeys(page)).toHaveLength(1);
  expect(seed.media).toHaveLength(1);
});

test("the range-decoded buffer plays the trimmed window from its own start", async ({ page }) => {
  await installBufferAudioMock(page);
  await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 1,
    spec: { seconds: 60, channels: 2, freqHz: 220 },
    filledCellsPerPanel: 1,
    trimStartMs: 0,
    trimEndMs: 5000
  });
  await page.goto("/");
  await waitForWarm(page, 1);

  const cell = page.getByRole("button", { name: "Ячейка 1 Seed 0" });
  await cell.click();
  await expect(cell).toHaveAttribute("data-playing", "true");

  const probe = await readProbe(page);
  expect(probe.sources).toHaveLength(1);
  // The buffer already starts at the trim, so the offset into it is 0 rather than the trim
  // position — `sliceStartSeconds` absorbs the difference, exactly as it does for a sliced buffer.
  expect(probe.sources[0]?.startCalls).toEqual([{ when: 0, offset: 0, duration: 5 }]);
});

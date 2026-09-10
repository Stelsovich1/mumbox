import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { installBufferAudioMock, readProbe } from "../support/audioMock";
import type { MockDecodeProbe } from "../support/audioMock";
import { makeWavBuffer } from "../support/audioFixtures";
import {
  diagCacheKeys,
  diagCacheStats,
  diagClearCaches,
  diagDecodeCount,
  diagLastPanelSwitchMs,
  diagLastWarmupMs,
  diagPcmBytes,
  diagPcmBytesForActivePanel,
  diagSetBudgetMb,
  diagSetMono,
  diagSnapshot
} from "../support/diag";
import { seedProject } from "../support/seedProject";
import type { SeedPlan } from "../support/seedProject";

/**
 * The decoded-buffer cache used to grow without bound and was never invalidated. These are the
 * assertions that prove it does not any more.
 */

const SPEC = { seconds: 2, channels: 1, freqHz: 220 } as const;
/** 2 s mono at 44.1 kHz: 88 200 frames x 1 channel x 4 bytes. */
const DECODED_BYTES = 2 * 44_100 * 4;
/**
 * The widest warm-up pool any device uses: `cores - 2` capped at four on a fine pointer, two on a
 * coarse one. Runs are serialized, so this is also the ceiling on decodes in flight at any moment
 * no matter how many panel switches are queued behind them.
 */
const MAX_POOL = 4;

/** Peak number of decodes in flight at once, swept from the mock's start/settle timestamps. */
function peakConcurrentDecodes(decodes: MockDecodeProbe[]): number {
  const events = decodes.flatMap((decode) => [
    { at: decode.startedAt, delta: 1 },
    { at: decode.settledAt ?? Number.POSITIVE_INFINITY, delta: -1 }
  ]);
  events.sort((first, second) => first.at - second.at || first.delta - second.delta);

  let inFlight = 0;
  let peak = 0;
  for (const event of events) {
    inFlight += event.delta;
    peak = Math.max(peak, inFlight);
  }
  return peak;
}

async function setup(page: Page, plan: Partial<SeedPlan> = {}) {
  const seed = await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 3,
    spec: SPEC,
    filledCellsPerPanel: 3,
    ...plan
  });
  await page.goto("/");
  return seed;
}

async function waitForWarm(page: Page, count: number) {
  await expect(page.locator('[data-warm-state="ready"]')).toHaveCount(count, { timeout: 30_000 });
}

test("accounts decoded PCM exactly", async ({ page }) => {
  await installBufferAudioMock(page);
  await setup(page);
  await waitForWarm(page, 3);

  // WAV fixtures are written at exactly 44 100 Hz, so decodeAudioData does no resampling and the
  // byte count is an equality, not an approximation.
  expect(await diagPcmBytes(page)).toBe(3 * DECODED_BYTES);
  expect(await diagPcmBytesForActivePanel(page)).toBe(3 * DECODED_BYTES);
  expect(await diagCacheKeys(page)).toHaveLength(3);
});

test("purges the cache when media is deleted", async ({ page }) => {
  await installBufferAudioMock(page);
  const seed = await setup(page);
  await waitForWarm(page, 3);
  expect(await diagPcmBytes(page)).toBe(3 * DECODED_BYTES);

  // The picker in the cell settings drawer, which is the flow the rest of the suite exercises.
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Пустая ячейка 4", exact: true }).click();
  await expect(page.getByRole("table", { name: "Выбор медиа" })).toBeVisible();

  const target = seed.media[0];
  const fileName = target?.fileName ?? "";
  // The delete control only becomes visible on row hover.
  await page.getByRole("button", { name: `Выбрать ${fileName}` }).hover();
  await page.getByRole("button", { name: `Удалить из медиатеки ${fileName}` }).click();
  await page.getByRole("button", { name: "Удалить", exact: true }).click();

  // Exactly this media's bytes go, and only this media's.
  await expect.poll(async () => diagPcmBytes(page), { timeout: 10_000 }).toBe(2 * DECODED_BYTES);
  const keys = await diagCacheKeys(page);
  expect(keys).toHaveLength(2);
  expect(keys.some((key) => key.startsWith(`${target?.id ?? ""}|`))).toBe(false);
});

test("empties the cache on a full reset", async ({ page }) => {
  await installBufferAudioMock(page);
  await setup(page);
  await waitForWarm(page, 3);
  expect(await diagPcmBytes(page)).toBe(3 * DECODED_BYTES);

  await page.getByRole("button", { name: "Проект" }).click();
  await page.getByRole("menuitem", { name: "Стереть все данные" }).click();
  await page.getByRole("button", { name: "Да, стереть" }).click();

  await expect.poll(async () => diagPcmBytes(page), { timeout: 15_000 }).toBe(0);
  expect(await diagCacheKeys(page)).toHaveLength(0);
});

test("keeps only the panel on screen resident", async ({ page }) => {
  // The bound the crash-on-a-phone needed: resident PCM is one panel's worth, whatever route
  // through the project the user took to get there.
  await installBufferAudioMock(page);
  await setup(page, { panels: 3, distinctMedia: 3, filledCellsPerPanel: 1 });
  await waitForWarm(page, 1);

  const panelA = (await diagCacheKeys(page))[0] ?? "";
  expect(panelA).not.toBe("");

  await page.getByRole("tab", { name: "Panel 2" }).click();
  await waitForWarm(page, 1);
  await page.getByRole("tab", { name: "Panel 3" }).click();
  await waitForWarm(page, 1);

  const keys = await diagCacheKeys(page);
  expect(keys).toHaveLength(1);
  expect(keys).not.toContain(panelA);
  expect(await diagPcmBytes(page)).toBe(DECODED_BYTES);
  expect(await diagPcmBytesForActivePanel(page)).toBe(DECODED_BYTES);
});

test("drops the warm state along with the evicted panel", async ({ page }) => {
  // A cell left as "ready" after its buffer was dropped promises an instant start the engine
  // cannot deliver, and suppresses the re-warm that would have made it true again.
  await installBufferAudioMock(page, { decodeDelayMs: 400 });
  await setup(page, { panels: 2, distinctMedia: 2, filledCellsPerPanel: 1 });
  await waitForWarm(page, 1);

  await page.getByRole("tab", { name: "Panel 2" }).click();
  await waitForWarm(page, 1);
  await page.getByRole("tab", { name: "Panel 1" }).click();

  // Cold again on arrival, then warm once the re-decode lands.
  await expect(page.locator('[data-warm-state="ready"]')).toHaveCount(0);
  await waitForWarm(page, 1);
});

test("returning to the previous panel re-decodes it", async ({ page }) => {
  // The price of the one-panel bound, pinned on purpose: coming back costs a decode, and in
  // exchange the footprint stays at one panel instead of two.
  await installBufferAudioMock(page);
  await setup(page, { panels: 2, distinctMedia: 2, filledCellsPerPanel: 1 });
  await waitForWarm(page, 1);

  await page.getByRole("tab", { name: "Panel 2" }).click();
  await waitForWarm(page, 1);
  await expect.poll(async () => diagDecodeCount(page), { timeout: 10_000 }).toBe(2);

  await page.getByRole("tab", { name: "Panel 1" }).click();
  await waitForWarm(page, 1);
  await expect.poll(async () => diagDecodeCount(page), { timeout: 10_000 }).toBe(3);
  expect(await diagPcmBytes(page)).toBe(DECODED_BYTES);
  expect(await diagLastPanelSwitchMs(page)).not.toBeNull();
});

test("a burst of panel switches settles on one panel and one footprint", async ({ page }) => {
  // The question the whole design turns on: can flicking through panels break it? Every switch
  // drops the previous panel, so an undebounced, unserialized warm-up would pile a fresh pool of
  // decodes on top of the ones still in flight and land their buffers in a cache that was already
  // emptied. What must hold after the dust settles is exactly one panel resident.
  await installBufferAudioMock(page, { decodeDelayMs: 400 });
  await setup(page, { panels: 3, distinctMedia: 3, filledCellsPerPanel: 1 });

  for (const name of ["Panel 2", "Panel 3", "Panel 1", "Panel 3", "Panel 2"]) {
    await page.getByRole("tab", { name }).click();
  }

  await waitForWarm(page, 1);
  // Long enough for anything that was in flight during the burst to have resolved.
  await page.waitForTimeout(1500);

  const keys = await diagCacheKeys(page);
  expect(keys).toHaveLength(1);
  expect(await diagPcmBytes(page)).toBe(DECODED_BYTES);
  expect(await diagPcmBytesForActivePanel(page)).toBe(DECODED_BYTES);
  await expect(page.locator('[data-warm-state="ready"]')).toHaveCount(1);
  // The crash-safety fact: however many switches queue up, decodes never overlap beyond one
  // pool, so the transient allocation that gets a tab killed cannot be multiplied by clicking.
  // (The debounce on top of this is a wall-clock saving; it is not what this asserts, because
  // under a loaded test runner two clicks can legitimately fall outside one debounce window.)
  expect(peakConcurrentDecodes((await readProbe(page)).decodes)).toBeLessThanOrEqual(MAX_POOL);
});

test("a buffer in use by a playing route survives a panel switch", async ({ page }) => {
  await installBufferAudioMock(page);
  await setup(page, { panels: 2, distinctMedia: 2, filledCellsPerPanel: 1 });
  await waitForWarm(page, 1);

  const cellOne = page.getByRole("button", { name: "Ячейка 1 Seed 0" });
  await cellOne.click();
  await expect(cellOne).toHaveAttribute("data-playing", "true");
  const playingKey = (await diagCacheKeys(page))[0] ?? "";

  // A budget this tight evicts everything it is allowed to, and makes the warm-up on the next
  // panel skip outright — so no cell there ever reaches the ready state. The pinned buffer must
  // survive both.
  await diagSetBudgetMb(page, 0.001);
  await page.getByRole("tab", { name: "Panel 2" }).click();
  await expect(page.getByRole("button", { name: "Ячейка 1 Seed 1" })).toBeVisible();
  await page.waitForTimeout(500);

  expect(await diagCacheKeys(page)).toContain(playingKey);
  expect((await diagCacheStats(page))?.pinnedBytes).toBeGreaterThan(0);

  await page.getByRole("tab", { name: "Panel 1" }).click();
  await expect(page.getByRole("button", { name: "Ячейка 1 Seed 0" })).toHaveAttribute(
    "data-playing",
    "true"
  );
});

test("the warm-up stops before blowing the budget instead of thrashing", async ({ page }) => {
  await installBufferAudioMock(page);
  await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 8,
    spec: SPEC,
    filledCellsPerPanel: 8
  });
  // The budget comes from the query parameter, which the diagnostics module reads before the
  // first warm-up runs.
  await page.goto("/?pcmBudgetMb=1");

  // The arithmetic is fully determined. The pre-decode estimate cannot know the channel count, so
  // it assumes stereo: 2 s at 44.1 kHz is estimated at 705 600 bytes against a warm-up ceiling of
  // 90 % of 1 MiB (943 718). One media therefore fits and the other seven are refused, even
  // though each actually decodes to 352 800 bytes as mono. Being wrong high costs a re-decode;
  // being wrong low costs a crash on the device this whole change exists for.
  await expect
    .poll(async () => (await diagSnapshot(page))?.lastWarmupSkipped ?? 0, { timeout: 30_000 })
    .toBe(7);

  const snapshot = await diagSnapshot(page);
  expect(snapshot?.lastWarmupWarmed).toBe(1);
  const stats = await diagCacheStats(page);
  expect(stats?.budgetBytes).toBe(1024 * 1024);
  expect(await diagPcmBytes(page)).toBe(DECODED_BYTES);
});

test("an unrelated cell edit does not restart the warm-up", async ({ page }) => {
  await installBufferAudioMock(page);
  await setup(page);
  await waitForWarm(page, 3);

  const decodesBefore = await diagDecodeCount(page);
  // The last cell reaching "ready" precedes the final inter-decode gap, so the warm-up total is
  // recorded slightly later. Capture it only once it exists, or the comparison is against null.
  await expect.poll(async () => diagLastWarmupMs(page), { timeout: 10_000 }).not.toBeNull();
  const warmupBefore = await diagLastWarmupMs(page);

  await page.getByRole("button", { name: "Режим редактирования" }).click();
  // Saving closes the drawer, so the cell has to be reselected — and its label is whatever the
  // previous iteration renamed it to.
  const labels = ["Seed 1", "Имя 0", "Имя 1"];
  for (const [index, label] of labels.entries()) {
    await page.getByRole("button", { name: `Ячейка 2 ${label}` }).click();
    await page.getByLabel("Псевдоним").fill(`Имя ${String(index)}`);
    await page.getByRole("button", { name: "Сохранить настройки ячейки" }).click();
    await expect(page.getByRole("button", { name: `Ячейка 2 Имя ${String(index)}` })).toBeVisible();
  }

  expect(await diagDecodeCount(page)).toBe(decodesBefore);
  expect(await diagLastWarmupMs(page)).toBe(warmupBefore);
});

test("caches only the trimmed window of a long media", async ({ page }) => {
  await installBufferAudioMock(page);
  await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 1,
    spec: { seconds: 60, channels: 2, freqHz: 220 },
    filledCellsPerPanel: 1,
    trimStartMs: 10_000,
    trimEndMs: 15_000
  });
  await page.goto("/");
  await waitForWarm(page, 1);

  // Full decode is 60 s stereo = 21 168 000 bytes; the 5 s window is 1 764 000.
  expect(await diagPcmBytes(page)).toBe(5 * 44_100 * 2 * 4);
});

test("keeps the whole buffer when trimming would not pay", async ({ page }) => {
  await installBufferAudioMock(page);
  await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 1,
    spec: { seconds: 2, channels: 1, freqHz: 220 },
    filledCellsPerPanel: 1,
    trimStartMs: 100,
    trimEndMs: 1900
  });
  await page.goto("/");
  await waitForWarm(page, 1);

  // Trimming 0.2 s off a 2 s mono buffer saves 35 KB — far under the copy-is-worth-it threshold.
  expect(await diagPcmBytes(page)).toBe(DECODED_BYTES);
});

test("two trims of one media are read as two byte ranges instead of one shared decode", async ({
  page
}) => {
  await installBufferAudioMock(page);
  await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 1,
    spec: { seconds: 60, channels: 2, freqHz: 220 },
    filledCellsPerPanel: 2,
    cellPatch: (index) =>
      index === 0
        ? { trimStartMs: 0, trimEndMs: 5000 }
        : { trimStartMs: 30_000, trimEndMs: 35_000 }
  });
  await page.goto("/");
  // Warm state is keyed by media id, and both cells reference the same media.
  await waitForWarm(page, 2);

  await expect.poll(async () => (await diagCacheKeys(page)).length, { timeout: 20_000 }).toBe(2);
  // This assertion used to be `1`: staging decoded the whole 60 s once and sliced it twice, which
  // is the best a full-decode path can do. Two range reads beat it outright — 10 s of this file is
  // touched instead of 60 — so there is no full decode left to count.
  //
  // Sharing a decode was never the goal; avoiding the 60 s decode was. Two 5 s reads never allocate
  // the transient that one 60 s decode does, and that transient is what kills a tab. Do not
  // "restore" this to 1 by keeping staging alive for range-bound media: that would pay the whole
  // transient and then throw the result away.
  expect(await diagDecodeCount(page)).toBe(0);
  expect(await diagPcmBytes(page)).toBe(2 * 5 * 44_100 * 2 * 4);
});

test("mono halves the decoded footprint and partitions the cache", async ({ page }) => {
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

  const stereoBytes = await diagPcmBytes(page);
  expect(stereoBytes).toBe(4 * 44_100 * 2 * 4);
  expect((await diagCacheKeys(page)).every((key) => key.endsWith("|s"))).toBe(true);
  expect((await diagSnapshot(page))?.mono).toBe(false);

  await diagSetMono(page, true);
  await expect
    .poll(async () => diagPcmBytes(page), { timeout: 20_000 })
    .toBe(stereoBytes / 2);
  const keys = await diagCacheKeys(page);
  expect(keys).toHaveLength(1);
  expect(keys[0]?.endsWith("|m")).toBe(true);
});

test("changing the trim in the editor replaces the cached buffer", async ({ page }) => {
  await installBufferAudioMock(page);
  await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 1,
    spec: { seconds: 10, channels: 1, freqHz: 220 },
    filledCellsPerPanel: 1
  });
  await page.goto("/");
  await waitForWarm(page, 1);
  const originalKey = (await diagCacheKeys(page))[0] ?? "";

  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Ячейка 1 Seed 0" }).click();
  await page.getByRole("button", { name: "Открыть редактор аудио" }).click();
  await page.getByLabel("Начало сек").fill("1.2");
  await page.getByLabel("Конец сек").fill("7.4");
  await page.getByRole("button", { name: "Сохранить редактор аудио" }).click();

  await expect
    .poll(async () => (await diagCacheKeys(page)).some((key) => key !== originalKey), {
      timeout: 20_000
    })
    .toBe(true);
  const keys = await diagCacheKeys(page);
  expect(keys).not.toContain(originalKey);
  expect(keys.some((key) => key.includes("|1200|7400|"))).toBe(true);
});

test("a fade-only edit keeps the cached buffer", async ({ page }) => {
  await installBufferAudioMock(page);
  await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 1,
    spec: { seconds: 10, channels: 1, freqHz: 220 },
    filledCellsPerPanel: 1
  });
  await page.goto("/");
  await waitForWarm(page, 1);
  const originalKey = (await diagCacheKeys(page))[0] ?? "";
  const decodesBefore = await diagDecodeCount(page);

  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Ячейка 1 Seed 0" }).click();
  await page.getByRole("button", { name: "Открыть редактор аудио" }).click();
  await page.getByLabel("Нарастание").check();
  await page.getByLabel("Секунды").first().fill("0.5");
  await page.getByRole("button", { name: "Сохранить редактор аудио" }).click();

  await expect(page.locator('[data-cell-id="cell-0"]')).toHaveAttribute("data-fade-in-ms", "500");
  expect(await diagCacheKeys(page)).toEqual([originalKey]);
  expect(await diagDecodeCount(page)).toBe(decodesBefore);
});

test("a decode that was in flight during a purge does not repopulate the cache", async ({
  page
}) => {
  // The decode outlives the purge: `AppShell` purges synchronously while the buffer is still
  // being read and decoded, and without a generation check the resolved PCM went straight back
  // into the cache for media the app no longer has.
  await installBufferAudioMock(page, { decodeDelayMs: 800 });
  await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 1,
    spec: SPEC,
    filledCellsPerPanel: 1
  });
  await page.goto("/");

  // Purge while the warm-up decode is still in flight. The cell turns "warming" immediately
  // before the decode is awaited, which is the only signal that the decode has actually started —
  // a decode count of zero no longer implies it, because the warm-up is debounced.
  await expect(page.locator('[data-warm-state="warming"]')).toHaveCount(1);
  expect(await diagDecodeCount(page)).toBe(0);
  await diagClearCaches(page);

  await page.waitForTimeout(1500);
  await expect.poll(async () => diagDecodeCount(page), { timeout: 10_000 }).toBe(1);
  expect(await diagPcmBytes(page)).toBe(0);
  expect(await diagCacheKeys(page)).toHaveLength(0);
  await expect(page.locator('[data-warm-state="ready"]')).toHaveCount(0);
});

test("an in-panel edit does not drop the panel's own buffers", async ({ page }) => {
  // The eviction effect also re-runs when the cache keys change without the panel changing, and
  // it now drops everything outside the active panel. What must survive that re-run is the panel
  // on screen: assigning one more media must cost one decode, not a re-warm of the whole panel.
  await installBufferAudioMock(page);
  await seedProject(page, {
    panels: 2,
    gridSize: 6,
    distinctMedia: 3,
    spec: SPEC,
    filledCellsPerPanel: 1
  });
  await page.goto("/");
  await waitForWarm(page, 1);

  await page.getByRole("tab", { name: "Panel 2" }).click();
  await waitForWarm(page, 1);
  await expect.poll(async () => diagDecodeCount(page), { timeout: 15_000 }).toBe(2);

  // An in-panel edit that changes the key set: a third media assigned to a free cell.
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Пустая ячейка 2", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать seed-0002.wav" }).click();
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await expect.poll(async () => diagDecodeCount(page), { timeout: 15_000 }).toBe(3);
  await waitForWarm(page, 2);

  // Both of the active panel's cells are resident, and nothing else is.
  await page.waitForTimeout(500);
  expect(await diagCacheKeys(page)).toHaveLength(2);
  expect(await diagPcmBytes(page)).toBe(2 * DECODED_BYTES);
  expect(await diagDecodeCount(page)).toBe(3);
});

test("a multi-cell drop decodes each media exactly once", async ({ page }) => {
  // Six cells filled in one gesture must cost six decodes, not more. React already batches the
  // dispatches inside one handler, so this does not discriminate batched from unbatched assignment;
  // what it guards is that the warm-up does not restart mid-flight and re-decode what its own
  // still-running workers were about to cache.
  await installBufferAudioMock(page);
  const wav = makeWavBuffer(SPEC).toString("base64");
  await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 0,
    spec: SPEC,
    filledCellsPerPanel: 0
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Режим редактирования" }).click();

  await page.locator('[aria-label^="Рабочая сетка"]').evaluate(
    (grid, payload) => {
      const bytes = Uint8Array.from(atob(payload.wav), (character) => character.charCodeAt(0));
      const transfer = new DataTransfer();
      for (let index = 0; index < 6; index += 1) {
        transfer.items.add(
          new File([bytes], `batched-${String(index)}.wav`, { type: "audio/wav" })
        );
      }
      for (const type of ["dragover", "drop"]) {
        const event = new DragEvent(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: transfer });
        grid.dispatchEvent(event);
      }
    },
    { wav }
  );

  await waitForWarm(page, 6);
  await expect.poll(async () => diagDecodeCount(page), { timeout: 15_000 }).toBe(6);

  // The count must not climb once the run has settled: a restarted warm-up shows up here.
  await page.waitForTimeout(750);
  expect(await diagDecodeCount(page)).toBe(6);
  expect(await diagCacheKeys(page)).toHaveLength(6);
});

/**
 * The coarse-pointer default budget.
 *
 * There was no default budget on any device, on the argument that a cap smaller than the project
 * turns every pad into a cold decode. That argument still holds for the desktop, and it stopped
 * holding for a phone once a legitimate decline was measured: byte-range decoding off, one 18-cell
 * panel, 1 539 MiB of resident PCM and the previous session reported killed. Declining is normal
 * and sometimes permanent — a loop is excluded from streaming by design, a file whose alignment
 * cannot be measured is off the path for good — so a handful of full decodes must not be able to
 * end the session.
 *
 * Written to run in BOTH projects and to assert both branches from the media query, rather than as
 * two tests keyed by project name: the thing being pinned is that the budget follows the pointer,
 * and a test that hard-codes one answer per project would still pass if that link were cut.
 */
test("a coarse pointer gets a default PCM budget and a fine pointer does not", async ({ page }) => {
  await installBufferAudioMock(page);
  await seedProject(page, { panels: 1, gridSize: 6, distinctMedia: 1, spec: SPEC, filledCellsPerPanel: 1 });
  await page.goto("/");
  await waitForWarm(page, 1);

  const coarse = await page.evaluate(
    () => window.matchMedia("(hover: none) and (pointer: coarse)").matches
  );
  const stats = await diagCacheStats(page);
  expect(stats?.budgetBytes).toBe(coarse ? 1024 * 1024 * 1024 : null);
});

/**
 * `?pcmBudgetMb=0` still means "no budget", including where a default would otherwise apply.
 *
 * The flag used to be read as `number | null`, which cannot tell "no flag" from "flag asking for no
 * cap" — harmless while the default was null everywhere, and a silent loss of the escape hatch the
 * moment it was not. The escape hatch is the only way to measure a device against the uncapped
 * behaviour, which is exactly what setting the default required.
 */
test("an explicit zero budget clears the default", async ({ page }) => {
  await installBufferAudioMock(page);
  await seedProject(page, { panels: 1, gridSize: 6, distinctMedia: 1, spec: SPEC, filledCellsPerPanel: 1 });
  await page.goto("/?pcmBudgetMb=0");
  await waitForWarm(page, 1);

  expect((await diagCacheStats(page))?.budgetBytes).toBeNull();
});

/**
 * A budget must not leave half a panel permanently cold.
 *
 * The predictive skip was written when warming a cell meant decoding its whole window, so it judges
 * the cell at that window's PCM. A STREAMED cell caches its head — 0.5 s, about 0.2 MiB — and
 * nothing else, so judging it at 7 MiB is wrong by a factor of thirty-five, and once a default
 * budget existed on a coarse pointer the arithmetic tipped: cells warmed for a while and then a
 * whole group stopped, dim for the life of the panel, with the page perfectly healthy and nothing on
 * screen to explain it. The warm-up never revisits a skipped target.
 *
 * The fixture is built so the two estimates land on OPPOSITE sides of the budget: eight untrimmed
 * 20 s stereo cells are 7.06 MB of window PCM each against a 4 MiB budget — every one refused under
 * the old estimate — while eight heads together are ~1.6 MB, comfortably inside it. `?rate=44100`
 * pins the engine to the fixtures' own rate, because a WAV whose rate differs from the engine's
 * deliberately falls through to a full decode, where a skip would be legitimate and the test would
 * be measuring the wrong thing.
 */
test("a budget skips nothing that would only have cached a head", async ({ page }) => {
  await installBufferAudioMock(page);
  await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 8,
    spec: { seconds: 20, channels: 2, freqHz: 220 },
    filledCellsPerPanel: 8
  });
  await page.goto("/?pcmBudgetMb=4&rate=44100");

  await waitForWarm(page, 8);
  const stats = await diagCacheStats(page);
  expect(stats?.budgetBytes).toBe(4 * 1024 * 1024);
  // Nothing was refused, and nothing had to be evicted to achieve it: eight heads fit.
  expect(await page.evaluate(() => window.__mumboxDiag?.snapshot().then((s) => s.lastWarmupSkipped))).toBe(0);
  expect(stats?.evictions).toBe(0);
});

/**
 * A cell claims to be warm exactly when its buffer is cached.
 *
 * The warm indicator is engine state keyed by cache key, and nothing invalidated it when the cache
 * evicted underneath — invisible while no device had a budget, because then nothing was ever
 * evicted. With one, the pad stays coloured, the tap finds no buffer, and the cell flickers through
 * a cold decode before it plays. Worse than cosmetic: holding the key also suppressed the re-warm,
 * so the cell could never recover on its own.
 *
 * The budget is LOWERED after the panel is warm, rather than set at load. Setting it at load proves
 * nothing about eviction: the predictive skip exists precisely so that a cell which would be
 * evicted on arrival is never decoded, so the cache never goes over budget and no eviction happens
 * at all. Lowering it is also the real sequence a device sees, via `?pcmBudgetMb=` or the diag knob.
 *
 * The assertion is the invariant rather than a count: however many entries survive, the cells
 * claiming to be warm are exactly those keys.
 */
test("an evicted buffer takes its warm indicator with it", async ({ page }) => {
  await installBufferAudioMock(page);
  await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 8,
    spec: { seconds: 20, channels: 2, freqHz: 220 },
    filledCellsPerPanel: 8,
    trimStartMs: 0,
    trimEndMs: 5000
  });
  await page.goto("/?rate=44100");

  // 5 s of 44.1 kHz stereo is 1 764 000 bytes per cell, so eight of them are ~13.5 MiB.
  await waitForWarm(page, 8);
  await diagSetBudgetMb(page, 4);

  await expect.poll(async () => (await diagCacheStats(page))?.evictions ?? 0).toBeGreaterThan(0);
  const cachedKeys = await diagCacheKeys(page);
  await expect(page.locator('[data-warm-state="ready"]')).toHaveCount(cachedKeys.length);
  // And the survivors are genuinely cached: a count alone would also pass on an implementation
  // that dropped every indicator.
  expect(cachedKeys.length).toBeGreaterThan(0);
});

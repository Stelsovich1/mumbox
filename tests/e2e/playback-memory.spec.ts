import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { installBufferAudioMock } from "../support/audioMock";
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

test("keeps every visited panel resident while the library fits", async ({ page }) => {
  // The behaviour a user actually notices: a warmed pad stays instant. Evicting a panel while
  // there is still room buys nothing and turns the next trigger into a decode.
  await installBufferAudioMock(page);
  await setup(page, { panels: 3, distinctMedia: 3, filledCellsPerPanel: 1 });
  await waitForWarm(page, 1);

  const panelA = (await diagCacheKeys(page))[0] ?? "";
  expect(panelA).not.toBe("");

  await page.getByRole("tab", { name: "Panel 2" }).click();
  await waitForWarm(page, 1);
  await expect.poll(async () => (await diagCacheKeys(page)).length, { timeout: 10_000 }).toBe(2);

  await page.getByRole("tab", { name: "Panel 3" }).click();
  await waitForWarm(page, 1);
  await expect.poll(async () => (await diagCacheKeys(page)).length, { timeout: 10_000 }).toBe(3);

  expect(await diagCacheKeys(page)).toContain(panelA);
  // Only the active panel counts as the active-panel footprint, whatever else is resident.
  expect(await diagPcmBytesForActivePanel(page)).toBe(DECODED_BYTES);
  expect(await diagPcmBytes(page)).toBe(3 * DECODED_BYTES);
});

test("evicts another panel, not the active one, once the budget is tight", async ({ page }) => {
  // A budget with room for two entries. The third panel must still warm — it is the one the user
  // is looking at — and the buffer that goes is the one belonging to a panel they left.
  await installBufferAudioMock(page);
  await seedProject(page, {
    panels: 3,
    gridSize: 6,
    distinctMedia: 3,
    spec: SPEC,
    filledCellsPerPanel: 1
  });
  await page.goto("/?pcmBudgetMb=0.75");

  await waitForWarm(page, 1);
  const panelA = (await diagCacheKeys(page))[0] ?? "";

  await page.getByRole("tab", { name: "Panel 2" }).click();
  await waitForWarm(page, 1);
  await expect.poll(async () => (await diagCacheKeys(page)).length, { timeout: 10_000 }).toBe(2);

  await page.getByRole("tab", { name: "Panel 3" }).click();
  await waitForWarm(page, 1);

  const keys = await diagCacheKeys(page);
  expect(keys).toHaveLength(2);
  // Panel A was the least recently used non-active panel.
  expect(keys).not.toContain(panelA);
  expect(await diagPcmBytesForActivePanel(page)).toBe(DECODED_BYTES);
  expect((await diagCacheStats(page))?.evictions).toBeGreaterThan(0);
});

test("returning to the previous panel costs no re-decode", async ({ page }) => {
  await installBufferAudioMock(page);
  await setup(page, { panels: 2, distinctMedia: 2, filledCellsPerPanel: 1 });
  await waitForWarm(page, 1);

  await page.getByRole("tab", { name: "Panel 2" }).click();
  await waitForWarm(page, 1);
  await expect.poll(async () => diagDecodeCount(page), { timeout: 10_000 }).toBe(2);

  await page.getByRole("tab", { name: "Panel 1" }).click();
  await waitForWarm(page, 1);
  await page.waitForTimeout(500);
  expect(await diagDecodeCount(page)).toBe(2);
  expect(await diagLastPanelSwitchMs(page)).not.toBeNull();
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

test("two trims of one media share a single decode", async ({ page }) => {
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
  // The staging buffer means the second trim slices the first decode instead of decoding again.
  expect(await diagDecodeCount(page)).toBe(1);
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

  // Purge while the warm-up decode is still in flight.
  await expect.poll(async () => diagDecodeCount(page), { timeout: 10_000 }).toBe(0);
  await diagClearCaches(page);

  await page.waitForTimeout(1500);
  await expect.poll(async () => diagDecodeCount(page), { timeout: 10_000 }).toBe(1);
  expect(await diagPcmBytes(page)).toBe(0);
  expect(await diagCacheKeys(page)).toHaveLength(0);
  await expect(page.locator('[data-warm-state="ready"]')).toHaveCount(0);
});

test("retention survives an edit made without leaving the panel", async ({ page }) => {
  // The eviction effect also re-runs when the cache keys change without the panel changing. If
  // the retained panel were derived from "the panel of the previous run", that re-run would
  // resolve it to the current panel and silently drop the panel being retained.
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

  await page.getByRole("tab", { name: "Panel 1" }).click();
  await waitForWarm(page, 1);
  await page.waitForTimeout(500);
  // Panel 1's buffer was retained across the edit, so returning costs no decode.
  expect(await diagDecodeCount(page)).toBe(3);
});

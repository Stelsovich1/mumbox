import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { diagCacheStats, diagSnapshot } from "../support/diag";
import { seedAppSettings, seedProject } from "../support/seedProject";
import type { SeedPlan } from "../support/seedProject";

/**
 * The settings dialog, end to end.
 *
 * What the unit tier cannot see and this checks: that applying reaches the DOM and survives a
 * reload, that closing without applying really discards, that the reset is scoped to settings and
 * leaves the project alone, and that deleting "unused" audio respects a cue hidden by a grid
 * shrink — the one case where a wrong answer destroys data rather than looking wrong.
 */

const SILENT: SeedPlan["spec"] = { seconds: 0.05, channels: 1, freqHz: 0 };

async function boot(page: Page, plan: Partial<SeedPlan> = {}) {
  const seed = await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 3,
    spec: SILENT,
    filledCellsPerPanel: 3,
    ...plan
  });
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "Panel 1" })).toBeVisible();
  return seed;
}

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Проект" }).click();
  await page.getByRole("menuitem", { name: "Настройки приложения" }).click();
  await expect(page.getByRole("dialog", { name: "Настройки приложения" })).toBeVisible();
}

function rootAttribute(page: Page, name: string) {
  return page.evaluate((attribute) => document.documentElement.getAttribute(attribute), name);
}

test("applies visual settings, and they survive a reload", async ({ page }) => {
  await boot(page);
  await openSettings(page);

  await page.getByTestId("settings-nav-visuals").click();
  await expect(page.getByTestId("settings-section-visuals")).toBeVisible();

  // Nothing is applied until the button is pressed: the dialog edits a draft.
  await page.getByRole("switch", { name: "Упрощённая графика" }).click();
  expect(await rootAttribute(page, "data-visuals")).toBeNull();

  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await expect.poll(async () => rootAttribute(page, "data-visuals")).toBe("flat");

  await page.reload();
  await expect(page.getByRole("tab", { name: "Panel 1" })).toBeVisible();
  await expect
    .poll(async () => rootAttribute(page, "data-visuals"))
    .toBe("flat");
});

test("the label scale reaches the cells as a CSS variable", async ({ page }) => {
  await boot(page);
  await openSettings(page);
  await page.getByTestId("settings-nav-visuals").click();

  await page.getByRole("combobox", { name: "Размер подписей" }).click();
  await page.getByRole("option", { name: "XL — очень крупный" }).click();
  await page.getByRole("button", { name: "Применить", exact: true }).click();

  const scale = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--mumbox-label-scale").trim()
  );
  expect(Number(scale)).toBeGreaterThan(1);
});

test("closing without applying discards the draft", async ({ page }) => {
  await boot(page);
  await openSettings(page);
  await page.getByTestId("settings-nav-visuals").click();
  await page.getByRole("switch", { name: "Уменьшить движение" }).click();

  // A dirty draft asks before it is thrown away, because the dialog looks like a form.
  await page.getByRole("button", { name: "Закрыть", exact: true }).click();
  await page.getByRole("button", { name: "Закрыть без применения" }).click();
  expect(await rootAttribute(page, "data-motion")).toBeNull();

  await openSettings(page);
  await page.getByTestId("settings-nav-visuals").click();
  await expect(page.getByRole("switch", { name: "Уменьшить движение" })).not.toBeChecked();
});

test("the reset returns settings to their defaults and leaves the project alone", async ({
  page
}) => {
  const seed = await boot(page);
  await openSettings(page);
  await page.getByTestId("settings-nav-visuals").click();
  await page.getByRole("switch", { name: "Упрощённая графика" }).click();
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  expect(await rootAttribute(page, "data-visuals")).toBe("flat");

  await page.getByTestId("settings-nav-reset").click();
  await page.getByRole("button", { name: "Вернуть настройки приложения к умолчанию" }).click();
  await page.getByRole("button", { name: "Сбросить настройки", exact: true }).click();

  expect(await rootAttribute(page, "data-visuals")).toBeNull();
  await page.getByRole("button", { name: "Закрыть", exact: true }).click();

  // The project is untouched: the reset is about this device, not about the work. Asserted on the
  // accessible name, which says whether the cell HOLDS media — `data-warm-state` is written for
  // every cell including empty ones, so a regex over it would pass on a destroyed project.
  const panelId = seed.panelIds[0] ?? "";
  for (const cellId of seed.filledCellIdsByPanel[panelId] ?? []) {
    await expect(page.locator(`[data-cell-id="${cellId}"]`)).toHaveAttribute(
      "aria-label",
      /^Ячейка \d+ .+/
    );
  }
  await expect(page.getByRole("tab", { name: "Panel 1" })).toBeVisible();
});

test("deleting audio that is in no cell keeps a cue hidden by a grid shrink", async ({ page }) => {
  // Nine media, eight of them assigned on a 12x12 grid: cells 6 and 7 sit in the first row beyond
  // a 6x6 lattice, so shrinking the grid hides them. Their media is still assigned and must not be
  // offered for deletion — a scan driven by the visible lattice would offer exactly those two, and
  // accepting the offer would destroy cues the user cannot even see to defend.
  const seed = await seedProject(page, {
    panels: 1,
    gridSize: 12,
    distinctMedia: 9,
    spec: SILENT,
    filledCellsPerPanel: 8
  });
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "Panel 1" })).toBeVisible();

  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Размер сетки" }).click();
  await page.getByRole("button", { name: "6x6" }).click();
  await expect(page.getByLabel("Рабочая сетка 6 на 6")).toBeVisible();
  await page.getByRole("button", { name: "Режим редактирования" }).click();

  // The two hidden cells are gone from the DOM, which is what makes this the dangerous case.
  await expect(page.locator('[data-cell-id="cell-6"]')).toHaveCount(0);

  await openSettings(page);
  await page.getByTestId("settings-nav-storage").click();

  const deleteButton = page.getByRole("button", { name: /Удалить аудио вне ячеек/ });
  await expect(deleteButton).toContainText("(1)");

  await deleteButton.click();
  await page.getByRole("button", { name: "Удалить безвозвратно" }).click();
  await expect(page.getByRole("button", { name: /Удалить аудио вне ячеек/ })).toBeDisabled();
  await page.getByRole("button", { name: "Закрыть", exact: true }).click();

  // Grow the grid back: the hidden cues are still there, with their media.
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Размер сетки" }).click();
  await page.getByRole("button", { name: "12x12" }).click();
  await page.getByRole("button", { name: "Режим редактирования" }).click();

  const panelId = seed.panelIds[0] ?? "";
  for (const cellId of seed.filledCellIdsByPanel[panelId] ?? []) {
    // Holding media, not merely rendered: an empty cell also carries `data-warm-state="idle"`.
    await expect(page.locator(`[data-cell-id="${cellId}"]`)).toHaveAttribute(
      "aria-label",
      /^Ячейка \d+ .+/
    );
  }
});

test("the warm-up mode reaches the grid: on-press stops the dim state", async ({ page }) => {
  await boot(page);
  await openSettings(page);

  await page.getByRole("combobox", { name: "Режим прогрева" }).click();
  await page.getByRole("option", { name: "Только по нажатию" }).click();
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await page.getByRole("button", { name: "Закрыть", exact: true }).click();

  // `auto` warmth follows the mode: under a mode that never warms the whole panel, a permanently
  // dim grid would read as a defect rather than as a state.
  await expect
    .poll(async () => page.locator('[data-cell-id][data-warmth="off"]').count())
    .toBeGreaterThan(0);

  // And the mode reached the engine. Checked after a reload, because switching modes does not
  // evict: the cells warmed under the default mode stay cached and stay ready, which is correct
  // and would make an in-place assertion pass for the wrong reason.
  await page.reload();
  await expect(page.getByRole("tab", { name: "Panel 1" })).toBeVisible();
  await expect
    .poll(async () => (await diagSnapshot(page))?.lastWarmupMs ?? null, { timeout: 30_000 })
    .not.toBeNull();
  expect(await page.locator('[data-warm-state="ready"]').count()).toBe(0);
});

test("a query flag keeps the control it owns", async ({ page }) => {
  await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 3,
    spec: SILENT,
    filledCellsPerPanel: 3
  });
  // The flag is the instrument every memory measurement in this repo is taken with, so a saved
  // setting must not be able to beat it — and the plumbing runs the other way round by default.
  await page.goto("/?partial=0&pcmBudgetMb=64");
  await expect(page.getByRole("tab", { name: "Panel 1" })).toBeVisible();

  await openSettings(page);
  await expect(page.getByRole("combobox", { name: "Побайтовое декодирование" })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Память под декодированный звук" })).toBeDisabled();
  await expect(page.getByText("Переопределено флагом в адресе страницы").first()).toBeVisible();
});

/**
 * Warm-up modes other than the default, which the first version of this suite left untested.
 *
 * A mutation round made the gap concrete: inverting the time-budget comparison (so the run skips
 * everything) and inverting the heads-only predicate (so it warms exactly the containers it exists
 * to avoid) both survived the whole suite. Neither mode was ever selected by a test.
 */

async function bootWithSettings(
  page: Page,
  settings: Record<string, unknown>,
  plan: Partial<SeedPlan> = {}
) {
  const seed = await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 3,
    spec: SILENT,
    filledCellsPerPanel: 3,
    ...plan
  });
  await seedAppSettings(page, { version: 1, ...settings });
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "Panel 1" })).toBeVisible();
  return seed;
}

async function waitForWarmupToRun(page: Page) {
  await expect
    .poll(async () => (await diagSnapshot(page))?.lastWarmupMs ?? null, { timeout: 30_000 })
    .not.toBeNull();
}

test("a time budget large enough warms the whole panel", async ({ page }) => {
  await bootWithSettings(page, {
    performance: { warmupMode: "time-budget", warmupBudgetSeconds: 120 }
  });

  // The budget is compared against elapsed time, and the comparison pointing the wrong way makes
  // the mode skip every target instantly — indistinguishable from "on-press" on screen, because
  // `auto` warmth stops showing the dim state in this mode too.
  await waitForWarmupToRun(page);
  await expect(page.locator('[data-warm-state="ready"]')).toHaveCount(3);
});

test("heads-only leaves alone what the byte-range path cannot serve", async ({ page }) => {
  // Short untrimmed cues: nothing to read as a range, nothing long enough to stream. The mode must
  // therefore warm none of them rather than pay a full decode for each.
  await bootWithSettings(page, { performance: { warmupMode: "heads-only" } });

  await waitForWarmupToRun(page);
  expect(await page.locator('[data-warm-state="ready"]').count()).toBe(0);
});

test("heads-only warms a trimmed window, which the range path can serve", async ({ page }) => {
  await bootWithSettings(
    page,
    { performance: { warmupMode: "heads-only" } },
    // A five-second window out of thirty is the shape `shouldReadRange` exists for.
    { spec: { seconds: 30, channels: 1, freqHz: 220 }, trimStartMs: 5000, trimEndMs: 10_000 }
  );

  await waitForWarmupToRun(page);
  await expect(page.locator('[data-warm-state="ready"]')).toHaveCount(3, { timeout: 30_000 });
});

test("switching the mode takes effect without a reload", async ({ page }) => {
  await bootWithSettings(page, { performance: { warmupMode: "on-press" } });
  await waitForWarmupToRun(page);
  expect(await page.locator('[data-warm-state="ready"]').count()).toBe(0);

  await openSettings(page);
  await page.getByRole("combobox", { name: "Режим прогрева" }).click();
  await page.getByRole("option", { name: "Полный — вся панель" }).click();
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await page.getByRole("button", { name: "Закрыть", exact: true }).click();

  // The warm-up effect is keyed on the cache keys the panel wants, and a mode change does not touch
  // those — so without the settings object in its dependencies this would wait for a panel switch
  // that a single-panel project never provides.
  await expect(page.locator('[data-warm-state="ready"]')).toHaveCount(3, { timeout: 30_000 });
});

test("a query flag still owns the budget after settings are applied", async ({ page }) => {
  await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 3,
    spec: SILENT,
    filledCellsPerPanel: 3
  });
  await page.goto("/?pcmBudgetMb=64");
  await expect(page.getByRole("tab", { name: "Panel 1" })).toBeVisible();

  const flagBytes = 64 * 1024 * 1024;
  expect((await diagCacheStats(page))?.budgetBytes).toBe(flagBytes);

  // Applying ANY setting runs the whole apply path. The control for the budget is disabled, but
  // that is the dialog's own guard — this asserts the engine's, which is the one that decides what
  // a memory measurement taken with the flag is actually measuring.
  await openSettings(page);
  await page.getByTestId("settings-nav-visuals").click();
  await page.getByRole("switch", { name: "Упрощённая графика" }).click();
  await page.getByRole("button", { name: "Применить", exact: true }).click();

  expect((await diagCacheStats(page))?.budgetBytes).toBe(flagBytes);
});

test("warmth off really stops the dimming, not just the animation", async ({ page }) => {
  await bootWithSettings(page, {
    performance: { warmupMode: "on-press" },
    visuals: { warmthDisplay: "static" }
  });
  await waitForWarmupToRun(page);

  const cellColor = () =>
    page.evaluate(() => {
      const cell = document.querySelector('[data-cell-id="cell-0"]');
      return cell ? getComputedStyle(cell).backgroundColor : "";
    });
  const dimmed = await cellColor();

  await openSettings(page);
  await page.getByTestId("settings-nav-visuals").click();
  await page.getByRole("combobox", { name: "Индикация готовности ячейки" }).click();
  await page.getByRole("option", { name: "Не показывать" }).click();
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await page.getByRole("button", { name: "Закрыть", exact: true }).click();

  // The dimming is computed in JS, not in the CSS the attribute switches, so the attribute reaching
  // the DOM says nothing about whether the cell stopped being 30 % darker.
  await expect.poll(cellColor).not.toBe(dimmed);
});

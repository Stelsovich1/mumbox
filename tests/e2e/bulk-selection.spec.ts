import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { seedProject } from "../support/seedProject";
import type { SeedPlan } from "../support/seedProject";

/**
 * Selection mode: the bulk counterpart of clearing one cell, copying one cell and deleting one
 * panel. The reducer side is pinned by the unit tier (`clear-cells`, `copy-cells`,
 * `delete-panels`); what is checked here is the wiring the unit tier cannot see — that a tap in
 * selection mode does not play or open settings, that the selection is dropped on the events that
 * make it meaningless, and that the confirmations report real numbers.
 */

const SILENT: SeedPlan["spec"] = { seconds: 0.05, channels: 1, freqHz: 0 };

async function boot(page: Page, plan: Partial<SeedPlan> = {}) {
  const seed = await seedProject(page, {
    panels: 3,
    gridSize: 8,
    distinctMedia: 4,
    spec: SILENT,
    filledCellsPerPanel: 4,
    ...plan
  });
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "Panel 1" })).toBeVisible();
  return seed;
}

async function enterSelectionMode(page: Page) {
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Режим выбора" }).click();
  await expect(page.getByTestId("selection-action-bar")).toBeVisible();
}

function cell(page: Page, cellId: string) {
  return page.locator(`[data-cell-id="${cellId}"]`);
}

function selectionCount(page: Page) {
  return page.getByTestId("selection-count");
}

test("offers selection mode only inside edit mode", async ({ page }) => {
  await boot(page);

  await expect(page.getByRole("button", { name: "Режим выбора" })).toHaveCount(0);
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await expect(page.getByRole("button", { name: "Режим выбора" })).toBeVisible();
  await expect(page.getByTestId("selection-action-bar")).toHaveCount(0);
});

test("a tap ticks a cell instead of playing it or opening its settings", async ({ page }) => {
  await boot(page);
  await enterSelectionMode(page);

  await cell(page, "cell-0").click();

  await expect(cell(page, "cell-0")).toHaveAttribute("data-multi-selected", "true");
  await expect(cell(page, "cell-0")).toHaveAttribute("data-playing", "false");
  await expect(page.getByRole("button", { name: "Сохранить настройки ячейки" })).toHaveCount(0);
  await expect(selectionCount(page)).toHaveText("Выбрано: 1 ячейка");

  await cell(page, "cell-0").click();
  await expect(cell(page, "cell-0")).toHaveAttribute("data-multi-selected", "false");
  await expect(selectionCount(page)).toHaveText("Выбрано: 0 ячеек");
});

test("«Все» sweeps in every configured cell and «Снять» drops the selection", async ({ page }) => {
  await boot(page);
  await enterSelectionMode(page);

  await page.getByRole("button", { name: "Выбрать все ячейки" }).click();
  await expect(selectionCount(page)).toHaveText("Выбрано: 4 ячейки");
  await expect(page.locator('[data-multi-selected="true"]')).toHaveCount(4);

  await page.getByRole("button", { name: "Снять выбор" }).click();
  await expect(selectionCount(page)).toHaveText("Выбрано: 0 ячеек");
});

test("clears the selected cells after a confirmation that counts them", async ({ page }) => {
  await boot(page);
  await enterSelectionMode(page);

  await cell(page, "cell-0").click();
  await cell(page, "cell-2").click();
  await page.getByRole("button", { name: "Очистить выбранные ячейки" }).click();

  const dialog = page.getByRole("dialog", { name: "Очистить выбранные ячейки?" });
  await expect(dialog).toContainText("Будет очищено 2 ячейки");
  await expect(dialog).toContainText("с настройками — 2");
  await dialog.getByRole("button", { name: "Очистить" }).click();

  await expect(
    page.getByRole("button", { name: "Пустая ячейка 1", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Пустая ячейка 3", exact: true })
  ).toBeVisible();
  // Untouched neighbours stay, and the media itself is still in the library.
  await expect(page.getByRole("button", { name: "Ячейка 2 Seed 1" })).toBeVisible();
  await expect(selectionCount(page)).toHaveText("Выбрано: 0 ячеек");
});

test("an empty cell cannot be selected at all", async ({ page }) => {
  await boot(page);
  await enterSelectionMode(page);

  // cell-7 is row 0, column 7 — the last cell of an 8x8 grid, and never filled by the seed. It has
  // nothing to clear and nothing to copy, so it takes neither a tick nor a tap.
  await expect(page.getByTestId("cell-tick-cell-7")).toHaveCount(0);
  await expect(page.getByTestId("cell-tick-cell-0")).toBeVisible();

  await cell(page, "cell-7").click();

  await expect(selectionCount(page)).toHaveText("Выбрано: 0 ячеек");
  await expect(cell(page, "cell-7")).toHaveAttribute("data-multi-selected", "false");
  await expect(page.getByRole("button", { name: "Очистить выбранные ячейки" })).toBeDisabled();
});

test("the selection toggle sits above edit mode and is white until it is on", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Режим редактирования" }).click();

  const selectionToggle = page.getByRole("button", { name: "Режим выбора" });
  const editToggle = page.getByRole("button", { name: "Режим редактирования" });
  const selectionBox = await selectionToggle.boundingBox();
  const editBox = await editToggle.boundingBox();
  // Above, so entering edit mode does not push the buttons below it down the sidebar.
  expect(selectionBox?.y ?? 0).toBeLessThan(editBox?.y ?? 0);

  await expect(selectionToggle).toHaveCSS("color", "rgb(255, 255, 255)");
  await selectionToggle.click();
  await expect(selectionToggle).not.toHaveCSS("color", "rgb(255, 255, 255)");
});

test("the per-tab delete cross stands down while selecting", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Режим редактирования" }).click();

  await expect(page.getByRole("button", { name: "Удалить панель Panel 2" })).toBeVisible();
  await page.getByRole("button", { name: "Режим выбора" }).click();
  // The cross is absolutely positioned over the tab corner and the checkbox widens the label, so
  // the two overlapped on a phone. Bulk deletion replaces it while selection mode is on.
  await expect(page.getByRole("button", { name: "Удалить панель Panel 2" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Выбрать панель Panel 2" })).toBeVisible();

  await page.getByRole("button", { name: "Режим выбора" }).click();
  await expect(page.getByRole("button", { name: "Удалить панель Panel 2" })).toBeVisible();
});

test("the action bar wraps instead of scrolling on a narrow portrait screen", async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-landscape", "Needs a touch-sized viewport.");
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await enterSelectionMode(page);

  const bar = page.getByTestId("selection-action-bar");
  await expect(bar.locator("> *").first()).toHaveCSS("flex-wrap", "wrap");
  const box = await bar.boundingBox();
  expect(box?.width ?? 0).toBeLessThanOrEqual(390);
  // Wrapping means more than one row of controls, which is the point: nothing is hidden off-edge.
  expect(box?.height ?? 0).toBeGreaterThan(44);
});

test("the action bar keeps a thumb-sized height on mobile landscape", async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-landscape", "Mobile landscape layout.");
  await boot(page);
  await enterSelectionMode(page);

  const box = await page.getByTestId("selection-action-bar").boundingBox();
  // 20 % taller than the first landscape pass, which measured 34 px.
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
});

test("bulk buttons stay disabled while nothing is selected", async ({ page }) => {
  await boot(page);
  await enterSelectionMode(page);

  await expect(page.getByRole("button", { name: "Очистить выбранные ячейки" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Скопировать выбранные ячейки" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Удалить выбранные панели" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Снять выбор" })).toBeDisabled();
});

test("copies the selected cells into the first free cells of another panel", async ({ page }) => {
  await boot(page);
  await enterSelectionMode(page);

  await cell(page, "cell-0").click();
  await cell(page, "cell-1").click();
  await page.getByRole("button", { name: "Скопировать выбранные ячейки" }).click();

  const dialog = page.getByRole("dialog", { name: "Скопировать выбранные ячейки" });
  await expect(page.getByTestId("copy-selection-hint")).toContainText("2 из 60 свободных");
  await dialog.getByRole("button", { name: "Скопировать" }).click();

  await expect(page.getByText("Скопировано 2 ячейки на панель «Panel 2»")).toBeVisible();
  await page.getByRole("tab", { name: "Panel 2" }).click();
  // Panel 2 starts with cell-0..cell-3 filled, so the copies land right after them. The copy's
  // alias comes from the media file name, exactly as a single-cell copy names one.
  await expect(
    page.getByRole("button", { name: "Ячейка 5 seed-0000.wav_copy" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Ячейка 6 seed-0001.wav_copy" })
  ).toBeVisible();
});

test("copies as many cells as fit and says how many did not", async ({ page }) => {
  // 6x6 panels with 35 of 36 cells filled: exactly one free target on the other panel.
  await boot(page, { panels: 2, gridSize: 6, distinctMedia: 2, filledCellsPerPanel: 35 });
  await enterSelectionMode(page);

  await cell(page, "cell-0").click();
  await cell(page, "cell-1").click();
  await cell(page, "cell-2").click();
  await page.getByRole("button", { name: "Скопировать выбранные ячейки" }).click();

  await expect(page.getByTestId("copy-selection-hint")).toContainText(
    "С аудио выбрано 3, свободных ячеек — 1"
  );
  await page
    .getByRole("dialog", { name: "Скопировать выбранные ячейки" })
    .getByRole("button", { name: "Скопировать" })
    .click();

  await expect(page.getByText("Скопировано 1 из 3")).toBeVisible();
});

test("refuses a copy onto a panel with no free cells", async ({ page }) => {
  await boot(page, { panels: 2, gridSize: 6, distinctMedia: 2, filledCellsPerPanel: 36 });
  await enterSelectionMode(page);

  await cell(page, "cell-0").click();
  await page.getByRole("button", { name: "Скопировать выбранные ячейки" }).click();

  await expect(
    page
      .getByRole("dialog", { name: "Скопировать выбранные ячейки" })
      .getByRole("button", { name: "Скопировать" })
  ).toBeDisabled();
});

test("deletes several panels at once and keeps the first one unselectable", async ({ page }) => {
  await boot(page);
  await enterSelectionMode(page);

  await expect(page.getByRole("button", { name: "Выбрать панель Panel 1" })).toHaveCount(0);
  await page.getByRole("button", { name: "Выбрать панель Panel 2" }).click();
  await page.getByRole("button", { name: "Выбрать панель Panel 3" }).click();
  await expect(selectionCount(page)).toHaveText("Выбрано: 0 ячеек, 2 панели");

  await page.getByRole("button", { name: "Удалить выбранные панели" }).click();
  const dialog = page.getByRole("dialog", { name: "Удалить выбранные панели?" });
  await expect(page.getByTestId("delete-panels-hint")).toContainText("Будет удалено 2 панели");
  await dialog.getByRole("button", { name: "Удалить" }).click();

  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.getByRole("tab", { name: "Panel 1" })).toBeVisible();
  await expect(selectionCount(page)).toHaveText("Выбрано: 0 ячеек");
});

test("deleting the active panel among several keeps the app on a panel that exists", async ({
  page
}) => {
  await boot(page);
  await enterSelectionMode(page);

  await page.getByRole("tab", { name: "Panel 3" }).click();
  await page.getByRole("button", { name: "Выбрать панель Panel 3" }).click();
  await page.getByRole("button", { name: "Удалить выбранные панели" }).click();
  await page
    .getByRole("dialog", { name: "Удалить выбранные панели?" })
    .getByRole("button", { name: "Удалить" })
    .click();

  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.getByRole("tab", { name: "Panel 2" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
});

test("switching panels drops the cell selection", async ({ page }) => {
  await boot(page);
  await enterSelectionMode(page);

  await cell(page, "cell-0").click();
  await expect(selectionCount(page)).toHaveText("Выбрано: 1 ячейка");

  await page.getByRole("tab", { name: "Panel 2" }).click();
  await expect(selectionCount(page)).toHaveText("Выбрано: 0 ячеек");
  await expect(cell(page, "cell-0")).toHaveAttribute("data-multi-selected", "false");
});

test("a cell hidden by a smaller grid leaves the selection", async ({ page }) => {
  await boot(page, { panels: 1, gridSize: 12, distinctMedia: 12, filledCellsPerPanel: 12 });
  await enterSelectionMode(page);

  // cell-8 is row 0, column 8 — inside a 12x12 grid and outside a 6x6 one.
  await cell(page, "cell-0").click();
  await cell(page, "cell-8").click();
  await expect(selectionCount(page)).toHaveText("Выбрано: 2 ячейки");

  await page.getByRole("button", { name: "Размер сетки" }).click();
  await page.getByRole("button", { name: "6x6" }).click();

  await expect(selectionCount(page)).toHaveText("Выбрано: 1 ячейка");
  await expect(cell(page, "cell-0")).toHaveAttribute("data-multi-selected", "true");
});

test("leaving edit mode leaves selection mode", async ({ page }) => {
  await boot(page);
  await enterSelectionMode(page);

  await cell(page, "cell-0").click();
  await page.getByRole("button", { name: "Режим редактирования" }).click();

  await expect(page.getByTestId("selection-action-bar")).toHaveCount(0);
  await expect(cell(page, "cell-0")).toHaveAttribute("data-multi-selected", "false");

  // Re-entering starts from an empty selection rather than the one left behind.
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Режим выбора" }).click();
  await expect(selectionCount(page)).toHaveText("Выбрано: 0 ячеек");
});

test("selection mode suppresses the cell drag", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Режим редактирования" }).click();

  await expect(cell(page, "cell-0")).toHaveAttribute("draggable", "true");
  await page.getByRole("button", { name: "Режим выбора" }).click();
  await expect(cell(page, "cell-0")).toHaveAttribute("draggable", "false");
});

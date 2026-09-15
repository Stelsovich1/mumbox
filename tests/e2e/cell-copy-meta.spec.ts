import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { seedProject } from "../support/seedProject";
import type { SeedPlan } from "../support/seedProject";

/**
 * A copy onto another panel carries the whole cell: the alias exactly as it was, the colour, and
 * every playback setting. The reducer side is pinned by `copy-cells`; this checks what the grid
 * shows for the copy, on both the single-cell path and the selection-mode path, and that it is
 * still there after a reload.
 */

const SILENT: SeedPlan["spec"] = { seconds: 0.05, channels: 1, freqHz: 0 };

async function boot(page: Page) {
  await seedProject(page, {
    panels: 2,
    gridSize: 8,
    distinctMedia: 2,
    spec: SILENT,
    filledCellsPerPanel: 2
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Режим редактирования" }).click();
}

async function nameAndColourCell0(page: Page) {
  await page.locator('[data-cell-id="cell-0"]').click();
  await page.getByRole("textbox", { name: "Псевдоним ячейки" }).fill("Гром");
  await page.getByRole("radio", { name: "Цвет ячейки #f97316" }).click();
}

function backgroundOf(page: Page, name: string) {
  return page
    .getByRole("button", { name })
    .evaluate((element) => getComputedStyle(element).backgroundColor);
}

/**
 * The cell background is transitioned, and closing the drawer deselects the cell, so a read taken
 * right after «Сохранить» can land mid-transition. Two equal reads 200 ms apart mean it settled.
 */
async function settledBackgroundOf(page: Page, name: string) {
  let previous = await backgroundOf(page, name);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.waitForTimeout(200);
    const current = await backgroundOf(page, name);
    if (current === previous) {
      return current;
    }
    previous = current;
  }
  return previous;
}

test("a single copy onto another panel keeps the alias and the colour", async ({ page }) => {
  await boot(page);
  await nameAndColourCell0(page);

  await page.getByRole("button", { name: "Скопировать", exact: true }).click();
  await page.getByRole("combobox", { name: "Панель" }).click();
  await page.getByRole("option", { name: "Panel 2" }).click();
  await page
    .getByRole("dialog", { name: "Скопировать" })
    .getByRole("button", { name: "Скопировать" })
    .click();
  await page.getByRole("button", { name: "Сохранить настройки ячейки" }).click();
  const sourceBackground = await settledBackgroundOf(page, "Ячейка 1 Гром");

  await page.getByRole("tab", { name: "Panel 2" }).click();
  // No `_copy` suffix across panels: the cue is the same cue, on another panel.
  await expect(page.getByRole("button", { name: "Ячейка 3 Гром" })).toBeVisible();
  await expect.poll(() => backgroundOf(page, "Ячейка 3 Гром")).toBe(sourceBackground);

  await page.reload();
  await page.getByRole("tab", { name: "Panel 2" }).click();
  await expect(page.getByRole("button", { name: "Ячейка 3 Гром" })).toBeVisible();
  // Polled: a freshly loaded cell paints dimmer until its buffer is warm, and the comparison has
  // to wait for the same visual state the source was read in.
  await expect.poll(() => backgroundOf(page, "Ячейка 3 Гром")).toBe(sourceBackground);
});

test("a bulk copy onto another panel keeps the alias and the colour", async ({ page }) => {
  await boot(page);
  await nameAndColourCell0(page);
  await page.getByRole("button", { name: "Сохранить настройки ячейки" }).click();
  const sourceBackground = await settledBackgroundOf(page, "Ячейка 1 Гром");

  await page.getByRole("button", { name: "Режим выбора" }).click();
  await page.locator('[data-cell-id="cell-0"]').click();
  await page.locator('[data-cell-id="cell-1"]').click();
  await page.getByRole("button", { name: "Скопировать выбранные ячейки" }).click();
  await page
    .getByRole("dialog", { name: "Скопировать выбранные ячейки" })
    .getByRole("button", { name: "Скопировать" })
    .click();

  await page.getByRole("tab", { name: "Panel 2" }).click();
  await expect(page.getByRole("button", { name: "Ячейка 3 Гром" })).toBeVisible();
  await expect.poll(() => backgroundOf(page, "Ячейка 3 Гром")).toBe(sourceBackground);
  // The cell without an override keeps showing its media alias, as the source does.
  await expect(page.getByRole("button", { name: "Ячейка 4 Seed 1" })).toBeVisible();
});

test("a copy onto the same panel is suffixed on the label the cell shows", async ({ page }) => {
  await boot(page);
  await nameAndColourCell0(page);

  await page.getByRole("button", { name: "Скопировать", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Скопировать" })
    .getByRole("button", { name: "Скопировать" })
    .click();
  await page.getByRole("button", { name: "Сохранить настройки ячейки" }).click();

  await expect(page.getByRole("button", { name: "Ячейка 3 Гром_copy" })).toBeVisible();
  const sourceBackground = await settledBackgroundOf(page, "Ячейка 1 Гром");
  await expect.poll(() => backgroundOf(page, "Ячейка 3 Гром_copy")).toBe(sourceBackground);
});

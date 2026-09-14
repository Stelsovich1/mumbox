import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { installBufferAudioMock } from "../support/audioMock";
import { seedProject } from "../support/seedProject";

/**
 * The seconds fields of the audio editor show a decimal from the start (`0,0`, `34,0`) and take a
 * comma as well as a dot, so a fraction can be typed over the shown digit without hunting for a
 * separator the Russian keyboard does not offer to a number input.
 */

async function openEditor(page: Page) {
  await installBufferAudioMock(page);
  await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 1,
    spec: { seconds: 10, channels: 1, freqHz: 220 },
    filledCellsPerPanel: 1
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Ячейка 1 Seed 0" }).click();
  await page.getByRole("button", { name: "Открыть редактор аудио" }).click();
  await expect(page.getByRole("dialog", { name: "Редактор аудио" })).toBeVisible();
}

test("seconds fields show one fraction digit from the start", async ({ page }) => {
  await openEditor(page);

  await expect(page.getByLabel("Начало сек")).toHaveValue("0,0");
  await expect(page.getByLabel("Конец сек")).toHaveValue("10,0");
  await expect(page.getByLabel("Секунды").first()).toHaveValue("0,0");
  await expect(page.getByLabel("Секунды").nth(1)).toHaveValue("0,0");
  await expect(page.getByLabel("Начало сек")).toHaveAttribute("inputmode", "decimal");
});

test("a comma-separated value is accepted and a whole one settles to ,0 on blur", async ({
  page
}) => {
  await openEditor(page);

  await page.getByLabel("Начало сек").fill("1,2");
  await page.getByLabel("Конец сек").fill("7");
  await page.getByLabel("Нарастание").check();
  await page.getByLabel("Затухание").check();
  await page.getByLabel("Секунды").first().fill("0,5");
  await page.getByLabel("Секунды").nth(1).fill("0.75");
  // Blur the last field so it reformats; the others already did when focus moved on.
  await page.getByLabel("Секунды").nth(1).blur();

  await expect(page.getByLabel("Начало сек")).toHaveValue("1,2");
  await expect(page.getByLabel("Конец сек")).toHaveValue("7,0");
  await expect(page.getByLabel("Секунды").first()).toHaveValue("0,5");
  await expect(page.getByLabel("Секунды").nth(1)).toHaveValue("0,75");

  await page.getByRole("button", { name: "Сохранить редактор аудио" }).click();
  const cell = page.locator('[data-cell-id="cell-0"]');
  await expect(cell).toHaveAttribute("data-trim-start-ms", "1200");
  await expect(cell).toHaveAttribute("data-trim-end-ms", "7000");
  await expect(cell).toHaveAttribute("data-fade-in-ms", "500");
  await expect(cell).toHaveAttribute("data-fade-out-ms", "750");
});

test("a half-typed value does not disturb the stored one", async ({ page }) => {
  await openEditor(page);

  const start = page.getByLabel("Начало сек");
  await start.fill("2,");
  // `2,` reads as 2 while the fraction is still coming; the field keeps the text as typed.
  await expect(start).toHaveValue("2,");
  await start.fill("");
  await expect(start).toHaveValue("");
  await start.blur();
  // Empty parsed to nothing, so the last good value is what comes back.
  await expect(start).toHaveValue("2,0");
});

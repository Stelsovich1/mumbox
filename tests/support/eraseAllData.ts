import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * Opens the project-wide erase confirmation.
 *
 * The trigger moved out of the «Проект» menu and into the settings dialog's «Сброс» section, so
 * every test that used to click a menu item goes through here instead. One helper rather than six
 * copies of the sequence: the next move should cost one edit.
 */
export async function openEraseAllData(page: Page): Promise<void> {
  // Several callers already have the menu open, and clicking «Проект» again would close it. Opening
  // it only when it is not open keeps the helper usable from both.
  const settingsItem = page.getByRole("menuitem", { name: "Настройки приложения" });
  if (!(await settingsItem.isVisible())) {
    await page.getByRole("button", { name: "Проект" }).click();
  }
  await settingsItem.click();
  await page.getByTestId("settings-nav-reset").click();
  await page.getByRole("button", { name: "Стереть все данные" }).click();
  await expect(page.getByRole("dialog", { name: "Стереть все данные?" })).toBeVisible();
}

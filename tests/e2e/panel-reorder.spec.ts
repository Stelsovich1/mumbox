import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { seedProject } from "../support/seedProject";
import type { SeedPlan } from "../support/seedProject";

/**
 * Panel reordering by the drag handle that appears in front of the tab name in edit mode. The
 * planner is pinned by the unit tier (`reorder-panels`); this checks the gesture wiring — that a
 * pointer drag from the handle onto another tab moves the panel, that the press on the handle does
 * not also select the tab, and that the new order survives a reload.
 */

const SILENT: SeedPlan["spec"] = { seconds: 0.05, channels: 1, freqHz: 0 };

async function boot(page: Page) {
  await seedProject(page, {
    panels: 3,
    gridSize: 6,
    distinctMedia: 1,
    spec: SILENT,
    filledCellsPerPanel: 1
  });
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "Panel 1" })).toBeVisible();
}

function handleOf(page: Page, panelName: string) {
  return page.locator(`[data-testid="panel-drag-handle"][data-panel-name="${panelName}"]`);
}

async function tabNames(page: Page) {
  return page.getByRole("tab").allInnerTexts();
}

async function centerOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error("element has no box");
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function dragHandleOnto(page: Page, handle: Locator, target: Locator) {
  const from = await centerOf(handle);
  const to = await centerOf(target);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 4, from.y, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

test("the drag handle exists only in edit mode and outside selection mode", async ({ page }) => {
  await boot(page);

  await expect(handleOf(page, "Panel 1")).toHaveCount(0);
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await expect(handleOf(page, "Panel 1")).toBeVisible();
  await expect(handleOf(page, "Panel 3")).toBeVisible();

  await page.getByRole("button", { name: "Режим выбора" }).click();
  await expect(handleOf(page, "Panel 1")).toHaveCount(0);
});

test("dragging a panel's handle onto another tab moves it there and the order persists", async ({
  page
}) => {
  await boot(page);
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  expect(await tabNames(page)).toEqual(["Panel 1", "Panel 2", "Panel 3"]);

  await dragHandleOnto(
    page,
    handleOf(page, "Panel 3"),
    page.getByRole("tab", { name: "Panel 1" })
  );

  expect(await tabNames(page)).toEqual(["Panel 3", "Panel 1", "Panel 2"]);
  // The press on the handle is not a tap on the tab: the active panel did not change.
  await expect(page.getByRole("tab", { name: "Panel 1" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Panel 3" })).toHaveAttribute("aria-selected", "false");

  // Forward as well as backward, and onto the far end.
  await dragHandleOnto(
    page,
    handleOf(page, "Panel 3"),
    page.getByRole("tab", { name: "Panel 2" })
  );
  expect(await tabNames(page)).toEqual(["Panel 1", "Panel 2", "Panel 3"]);

  await dragHandleOnto(
    page,
    handleOf(page, "Panel 1"),
    page.getByRole("tab", { name: "Panel 2" })
  );
  expect(await tabNames(page)).toEqual(["Panel 2", "Panel 1", "Panel 3"]);

  await page.reload();
  await expect(page.getByRole("tab", { name: "Panel 1" })).toBeVisible();
  expect(await tabNames(page)).toEqual(["Panel 2", "Panel 1", "Panel 3"]);
});

test("a drag that ends over the panel's own tab changes nothing", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Режим редактирования" }).click();

  await dragHandleOnto(
    page,
    handleOf(page, "Panel 2"),
    page.getByRole("tab", { name: "Panel 2" })
  );

  expect(await tabNames(page)).toEqual(["Panel 1", "Panel 2", "Panel 3"]);
  await expect(page.getByRole("tab", { name: "Panel 1" })).toHaveAttribute("aria-selected", "true");
});

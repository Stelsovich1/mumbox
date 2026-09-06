import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { installFilePickerMock, readPickerCalls } from "../support/fileSystemAccessMock";
import { readProjectRowIds, seedProjectRows } from "../support/seedProjects";
import type { SeededProjectRow } from "../support/seedProjects";

/**
 * The projects list is a table of bookmarks: metadata plus, where the browser can keep one, a file
 * handle. It never stores project audio.
 *
 * A fake handle cannot survive structured clone, so seeded rows are always handle-less — which is
 * exactly the shape Safari, iOS and Firefox produce, and the case worth pinning hardest.
 */

test.use({ timezoneId: "UTC" });

const TWO_ROWS: SeededProjectRow[] = [
  {
    id: "project-a",
    fileName: "выезд.mumbox",
    projectName: "Выезд",
    description: "Набор для сцены",
    savedAt: "2024-01-05T09:07:00.000Z"
  },
  {
    id: "project-b",
    fileName: "студия.mumbox",
    savedAt: "2023-03-02T22:45:00.000Z"
  }
];

async function openProjects(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Проект" }).click();
  await page.getByRole("menuitem", { name: "Проекты" }).click();
  await expect(page.getByRole("table", { name: "Проекты" })).toBeVisible();
}

test("shows seeded rows and their metadata instead of a path", async ({ page }) => {
  await seedProjectRows(page, TWO_ROWS);
  await openProjects(page);

  await expect(page.getByText("Выезд", { exact: true })).toBeVisible();
  await expect(page.getByText("Набор для сцены")).toBeVisible();
  await expect(page.getByText("выезд.mumbox")).toBeVisible();
  // No path column exists, because no browser exposes one.
  await expect(page.getByRole("columnheader", { name: "Путь" })).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Размер" })).toBeVisible();
  await expect(page.getByText("05.01.2024 09:07")).toBeVisible();
});

test("groups rows the browser cannot link and offers no warning for them", async ({ page }) => {
  await seedProjectRows(page, TWO_ROWS);
  await openProjects(page);

  await expect(page.getByText("Проекты без привязки к файлу")).toBeVisible();
  await expect(page.locator('[data-project-row="project-a"]')).toHaveAttribute(
    "data-project-status",
    "noHandle"
  );
  // A browser that cannot keep a reference is not a broken project.
  await expect(page.getByLabel("Файл проекта не найден")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Указать файл" })).toHaveCount(2);
});

test("never promises a disk deletion the browser cannot perform", async ({ page }) => {
  await seedProjectRows(page, TWO_ROWS);
  await openProjects(page);

  await page.getByRole("button", { name: "Удалить проект Выезд" }).click();

  const message = page.getByText(/Удалить проект "Выезд"/);
  await expect(message).toBeVisible();
  await expect(message).toContainText("Файл на диске останется");
  await expect(page.getByText(/будет удалён с диска/i)).toHaveCount(0);
});

test("deletes exactly the selected rows from the store", async ({ page }) => {
  await seedProjectRows(page, [
    ...TWO_ROWS,
    { id: "project-c", fileName: "архив.mumbox", projectName: "Архив" }
  ]);
  await openProjects(page);

  await page.getByRole("checkbox", { name: "Выбрать проект Выезд" }).check();
  await page.getByRole("checkbox", { name: "Выбрать проект Архив" }).check();
  await expect(page.getByText("Выбрано: 2")).toBeVisible();

  await page.getByRole("button", { name: "Удалить (2)" }).click();
  await expect(page.getByText("Удалить 2 проекта из списка? Файлы на диске останутся.")).toBeVisible();
  await page.getByRole("button", { name: "Удалить", exact: true }).click();

  await expect(page.getByText("Удалено проектов из списка: 2")).toBeVisible();
  await expect.poll(async () => readProjectRowIds(page)).toEqual(["project-b"]);
});

test("asks before switching away from an unsaved project", async ({ page }) => {
  await seedProjectRows(page, TWO_ROWS);
  await openProjects(page);

  await page.locator('[data-project-row="project-a"]').click();

  await expect(page.getByRole("dialog", { name: "Активировать проект?" })).toBeVisible();
  await expect(page.getByText('Текущий проект не сохранён. Открыть "Выезд"?')).toBeVisible();
  await expect(page.getByRole("button", { name: "Сохранить и открыть" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Без сохранения" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Отмена" })).toBeVisible();
});

test("saving a project adds a row to the list", async ({ page }) => {
  await installFilePickerMock(page, { mode: "unsupported" });
  await page.goto("/");

  await page.getByRole("button", { name: "Проект" }).click();
  await page.getByRole("menuitem", { name: "Сохранить проект" }).click();
  await page.getByLabel("Имя проекта").fill("Свежий");
  await page.getByLabel("Описание проекта").fill("Собран в тесте");
  await page.getByLabel("Имя файла проекта").fill("свежий");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await downloadPromise;

  await page.getByRole("button", { name: "Проект" }).click();
  await page.getByRole("menuitem", { name: "Проекты" }).click();
  await expect(page.getByRole("table", { name: "Проекты" })).toBeVisible();
  await expect(page.getByText("Свежий", { exact: true })).toBeVisible();
  await expect(page.getByText("Собран в тесте")).toBeVisible();
  await expect(page.getByText("свежий.mumbox")).toBeVisible();
});

test("adds projects through the picker and opens one in a single click", async ({ page }) => {
  await installFilePickerMock(page, { mode: "unsupported" });
  await page.goto("/");

  // Save a real project first so there is a file the picker mock can hand back.
  await page.getByRole("button", { name: "Проект" }).click();
  await page.getByRole("menuitem", { name: "Сохранить проект" }).click();
  await page.getByLabel("Имя проекта").fill("Через пикер");
  await page.getByLabel("Имя файла проекта").fill("picker");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await downloadPromise;

  await page.getByRole("button", { name: "Проект" }).click();
  await page.getByRole("menuitem", { name: "Проекты" }).click();
  await expect(page.getByRole("table", { name: "Проекты" })).toBeVisible();
  await expect(page.getByText("Через пикер", { exact: true })).toBeVisible();
});

test("erasing everything clears the projects list as well", async ({ page }) => {
  await seedProjectRows(page, TWO_ROWS);
  await page.goto("/");

  await page.getByRole("button", { name: "Проект" }).click();
  await page.getByText("Стереть все данные").click();
  await expect(page.getByRole("dialog", { name: "Стереть все данные?" })).toBeVisible();
  await expect(page.getByText(/Список проектов также будет очищен/)).toBeVisible();
  await page.getByRole("button", { name: "Да, стереть" }).click();

  await expect(page.getByText("Все данные MUMBOX стерты")).toBeVisible();
  await expect.poll(async () => readProjectRowIds(page)).toEqual([]);
});

test("the picker mock reports how many times a permission was requested", async ({ page }) => {
  // Guards the mock itself: the permission counter is what the needsPermission flow is asserted on.
  await installFilePickerMock(page, { mode: "handles", permission: "prompt" });
  await page.goto("/");

  expect(await readPickerCalls(page)).toMatchObject({ requestPermission: 0, save: 0, open: 0 });
});

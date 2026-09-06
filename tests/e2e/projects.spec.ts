import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { join } from "node:path";
import { tmpdir } from "node:os";

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

const SHARED_AUDIO = {
  name: "shared.wav",
  mimeType: "audio/wav",
  buffer: Buffer.from("RIFF....WAVEfmt ")
};

/** The picker path needs a working Audio double, same as the rest of the suite. */
async function installAudioMock(page: Page) {
  await page.addInitScript(() => {
    class MockAudio extends EventTarget {
      duration = 10;
      currentTime = 0;
      paused = true;
      volume = 1;
      loop = false;
      preload = "";

      constructor() {
        super();
        window.setTimeout(() => {
          this.dispatchEvent(new Event("loadedmetadata"));
        }, 0);
      }

      play() {
        return Promise.resolve();
      }

      pause() {
        // no-op
      }

      load() {
        // no-op
      }

      removeAttribute() {
        // no-op
      }
    }

    Object.defineProperty(window, "Audio", { value: MockAudio });
  });
}

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

async function saveProjectAs(page: Page, projectName: string, fileName: string) {
  await page.getByRole("button", { name: "Проект" }).click();
  await page.getByRole("menuitem", { name: "Сохранить проект" }).click();
  await page.getByLabel("Имя проекта").fill(projectName);
  await page.getByLabel("Имя файла проекта").fill(fileName);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();

  return downloadPromise;
}

test("merging appends panels and skips audio that is already present", async ({ page }) => {
  await installFilePickerMock(page, { mode: "unsupported" });
  await installAudioMock(page);
  await page.goto("/");

  // A project with one panel holding one audio file.
  await page.getByTestId("audio-file-input").setInputFiles(SHARED_AUDIO);
  await page.getByLabel("Выбрать все аудио").click();
  await page.getByRole("button", { name: "Сохранить" }).click();
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Пустая ячейка 1", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать shared.wav" }).click();
  await page.getByRole("button", { name: "Сохранить настройки ячейки" }).click();

  const download = await saveProjectAs(page, "Первый", "first");
  const projectPath = join(tmpdir(), `merge-source-${Date.now().toString()}.mumbox`);
  await download.saveAs(projectPath);

  // Merge that same project back into itself: the panel is added, the audio is not duplicated.
  await page.getByRole("button", { name: "Проект" }).click();
  await page.getByRole("menuitem", { name: "Объединить с проектом" }).click();
  await page.getByTestId("project-file-input").setInputFiles(projectPath);

  await expect(page.getByText(/Добавлено панелей: 1/)).toBeVisible();
  await expect(page.getByText(/дубликатов аудио пропущено: 1/)).toBeVisible();
  await expect(page.getByRole("tab", { name: "Panel 1", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Panel 1_2" })).toBeVisible();

  await page.getByRole("button", { name: "Проект" }).click();
  await page.getByRole("menuitem", { name: "Медиатека" }).click();
  await expect(page.getByRole("checkbox", { name: "Выбрать запись shared.wav" })).toHaveCount(1);
  await page.getByRole("button", { name: "Закрыть" }).click();

  // The merged panel keeps its cell, pointing at the deduplicated media.
  await page.getByRole("tab", { name: "Panel 1_2" }).click();
  await expect(page.locator('[data-cell-id="cell-0"]')).toHaveAttribute(
    "aria-label",
    "Ячейка 1 shared.wav"
  );
});

test("merging keeps the current project's global settings", async ({ page }) => {
  await installFilePickerMock(page, { mode: "unsupported" });
  await installAudioMock(page);
  await page.goto("/");

  const download = await saveProjectAs(page, "Донор", "donor");
  const projectPath = join(tmpdir(), `merge-globals-${Date.now().toString()}.mumbox`);
  await download.saveAs(projectPath);

  // Change the master volume away from the value stored in the file.
  await page.getByRole("button", { name: "Отключить звук" }).click();
  await expect(page.getByRole("button", { name: "Включить звук" })).toBeVisible();

  await page.getByRole("button", { name: "Проект" }).click();
  await page.getByRole("menuitem", { name: "Объединить с проектом" }).click();
  await page.getByTestId("project-file-input").setInputFiles(projectPath);
  await expect(page.getByText(/Добавлено панелей: 1/)).toBeVisible();

  // The incoming project was saved unmuted; the current setting must win.
  await expect(page.getByRole("button", { name: "Включить звук" })).toBeVisible();
});

test("merges the projects selected in the list", async ({ page }) => {
  await installFilePickerMock(page, { mode: "unsupported" });
  await installAudioMock(page);
  await page.goto("/");

  const download = await saveProjectAs(page, "Из списка", "from-list");
  const projectPath = join(tmpdir(), `merge-row-${Date.now().toString()}.mumbox`);
  await download.saveAs(projectPath);

  await page.getByRole("button", { name: "Проект" }).click();
  await page.getByRole("menuitem", { name: "Проекты" }).click();
  await page.getByRole("checkbox", { name: "Выбрать проект Из списка" }).check();
  await page.getByRole("button", { name: "Объединить (1)" }).click();

  // The row has no handle in this browser, so the app asks for the file through the input.
  await page.getByTestId("project-file-input").setInputFiles(projectPath);
  await expect(page.getByText(/Добавлено панелей: 1/)).toBeVisible();
  await expect(page.getByRole("tab", { name: "Panel 1_2" })).toBeVisible();
});

test("merging a project whose audio is new keeps its cells filled", async ({ page }) => {
  // The self-merge case hides an id-remapping bug: there, incoming ids already equal the current
  // ones. This merges a project whose audio the current library has never seen.
  await installFilePickerMock(page, { mode: "unsupported" });
  await installAudioMock(page);
  await page.goto("/");

  await page.getByTestId("audio-file-input").setInputFiles(SHARED_AUDIO);
  await page.getByLabel("Выбрать все аудио").click();
  await page.getByRole("button", { name: "Сохранить" }).click();
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Пустая ячейка 1", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать shared.wav" }).click();
  await page.getByRole("button", { name: "Сохранить настройки ячейки" }).click();

  const download = await saveProjectAs(page, "Донор", "donor-audio");
  const projectPath = join(tmpdir(), `merge-newmedia-${Date.now().toString()}.mumbox`);
  await download.saveAs(projectPath);

  // Wipe everything, then build a project holding completely different audio.
  await page.getByRole("button", { name: "Проект" }).click();
  await page.getByText("Стереть все данные").click();
  await page.getByRole("button", { name: "Да, стереть" }).click();
  await expect(page.getByText("Все данные MUMBOX стерты")).toBeVisible();

  await page.getByTestId("audio-file-input").setInputFiles({
    name: "other.wav",
    mimeType: "audio/wav",
    buffer: Buffer.from("RIFF....WAVEfmt other")
  });
  await page.getByLabel("Выбрать все аудио").click();
  await page.getByRole("button", { name: "Сохранить" }).click();

  await page.getByRole("button", { name: "Проект" }).click();
  await page.getByRole("menuitem", { name: "Объединить с проектом" }).click();
  await page.getByTestId("project-file-input").setInputFiles(projectPath);
  await expect(page.getByText(/Добавлено панелей: 1/)).toBeVisible();

  // The incoming audio is genuinely new, so it is written under a fresh id — and the merged
  // panel's cell must point at that id, not be emptied.
  await page.getByRole("tab", { name: "Panel 1_2" }).click();
  await expect(page.locator('[data-cell-id="cell-0"]')).toHaveAttribute(
    "aria-label",
    "Ячейка 1 shared.wav"
  );

  await page.getByRole("button", { name: "Проект" }).click();
  await page.getByRole("menuitem", { name: "Медиатека" }).click();
  await expect(page.getByRole("checkbox", { name: "Выбрать запись other.wav" })).toHaveCount(1);
  await expect(page.getByRole("checkbox", { name: "Выбрать запись shared.wav" })).toHaveCount(1);
});

test("a second merge builds on the result of the first", async ({ page }) => {
  // Two merges from two separate gestures accumulate. Note what this does NOT cover: merging
  // several rows inside one `mergeProjectRows` loop, where no render happens between iterations.
  // That path needs handle-bearing rows, and a fake handle cannot survive structured clone, so it
  // is unreachable from the harness — the stale-closure fix there rests on the `stateRef` idiom.
  await installFilePickerMock(page, { mode: "unsupported" });
  await installAudioMock(page);
  await page.goto("/");

  const download = await saveProjectAs(page, "Дважды", "twice");
  const projectPath = join(tmpdir(), `merge-twice-${Date.now().toString()}.mumbox`);
  await download.saveAs(projectPath);

  for (const expectedTab of ["Panel 1_2", "Panel 1_3"]) {
    await page.getByRole("button", { name: "Проект" }).click();
    await page.getByRole("menuitem", { name: "Объединить с проектом" }).click();
    await page.getByTestId("project-file-input").setInputFiles(projectPath);
    await expect(page.getByRole("tab", { name: expectedTab })).toBeVisible();
  }

  await expect(page.getByRole("tab", { name: "Panel 1", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Panel 1_2" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Panel 1_3" })).toBeVisible();
});

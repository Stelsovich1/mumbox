import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// The date column renders local time, so pin the zone rather than the formatter.
test.use({ timezoneId: "UTC" });

/**
 * The media library dialog had no coverage at all before multi-select landed here. These tests seed
 * state through localStorage only: the dialog reads metadata, never blobs.
 */

const MAX_GRID_SIZE = 12;

type SeedMedia = {
  id: string;
  fileName: string;
  alias?: string;
  color?: string;
  createdAt?: string | null;
};

function cellId(index: number) {
  const row = Math.floor(index / 6);
  const column = index % 6;

  return `cell-${String(row * MAX_GRID_SIZE + column)}`;
}

function makeCell(id: string, mediaId: string | null) {
  return {
    id,
    mediaId,
    aliasOverride: "",
    colorOverride: null,
    playbackMode: "once",
    volumeOffset: 0,
    hotkey: "",
    trimStartMs: null,
    trimEndMs: null,
    fadeInEnabled: false,
    fadeInMs: 0,
    fadeOutEnabled: false,
    fadeOutMs: 0
  };
}

/** `assignments` maps a panel index to the media id placed in each of its first cells. */
function buildState(media: SeedMedia[], assignments: (string | null)[][]) {
  const cellIds = Array.from({ length: 36 }, (_, index) => cellId(index));
  const panels = assignments.map((_, panelIndex) => ({
    id: `panel-${String(panelIndex)}`,
    name: `Panel ${String(panelIndex + 1)}`,
    gridSize: 6,
    cellIds
  }));

  const cellsByPanel: Record<string, Record<string, unknown>> = {};
  for (const [panelIndex, panelAssignments] of assignments.entries()) {
    const panelId = `panel-${String(panelIndex)}`;
    cellsByPanel[panelId] = Object.fromEntries(
      cellIds.map((id, index) => [id, makeCell(id, panelAssignments[index] ?? null)])
    );
  }

  return {
    panels,
    activePanelId: "panel-0",
    cellsByPanel,
    media: media.map((item) => {
      const asset: Record<string, unknown> = {
        id: item.id,
        fileName: item.fileName,
        alias: item.alias ?? "",
        color: item.color ?? "#ec5aa7",
        mimeType: "audio/wav",
        size: 1024,
        durationMs: 1000
      };
      if (item.createdAt !== null) {
        asset.createdAt = item.createdAt ?? new Date(0).toISOString();
      }

      return asset;
    }),
    masterVolume: 80,
    masterMuted: false,
    stopOthers: false
  };
}

async function openLibrary(page: Page, state: unknown) {
  await page.addInitScript(
    ({ key, value }) => {
      localStorage.setItem(key, JSON.stringify(value));
    },
    { key: "mumbox:state:v1", value: state }
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Проект" }).click();
  await page.getByRole("menuitem", { name: "Медиатека" }).click();
  await expect(page.getByRole("table", { name: "Медиатека" })).toBeVisible();
}

/** The row delete button only materialises on hover, exactly as in the cell media picker. */
async function clickRowDelete(page: Page, fileName: string) {
  await page.getByRole("checkbox", { name: `Выбрать запись ${fileName}` }).hover();
  await page.getByRole("button", { name: `Удалить из медиатеки ${fileName}` }).click();
}

const THREE_MEDIA: SeedMedia[] = [
  { id: "media-a", fileName: "alpha.wav", alias: "Мой звук" },
  { id: "media-b", fileName: "beta.wav" },
  { id: "media-c", fileName: "gamma.wav", color: "#6df7a5" }
];

test("deletes several selected records in one operation", async ({ page }) => {
  await openLibrary(page, buildState(THREE_MEDIA, [["media-a", "media-b", "media-c"]]));

  await page.getByRole("checkbox", { name: "Выбрать запись alpha.wav" }).check();
  await page.getByRole("checkbox", { name: "Выбрать запись beta.wav" }).check();
  await expect(page.getByText("Выбрано: 2")).toBeVisible();

  await page.getByRole("button", { name: "Удалить выбранное" }).click();
  await expect(page.getByText("Удалить 2 записи из медиатеки")).toBeVisible();
  await expect(page.getByText("Будет очищено ячеек: 2")).toBeVisible();

  await page.getByRole("button", { name: "Удалить", exact: true }).click();

  await expect(page.getByRole("checkbox", { name: "Выбрать запись alpha.wav" })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Выбрать запись beta.wav" })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Выбрать запись gamma.wav" })).toBeVisible();

  await page.getByRole("button", { name: "Закрыть" }).click();
  await expect(page.locator('[data-cell-id="cell-0"]')).toHaveAttribute(
    "aria-label",
    "Пустая ячейка 1"
  );
  await expect(page.locator('[data-cell-id="cell-1"]')).toHaveAttribute(
    "aria-label",
    "Пустая ячейка 2"
  );
  await expect(page.locator('[data-cell-id="cell-2"]')).toHaveAttribute(
    "aria-label",
    "Ячейка 3 gamma.wav"
  );
});

test("names a single record by its alias and falls back to the file name", async ({ page }) => {
  await openLibrary(page, buildState(THREE_MEDIA, [[]]));

  await clickRowDelete(page, "alpha.wav");
  await expect(
    page.getByText('Вы действительно хотите удалить "Мой звук" из медиатеки?')
  ).toBeVisible();
  // Nothing uses these media, so the affected-cells note must stay silent.
  await expect(page.getByText(/Будет очищено ячеек/)).toHaveCount(0);
  await page.getByRole("button", { name: "Отмена" }).click();

  await clickRowDelete(page, "beta.wav");
  await expect(
    page.getByText('Вы действительно хотите удалить "beta.wav" из медиатеки?')
  ).toBeVisible();
});

test("cancelling a deletion keeps both the records and the selection", async ({ page }) => {
  await openLibrary(page, buildState(THREE_MEDIA, [[]]));

  await page.getByRole("checkbox", { name: "Выбрать запись alpha.wav" }).check();
  await page.getByRole("button", { name: "Удалить выбранное" }).click();
  await page.getByRole("button", { name: "Отмена" }).click();

  await expect(page.getByRole("checkbox", { name: "Выбрать запись alpha.wav" })).toBeChecked();
  await expect(page.getByText("Выбрано: 1")).toBeVisible();
});

test("select all applies only to the rows the filter shows", async ({ page }) => {
  await openLibrary(page, buildState(THREE_MEDIA, [[]]));

  await page.getByLabel("Поиск по медиатеке").fill("alpha");
  await expect(page.getByRole("checkbox", { name: "Выбрать запись beta.wav" })).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Выбрать все в медиатеке" }).check();

  await page.getByLabel("Поиск по медиатеке").fill("");
  await expect(page.getByText("Выбрано: 1")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Выбрать запись beta.wav" })).not.toBeChecked();

  // The colour filter is the second way to hide rows, and it must behave the same.
  await page.getByRole("button", { name: "Фильтр по цвету #6df7a5" }).click();
  await page.getByRole("checkbox", { name: "Выбрать все в медиатеке" }).check();
  await page.getByRole("button", { name: "Все" }).click();
  await expect(page.getByText("Выбрано: 2")).toBeVisible();
});

test("clears the selection once every record is gone", async ({ page }) => {
  await openLibrary(page, buildState(THREE_MEDIA, [[]]));

  await page.getByRole("checkbox", { name: "Выбрать все в медиатеке" }).check();
  await expect(page.getByText("Выбрано: 3")).toBeVisible();
  await page.getByRole("button", { name: "Удалить выбранное" }).click();
  await expect(page.getByText("Удалить 3 записи из медиатеки")).toBeVisible();
  await page.getByRole("button", { name: "Удалить", exact: true }).click();

  await expect(page.getByText("Нет аудио")).toBeVisible();
  await expect(page.getByText(/Выбрано:/)).toHaveCount(0);
  const selectAll = page.getByRole("checkbox", { name: "Выбрать все в медиатеке" });
  await expect(selectAll).not.toBeChecked();
  await expect(selectAll).toHaveJSProperty("indeterminate", false);
});

test("counts and clears cells across every panel", async ({ page }) => {
  await openLibrary(
    page,
    buildState(THREE_MEDIA, [
      ["media-a", "media-a"],
      ["media-a", "media-b"]
    ])
  );

  await clickRowDelete(page, "alpha.wav");
  await expect(page.getByText("Будет очищено ячеек: 3")).toBeVisible();
  await page.getByRole("button", { name: "Удалить", exact: true }).click();
  await page.getByRole("button", { name: "Закрыть" }).click();

  await expect(page.locator('[data-cell-id="cell-0"]')).toHaveAttribute(
    "aria-label",
    "Пустая ячейка 1"
  );
  await page.getByRole("tab", { name: "Panel 2" }).click();
  await expect(page.locator('[data-cell-id="cell-0"]')).toHaveAttribute(
    "aria-label",
    "Пустая ячейка 1"
  );
  await expect(page.locator('[data-cell-id="cell-1"]')).toHaveAttribute(
    "aria-label",
    "Ячейка 2 beta.wav"
  );
});

const DATED_MEDIA: SeedMedia[] = [
  { id: "media-a", fileName: "alpha.wav", createdAt: "2024-01-05T09:07:00.000Z" },
  { id: "media-b", fileName: "beta.wav", createdAt: "2023-03-02T22:45:00.000Z" },
  // Written by a build that predates the column: no createdAt at all.
  { id: "media-c", fileName: "gamma.wav", createdAt: null }
];

test("shows the date a record was added and a dash when the save predates it", async ({ page }) => {
  await openLibrary(page, buildState(DATED_MEDIA, [[]]));

  await expect(page.getByText("05.01.2024 09:07")).toBeVisible();
  await expect(page.getByText("02.03.2023 22:45")).toBeVisible();
  await expect(page.getByRole("table", { name: "Медиатека" }).getByText("—")).toHaveCount(1);
});

test("keeps the media library columns aligned", async ({ page }) => {
  await openLibrary(page, buildState(DATED_MEDIA, [[]]));

  const templates = await page.getByRole("table", { name: "Медиатека" }).evaluate((table) => {
    const rows = Array.from(table.children);

    return rows.slice(0, 2).map((row) => getComputedStyle(row).gridTemplateColumns);
  });

  expect(templates[0]).toBe(templates[1]);
  expect(templates[0]?.split(" ")).toHaveLength(7);
});

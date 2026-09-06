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

  // Date over time on two lines: one line forces a column wider than its own header.
  await expect(page.getByText("05.01.2024", { exact: true })).toBeVisible();
  await expect(page.getByText("09:07", { exact: true })).toBeVisible();
  await expect(page.getByText("02.03.2023", { exact: true })).toBeVisible();
  await expect(page.getByText("22:45", { exact: true })).toBeVisible();
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

async function fileNameOrder(page: Page) {
  return page.getByRole("table", { name: "Медиатека" }).evaluate((table) => {
    const rows = Array.from(table.children).slice(1);

    return rows
      .map((row) => row.children[1]?.textContent ?? "")
      .filter((name) => name !== "Нет аудио");
  });
}

test("cycles a column through three sort states", async ({ page }) => {
  await openLibrary(page, buildState(DATED_MEDIA, [[]]));

  const header = page.getByRole("columnheader", { name: "Добавлено" });
  const button = page.getByRole("button", { name: "Добавлено" });

  await expect(header).toHaveAttribute("aria-sort", "none");
  await expect.poll(async () => fileNameOrder(page)).toEqual([
    "alpha.wav",
    "beta.wav",
    "gamma.wav"
  ]);

  await button.click();
  await expect(header).toHaveAttribute("aria-sort", "ascending");
  // gamma.wav has no date at all, so it sorts last ascending.
  await expect.poll(async () => fileNameOrder(page)).toEqual([
    "beta.wav",
    "alpha.wav",
    "gamma.wav"
  ]);

  await button.click();
  await expect(header).toHaveAttribute("aria-sort", "descending");
  await expect.poll(async () => fileNameOrder(page)).toEqual([
    "gamma.wav",
    "alpha.wav",
    "beta.wav"
  ]);

  await button.click();
  await expect(header).toHaveAttribute("aria-sort", "none");
  await expect.poll(async () => fileNameOrder(page)).toEqual([
    "alpha.wav",
    "beta.wav",
    "gamma.wav"
  ]);
});

test("sorts file names naturally and keeps only one column sorted", async ({ page }) => {
  await openLibrary(
    page,
    buildState(
      [
        { id: "media-10", fileName: "track-10.wav" },
        { id: "media-2", fileName: "track-2.wav" },
        { id: "media-1", fileName: "track-1.wav" }
      ],
      [[]]
    )
  );

  await page.getByRole("button", { name: "Файл" }).click();
  await expect.poll(async () => fileNameOrder(page)).toEqual([
    "track-1.wav",
    "track-2.wav",
    "track-10.wav"
  ]);

  await page.getByRole("button", { name: "Время" }).click();
  await expect(page.getByRole("columnheader", { name: "Файл" })).toHaveAttribute(
    "aria-sort",
    "none"
  );
  await expect(page.getByRole("columnheader", { name: "Время" })).toHaveAttribute(
    "aria-sort",
    "ascending"
  );
});

test("keeps sorting, search and the colour filter composed", async ({ page }) => {
  await openLibrary(page, buildState(THREE_MEDIA, [[]]));

  await page.getByRole("button", { name: "Файл" }).click();
  await page.getByRole("button", { name: "Файл" }).click();
  await expect.poll(async () => fileNameOrder(page)).toEqual([
    "gamma.wav",
    "beta.wav",
    "alpha.wav"
  ]);

  await page.getByLabel("Поиск по медиатеке").fill("a");
  await expect.poll(async () => fileNameOrder(page)).toEqual([
    "gamma.wav",
    "beta.wav",
    "alpha.wav"
  ]);

  await page.getByRole("button", { name: "Фильтр по цвету #6df7a5" }).click();
  await expect.poll(async () => fileNameOrder(page)).toEqual(["gamma.wav"]);
  await expect(page.getByRole("columnheader", { name: "Файл" })).toHaveAttribute(
    "aria-sort",
    "descending"
  );
});

const LONG_ALIAS = "Очень длинный псевдоним записи, который заведомо не помещается в одну строку";

test("wraps a long alias but keeps the file name on one line", async ({ page }) => {
  await openLibrary(
    page,
    buildState([{ id: "media-a", fileName: "очень-длинное-имя-файла-записи.wav", alias: LONG_ALIAS }], [[]])
  );

  const metrics = await page.getByRole("table", { name: "Медиатека" }).evaluate((table) => {
    const row = Array.from(table.querySelectorAll('[role="row"]'))[1];
    if (!row) {
      throw new Error("no data row");
    }
    const fileCell = row.children[1];
    const aliasCell = row.children[2];
    if (!fileCell || !aliasCell) {
      throw new Error("row is missing its cells");
    }
    const lineHeight = parseFloat(getComputedStyle(aliasCell).lineHeight) || 16;

    return {
      fileClipped: fileCell.scrollWidth > fileCell.clientWidth + 0.5,
      fileLines: Math.round(fileCell.getBoundingClientRect().height / lineHeight),
      aliasLines: Math.round(aliasCell.getBoundingClientRect().height / lineHeight)
    };
  });

  // A file name is an identifier: truncating it beats reflowing the table. An alias is prose.
  expect(metrics.fileClipped).toBe(true);
  expect(metrics.fileLines).toBe(1);
  expect(metrics.aliasLines).toBe(2);
});

test("keeps every picker row at one pitch even with wrapping aliases", async ({ page }) => {
  // The picker positions rows absolutely at a fixed pitch above 80 items, so an alias that grows
  // without bound would make them overlap.
  const media = Array.from({ length: 100 }, (_, index) => ({
    id: `media-${String(index)}`,
    fileName: `track-${String(index)}.wav`,
    alias: index % 2 === 0 ? `${LONG_ALIAS} ${String(index)}` : ""
  }));
  await page.addInitScript(
    ({ key, value }) => {
      localStorage.setItem(key, JSON.stringify(value));
    },
    { key: "mumbox:state:v1", value: buildState(media, [[]]) }
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Пустая ячейка 1", exact: true }).click();

  const picker = page.getByRole("table", { name: "Выбор медиа" });
  await expect(picker).toBeVisible();

  const heights = await picker.evaluate((table) =>
    Array.from(table.querySelectorAll('[role="button"][aria-label^="Выбрать"]'))
      .slice(0, 12)
      .map((row) => Math.round(row.getBoundingClientRect().height))
  );

  expect(heights.length).toBeGreaterThan(4);
  expect(new Set(heights).size).toBe(1);
});

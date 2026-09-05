import { expect, test } from "@playwright/test";

import { makeWavBuffer, SIZES } from "../support/audioFixtures";
import {
  getPanelCellIds,
  IDB_DATABASE_NAME,
  IDB_STORE_NAME,
  MEDIA_BLOB_PREFIX,
  readSeededKeys,
  seedProject
} from "../support/seedProject";

/**
 * Drift guards for the two contracts `tests/support/seedProject.ts` duplicates instead of
 * importing. If idb-keyval changes its default database or store name, or if the cell-id scheme
 * in `getPanelCellIds` changes, these fail loudly rather than letting the seeder silently write
 * into a store nobody reads.
 */

test("idb-keyval writes imported media where the seeding helper expects them", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("audio-file-input").setInputFiles({
    name: "contract.wav",
    mimeType: "audio/wav",
    buffer: makeWavBuffer({ seconds: 0.25, channels: 1, freqHz: 220 })
  });
  const importDialog = page.getByRole("dialog", { name: "Импорт аудио" });
  await expect(importDialog).toBeVisible();
  await importDialog.getByRole("cell", { name: "contract.wav", exact: true }).click();
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(importDialog).toBeHidden();

  const databases = await page.evaluate(async () => {
    const list = await indexedDB.databases();
    return list.map((entry) => entry.name ?? "");
  });
  expect(databases).toContain(IDB_DATABASE_NAME);

  const stores = await page.evaluate(async (dbName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName);
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(request.error ?? new Error("open failed"));
      };
    });
    const names = Array.from(db.objectStoreNames);
    db.close();
    return names;
  }, IDB_DATABASE_NAME);
  expect(stores).toContain(IDB_STORE_NAME);

  const keys = await readSeededKeys(page);
  const mediaKeys = keys.filter((key) => key.startsWith(MEDIA_BLOB_PREFIX));
  expect(mediaKeys).toHaveLength(1);
});

test("seeded cell ids match the ids the app renders", async ({ page }) => {
  const seed = await seedProject(page, {
    panels: 1,
    gridSize: 12,
    distinctMedia: 2,
    spec: SIZES.small,
    filledCellsPerPanel: 3
  });
  await page.goto("/");

  const panelId = seed.panelIds[0] ?? "";
  const expectedCellIds = seed.cellIdsByPanel[panelId] ?? [];
  expect(expectedCellIds).toEqual(getPanelCellIds(12));

  await expect(page.locator("[data-cell-id]")).toHaveCount(expectedCellIds.length);
  const renderedCellIds = await page.locator("[data-cell-id]").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-cell-id") ?? "")
  );
  expect(renderedCellIds).toEqual(expectedCellIds);
});

test("seeded media blobs are readable by the app", async ({ page }) => {
  const seed = await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 2,
    spec: SIZES.small,
    filledCellsPerPanel: 2
  });
  await page.goto("/");

  const keys = await readSeededKeys(page);
  for (const asset of seed.media) {
    expect(keys).toContain(`${MEDIA_BLOB_PREFIX}${asset.id}`);
  }

  // The seeded layout must actually render the assigned media, which proves the state shape
  // survives `sanitizeImportedState`.
  await expect(page.getByRole("button", { name: "Ячейка 1 Seed 0" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ячейка 2 Seed 1" })).toBeVisible();
});

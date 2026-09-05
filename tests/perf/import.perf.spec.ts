import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { makeWavBuffer } from "../support/audioFixtures";
import { readStorageEstimate } from "../support/seedProject";
import { expectWithinBaseline } from "./support/baseline";
import { installPerfInstrumentation } from "./support/instrument";

/**
 * Import cost through the real file input, which is the only path that exercises duration reading
 * and the IndexedDB writes together.
 */

const FILE_COUNT = 24;
const SPEC = { seconds: 3, channels: 1, freqHz: 220 } as const;

test("importing a folder of files stays within its baseline", async ({ page }) => {
  const directory = join(process.cwd(), "test-results", "perf-fixtures");
  await mkdir(directory, { recursive: true });

  const paths: string[] = [];
  for (let index = 0; index < FILE_COUNT; index += 1) {
    const path = join(directory, `import-${String(index).padStart(3, "0")}.wav`);
    await writeFile(path, makeWavBuffer(SPEC));
    paths.push(path);
  }

  await installPerfInstrumentation(page);
  await page.goto("/");

  const dialogStartedAt = Date.now();
  await page.getByTestId("audio-file-input").setInputFiles(paths);
  const importDialog = page.getByRole("dialog", { name: "Импорт аудио" });
  await expect(importDialog).toBeVisible();
  // The dialog is usable only once every duration has been read, which is the part that used to
  // hang forever on a file whose metadata never loaded.
  await importDialog
    .getByRole("cell", { name: "import-000.wav", exact: true })
    .click({ timeout: 60_000 });
  const readyMs = Date.now() - dialogStartedAt;

  const saveStartedAt = Date.now();
  await page.getByLabel("Выбрать все аудио").click();
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(importDialog).toBeHidden({ timeout: 60_000 });
  const persistMs = Date.now() - saveStartedAt;

  const estimate = await readStorageEstimate(page);

  expectWithinBaseline("import-24-small", {
    importReadyMsPerFile: {
      value: Math.round(readyMs / FILE_COUNT),
      unit: "ms",
      gate: "soft",
      absFloor: 10
    },
    importPersistMsPerFile: {
      value: Math.round(persistMs / FILE_COUNT),
      unit: "ms",
      gate: "soft",
      absFloor: 10
    },
    // Recorded, not gated: the quota accounting lags the writes, so the value read right after
    // the save is not a stable quantity.
    storageUsageBytes: { value: estimate.usage ?? 0, unit: "bytes", gate: "record" }
  });
});

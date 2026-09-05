import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { makeWavBuffer } from "../support/audioFixtures";

/**
 * `readAudioDurationMs` used to wait forever on a file that fires neither `loadedmetadata` nor
 * `error`. Both import paths await `Promise.all` over batches of 24, so one stuck file froze the
 * whole import behind a full-screen backdrop with no way out.
 */
async function installSilentAudio(page: Page) {
  await page.addInitScript(() => {
    class StuckAudio extends EventTarget {
      preload = "";
      currentTime = 0;
      volume = 1;
      readonly duration = NaN;

      // Neither "loadedmetadata" nor "error" is ever dispatched.
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
      canPlayType() {
        return "maybe";
      }
    }
    Object.defineProperty(window, "Audio", { value: StuckAudio, configurable: true });
  });
}

function wavFiles(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    name: `stuck-${String(index)}.wav`,
    mimeType: "audio/wav",
    buffer: makeWavBuffer({ seconds: 0.1, channels: 1, freqHz: 220 })
  }));
}

test("an import survives files whose metadata never loads", async ({ page }) => {
  await installSilentAudio(page);
  await page.goto("/");

  await page.getByTestId("audio-file-input").setInputFiles(wavFiles(3));
  const importDialog = page.getByRole("dialog", { name: "Импорт аудио" });
  await expect(importDialog).toBeVisible();

  // The blocking backdrop must lift within the 5 s timeout. Before the fix this click was
  // intercepted forever and the whole app was unusable until a reload.
  await importDialog
    .getByRole("cell", { name: "stuck-0.wav", exact: true })
    .click({ timeout: 9000 });

  // Unknown durations render as the placeholder rather than hanging.
  await expect(importDialog.getByText("--:--").first()).toBeVisible();

  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(importDialog).toBeHidden();
});

test("a full batch of stuck files still resolves", async ({ page }) => {
  await installSilentAudio(page);
  await page.goto("/");

  // 24 is the batch size the import awaits with Promise.all.
  await page.getByTestId("audio-file-input").setInputFiles(wavFiles(24));
  const importDialog = page.getByRole("dialog", { name: "Импорт аудио" });
  await expect(importDialog).toBeVisible();

  await importDialog
    .getByRole("cell", { name: "stuck-5.wav", exact: true })
    .click({ timeout: 12_000 });
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(importDialog).toBeHidden();
});

test("a healthy import is not delayed by the timeout", async ({ page }) => {
  await page.goto("/");

  const startedAt = Date.now();
  await page.getByTestId("audio-file-input").setInputFiles(wavFiles(3));
  const importDialog = page.getByRole("dialog", { name: "Импорт аудио" });
  await expect(importDialog).toBeVisible();
  await importDialog.getByRole("cell", { name: "stuck-0.wav", exact: true }).click();
  // Real WAV metadata resolves immediately; the 5 s guard must not be on the happy path.
  expect(Date.now() - startedAt).toBeLessThan(5000);

  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(importDialog).toBeHidden();
  await expect(page.getByText("--:--")).toHaveCount(0);
});

import { expect, test } from "@playwright/test";
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";

import {
  installPerfInstrumentation,
  perfGoto,
  readPerfProbe
} from "./support/instrument";
import { expectWithinBaseline, median } from "./support/baseline";

/**
 * The codec axis, measured separately and only when a real corpus is present.
 *
 * The committed baseline uses synthesized WAV, which makes decoded PCM bytes an exact quantity but
 * understates decode CPU — the two costs are independent and mixing them would add variance to
 * exactly the numbers the memory work needs to be stable. A synthesized MP3 is not an option
 * either: the only thing that can be built without a dependency is a tiled silent frame, which is
 * the cheapest possible Huffman decode and would produce a confidently optimistic number.
 *
 * Drop real files into `tests/fixtures/audio/` (gitignored) to measure this axis.
 */

const FIXTURE_DIR = join(process.cwd(), "tests", "fixtures", "audio");
const EXTENSIONS = new Set([".mp3", ".m4a", ".ogg", ".opus", ".aac", ".flac"]);

test("decode cost of a real audio corpus", async ({ page }) => {
  test.skip(
    !existsSync(FIXTURE_DIR),
    "Drop real audio into tests/fixtures/audio/ to measure codec cost."
  );

  const names = (await readdir(FIXTURE_DIR)).filter((name) =>
    EXTENSIONS.has(extname(name).toLowerCase())
  );
  test.skip(names.length === 0, "tests/fixtures/audio/ contains no supported audio files.");

  // PATHS, not buffers. `setInputFiles` refuses a payload over 50 MB, and a realistic corpus of
  // twelve tracks is roughly twice that - so reading them into memory here made the spec fail as
  // soon as it stopped being skipped, which is the one moment it was supposed to start working.
  const files = names.slice(0, 12).map((name) => ({ name, path: join(FIXTURE_DIR, name) }));

  await installPerfInstrumentation(page);
  await perfGoto(page, "/");

  await page.getByTestId("audio-file-input").setInputFiles(files.map((file) => file.path));
  const importDialog = page.getByRole("dialog", { name: "Импорт аудио" });
  await expect(importDialog).toBeVisible();
  await page.getByLabel("Выбрать все аудио").click();
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(importDialog).toBeHidden({ timeout: 120_000 });

  await page.getByRole("button", { name: "Режим редактирования" }).click();
  for (const [index, file] of files.entries()) {
    await page.getByRole("button", { name: `Пустая ячейка ${String(index + 1)}`, exact: true }).click();
    await page.getByRole("button", { name: `Выбрать ${file.name}` }).click();
  }
  await page.getByRole("button", { name: "Режим редактирования" }).click();

  await expect(page.locator('[data-warm-state="ready"]')).toHaveCount(files.length, {
    timeout: 300_000
  });

  const probe = await readPerfProbe(page);
  const perMb = probe.decodes
    .filter((sample) => sample.settledAt !== null && sample.inputBytes > 0)
    .map((sample) => ((sample.settledAt ?? 0) - sample.startedAt) / (sample.inputBytes / 1e6));
  const expansion = probe.decodes
    .filter((sample) => sample.inputBytes > 0 && sample.outputBytes > 0)
    .map((sample) => sample.outputBytes / sample.inputBytes);

  expectWithinBaseline("codec-cost", {
    decodeMsPerMb: { value: median(perMb), unit: "ms/MB", gate: "soft", absFloor: 2 },
    // How much a source byte expands once decoded. The WAV-based scenarios can be divided by this
    // to translate their IndexedDB numbers into real-library terms.
    decodedBytesPerSourceByte: { value: median(expansion), unit: "ratio", gate: "soft", absFloor: 1 }
  });
});

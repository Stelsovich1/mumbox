import { expect, test } from "@playwright/test";

import { diagPartial, diagPcmBytes } from "../support/diag";
import {
  hasMp3Fixtures,
  MP3_FIXTURE_SKIP_REASON,
  readMp3Fixtures
} from "../support/mp3Fixtures";

/**
 * The MP3 decoder path, exercised against real files and the browser's real decoder.
 *
 * Everything else in the suite mocks Web Audio or feeds it synthesized WAV, and both choices are
 * right for what they measure — but together they left the MP3 half of the byte-range feature with
 * no coverage of any kind. `partialSource.ts` has no unit tests, and `ensureMp3Alignment` was
 * reached by no test at all.
 *
 * Deliberately no `installBufferAudioMock` here: the whole point is the decoder the user has.
 *
 * Read the header comment in `tests/support/mp3Fixtures.ts` before treating a green run here as
 * coverage — the corpus is a single shape (MPEG-1, 44.1 kHz, stereo, 192 kbps, no ID3v2) and says
 * nothing about MPEG-2, mono, tagged files or true CBR.
 */

test.describe(() => {
  test.skip(!hasMp3Fixtures(2), MP3_FIXTURE_SKIP_REASON);
  test.skip(({ isMobile }) => isMobile, "decoding a real corpus is desktop-only in this suite");

  test("streams whole untrimmed tracks instead of decoding them in full", async ({ page }) => {
    test.setTimeout(180_000);
    const files = readMp3Fixtures(2);

    await page.goto("/");
    await page.getByTestId("audio-file-input").setInputFiles(files);

    const importDialog = page.getByRole("dialog", { name: "Импорт аудио" });
    await expect(importDialog).toBeVisible();
    await page.getByLabel("Выбрать все аудио").click();
    await page.getByRole("button", { name: "Сохранить" }).click();
    await expect(importDialog).toBeHidden({ timeout: 120_000 });

    await page.getByRole("button", { name: "Режим редактирования" }).click();
    for (const [index, file] of files.entries()) {
      await page
        .getByRole("button", { name: `Пустая ячейка ${String(index + 1)}`, exact: true })
        .click();
      await page.getByRole("button", { name: `Выбрать ${file.name}` }).click();
    }
    await page.getByRole("button", { name: "Режим редактирования" }).click();

    await expect(page.locator('[data-warm-state="ready"]')).toHaveCount(files.length, {
      timeout: 150_000
    });

    const partial = await diagPartial(page);
    expect(partial?.probes.mp3).toBe(files.length);

    // A whole untrimmed track has nothing to skip, so `shouldReadRange` correctly declines it — the
    // saving has to come from streaming the window in segments. If `served.streamed` is 0 the
    // feature is inert on the dominant shape of a real project and every such cell pays a full
    // decode: 300 s of stereo is 105.8 MB of resident PCM, and a panel of twelve is 1.27 GB.
    expect(partial?.served.streamed).toBe(files.length);
    expect(partial?.served.declined).toBe(0);

    // The head of a streamed window is 0.5 s, so two cells are well under a megabyte. Two full
    // decodes of these fixtures would be roughly 190 MB.
    expect(await diagPcmBytes(page)).toBeLessThan(4 * 1024 * 1024);
  });
});

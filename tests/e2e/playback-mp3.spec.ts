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

  test("a streamed track keeps playing past its head", async ({ page }) => {
    // The defect this pins is the one a user reports as "the pad plays half a second and stops",
    // and every assertion in the test above passes while it is present: the route DOES stream, the
    // head IS served from a range read, and resident PCM IS small. What none of them touch is
    // whether the cue survives its first seam.
    //
    // Two independent causes, both fixed together:
    //  - `verifyMp3Alignment` was handed a frame table that had never been scanned. A freshly built
    //    VBR index has `frameCount === 0` (the table fills lazily), so the guard at the top read
    //    "too short", returned `skipped`, and `alignDeltaSamples` stayed null forever. Every real
    //    file takes that path: at 192 kbps / 44.1 kHz the padding bit alternates, so
    //    `constantFrameBytes` is null and `fillConstantBitrateIndex` never runs.
    //  - `planMediaSegments` only refused an unmeasured MP3 when the window started mid-file. An
    //    untrimmed window starts at 0, so the plan was accepted, the head played, and then every
    //    segment after it was refused by `decodeMp3Range` — which needs the offset because it
    //    starts mid-file whatever the window did. `promoteToLast` ended the cue at 0.5 s.
    //
    // A loop is unaffected and that is diagnostic rather than coincidental: loops are excluded from
    // streaming, so they take the full decode and never reach a seam.
    test.setTimeout(180_000);
    const files = readMp3Fixtures(1);

    await page.goto("/");
    await page.getByTestId("audio-file-input").setInputFiles(files);
    const importDialog = page.getByRole("dialog", { name: "Импорт аудио" });
    await expect(importDialog).toBeVisible();
    await page.getByLabel("Выбрать все аудио").click();
    await page.getByRole("button", { name: "Сохранить" }).click();
    await expect(importDialog).toBeHidden({ timeout: 120_000 });

    await page.getByRole("button", { name: "Режим редактирования" }).click();
    await page.getByRole("button", { name: "Пустая ячейка 1", exact: true }).click();
    const first = files[0];
    if (!first) {
      throw new Error("fixture");
    }
    await page.getByRole("button", { name: `Выбрать ${first.name}` }).click();
    await page.getByRole("button", { name: "Режим редактирования" }).click();
    await expect(page.locator('[data-warm-state="ready"]')).toHaveCount(1, { timeout: 150_000 });

    // The measurement itself, asserted directly: without it the cue cannot continue, and a
    // `skipped` verdict leaves `fail` at zero, so no existing counter would have shown this.
    const warm = await diagPartial(page);
    expect(warm?.verifications.pass).toBeGreaterThan(0);
    expect(warm?.verifications.skipped).toBe(0);

    const cell = page.locator("[data-cell-id]").first();
    await cell.click();
    await expect(cell).toHaveAttribute("data-playing", "true");

    // Past the 0.5 s head and past the first seam, in real time against the real decoder — there is
    // no audio mock here to advance a clock with.
    await page.waitForTimeout(6_000);
    await expect(cell).toHaveAttribute("data-playing", "true");

    const playing = await diagPartial(page);
    // At least one segment after the head was decoded and scheduled...
    expect(playing?.segments.scheduled).toBeGreaterThan(0);
    // ...and none of them gave up, which is how the cue used to end at the head.
    expect(playing?.segments.missed).toBe(0);
  });
});

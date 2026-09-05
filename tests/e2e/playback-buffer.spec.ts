import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  advanceAudioClock,
  breakAudioContext,
  installBufferAudioMock,
  installMediaAudioMock,
  readProbe
} from "../support/audioMock";
import { seedProject } from "../support/seedProject";
import type { SeedPlan } from "../support/seedProject";

/**
 * Coverage for `startBufferRoute` — the path every real browser takes and the one the existing
 * suite has never executed, because `installAudioMock` in `app-shell.spec.ts` defines no
 * `createBufferSource`.
 */

const SPEC = { seconds: 4, channels: 1, freqHz: 220 } as const;

async function setup(page: Page, plan: Partial<SeedPlan> = {}) {
  const seed = await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 3,
    spec: SPEC,
    filledCellsPerPanel: 3,
    ...plan
  });
  await page.goto("/");
  return seed;
}

function cell(page: Page, number: number) {
  return page.getByRole("button", { name: `Ячейка ${String(number)} Seed ${String(number - 1)}` });
}

async function waitForWarm(page: Page, count: number) {
  await expect(page.locator('[data-warm-state="ready"]')).toHaveCount(count, { timeout: 15_000 });
}

test.describe("buffer route", () => {
  test("plays through an AudioBufferSourceNode with an exact start window", async ({ page }) => {
    await installBufferAudioMock(page);
    await setup(page);
    await waitForWarm(page, 3);

    await cell(page, 1).click();
    await expect(cell(page, 1)).toHaveAttribute("data-playing", "true");

    const probe = await readProbe(page);
    expect(probe.sources).toHaveLength(1);
    expect(probe.sources[0]?.startCalls).toEqual([{ when: 0, offset: 0, duration: 4 }]);
    // envelopeGain then volumeGain, in that order.
    expect(probe.gains.length).toBeGreaterThanOrEqual(2);
    // No object URL and no per-route context: those belong to the media-element fallback.
    expect(probe.objectUrls.created).toHaveLength(0);
    expect(probe.contexts.filter((entry) => entry.kind === "audio")).toHaveLength(1);
  });

  test("starts inside the trimmed window", async ({ page }) => {
    await installBufferAudioMock(page);
    await setup(page, { trimStartMs: 1000, trimEndMs: 2500 });
    await waitForWarm(page, 3);

    await cell(page, 1).click();
    await expect(cell(page, 1)).toHaveAttribute("data-playing", "true");

    const probe = await readProbe(page);
    expect(probe.sources[0]?.startCalls[0]?.offset).toBeCloseTo(1, 6);
    expect(probe.sources[0]?.startCalls[0]?.duration).toBeCloseTo(1.5, 6);
  });

  test("clamps a trim window that runs past the media duration", async ({ page }) => {
    await installBufferAudioMock(page);
    await setup(page, {
      filledCellsPerPanel: 3,
      cellPatch: (index) => {
        if (index === 0) {
          return { trimStartMs: 10_000, trimEndMs: 20_000 };
        }
        if (index === 1) {
          return { trimStartMs: 3000, trimEndMs: 1000 };
        }
        return { trimStartMs: 500, trimEndMs: 99_000 };
      }
    });
    await waitForWarm(page, 3);

    // Start beyond the media: the clamped window collapses to zero and nothing is scheduled.
    await cell(page, 1).click();
    await expect(cell(page, 1)).toHaveAttribute("data-playing", "false");
    expect((await readProbe(page)).sources).toHaveLength(0);

    // End before start: same collapse.
    await cell(page, 2).click();
    await expect(cell(page, 2)).toHaveAttribute("data-playing", "false");
    expect((await readProbe(page)).sources).toHaveLength(0);

    // End beyond the media clamps down to the media duration.
    await cell(page, 3).click();
    await expect(cell(page, 3)).toHaveAttribute("data-playing", "true");
    const probe = await readProbe(page);
    expect(probe.sources).toHaveLength(1);
    expect(probe.sources[0]?.startCalls[0]?.offset).toBeCloseTo(0.5, 6);
    expect(probe.sources[0]?.startCalls[0]?.duration).toBeCloseTo(3.5, 6);
  });

  test("builds a fresh source on every loop iteration", async ({ page }) => {
    // Unlike the media-element path, a looping buffer route cannot restart in place: an
    // AudioBufferSourceNode is single-use. The previous chain is disconnected before the next one
    // is built, so the node count per iteration is bounded.
    await installBufferAudioMock(page);
    await setup(page, { cellPatch: () => ({ playbackMode: "loop" }) });
    await waitForWarm(page, 3);

    await cell(page, 1).click();
    await expect(cell(page, 1)).toHaveAttribute("data-playing", "true");

    await advanceAudioClock(page, 4.1);
    await expect
      .poll(async () => (await readProbe(page)).sources.length, { timeout: 5000 })
      .toBe(2);
    await expect(cell(page, 1)).toHaveAttribute("data-playing", "true");

    await advanceAudioClock(page, 4.1);
    await expect
      .poll(async () => (await readProbe(page)).sources.length, { timeout: 5000 })
      .toBe(3);
  });

  test("stops a non-looping cell when its window ends", async ({ page }) => {
    await installBufferAudioMock(page);
    await setup(page);
    await waitForWarm(page, 3);

    await cell(page, 1).click();
    await expect(cell(page, 1)).toHaveAttribute("data-playing", "true");

    await advanceAudioClock(page, 4.1);
    await expect(cell(page, 1)).toHaveAttribute("data-playing", "false");
  });

  test("tears the route down on stop", async ({ page }) => {
    await installBufferAudioMock(page);
    await setup(page);
    await waitForWarm(page, 3);

    await cell(page, 1).click();
    await expect(cell(page, 1)).toHaveAttribute("data-playing", "true");
    await cell(page, 1).click();
    await expect(cell(page, 1)).toHaveAttribute("data-playing", "false");

    await expect
      .poll(
        async () => {
          const probe = await readProbe(page);
          return {
            sourceDisconnects: probe.sources[0]?.disconnectCalls ?? 0,
            gainDisconnects: probe.gains.filter((gain) => gain.disconnectCalls > 0).length,
            stopped: (probe.sources[0]?.stopCalls.length ?? 0) > 0
          };
        },
        { timeout: 5000 }
      )
      .toEqual({ sourceDisconnects: 1, gainDisconnects: 2, stopped: true });

    const probe = await readProbe(page);
    // The release ramp runs on envelopeGain before the disconnect.
    const ramped = probe.gains.filter((gain) => gain.gain.ramps.length > 0);
    expect(ramped.length).toBeGreaterThanOrEqual(1);
    expect(ramped[0]?.gain.ramps[0]?.value).toBe(0);
    // A buffer route shares the singleton context; nothing may close it.
    expect(probe.contexts.filter((entry) => entry.kind === "audio" && entry.closed)).toHaveLength(0);
  });

  test("stopOthers actually stops the previous cell", async ({ page }) => {
    await installBufferAudioMock(page);
    await setup(page, { stopOthers: true });
    await waitForWarm(page, 3);

    await cell(page, 1).click();
    await expect(cell(page, 1)).toHaveAttribute("data-playing", "true");
    await cell(page, 2).click();
    await expect(cell(page, 2)).toHaveAttribute("data-playing", "true");
    await expect(cell(page, 1)).toHaveAttribute("data-playing", "false");

    const probe = await readProbe(page);
    expect(probe.sources).toHaveLength(2);
    expect(probe.sources[0]?.stopCalls.length).toBeGreaterThan(0);
    expect(probe.sources[1]?.stopCalls).toHaveLength(0);
  });

  test("keeps both cells playing when stopOthers is off", async ({ page }) => {
    await installBufferAudioMock(page);
    await setup(page, { stopOthers: false });
    await waitForWarm(page, 3);

    await cell(page, 1).click();
    await cell(page, 2).click();
    await expect(cell(page, 1)).toHaveAttribute("data-playing", "true");
    await expect(cell(page, 2)).toHaveAttribute("data-playing", "true");
  });

  test("a rapid double trigger leaves exactly one route", async ({ page }) => {
    await installBufferAudioMock(page, { decodeDelayMs: 400 });
    await setup(page, { distinctMedia: 1, filledCellsPerPanel: 1 });

    // Both clicks are dispatched inside the page, back to back, so they land while the decode
    // is still in flight. Two awaited Playwright clicks are hundreds of ms apart and the second
    // would simply stop the first route instead of racing it.
    await page.evaluate(() => {
      const target = document.querySelector<HTMLElement>('[data-cell-id="cell-0"]');
      target?.click();
      target?.click();
    });
    await expect(cell(page, 1)).toHaveAttribute("data-playing", "true", { timeout: 10_000 });

    await page.waitForTimeout(600);
    const probe = await readProbe(page);
    expect(probe.sources).toHaveLength(1);
    expect(probe.sources[0]?.stopCalls).toHaveLength(0);
  });

  test("drives the progress loop as the audio clock advances", async ({ page }) => {
    await installBufferAudioMock(page);
    await setup(page);
    await waitForWarm(page, 3);

    await cell(page, 1).click();
    await expect(cell(page, 1)).toHaveAttribute("data-playing", "true");

    const readProgress = async () =>
      cell(page, 1)
        .getAttribute("data-progress")
        .then((value) => Number(value ?? "0"));

    const initial = await readProgress();
    await advanceAudioClock(page, 1);
    await expect.poll(readProgress, { timeout: 5000 }).toBeGreaterThan(initial);
    const middle = await readProgress();
    await advanceAudioClock(page, 1);
    await expect.poll(readProgress, { timeout: 5000 }).toBeGreaterThan(middle);
  });

  test("recovers from a context that is no longer running", async ({ page }) => {
    await installBufferAudioMock(page);
    await setup(page);
    await waitForWarm(page, 3);

    await cell(page, 1).click();
    await expect(cell(page, 1)).toHaveAttribute("data-playing", "true");
    await cell(page, 1).click();
    await expect(cell(page, 1)).toHaveAttribute("data-playing", "false");

    const before = (await readProbe(page)).contexts.filter((entry) => entry.kind === "audio").length;
    await breakAudioContext(page, "interrupted");

    await cell(page, 2).click();
    await expect(cell(page, 2)).toHaveAttribute("data-playing", "true");
    const after = (await readProbe(page)).contexts.filter((entry) => entry.kind === "audio");
    expect(after.length).toBeGreaterThan(before);
    expect(after.some((entry) => entry.closed)).toBe(true);
  });

  test("reaches the ready warm state and decodes each media once", async ({ page }) => {
    await installBufferAudioMock(page);
    await setup(page, { distinctMedia: 3, filledCellsPerPanel: 6 });
    await waitForWarm(page, 6);

    const probe = await readProbe(page);
    // Six cells, three distinct media: the warm-up dedupes by media id.
    expect(probe.decodes.filter((entry) => entry.ok === true)).toHaveLength(3);
  });
});

test.describe("media-element fallback", () => {
  test("restarts a loop in place instead of leaking a context, a URL and an element", async ({
    page
  }) => {
    // `startMediaElementFallback` used to re-enter itself on "ended" and overwrite the route
    // without calling `stopRoute`, leaking one AudioContext + one object URL + one
    // HTMLAudioElement per loop. Browsers cap concurrent contexts, so the loop eventually threw.
    await installMediaAudioMock(page);
    await setup(page, {
      distinctMedia: 1,
      filledCellsPerPanel: 1,
      cellPatch: () => ({ playbackMode: "loop" })
    });

    await cell(page, 1).click();
    await expect(cell(page, 1)).toHaveAttribute("data-playing", "true", { timeout: 10_000 });

    for (let index = 0; index < 4; index += 1) {
      await page.evaluate(() => {
        const probe = (
          window as unknown as { __mumboxAudio: { liveMedia: EventTarget[] } }
        ).__mumboxAudio;
        probe.liveMedia.at(-1)?.dispatchEvent(new Event("ended"));
      });
      await page.waitForTimeout(50);
    }

    const probe = await readProbe(page);
    expect(probe.mediaElements).toHaveLength(1);
    // Two contexts total and no more: the engine's singleton plus the one this route owns.
    // Before the fix, four loops produced six — one per iteration, and browsers cap them.
    expect(probe.contexts.filter((entry) => entry.kind === "audio")).toHaveLength(2);
    expect(probe.objectUrls.created).toHaveLength(1);
    expect(probe.objectUrls.revoked).toHaveLength(0);
    // The element was restarted, not recreated.
    expect(probe.mediaElements[0]?.playCalls).toBe(5);
    await expect(cell(page, 1)).toHaveAttribute("data-playing", "true");
  });

  test("does not reschedule the envelope when an unrelated cell is edited", async ({ page }) => {
    // The reschedule effect depends on `cells`, whose identity changes on any cell edit. Without
    // the per-route envelope signature it rebuilt a curve for every live route on every keystroke.
    await installBufferAudioMock(page);
    await setup(page, { distinctMedia: 2, filledCellsPerPanel: 2 });
    await waitForWarm(page, 2);

    await cell(page, 1).click();
    await expect(cell(page, 1)).toHaveAttribute("data-playing", "true");

    const curveCalls = async () => {
      const probe = await readProbe(page);
      return probe.gains.reduce((total, gain) => total + gain.gain.curveCalls, 0);
    };
    const before = await curveCalls();
    expect(before).toBeGreaterThan(0);

    await page.getByRole("button", { name: "Режим редактирования" }).click();
    await cell(page, 2).click();
    await page.getByLabel("Псевдоним").fill("Переименовано");
    await page.getByRole("button", { name: "Сохранить настройки ячейки" }).click();

    await expect(page.getByRole("button", { name: "Ячейка 2 Переименовано" })).toBeVisible();
    expect(await curveCalls()).toBe(before);
  });
});

test.describe("warm-up indication", () => {
  test("pulses while a cell is warming", async ({ page }) => {
    await installBufferAudioMock(page, { decodeDelayMs: 2000 });
    await setup(page, { distinctMedia: 2, filledCellsPerPanel: 2 });

    const warming = page.locator('[data-warm-state="warming"]').first();
    await expect(warming).toBeVisible({ timeout: 15_000 });
    await expect(warming).toHaveCSS("animation-name", "mumbox-cell-warm");
    await expect(warming).toHaveCSS("animation-iteration-count", "infinite");
    await expect(warming).toHaveCSS("animation-duration", "0.72s");
  });

  test("keeps the warm state visible without motion under reduced motion", async ({ page }) => {
    // The global reduced-motion rule in global.css collapses every animation to one 0.01 ms
    // frame. For decoration that is correct; for a status indicator it deletes the information
    // and leaves a twitch, so the state has to survive statically.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await installBufferAudioMock(page, { decodeDelayMs: 2000 });
    await setup(page, { distinctMedia: 2, filledCellsPerPanel: 2 });

    const warming = page.locator('[data-warm-state="warming"]').first();
    await expect(warming).toBeVisible({ timeout: 15_000 });
    // The pulse is gone, as the setting asks.
    await expect(warming).toHaveCSS("animation-duration", "1e-05s");
    // The signal is not.
    await expect(warming).toHaveCSS("border-style", "dashed");
    await expect(warming).toHaveCSS("opacity", "0.6");

    const idle = page.locator('[data-warm-state="idle"]').first();
    await expect(idle).toHaveCSS("border-style", "solid");
  });
});

test.describe("un-warmed cells", () => {
  test("a cell holding media that is not decoded yet reads as a third state", async ({ page }) => {
    // Warming and ready were distinguishable; idle-with-media was not distinguishable from ready,
    // so there was no way to see which pads would start instantly.
    await installBufferAudioMock(page, { decodeDelayMs: 4000 });
    // More cells than the warm-up pool is wide, so the last one is still untouched while the
    // first batch decodes. On a 6x6 grid the eighth filled cell is cell-13.
    await setup(page, { distinctMedia: 8, filledCellsPerPanel: 8 });

    // The same cell before and after: comparing two different cells would compare two different
    // palette colours and prove nothing.
    const cellThree = page.locator('[data-cell-id="cell-13"]');
    await expect(cellThree).toHaveAttribute("data-warm-state", "idle");
    const idleColor = await cellThree.evaluate((node) => getComputedStyle(node).backgroundColor);

    await expect(cellThree).toHaveAttribute("data-warm-state", "ready", { timeout: 60_000 });
    const readyColor = await cellThree.evaluate((node) => getComputedStyle(node).backgroundColor);

    expect(idleColor).not.toBe(readyColor);

    // Darker, not merely different: the un-warmed look is the cell colour dimmed.
    const luminance = (rgb: string) => {
      const [r = 0, g = 0, b = 0] = (rgb.match(/\d+/g) ?? []).map(Number);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    expect(luminance(idleColor)).toBeLessThan(luminance(readyColor));
  });
});

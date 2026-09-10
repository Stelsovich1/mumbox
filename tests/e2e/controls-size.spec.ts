import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

/**
 * Geometry and touch behaviour of the master volume control, plus the tab strip's tap target.
 *
 * These are pinned as numbers on purpose: all four are deliberate sizes chosen for a thumb, and
 * every one of them is the kind of value a later `sx` tidy-up silently halves.
 */

function slider(page: Page): Locator {
  return page.locator(".MuiSlider-root");
}

async function heightOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error("element has no box");
  }
  return box.height;
}

async function widthOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error("element has no box");
  }
  return box.width;
}

test("the volume slider keeps its enlarged travel and rail", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Desktop geometry.");
  await page.goto("/");

  // 234 = the old 180 plus 30 %.
  expect(await heightOf(slider(page))).toBeCloseTo(234, 0);
  expect(await widthOf(page.locator(".MuiSlider-rail"))).toBeCloseTo(16, 0);
  expect(await widthOf(page.locator(".MuiSlider-thumb"))).toBeCloseTo(30, 0);
  // The whole hit area fits the 64 px sidebar column, so none of it is clipped away.
  expect(await widthOf(slider(page))).toBeLessThanOrEqual(64);
});

test("the volume slider stays inside the narrow mobile landscape sidebar", async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-landscape", "Mobile landscape geometry.");
  await page.goto("/");

  // 114 = the old 88 plus 30 %.
  expect(await heightOf(slider(page))).toBeCloseTo(114, 0);
  expect(await widthOf(page.locator(".MuiSlider-rail"))).toBeCloseTo(8, 0);
  // The sidebar column is 46 px wide there; anything wider would clip.
  expect(await widthOf(slider(page))).toBeLessThanOrEqual(46);
});

test("a touch drag on the volume slider keeps the value it was released at", async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-landscape", "Touch only.");
  await page.goto("/");

  const input = page.getByLabel("Общая громкость");
  const before = Number(await input.inputValue());
  const track = await slider(page).boundingBox();
  const thumb = await page.locator(".MuiSlider-thumb").boundingBox();
  if (!track || !thumb) {
    throw new Error("slider has no box");
  }
  const x = track.x + track.width / 2;
  const startY = thumb.y + thumb.height / 2;
  // Downwards on a vertical slider is quieter, so the released value must be below the seeded one.
  const endY = track.y + track.height - 2;

  await page.evaluate(
    (points) => {
      const root = document.querySelector(".MuiSlider-root");
      if (!root) {
        throw new Error("no slider root");
      }
      const event = (type: string, clientY: number) => {
        const touch = new Touch({
          identifier: 1,
          target: root,
          clientX: points.x,
          clientY
        });
        const ended = type === "touchend";
        return new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: ended ? [] : [touch],
          targetTouches: ended ? [] : [touch],
          changedTouches: [touch]
        });
      };

      root.dispatchEvent(event("touchstart", points.startY));
      document.dispatchEvent(event("touchmove", (points.startY + points.endY) / 2));
      document.dispatchEvent(event("touchmove", points.endY));
      document.dispatchEvent(event("touchend", points.endY));
    },
    { x, startY, endY }
  );

  await expect
    .poll(async () => Number(await input.inputValue()))
    .toBeLessThan(before);

  // The reported glitch was the thumb springing back once the finger left it, so the value is read
  // again after the gesture has had time to settle.
  const released = Number(await input.inputValue());
  await page.waitForTimeout(600);
  expect(Number(await input.inputValue())).toBe(released);
  const thumbAfter = await page.locator(".MuiSlider-thumb").boundingBox();
  expect(thumbAfter?.y ?? 0).toBeGreaterThan(thumb.y);
});

test("the panel tab strip keeps a thumb-sized tap target on mobile landscape", async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-landscape", "Mobile landscape layout.");
  await page.goto("/");

  const tab = page.getByRole("tab", { name: "Panel 1" });
  // 36 rather than the earlier 32, matching the 38 px header row in `AppShell`.
  expect(await heightOf(tab)).toBeGreaterThanOrEqual(36);
  await expect(tab).toHaveCSS("min-height", "36px");
});

test("the panel delete cross stays vertically centred on mobile landscape", async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-landscape", "Mobile landscape layout.");
  await page.goto("/");

  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Добавить панель" }).click();

  const tab = page.getByRole("tab", { name: "Panel 2" });
  const cross = page.getByRole("button", { name: "Удалить панель Panel 2" });
  const tabBox = await tab.boundingBox();
  const crossBox = await cross.boundingBox();
  if (!tabBox || !crossBox) {
    throw new Error("tab or cross has no box");
  }

  // The taller 38 px header row left a top-anchored cross sitting below the tab text.
  const tabCentre = tabBox.y + tabBox.height / 2;
  const crossCentre = crossBox.y + crossBox.height / 2;
  expect(Math.abs(crossCentre - tabCentre)).toBeLessThanOrEqual(3);
});

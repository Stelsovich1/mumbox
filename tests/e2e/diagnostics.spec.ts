import { expect, test } from "@playwright/test";

import { installBufferAudioMock } from "../support/audioMock";
import {
  diagDecodeCount,
  diagLastTimeToFirstSoundMs,
  diagSnapshot,
  diagTermination,
  diagVersion
} from "../support/diag";
import { seedProject } from "../support/seedProject";

const SESSION_KEY = "mumbox:diag:session:v1";

test("exposes the diagnostics API on a plain load", async ({ page }) => {
  await page.goto("/");
  expect(await diagVersion(page)).toBe(1);
  // The API is not gated, but the overlay is.
  await expect(page.getByTestId("diagnostics-overlay")).toHaveCount(0);
});

test("renders the overlay only under ?diag=1 and only then loads its chunk", async ({ page }) => {
  // One listener writing into a swappable set: two listeners would both keep recording and the
  // second navigation would pollute the first sample.
  let scripts = new Set<string>();
  page.on("request", (request) => {
    if (request.resourceType() === "script") {
      scripts.add(new URL(request.url()).pathname);
    }
  });

  await page.goto("/");
  await expect(page.getByTestId("diagnostics-overlay")).toHaveCount(0);
  const plainScripts = scripts;

  scripts = new Set<string>();
  await page.goto("/?diag=1");
  await expect(page.getByTestId("diagnostics-overlay")).toBeVisible();
  const diagScripts = scripts;

  // Chunk-name agnostic: the diagnostics run must fetch script files the plain run never did.
  const diagOnly = [...diagScripts].filter((path) => !plainScripts.has(path));
  expect(diagOnly.length).toBeGreaterThan(0);
});

test("the overlay expands and never intercepts pointer events", async ({ page }) => {
  await page.goto("/?diag=1");
  const overlay = page.getByTestId("diagnostics-overlay");
  await expect(overlay).toBeVisible();
  await expect(page.getByTestId("diagnostics-overlay-details")).toHaveCount(0);

  await page.getByTestId("diagnostics-overlay-toggle").click();
  await expect(page.getByTestId("diagnostics-overlay-details")).toBeVisible();

  await expect(overlay).toHaveCSS("pointer-events", "none");
  await expect(page.getByTestId("diagnostics-overlay-toggle")).toHaveCSS("pointer-events", "auto");
});

test("reports an ungraceful termination from the previous session", async ({ page }) => {
  await page.addInitScript(
    ({ key }) => {
      localStorage.setItem(
        key,
        JSON.stringify({ id: "previous", startedAt: 1, closedCleanly: false, pcmBytesAtEnd: 12345 })
      );
    },
    { key: SESSION_KEY }
  );
  await page.goto("/");

  const termination = await diagTermination(page);
  expect(termination?.ungraceful).toBe(true);
  expect(termination?.pcmBytesAtEnd).toBe(12345);
});

test("reports a clean termination after a normal navigation away", async ({ page }) => {
  await page.goto("/");
  // Navigating away fires pagehide, which marks the record cleanly closed.
  await page.goto("/mumbox/favicon.svg");
  await page.goto("/");

  const termination = await diagTermination(page);
  expect(termination?.ungraceful).toBe(false);
});

test("records time to first sound for a warmed cell", async ({ page }) => {
  await installBufferAudioMock(page);
  await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 1,
    spec: { seconds: 2, channels: 1, freqHz: 220 },
    filledCellsPerPanel: 1
  });
  await page.goto("/");
  await expect(page.locator('[data-warm-state="ready"]')).toHaveCount(1, { timeout: 15_000 });

  await page.getByRole("button", { name: "Ячейка 1 Seed 0" }).click();
  await expect(page.getByRole("button", { name: "Ячейка 1 Seed 0" })).toHaveAttribute(
    "data-playing",
    "true"
  );

  const ms = await diagLastTimeToFirstSoundMs(page);
  expect(ms).not.toBeNull();
  expect(Number.isFinite(ms)).toBe(true);
});

test("bounds the decode history to 64 entries", async ({ page }) => {
  await installBufferAudioMock(page);
  await seedProject(page, {
    panels: 1,
    gridSize: 12,
    distinctMedia: 100,
    spec: { seconds: 0.05, channels: 1, freqHz: 0 },
    filledCellsPerPanel: 100
  });
  await page.goto("/");

  await expect
    .poll(async () => diagDecodeCount(page), { timeout: 45_000 })
    .toBe(100);

  const snapshot = await diagSnapshot(page);
  expect(Object.keys(snapshot?.decodeMsByMediaId ?? {})).toHaveLength(64);
});

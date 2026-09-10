import type { Page } from "@playwright/test";

import type {
  DiagPartial,
  DiagPcmAccounting,
  DiagSnapshot,
  DiagTermination,
  MumboxDiag
} from "../../src/shared/lib/diagnostics";

/**
 * Typed access to `window.__mumboxDiag` from tests.
 *
 * The `declare global` augmentation lives in `src/`, which belongs to `tsconfig.app.json`; the
 * test files belong to `tsconfig.node.json` and cannot see it. Casting in one place keeps every
 * spec free of `as unknown as` noise.
 */
type DiagWindow = Window & { __mumboxDiag?: MumboxDiag };

export async function diagVersion(page: Page): Promise<number | null> {
  return page.evaluate(() => (window as DiagWindow).__mumboxDiag?.version ?? null);
}

export async function diagSnapshot(page: Page): Promise<DiagSnapshot | null> {
  return page.evaluate(async () => (await (window as DiagWindow).__mumboxDiag?.snapshot()) ?? null);
}

export async function diagTermination(page: Page): Promise<DiagTermination | null> {
  return page.evaluate(() => (window as DiagWindow).__mumboxDiag?.termination() ?? null);
}

export async function diagPcmBytes(page: Page): Promise<number> {
  return page.evaluate(() => (window as DiagWindow).__mumboxDiag?.pcmBytes() ?? -1);
}

export async function diagPcmBytesForActivePanel(page: Page): Promise<number> {
  return page.evaluate(() => (window as DiagWindow).__mumboxDiag?.pcmBytesForActivePanel() ?? -1);
}

export async function diagCacheKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as DiagWindow).__mumboxDiag?.cacheKeys() ?? []);
}

export async function diagCacheStats(page: Page): Promise<DiagPcmAccounting | null> {
  return page.evaluate(() => (window as DiagWindow).__mumboxDiag?.cacheStats() ?? null);
}

export async function diagDecodeCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as DiagWindow).__mumboxDiag?.decodeCount() ?? -1);
}

export async function diagLastWarmupMs(page: Page): Promise<number | null> {
  return page.evaluate(() => (window as DiagWindow).__mumboxDiag?.lastWarmupMs() ?? null);
}

export async function diagLastPanelSwitchMs(page: Page): Promise<number | null> {
  return page.evaluate(() => (window as DiagWindow).__mumboxDiag?.lastPanelSwitchMs() ?? null);
}

export async function diagLastTimeToFirstSoundMs(page: Page): Promise<number | null> {
  return page.evaluate(() => (window as DiagWindow).__mumboxDiag?.lastTimeToFirstSoundMs() ?? null);
}

export async function diagPartial(page: Page): Promise<DiagPartial | null> {
  return page.evaluate(() => (window as DiagWindow).__mumboxDiag?.partial() ?? null);
}

export async function diagSetPartialDecode(page: Page, mode: "auto" | "off" | "force" | null) {
  await page.evaluate((next) => {
    (window as DiagWindow).__mumboxDiag?.setPartialDecode(next);
  }, mode);
}

export async function diagSetBudgetMb(page: Page, mb: number): Promise<void> {
  await page.evaluate((value) => {
    (window as DiagWindow).__mumboxDiag?.setBudgetMb(value);
  }, mb);
}

export async function diagSetMono(page: Page, mono: boolean): Promise<void> {
  await page.evaluate((value) => {
    (window as DiagWindow).__mumboxDiag?.setMono(value);
  }, mono);
}

export async function diagClearCaches(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as DiagWindow).__mumboxDiag?.clearCaches();
  });
}

export async function diagReset(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as DiagWindow).__mumboxDiag?.reset();
  });
}

/**
 * PCM held by live routes. Zero unless something is playing, and the number that the cache-only
 * accounting could never show — a streamed route owns its segments outright.
 */
export async function diagRoutePcmBytes(page: Page): Promise<number> {
  return page.evaluate(() => window.__mumboxDiag?.routePcmBytes() ?? -1);
}

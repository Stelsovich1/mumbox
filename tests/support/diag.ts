import type { Page } from "@playwright/test";

import type {
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

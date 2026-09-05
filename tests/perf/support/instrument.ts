import type { Page } from "@playwright/test";

/**
 * Measurement harness for the performance tier.
 *
 * Everything is installed by wrapping prototypes in the page before the app boots, so the thing
 * being measured is the shipped code — no `performance.mark` calls are added to `src/`.
 */

export type DecodeSample = {
  inputBytes: number;
  startedAt: number;
  settledAt: number | null;
  outputBytes: number;
};

export type PerfProbe = {
  decodes: DecodeSample[];
  sourceStarts: number[];
  frameIntervals: number[];
};

export type FrameStats = {
  frames: number;
  fps: number;
  p95IntervalMs: number;
  maxIntervalMs: number;
};

type PerfWindow = Window & {
  __perf?: {
    decodes: DecodeSample[];
    sourceStarts: number[];
    frameIntervals: number[];
    startFrameSampler: () => void;
    stopFrameSampler: () => void;
  };
};

export async function installPerfInstrumentation(page: Page) {
  await page.addInitScript(() => {
    type Sample = {
      inputBytes: number;
      startedAt: number;
      settledAt: number | null;
      outputBytes: number;
    };

    const decodes: Sample[] = [];
    const sourceStarts: number[] = [];
    const frameIntervals: number[] = [];
    let sampling = false;
    let lastFrameAt = 0;

    const instrumentDecode = (prototype: Record<string, unknown>) => {
      const original = prototype.decodeAudioData as (data: ArrayBuffer) => Promise<AudioBuffer>;
      prototype.decodeAudioData = function decodeAudioData(this: unknown, data: ArrayBuffer) {
        const sample: Sample = {
          inputBytes: data.byteLength,
          startedAt: performance.now(),
          settledAt: null,
          outputBytes: 0
        };
        decodes.push(sample);
        return original.call(this, data).then(
          (buffer) => {
            sample.settledAt = performance.now();
            sample.outputBytes = buffer.length * buffer.numberOfChannels * 4;
            return buffer;
          },
          (error: unknown) => {
            sample.settledAt = performance.now();
            throw error;
          }
        );
      };
    };

    instrumentDecode(OfflineAudioContext.prototype as unknown as Record<string, unknown>);
    instrumentDecode(AudioContext.prototype as unknown as Record<string, unknown>);

    const sourcePrototype = AudioBufferSourceNode.prototype as unknown as Record<string, unknown>;
    const originalStart = sourcePrototype.start as (...args: unknown[]) => void;
    sourcePrototype.start = function start(this: unknown, ...args: unknown[]) {
      sourceStarts.push(performance.now());
      originalStart.apply(this, args);
    };

    const sampleFrame = (now: number) => {
      if (!sampling) {
        return;
      }
      if (lastFrameAt > 0) {
        frameIntervals.push(now - lastFrameAt);
      }
      lastFrameAt = now;
      requestAnimationFrame(sampleFrame);
    };

    (window as PerfWindow).__perf = {
      decodes,
      sourceStarts,
      frameIntervals,
      startFrameSampler: () => {
        frameIntervals.length = 0;
        lastFrameAt = 0;
        sampling = true;
        requestAnimationFrame(sampleFrame);
      },
      stopFrameSampler: () => {
        sampling = false;
      }
    };
  });
}

export async function readPerfProbe(page: Page): Promise<PerfProbe> {
  return page.evaluate(() => ({
    decodes: (window as PerfWindow).__perf?.decodes ?? [],
    sourceStarts: (window as PerfWindow).__perf?.sourceStarts ?? [],
    frameIntervals: (window as PerfWindow).__perf?.frameIntervals ?? []
  }));
}

export async function sampleFrames(page: Page, durationMs: number): Promise<FrameStats> {
  await page.evaluate(() => {
    (window as PerfWindow).__perf?.startFrameSampler();
  });
  await page.waitForTimeout(durationMs);
  return page.evaluate(() => {
    const probe = (window as PerfWindow).__perf;
    probe?.stopFrameSampler();
    const intervals = probe?.frameIntervals ?? [];
    const sorted = [...intervals].sort((first, second) => first - second);
    const total = intervals.reduce((sum, value) => sum + value, 0);
    return {
      frames: intervals.length,
      fps: total > 0 ? (intervals.length / total) * 1000 : 0,
      // With a handful of samples a mean hides exactly the stalls that matter.
      p95IntervalMs: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
      maxIntervalMs: sorted.at(-1) ?? 0
    };
  });
}

export async function readJsHeapBytes(page: Page): Promise<number | null> {
  const session = await page.context().newCDPSession(page);
  try {
    await page.evaluate(() => {
      (globalThis as { gc?: () => void }).gc?.();
    });
    await session.send("Performance.enable");
    const { metrics } = await session.send("Performance.getMetrics");
    return metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value ?? null;
  } catch {
    return null;
  } finally {
    await session.detach().catch(() => undefined);
  }
}

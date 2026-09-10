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

/**
 * Style-system cost, attributed rather than inferred.
 *
 * `insertRule` is the right hook and provably so: in a production build Emotion's sheet runs in
 * speedy mode and every insertion goes through `CSSStyleSheet.prototype.insertRule`. The perf tier
 * builds production, so nothing bypasses this. Ownership is decided once per sheet from
 * `ownerNode.dataset.emotion` and cached.
 *
 * `ruleCount` is read live from the sheets rather than counted here, so it survives a wrapper that
 * missed something. Emotion never removes what it inserts — `flush()` is only reachable from
 * `cache.sheet.flush()`, which MUI never calls — so it is a monotone counter by construction.
 */
export type StyleProbe = {
  emotionInsertRuleCalls: number;
  emotionInsertRuleMs: number;
  /** Distinct rule texts seen, capped so the probe cannot leak while measuring a leak. */
  emotionDistinctRules: number;
  emotionDistinctRulesCapped: boolean;
  /** Live sum of `cssRules.length` over every `style[data-emotion]`. */
  emotionRuleCount: number;
  otherInsertRuleCalls: number;
  longTasks: { supported: boolean; count: number; totalMs: number };
  /**
   * Long Animation Frames — the only in-page API that attributes. `blockingDuration` is additive
   * across frames, which is what makes it gateable where a quantised single frame interval is not.
   */
  loaf: {
    supported: boolean;
    count: number;
    totalMs: number;
    blockingMs: number;
    /** Browser-side style recalc plus layout, separated from script time. */
    styleAndLayoutMs: number;
    /** Script time by script basename. `vite.config.ts` splits MUI (and therefore Emotion) into
     * its own chunk, so this is a real attribution axis — see `scriptMsByChunk`. */
    scriptMsByFile: Record<string, number>;
  };
  /** `performance.now()` at which `[data-cell-id]` first reached each count. */
  cellCountMarks: { count: number; at: number }[];
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
  __perfStyle?: {
    read: () => StyleProbe;
    reset: () => void;
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

    // ---- style-system cost --------------------------------------------------------------------
    const RULE_TEXT_CAP = 20_000;
    let emotionCalls = 0;
    let emotionMs = 0;
    let otherCalls = 0;
    const ruleTexts = new Set<string>();
    let ruleTextsCapped = false;
    const sheetIsEmotion = new WeakMap<object, boolean>();
    const cellCountMarks: { count: number; at: number }[] = [];

    const sheetPrototype = CSSStyleSheet.prototype as unknown as Record<string, unknown>;
    const originalInsertRule = sheetPrototype.insertRule as (...args: unknown[]) => number;
    sheetPrototype.insertRule = function insertRule(this: CSSStyleSheet, ...args: unknown[]) {
      let owned = sheetIsEmotion.get(this);
      if (owned === undefined) {
        const owner = this.ownerNode;
        owned = owner instanceof HTMLStyleElement && owner.dataset.emotion !== undefined;
        sheetIsEmotion.set(this, owned);
      }
      if (!owned) {
        otherCalls += 1;
        return originalInsertRule.apply(this, args);
      }
      if (!ruleTextsCapped) {
        ruleTexts.add(typeof args[0] === "string" ? args[0] : "");
        if (ruleTexts.size >= RULE_TEXT_CAP) {
          ruleTextsCapped = true;
        }
      }
      emotionCalls += 1;
      const startedAt = performance.now();
      try {
        return originalInsertRule.apply(this, args);
      } finally {
        emotionMs += performance.now() - startedAt;
      }
    };

    let longTaskCount = 0;
    let longTaskMs = 0;
    let longTaskSupported = false;
    try {
      const longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTaskCount += 1;
          longTaskMs += entry.duration;
        }
      });
      longTaskObserver.observe({ type: "longtask", buffered: true });
      longTaskSupported = true;
    } catch {
      // Reported as unsupported rather than as 0: a zero would read as "no long tasks".
    }

    type LoafScript = { duration?: number; sourceURL?: string };
    type LoafEntry = PerformanceEntry & {
      blockingDuration?: number;
      styleAndLayoutStart?: number;
      scripts?: LoafScript[];
    };
    let loafCount = 0;
    let loafTotalMs = 0;
    let loafBlockingMs = 0;
    let loafStyleAndLayoutMs = 0;
    let loafSupported = false;
    const scriptMsByFile: Record<string, number> = {};
    try {
      const loafObserver = new PerformanceObserver((list) => {
        for (const raw of list.getEntries()) {
          const entry = raw as LoafEntry;
          loafCount += 1;
          loafTotalMs += entry.duration;
          loafBlockingMs += entry.blockingDuration ?? 0;
          const styleStart = entry.styleAndLayoutStart ?? 0;
          if (styleStart > 0) {
            loafStyleAndLayoutMs += entry.startTime + entry.duration - styleStart;
          }
          for (const script of entry.scripts ?? []) {
            const url = script.sourceURL ?? "";
            const file = url.slice(url.lastIndexOf("/") + 1) || "(inline)";
            scriptMsByFile[file] = (scriptMsByFile[file] ?? 0) + (script.duration ?? 0);
          }
        }
      });
      loafObserver.observe({ type: "long-animation-frame", buffered: true });
      loafSupported = true;
    } catch {
      // LoAF landed in Chrome 123. Without it there is no attribution at all, and saying so is the
      // only honest answer.
    }

    // The grid renders in one commit, so a MutationObserver sees the final count in the same task
    // React built it in. This is "cells in the DOM", not "cells painted" — style and layout for
    // them land afterwards, which is what `styleAndLayoutMs` and `blockingMs` cover.
    let lastCellCount = 0;
    const noteCellCount = () => {
      const count = document.querySelectorAll("[data-cell-id]").length;
      if (count !== lastCellCount) {
        lastCellCount = count;
        cellCountMarks.push({ count, at: performance.now() });
      }
    };
    new MutationObserver(noteCellCount).observe(document, { childList: true, subtree: true });

    const readEmotionRuleCount = () => {
      let total = 0;
      const nodes = document.querySelectorAll("style[data-emotion]");
      for (let index = 0; index < nodes.length; index += 1) {
        const sheet = (nodes.item(index) as HTMLStyleElement | null)?.sheet;
        if (!sheet) {
          continue;
        }
        try {
          total += sheet.cssRules.length;
        } catch {
          // A detached sheet throws; skipping it beats losing the whole reading.
        }
      }
      return total;
    };

    (window as PerfWindow).__perfStyle = {
      read: () => ({
        emotionInsertRuleCalls: emotionCalls,
        emotionInsertRuleMs: emotionMs,
        emotionDistinctRules: ruleTexts.size,
        emotionDistinctRulesCapped: ruleTextsCapped,
        emotionRuleCount: readEmotionRuleCount(),
        otherInsertRuleCalls: otherCalls,
        longTasks: { supported: longTaskSupported, count: longTaskCount, totalMs: longTaskMs },
        loaf: {
          supported: loafSupported,
          count: loafCount,
          totalMs: loafTotalMs,
          blockingMs: loafBlockingMs,
          styleAndLayoutMs: loafStyleAndLayoutMs,
          scriptMsByFile: { ...scriptMsByFile }
        },
        cellCountMarks: [...cellCountMarks]
      }),
      reset: () => {
        emotionCalls = 0;
        emotionMs = 0;
        otherCalls = 0;
        ruleTexts.clear();
        ruleTextsCapped = false;
        longTaskCount = 0;
        longTaskMs = 0;
        loafCount = 0;
        loafTotalMs = 0;
        loafBlockingMs = 0;
        loafStyleAndLayoutMs = 0;
        // Zeroed rather than deleted: the reader copies the object anyway, and a zeroed key is
        // still evidence that the chunk was seen at all — which is what `matched` keys off.
        for (const key of Object.keys(scriptMsByFile)) {
          scriptMsByFile[key] = 0;
        }
      }
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

/**
 * The sample rate the perf tier pins itself to.
 *
 * Decoding follows the hardware now, and every fixture in this repo is a 44.1 kHz WAV. On a machine
 * whose audio device runs at 48 000 two things would happen at once: every `exact` byte gate would
 * move by 48000/44100, and — far worse — those fixtures would stop matching the engine rate, which
 * sends WAV off the byte-range path entirely and collapses `fullDecodeCount` from 0 to 12. Both
 * would read as regressions. Pinning keeps the committed baseline a property of the code rather
 * than of whoever ran it.
 */
export const PERF_SAMPLE_RATE = 44_100;

/**
 * Navigate with the perf tier's pins applied. Use this instead of `page.goto` in `tests/perf`.
 */
export async function perfGoto(page: Page, path = "/"): Promise<void> {
  const [pathname, search = ""] = path.split("?");
  const params = new URLSearchParams(search);
  params.set("rate", String(PERF_SAMPLE_RATE));
  await page.goto(`${pathname ?? "/"}?${params.toString()}`);
}

export async function readStyleProbe(page: Page): Promise<StyleProbe> {
  return page.evaluate(() => {
    const probe = (window as PerfWindow).__perfStyle;
    if (!probe) {
      throw new Error("style probe missing: installPerfInstrumentation must run before goto");
    }
    return probe.read();
  });
}

export async function resetStyleProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as PerfWindow).__perfStyle?.reset();
  });
}

/**
 * Renderer-main-thread throttling, so a number taken on a 32-core Xeon says something about a
 * phone. A magnifier, not a simulator: it slows script and style work but not the compositor, the
 * GPU or memory bandwidth, so readings are comparable arm to arm and never to a real device.
 *
 * Must be applied before `goto` for anything that measures a mount. The CDP session is left
 * attached on purpose — detaching resets the override.
 */
export async function setCpuThrottling(page: Page, rate: number): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate });
}

/**
 * Script time grouped into "the MUI/Emotion chunk" and "our chunk".
 *
 * `vite.config.ts` already splits `manualChunks: { mui: ["@mui/material", "@mui/icons-material"] }`
 * and `@emotion/*` is reachable only from that entry, so Rollup lands Emotion in `mui-*.js`. That
 * makes this a real attribution axis rather than a guess — approximate, because the chunk also
 * holds MUI's own component code.
 *
 * Chunk names are content-hashed, so a build change renames them and naive grouping would silently
 * report 0. `matched` is what the caller must assert on: failing open here is worse than having no
 * metric at all.
 */
export function scriptMsByChunk(probe: StyleProbe): {
  muiMs: number;
  appMs: number;
  otherMs: number;
  matched: boolean;
} {
  let muiMs = 0;
  let appMs = 0;
  let otherMs = 0;
  let matched = false;
  for (const [file, ms] of Object.entries(probe.loaf.scriptMsByFile)) {
    if (/^mui-.*\.js$/.test(file)) {
      muiMs += ms;
      matched = true;
    } else if (/^index-.*\.js$/.test(file)) {
      appMs += ms;
      matched = true;
    } else {
      otherMs += ms;
    }
  }
  // Keyed on the filename being recognised, not on its time being non-zero: a frame whose script
  // time rounds to 0 is ordinary, a renamed chunk is the failure this guard exists for.
  return { muiMs, appMs, otherMs, matched };
}

/** `performance.now()` at which the grid first held exactly `count` cells, or null if it never did. */
export function cellMountMs(probe: StyleProbe, count: number): number | null {
  return probe.cellCountMarks.find((mark) => mark.count === count)?.at ?? null;
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

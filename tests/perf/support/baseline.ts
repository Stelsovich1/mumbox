import { expect } from "@playwright/test";
import { cpus, totalmem } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Baseline storage and comparison.
 *
 * Three gate kinds, deliberately different:
 *
 *   - `hard`  — an ABSOLUTE ceiling on the worst sample. Used for time to first sound, because
 *               the constraint is perceptual. A ratio gate is actively harmful there: against a
 *               3 ms baseline a "1.5x regression" to 4.5 ms is inaudible and would cry wolf,
 *               while against a 90 ms baseline 1.2x is already unacceptable.
 *   - `exact` — an equality. Cached PCM bytes are deterministic because the WAV fixtures are
 *               written at exactly the decode sample rate, so this is really a correctness
 *               assertion that happens to live in the perf tier.
 *   - `soft`  — fails only when BOTH a ratio and an absolute floor are exceeded. The AND is what
 *               kills the classic "5 ms to 8 ms is a 60 % regression" noise.
 *   - `record` — stored and reported, never asserted. For quantities a single sample per run
 *               cannot support: decode throughput on near-free WAV, first paint and heap size all
 *               swing 40-50 % run to run on a shared machine purely from scheduling. Gating them
 *               produces failures that say nothing, and a gate that cries wolf is worse than no
 *               gate because it teaches everyone to rerun until green.
 */

const BASELINE_PATH = join(process.cwd(), "tests", "perf", "baseline.json");
const RESULTS_DIR = join(process.cwd(), "perf-results");

const SOFT_RATIO = 1.3;

export type MetricGate = "hard" | "soft" | "exact" | "record";

export type MetricSpec = {
  value: number;
  unit: string;
  gate: MetricGate;
  /** hard gates only: absolute ceiling, applied to the value passed in. */
  ceiling?: number;
  /** soft gates only: minimum absolute regression before a ratio breach counts. */
  absFloor?: number;
  /**
   * soft gates only: overrides the default ratio for a metric whose own run-to-run variance is
   * wider than the default. Set it from measured spread, not from taste — a gate looser than the
   * regression it is meant to catch is decoration.
   */
  ratio?: number;
  /** soft gates only: set for metrics where higher is better (fps). */
  higherIsBetter?: boolean;
};

export type ScenarioMetrics = Record<string, MetricSpec>;

type BaselineFile = {
  schemaVersion: 1;
  recordedAt: string;
  notes: string;
  env: {
    os: string;
    cpuModel: string;
    cores: number;
    totalMemGb: number;
    node: string;
    ci: boolean;
  };
  scenarios: Record<string, { metrics: Record<string, { value: number; unit: string }> }>;
};

export function getEnvironment(): BaselineFile["env"] {
  return {
    os: process.platform,
    cpuModel: cpus()[0]?.model.trim() ?? "unknown",
    cores: cpus().length,
    totalMemGb: Math.round(totalmem() / 1024 ** 3),
    node: process.version,
    ci: Boolean(process.env.CI)
  };
}

function readBaseline(): BaselineFile | null {
  if (!existsSync(BASELINE_PATH)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as BaselineFile;
  } catch {
    return null;
  }
}

function writeBaseline(file: BaselineFile) {
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

export function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

export function recordRun(scenario: string, metrics: ScenarioMetrics) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = join(RESULTS_DIR, `${scenario}.json`);
  writeFileSync(
    path,
    `${JSON.stringify({ scenario, recordedAt: new Date().toISOString(), metrics }, null, 2)}\n`,
    "utf8"
  );
}

/**
 * Asserts the scenario against the committed baseline, and updates the baseline instead when
 * `PERF_UPDATE_BASELINE=1`.
 */
export function expectWithinBaseline(scenario: string, metrics: ScenarioMetrics) {
  recordRun(scenario, metrics);

  const environment = getEnvironment();

  if (process.env.PERF_UPDATE_BASELINE === "1") {
    const existing = readBaseline();
    const next: BaselineFile = {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      notes:
        "WAV-only fixtures: decode is near-free by design, which isolates memory and IndexedDB " +
        "cost from codec cost. Recorded locally; see codec-cost.perf.spec.ts for the codec axis.",
      env: environment,
      scenarios: {
        ...(existing?.scenarios ?? {}),
        [scenario]: {
          metrics: Object.fromEntries(
            Object.entries(metrics).map(([name, spec]) => [
              name,
              { value: spec.value, unit: spec.unit }
            ])
          )
        }
      }
    };
    writeBaseline(next);
    return;
  }

  // Hard gates are absolute and therefore meaningful with no baseline at all.
  for (const [name, spec] of Object.entries(metrics)) {
    if (spec.gate === "hard" && spec.ceiling !== undefined) {
      expect(spec.value, `${scenario}.${name} exceeds its absolute ceiling`).toBeLessThanOrEqual(
        spec.ceiling
      );
    }
  }

  const baseline = readBaseline();
  const scenarioBaseline = baseline?.scenarios[scenario];
  if (!baseline || !scenarioBaseline) {
    console.warn(
      `[perf] no baseline for "${scenario}". Run PERF_UPDATE_BASELINE=1 npm run test:perf to record one.`
    );
    return;
  }

  // Comparing a CI number against a workstation baseline is how perf gates become the thing
  // everyone ignores. Warn instead.
  const environmentMatches =
    baseline.env.cpuModel === environment.cpuModel && baseline.env.ci === environment.ci;
  const enforce = environmentMatches || process.env.PERF_ALLOW_ENV_MISMATCH === "1";
  if (!enforce) {
    console.warn(
      `[perf] baseline recorded on "${baseline.env.cpuModel}" (ci=${String(baseline.env.ci)}), running on "${environment.cpuModel}" (ci=${String(environment.ci)}). Comparisons are advisory.`
    );
  }

  for (const [name, spec] of Object.entries(metrics)) {
    const recorded = scenarioBaseline.metrics[name];
    if (!recorded) {
      continue;
    }

    if (spec.gate === "record") {
      continue;
    }

    if (spec.gate === "exact") {
      expect(spec.value, `${scenario}.${name} must match the baseline exactly`).toBe(recorded.value);
      continue;
    }

    if (spec.gate === "hard") {
      // The ceiling already ran above; the ratio is a drift warning only.
      if (recorded.value > 0 && spec.value > recorded.value * 1.5) {
        console.warn(
          `[perf] ${scenario}.${name} drifted from ${String(recorded.value)} to ${String(spec.value)} ${spec.unit}`
        );
      }
      continue;
    }

    const floor = spec.absFloor ?? 0;
    const ratio = spec.ratio ?? SOFT_RATIO;
    const regressed = spec.higherIsBetter
      ? spec.value < recorded.value / ratio && recorded.value - spec.value > floor
      : spec.value > recorded.value * ratio && spec.value - recorded.value > floor;

    if (regressed) {
      const message = `${scenario}.${name}: ${String(spec.value)} ${spec.unit} vs baseline ${String(recorded.value)} ${spec.unit}`;
      if (enforce) {
        expect(regressed, message).toBe(false);
      } else {
        console.warn(`[perf] (advisory) ${message}`);
      }
    }
  }
}

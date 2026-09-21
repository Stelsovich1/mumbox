/**
 * Per-DEVICE settings: the knobs that used to exist only as query flags or console calls.
 *
 * Deliberately NOT part of `SerializableAppState`. Everything in there is serialized into the
 * `.mumbox` payload, so a PCM budget chosen for an 8 GB laptop would travel to a phone inside the
 * project file. These are properties of the machine the app runs on, and they stay with it.
 *
 * This module is pure: no DOM, no IndexedDB, no React. `app/model/appStateStorage` owns the record
 * and `shared/lib/appSettingsStore` owns the subscription, so unit tests can reach the resolution
 * rules without loading either.
 */

export type PcmBudgetSetting =
  | { mode: "auto" }
  | { mode: "unlimited" }
  | { mode: "mb"; mb: number };

/**
 * What the warm-up is allowed to do before a pad is pressed.
 *
 * - `full` — every configured cell of the active panel. The behaviour that shipped before settings
 *   existed, and the default.
 * - `time-budget` — stop after a wall-clock budget. Adapts to the machine, which a fixed cell count
 *   cannot: a fast laptop still warms everything, a slow one warms what it managed.
 * - `heads-only` — warm only what the byte-range path is likely to serve without a whole-file
 *   decode: a streamed track caches its 0.5 s head, a trimmed cue its own window. Containers off
 *   that path stay cold. The test is the same HINT the staging exclusion uses, so a wrong guess
 *   costs one unshared decode rather than a wrong buffer.
 * - `on-press` — nothing up front; a press warms the cue it played and its next neighbours.
 */
export type WarmupMode = "full" | "time-budget" | "heads-only" | "on-press";

/**
 * How a cell shows that its audio is not decoded yet.
 *
 * `auto` exists because the dim state is honest only while it is TEMPORARY. Under `full` warm-up a
 * dim pad means "a moment longer"; under any other mode it would mean "this is how it stays", and a
 * grid that is permanently 30 % darker reads as a defect rather than as information.
 */
export type WarmthDisplay = "auto" | "full" | "static" | "off";

/**
 * What `resolveWarmthDisplay` can return — `auto` has already been answered.
 *
 * Separate from `WarmthDisplay` because the grid selects on `[data-warmth='…']` and `auto` matches
 * none of those selectors: a component typed on the wider union would accept it and silently lose
 * every warm indication.
 */
export type ResolvedWarmthDisplay = Exclude<WarmthDisplay, "auto">;

export type LabelScale = "xs" | "sm" | "md" | "lg" | "xl";

export type AppSettings = {
  version: 1;
  performance: {
    pcmBudget: PcmBudgetSetting;
    /**
     * Only `auto` and `off`.
     *
     * The engine also has a `force` mode, and it is deliberately NOT reachable from here: it
     * returns "allowed" before the per-browser verdict is consulted, i.e. it disables the only
     * guard against a browser that cannot decode byte ranges at all. As `?partial=1` that is a
     * one-load debugging switch; as a saved setting it would outlive the session that set it.
     */
    partialDecode: "auto" | "off";
    warmupMode: WarmupMode;
    warmupBudgetSeconds: number;
    warmupYieldsToInput: boolean;
    /** null = derive from the device, as before settings existed. */
    warmupConcurrency: number | null;
  };
  visuals: {
    flatGraphics: boolean;
    warmthDisplay: WarmthDisplay;
    reduceMotion: boolean;
    labelScale: LabelScale;
  };
  diagnostics: {
    overlay: boolean;
  };
};

/**
 * Bumping this RESETS every device's settings, so it is not the tool for an additive change.
 *
 * `parseSettings` falls back field by field, so a new optional field needs no bump at all: an older
 * build ignores it, this one supplies its default. Bump only when an existing field changes MEANING
 * — and note what a bump costs: with `registerType: "prompt"` a device can run last month's build
 * for weeks, so it would read the new record, get defaults, and silently lose the warm-up mode the
 * user chose precisely because the default was killing the tab.
 */
export const SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS: AppSettings = {
  version: SETTINGS_VERSION,
  performance: {
    pcmBudget: { mode: "auto" },
    partialDecode: "auto",
    warmupMode: "full",
    warmupBudgetSeconds: 8,
    warmupYieldsToInput: false,
    warmupConcurrency: null
  },
  visuals: {
    flatGraphics: false,
    warmthDisplay: "auto",
    reduceMotion: false,
    labelScale: "md"
  },
  diagnostics: {
    overlay: false
  }
};

export const MIN_WARMUP_BUDGET_SECONDS = 1;
export const MAX_WARMUP_BUDGET_SECONDS = 120;
export const MIN_PCM_BUDGET_MB = 16;
export const MAX_PCM_BUDGET_MB = 16384;
export const MIN_WARMUP_CONCURRENCY = 1;
export const MAX_WARMUP_CONCURRENCY = 4;

/** Multiplier applied to every cell label and hotkey badge. `md` is 1 by construction. */
export const LABEL_SCALE_FACTORS: Record<LabelScale, number> = {
  xs: 0.78,
  sm: 0.89,
  md: 1,
  lg: 1.14,
  xl: 1.3
};

const WARMUP_MODES: readonly WarmupMode[] = ["full", "time-budget", "heads-only", "on-press"];
const WARMTH_DISPLAYS: readonly WarmthDisplay[] = ["auto", "full", "static", "off"];
const LABEL_SCALES: readonly LabelScale[] = ["xs", "sm", "md", "lg", "xl"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parsePcmBudget(value: unknown): PcmBudgetSetting {
  if (!isRecord(value)) {
    return DEFAULT_SETTINGS.performance.pcmBudget;
  }
  if (value.mode === "unlimited") {
    return { mode: "unlimited" };
  }
  if (value.mode === "mb") {
    return {
      mode: "mb",
      mb: Math.round(clampNumber(value.mb, MIN_PCM_BUDGET_MB, MAX_PCM_BUDGET_MB, MIN_PCM_BUDGET_MB))
    };
  }
  return { mode: "auto" };
}

function parseConcurrency(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(
    clampNumber(value, MIN_WARMUP_CONCURRENCY, MAX_WARMUP_CONCURRENCY, MIN_WARMUP_CONCURRENCY)
  );
}

function parseFromList<T extends string>(value: unknown, list: readonly T[], fallback: T): T {
  return typeof value === "string" && (list as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * Validated field by field: every value is checked against what this build accepts before it is
 * used, and the two casts in `parseFromList` sit behind that check rather than replacing it.
 *
 * The record comes out of storage, which means it may have been written by another build, edited by
 * hand, or truncated — and `noUncheckedIndexedAccess` would not save a caller that simply asserted
 * the shape. An unknown `version` resets to defaults rather than guessing, the same rule the
 * byte-range policy record applies to its own `policy` field: a record whose meaning is unknown is
 * worth less than a known default.
 */
export function parseSettings(raw: unknown): AppSettings {
  if (!isRecord(raw) || raw.version !== SETTINGS_VERSION) {
    return DEFAULT_SETTINGS;
  }
  const performance = isRecord(raw.performance) ? raw.performance : {};
  const visuals = isRecord(raw.visuals) ? raw.visuals : {};
  const diagnostics = isRecord(raw.diagnostics) ? raw.diagnostics : {};
  const defaults = DEFAULT_SETTINGS;

  return {
    version: SETTINGS_VERSION,
    performance: {
      pcmBudget: parsePcmBudget(performance.pcmBudget),
      partialDecode: performance.partialDecode === "off" ? "off" : "auto",
      warmupMode: parseFromList(performance.warmupMode, WARMUP_MODES, defaults.performance.warmupMode),
      warmupBudgetSeconds: Math.round(
        clampNumber(
          performance.warmupBudgetSeconds,
          MIN_WARMUP_BUDGET_SECONDS,
          MAX_WARMUP_BUDGET_SECONDS,
          defaults.performance.warmupBudgetSeconds
        )
      ),
      warmupYieldsToInput: parseBoolean(
        performance.warmupYieldsToInput,
        defaults.performance.warmupYieldsToInput
      ),
      warmupConcurrency: parseConcurrency(performance.warmupConcurrency)
    },
    visuals: {
      flatGraphics: parseBoolean(visuals.flatGraphics, defaults.visuals.flatGraphics),
      warmthDisplay: parseFromList(visuals.warmthDisplay, WARMTH_DISPLAYS, defaults.visuals.warmthDisplay),
      reduceMotion: parseBoolean(visuals.reduceMotion, defaults.visuals.reduceMotion),
      labelScale: parseFromList(visuals.labelScale, LABEL_SCALES, defaults.visuals.labelScale)
    },
    diagnostics: {
      overlay: parseBoolean(diagnostics.overlay, defaults.diagnostics.overlay)
    }
  };
}

/**
 * A stable string for two settings objects, used for the dirty check and for skipping a write.
 *
 * Safe as a comparison key only because every `AppSettings` in the app is built by `parseSettings`
 * or by spreading one that was — so the key order is this module's literal order, not the caller's.
 */
export function serializeSettings(settings: AppSettings): string {
  return JSON.stringify(settings);
}

export function settingsEqual(first: AppSettings, second: AppSettings): boolean {
  return serializeSettings(first) === serializeSettings(second);
}

/**
 * The PCM budget this setting asks for, in the shape `readBudgetOverride` already uses.
 *
 * `present: false` means "say nothing, let the device default decide" — which is NOT the same as
 * asking for no cap, and conflating the two is what a plain `number | null` cannot express: at
 * runtime `null` already means unlimited.
 */
export function resolvePcmBudget(settings: AppSettings): { present: boolean; bytes: number | null } {
  const budget = settings.performance.pcmBudget;
  if (budget.mode === "auto") {
    return { present: false, bytes: null };
  }
  if (budget.mode === "unlimited") {
    return { present: true, bytes: null };
  }
  return { present: true, bytes: Math.round(budget.mb * 1024 * 1024) };
}

export function resolveWarmupConcurrency(settings: AppSettings, deviceDefault: number): number {
  return settings.performance.warmupConcurrency ?? deviceDefault;
}

/** `auto` follows the warm-up mode; see the doc on `WarmthDisplay`. */
export function resolveWarmthDisplay(settings: AppSettings): "full" | "static" | "off" {
  const display = settings.visuals.warmthDisplay;
  if (display !== "auto") {
    return display;
  }
  return settings.performance.warmupMode === "full" ? "full" : "off";
}

export function resolveLabelScaleFactor(settings: AppSettings): number {
  return LABEL_SCALE_FACTORS[settings.visuals.labelScale];
}

/** Section-scoped reset, so «сбросить раздел» does not touch the other sections. */
export function resetSection(settings: AppSettings, section: keyof Omit<AppSettings, "version">): AppSettings {
  return { ...settings, [section]: DEFAULT_SETTINGS[section] };
}

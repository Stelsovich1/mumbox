/**
 * Runtime diagnostics for the audio memory work.
 *
 * `window.__mumboxDiag` is installed unconditionally — the Playwright specs read it on a plain
 * `goto("/")`. Only the overlay UI is gated behind `?diag=1`, and it ships to production on
 * purpose: a deployed GitHub Pages build is the only way to reach real iOS Safari from a
 * Windows workstation, so gating on `import.meta.env.DEV` would make these numbers unreachable
 * exactly where they matter.
 *
 * Memory accounting is analytic, never sampled. `performance.memory` and
 * `measureUserAgentSpecificMemory()` cannot see AudioBuffer PCM — it lives outside the JS heap —
 * and the latter additionally needs cross-origin isolation, which GitHub Pages cannot set.
 */

import {
  getPartialDecodeMode,
  PartialDecodeMode,
  readPartialDecodeRecord,
  setPartialDecodeMode
} from "./partialDecodePolicy";

const SESSION_KEY = "mumbox:diag:session:v1";
const DECODE_HISTORY_LIMIT = 64;
const TIME_TO_FIRST_SOUND_LIMIT = 32;
const HIDDEN_WRITE_THROTTLE_MS = 500;

export type DiagPcmAccounting = {
  totalBytes: number;
  activePanelBytes: number;
  /** Bytes held by buffers a live route is still using; these are never evicted. */
  pinnedBytes: number;
  /** `null` means no budget is set, which is the default. */
  budgetBytes: number | null;
  entries: number;
  hits: number;
  misses: number;
  evictions: number;
  overBudget: boolean;
  /**
   * PCM held by the buffers of live routes, which the cache does not account for at all.
   *
   * A streamed route owns its segments outright; they are never cache entries. Reporting only
   * `totalBytes` therefore understates what the tab is holding by exactly the amount that grows
   * while a long cue plays, which is the one number a memory investigation needs.
   */
  routeBytes: number;
  /** `totalBytes + routeBytes` — what the tab is actually holding. */
  residentBytes: number;
};

export type DiagDecodeEntry = {
  readMs: number;
  decodeMs: number;
  bytes: number;
};

export type DiagTermination = {
  ungraceful: boolean;
  at: number | null;
  pcmBytesAtEnd: number | null;
  panelId: string | null;
  storageUsage: number | null;
};

export type DiagStorage = {
  usage: number | null;
  quota: number | null;
};

/**
 * The service worker readout exists for one reason: `controlled: false` is the state in which the
 * PWA plugin's own reload never fires (see `appUpdate.ts`), and a real iOS device is the only place
 * it can be observed.
 */
export type DiagServiceWorker = {
  supported: boolean;
  /** `navigator.serviceWorker.controller !== null`. */
  controlled: boolean;
  registered: boolean;
  installing: ServiceWorkerState | null;
  waiting: ServiceWorkerState | null;
  active: ServiceWorkerState | null;
  /** A worker is installed and waiting — «Обновить» has something to apply. */
  updatePending: boolean;
};

export type DiagDevice = {
  userAgent: string;
  deviceMemoryGb: number | null;
  hardwareConcurrency: number;
  coarsePointer: boolean;
  standalone: boolean;
};

/**
 * Byte-range decoding, as seen from the outside.
 *
 * Exists because iOS Safari cannot be reached from CI at all — its MP3 decoding goes through
 * CoreAudio, not ffmpeg — so these counters are the only way to find out on a real device whether
 * the feature is working, declining, or blocked. `rangeReads` in particular answers the one
 * assumption the whole design rests on: that reading a slice of an IndexedDB blob reads only the
 * slice. It measured that way in Chromium; a phone reporting bytes far above the windows requested
 * would say otherwise.
 */
export type DiagPartial = {
  mode: string;
  verdict: string;
  uaKey: string;
  probes: { mp3: number; wav: number; unsupported: number };
  /** Windows served without a full decode, split by shape. */
  served: { range: number; streamed: number; declined: number };
  /**
   * `watchdog` counts cues ended by the rAF safety net rather than by their last segment.
   *
   * On a healthy streamed cue it must stay 0: the last segment's `onended` is what ends a cue, and
   * the watchdog exists only for a chain that died. A non-zero value on a working path means the
   * `isLast` bookkeeping is broken — the cue still ends, so nothing sounds wrong, which is exactly
   * why the mechanism has to be observable rather than inferred from timing.
   */
  /**
   * `live` is how many segments a streamed route is holding right now, `peakLive` the high-water
   * mark of the session.
   *
   * They exist because the cache accounting structurally cannot see them: `pcm.totalBytes` reports
   * `playbackBufferCache`, and a segment belongs to a live route. That blind spot let every
   * segment of a cue accumulate for the cue's whole life — 14 of them on a 180 s window, ~63.8 MB
   * — while every memory assertion in the suite read a number that stayed small and correct.
   * `peakLive` is the discrete quantity that would have shown it: bounded by
   * `SEGMENT_LOOKAHEAD + 1`, it was reaching the segment count of the window.
   */
  segments: {
    scheduled: number;
    late: number;
    missed: number;
    watchdog: number;
    live: number;
    peakLive: number;
  };
  verifications: { pass: number; fail: number; skipped: number };
  /** Measured samples between an isolated mid-file decode and the full one, per media. */
  alignDeltaSamples: Record<string, number>;
  rangeReads: { count: number; bytes: number };
};

export type DiagSnapshot = {
  version: 1;
  overlayEnabled: boolean;
  uptimeMs: number;
  pcm: DiagPcmAccounting;
  partial: DiagPartial;
  decodeMsByMediaId: Record<string, DiagDecodeEntry>;
  decodeCount: number;
  lastWarmupMs: number | null;
  lastWarmupWarmed: number;
  lastWarmupSkipped: number;
  lastPanelSwitchEngineMs: number | null;
  lastPanelSwitchPaintMs: number | null;
  lastTimeToFirstSoundMs: number | null;
  timeToFirstSoundMs: number[];
  mono: boolean;
  storage: DiagStorage | null;
  termination: DiagTermination;
  device: DiagDevice;
};

export type MumboxDiag = {
  version: 1;
  snapshot: () => Promise<DiagSnapshot>;
  pcmBytes: () => number;
  /** PCM held by live routes, which `pcmBytes` (the cache) does not see. */
  routePcmBytes: () => number;
  pcmBytesForActivePanel: () => number;
  cacheKeys: () => string[];
  cacheStats: () => DiagPcmAccounting;
  decodeCount: () => number;
  decodeMs: (mediaId: string) => number | null;
  lastWarmupMs: () => number | null;
  lastPanelSwitchMs: () => number | null;
  lastTimeToFirstSoundMs: () => number | null;
  setBudgetMb: (mb: number) => void;
  setMono: (mono: boolean) => void;
  clearCaches: () => void;
  reset: () => void;
  termination: () => DiagTermination;
  serviceWorker: () => DiagServiceWorker;
  /** Byte-range decoding counters, the only way to read this feature on a real device. */
  partial: () => DiagPartial;
  /** `"off"` disables byte-range decoding, `"force"` overrides a blocked verdict, `null` clears. */
  setPartialDecode: (mode: PartialDecodeMode | null) => void;
};

declare global {
  // Declaration merging onto the DOM `Window` requires an interface.
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Window {
    __mumboxDiag?: MumboxDiag;
  }
}

type SessionRecord = {
  id: string;
  startedAt: number;
  // Optional because the record is parsed from untrusted localStorage and older records
  // written before this field existed must read as "not cleanly closed".
  closedCleanly?: boolean;
  pcmBytesAtEnd?: number;
  panelId?: string;
  storageUsage?: number;
};

const EMPTY_ACCOUNTING: DiagCacheAccounting = {
  totalBytes: 0,
  activePanelBytes: 0,
  pinnedBytes: 0,
  budgetBytes: null,
  entries: 0,
  hits: 0,
  misses: 0,
  evictions: 0,
  overBudget: false
};

const state = {
  startedAt: 0,
  marks: new Map<string, number>(),
  decodeMsByMediaId: new Map<string, DiagDecodeEntry>(),
  decodeCount: 0,
  lastWarmupMs: null as number | null,
  lastWarmupWarmed: 0,
  lastWarmupSkipped: 0,
  lastPanelSwitchEngineMs: null as number | null,
  lastPanelSwitchPaintMs: null as number | null,
  timeToFirstSoundMs: [] as number[],
  activePanelId: null as string | null,
  mono: false,
  termination: {
    ungraceful: false,
    at: null,
    pcmBytesAtEnd: null,
    panelId: null,
    storageUsage: null
  } as DiagTermination,
  lastHiddenWriteAt: 0,
  installed: false,
  partial: {
    probes: { mp3: 0, wav: 0, unsupported: 0 },
    served: { range: 0, streamed: 0, declined: 0 },
    segments: { scheduled: 0, late: 0, missed: 0, watchdog: 0, live: 0, peakLive: 0 },
    verifications: { pass: 0, fail: 0, skipped: 0 },
    alignDeltaSamples: new Map<string, number>(),
    rangeReads: { count: 0, bytes: 0 }
  }
};

/**
 * What the cache itself can report. Route-held PCM is composed in below, because the cache has no
 * way of knowing about it — that separation is the whole reason the accumulation went unseen.
 */
export type DiagCacheAccounting = Omit<DiagPcmAccounting, "routeBytes" | "residentBytes">;

let accountingSource: () => DiagCacheAccounting = () => EMPTY_ACCOUNTING;
let routePcmSource: () => number = () => 0;

function getAccounting(): DiagPcmAccounting {
  const base = accountingSource();
  const routeBytes = routePcmSource();
  return { ...base, routeBytes, residentBytes: base.totalBytes + routeBytes };
}
let cacheKeysSource: () => string[] = () => [];
let budgetSink: (bytes: number | null) => void = () => undefined;
let monoSink: (mono: boolean) => void = () => undefined;
let clearCachesSink: () => void = () => undefined;
let serviceWorkerSource: () => ServiceWorkerRegistration | null = () => null;

function readQueryFlag(name: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

let overlayEnabled: boolean | null = null;

export function isDiagnosticsEnabled(): boolean {
  overlayEnabled ??= readQueryFlag("diag") === "1";
  return overlayEnabled;
}

/** `?pcmBudgetMb=NNN` — the knob used to walk the mobile budget up until the device complains. */
export function getBudgetOverrideFromQuery(): number | null {
  const raw = readQueryFlag("pcmBudgetMb");
  if (raw === null) {
    return null;
  }
  const megabytes = Number.parseFloat(raw);
  if (!Number.isFinite(megabytes) || megabytes <= 0) {
    return null;
  }
  return Math.round(megabytes * 1024 * 1024);
}

export function setPcmAccountingSource(
  accounting: () => DiagCacheAccounting,
  keys: () => string[]
): void {
  accountingSource = accounting;
  cacheKeysSource = keys;
}

/** Reports PCM held by live routes, which the cache cannot see. */
export function setRoutePcmSource(bytes: () => number): void {
  routePcmSource = bytes;
}

export function recordLiveSegments(count: number): void {
  state.partial.segments.live = count;
  if (count > state.partial.segments.peakLive) {
    state.partial.segments.peakLive = count;
  }
}

export function setDiagnosticsSinks(sinks: {
  setBudgetBytes?: (bytes: number | null) => void;
  setMono?: (mono: boolean) => void;
  clearCaches?: () => void;
}): void {
  budgetSink = sinks.setBudgetBytes ?? budgetSink;
  monoSink = sinks.setMono ?? monoSink;
  clearCachesSink = sinks.clearCaches ?? clearCachesSink;
}

/** Wired from `AppShell`, which is the only holder of the registration. */
export function setServiceWorkerSource(source: () => ServiceWorkerRegistration | null): void {
  serviceWorkerSource = source;
}

function readServiceWorker(): DiagServiceWorker {
  const supported = typeof navigator !== "undefined" && "serviceWorker" in navigator;
  const registration = supported ? serviceWorkerSource() : null;
  return {
    supported,
    controlled: supported && navigator.serviceWorker.controller !== null,
    registered: registration !== null,
    installing: registration?.installing?.state ?? null,
    waiting: registration?.waiting?.state ?? null,
    active: registration?.active?.state ?? null,
    updatePending: Boolean(registration?.waiting)
  };
}

export function setActivePanelId(panelId: string | null): void {
  state.activePanelId = panelId;
}

export function markStart(name: string): void {
  state.marks.set(name, performance.now());
}

export function markEnd(name: string): number | null {
  const startedAt = state.marks.get(name);
  if (startedAt === undefined) {
    return null;
  }
  state.marks.delete(name);
  return performance.now() - startedAt;
}

/**
 * The IndexedDB read and the decode are recorded separately because on iOS the read frequently
 * dominates, and a single combined number hides which half to optimize.
 */
export function recordDecode(
  mediaId: string,
  readMs: number,
  decodeMs: number,
  bytes: number
): void {
  state.decodeCount += 1;
  if (state.decodeMsByMediaId.has(mediaId)) {
    state.decodeMsByMediaId.delete(mediaId);
  }
  state.decodeMsByMediaId.set(mediaId, { readMs, decodeMs, bytes });
  while (state.decodeMsByMediaId.size > DECODE_HISTORY_LIMIT) {
    const oldest = state.decodeMsByMediaId.keys().next().value;
    if (typeof oldest !== "string") {
      break;
    }
    state.decodeMsByMediaId.delete(oldest);
  }
}

export function recordTimeToFirstSound(ms: number): void {
  state.timeToFirstSoundMs.push(ms);
  while (state.timeToFirstSoundMs.length > TIME_TO_FIRST_SOUND_LIMIT) {
    state.timeToFirstSoundMs.shift();
  }
}

export function recordProbe(format: "mp3" | "wav" | "unsupported"): void {
  state.partial.probes[format] += 1;
}

export function recordPartialServed(kind: "range" | "streamed" | "declined"): void {
  state.partial.served[kind] += 1;
}

/**
 * One range read. `bytes` is what was actually pulled from the file.
 *
 * Segment decodes are tagged here rather than through `recordDecode`: one entry per segment per
 * playing track would bury the warm-up decodes in the decode history, and that history is the
 * primary signal readable on a real device.
 */
export function recordRangeRead(bytes: number): void {
  state.partial.rangeReads.count += 1;
  state.partial.rangeReads.bytes += bytes;
}

export function recordSegment(kind: "scheduled" | "late" | "missed" | "watchdog"): void {
  state.partial.segments[kind] += 1;
}

export function recordPartialVerificationResult(
  kind: "pass" | "fail" | "skipped",
  mediaId?: string,
  alignDeltaSamples?: number
): void {
  state.partial.verifications[kind] += 1;
  if (mediaId !== undefined && alignDeltaSamples !== undefined) {
    state.partial.alignDeltaSamples.set(mediaId, alignDeltaSamples);
  }
}

export function recordWarmup(totalMs: number, warmed: number, skipped: number): void {
  state.lastWarmupMs = totalMs;
  state.lastWarmupWarmed = warmed;
  state.lastWarmupSkipped = skipped;
}

export function recordPanelSwitchEngine(ms: number): void {
  state.lastPanelSwitchEngineMs = ms;
}

export function recordPanelSwitchPaint(ms: number): void {
  state.lastPanelSwitchPaintMs = ms;
}

export function setMonoState(mono: boolean): void {
  state.mono = mono;
}

async function readStorage(): Promise<DiagStorage | null> {
  // `navigator.storage.estimate()` directly, not `estimateStorage()` from ./storage — the latter
  // also calls `persist()`, which must not run on a 500 ms overlay poll.
  const storage = navigator.storage as { estimate?: () => Promise<StorageEstimate> } | undefined;
  if (!storage?.estimate) {
    return null;
  }
  try {
    const estimate = await storage.estimate();
    return { usage: estimate.usage ?? null, quota: estimate.quota ?? null };
  } catch {
    return null;
  }
}

function getDevice(): DiagDevice {
  const runtimeNavigator = navigator as Navigator & {
    deviceMemory?: number;
    standalone?: boolean;
  };
  return {
    userAgent: navigator.userAgent,
    deviceMemoryGb: typeof runtimeNavigator.deviceMemory === "number"
      ? runtimeNavigator.deviceMemory
      : null,
    hardwareConcurrency: navigator.hardwareConcurrency,
    coarsePointer: window.matchMedia("(hover: none) and (pointer: coarse)").matches,
    standalone:
      window.matchMedia("(display-mode: standalone)").matches ||
      runtimeNavigator.standalone === true
  };
}

/**
 * Assembled here rather than exported as raw state so the mode and verdict come from the policy
 * module itself — the one place that knows how a query flag, a runtime override and a stored
 * verdict combine.
 */
export function getPartialDiag(): DiagPartial {
  const record = readPartialDecodeRecord();
  return {
    mode: getPartialDecodeMode(),
    verdict: record.verdict,
    uaKey: record.uaKey,
    probes: { ...state.partial.probes },
    served: { ...state.partial.served },
    segments: { ...state.partial.segments },
    verifications: { ...state.partial.verifications },
    alignDeltaSamples: Object.fromEntries(state.partial.alignDeltaSamples),
    rangeReads: { ...state.partial.rangeReads }
  };
}

export async function getSnapshot(): Promise<DiagSnapshot> {
  return {
    version: 1,
    overlayEnabled: isDiagnosticsEnabled(),
    uptimeMs: performance.now() - state.startedAt,
    pcm: getAccounting(),
    partial: getPartialDiag(),
    decodeMsByMediaId: Object.fromEntries(state.decodeMsByMediaId),
    decodeCount: state.decodeCount,
    lastWarmupMs: state.lastWarmupMs,
    lastWarmupWarmed: state.lastWarmupWarmed,
    lastWarmupSkipped: state.lastWarmupSkipped,
    lastPanelSwitchEngineMs: state.lastPanelSwitchEngineMs,
    lastPanelSwitchPaintMs: state.lastPanelSwitchPaintMs,
    lastTimeToFirstSoundMs: state.timeToFirstSoundMs.at(-1) ?? null,
    timeToFirstSoundMs: [...state.timeToFirstSoundMs],
    mono: state.mono,
    storage: await readStorage(),
    termination: { ...state.termination },
    device: getDevice()
  };
}

function readSessionRecord(): SessionRecord | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as SessionRecord;
  } catch {
    return null;
  }
}

function writeSessionRecord(record: SessionRecord): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(record));
  } catch {
    // Private mode or a full quota — diagnostics must never break the app.
  }
}

let currentSession: SessionRecord | null = null;

function markSessionClosed(clean: boolean): void {
  if (!currentSession) {
    return;
  }
  const now = Date.now();
  if (clean && now - state.lastHiddenWriteAt < HIDDEN_WRITE_THROTTLE_MS) {
    return;
  }
  state.lastHiddenWriteAt = now;
  currentSession = {
    ...currentSession,
    closedCleanly: clean,
    pcmBytesAtEnd: getAccounting().residentBytes,
    panelId: state.activePanelId ?? undefined
  };
  writeSessionRecord(currentSession);
  if (clean) {
    void readStorage().then((storage) => {
      if (!currentSession) {
        return;
      }
      currentSession = { ...currentSession, storageUsage: storage?.usage ?? undefined };
      writeSessionRecord(currentSession);
    });
  }
}

export function installDiagnostics(): void {
  if (state.installed || typeof window === "undefined") {
    return;
  }
  state.installed = true;
  state.startedAt = performance.now();

  const previous = readSessionRecord();
  if (previous && !previous.closedCleanly) {
    // The previous session never ran its handler. On iOS that is most often a jetsam, but it
    // cannot be distinguished from a force quit, a browser crash or an OS reboot. The value is
    // the correlation: if ungraceful terminations cluster above a PCM figure and never below it,
    // that figure is the device's practical ceiling.
    state.termination = {
      ungraceful: true,
      at: previous.startedAt,
      pcmBytesAtEnd: previous.pcmBytesAtEnd ?? null,
      panelId: previous.panelId ?? null,
      storageUsage: previous.storageUsage ?? null
    };
  }

  currentSession = {
    id: `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: Date.now(),
    closedCleanly: false
  };
  writeSessionRecord(currentSession);

  window.addEventListener("pagehide", () => {
    markSessionClosed(true);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      markSessionClosed(true);
    }
  });
  window.addEventListener("pageshow", (event) => {
    // A bfcache restore must not leave the record looking cleanly closed, or a later jetsam
    // would be invisible.
    if (event.persisted) {
      markSessionClosed(false);
    }
  });

  const api: MumboxDiag = {
    version: 1,
    snapshot: getSnapshot,
    pcmBytes: () => getAccounting().totalBytes,
    routePcmBytes: () => getAccounting().routeBytes,
    pcmBytesForActivePanel: () => getAccounting().activePanelBytes,
    cacheKeys: () => cacheKeysSource(),
    cacheStats: () => getAccounting(),
    decodeCount: () => state.decodeCount,
    decodeMs: (mediaId) => {
      const entry = state.decodeMsByMediaId.get(mediaId);
      return entry ? entry.readMs + entry.decodeMs : null;
    },
    lastWarmupMs: () => state.lastWarmupMs,
    lastPanelSwitchMs: () => state.lastPanelSwitchEngineMs,
    lastTimeToFirstSoundMs: () => state.timeToFirstSoundMs.at(-1) ?? null,
    // A non-positive value clears the budget rather than setting one of zero.
    setBudgetMb: (mb) => {
      budgetSink(mb > 0 ? Math.round(mb * 1024 * 1024) : null);
    },
    setMono: (mono) => {
      monoSink(mono);
    },
    clearCaches: () => {
      clearCachesSink();
    },
    reset: () => {
      state.marks.clear();
      state.decodeMsByMediaId.clear();
      state.decodeCount = 0;
      state.lastWarmupMs = null;
      state.lastWarmupWarmed = 0;
      state.lastWarmupSkipped = 0;
      state.lastPanelSwitchEngineMs = null;
      state.lastPanelSwitchPaintMs = null;
      state.timeToFirstSoundMs = [];
    },
    termination: () => ({ ...state.termination }),
    serviceWorker: readServiceWorker,
    partial: getPartialDiag,
    setPartialDecode: (mode) => {
      setPartialDecodeMode(mode);
    }
  };

  window.__mumboxDiag = api;
}

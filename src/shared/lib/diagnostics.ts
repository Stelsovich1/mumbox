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

export type DiagSnapshot = {
  version: 1;
  overlayEnabled: boolean;
  uptimeMs: number;
  pcm: DiagPcmAccounting;
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

const EMPTY_ACCOUNTING: DiagPcmAccounting = {
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
  installed: false
};

let accountingSource: () => DiagPcmAccounting = () => EMPTY_ACCOUNTING;
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
  accounting: () => DiagPcmAccounting,
  keys: () => string[]
): void {
  accountingSource = accounting;
  cacheKeysSource = keys;
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

export async function getSnapshot(): Promise<DiagSnapshot> {
  return {
    version: 1,
    overlayEnabled: isDiagnosticsEnabled(),
    uptimeMs: performance.now() - state.startedAt,
    pcm: accountingSource(),
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
    pcmBytesAtEnd: accountingSource().totalBytes,
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
    pcmBytes: () => accountingSource().totalBytes,
    pcmBytesForActivePanel: () => accountingSource().activePanelBytes,
    cacheKeys: () => cacheKeysSource(),
    cacheStats: () => accountingSource(),
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
    serviceWorker: readServiceWorker
  };

  window.__mumboxDiag = api;
}

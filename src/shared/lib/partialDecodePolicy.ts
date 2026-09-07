/**
 * Whether byte-range decoding may be used, and the switches that turn it off.
 *
 * Four independent levels, because the browser this feature is riskiest on — iOS Safari, whose MP3
 * decoding goes through CoreAudio rather than ffmpeg — cannot be covered in CI at all:
 *
 * 1. `?partial=0` disables it for one load; `?partial=1` forces it on even against a stored
 *    verdict, which is how a device gets debugged.
 * 2. A verdict persisted per browser, set by the runtime verification. Survives reloads, which is
 *    what makes it a real safety net on hardware the developer cannot reach.
 * 3. A per-media flag (kept in the probe cache, not here), so one bad file degrades alone.
 * 4. Structurally, the caller wraps the partial path in a `try` and falls through to the existing
 *    full decode on any throw.
 *
 * The verdict is keyed by a hash of the user agent, and a mismatch resets it: a browser update can
 * fix a decoder bug as easily as introduce one, so a stale verdict is wrong in both directions.
 *
 * Sidecar storage, like `mumbox:project-session:v1` — deliberately outside `SerializableAppState`
 * and outside the `.mumbox` payload, so a project file written by a new build stays byte-identical
 * and an older build simply never reads this key.
 */

export type PartialDecodeMode = "auto" | "off" | "force";
export type PartialDecodeVerdict = "unknown" | "ok" | "blocked";

export type PartialDecodeRecord = {
  /** 32-bit FNV-1a of `navigator.userAgent`, hex. */
  uaKey: string;
  verdict: PartialDecodeVerdict;
  passes: number;
  failures: number;
  updatedAt: number;
};

export const PARTIAL_DECODE_STORAGE_KEY = "mumbox:partial-decode:v1";
/**
 * How many verifications must land before a failure is allowed to block the browser.
 *
 * Once past it, ANY failure blocks — not a ratio. One wrongly decoded range is one silently wrong
 * cue, and a soundboard that plays the wrong thing once in twenty is worse than one that is merely
 * slower.
 */
export const PARTIAL_MIN_VERIFICATIONS = 3;

const EMPTY_RECORD: PartialDecodeRecord = {
  uaKey: "",
  verdict: "unknown",
  passes: 0,
  failures: 0,
  updatedAt: 0
};

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

/** FNV-1a, 32-bit. Only needs to change when the UA changes, so collision resistance is moot. */
export function hashUserAgent(userAgent: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < userAgent.length; index += 1) {
    hash ^= userAgent.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function getCurrentUaKey(): string {
  if (typeof navigator === "undefined") {
    return "";
  }
  return hashUserAgent(navigator.userAgent);
}

function isVerdict(value: unknown): value is PartialDecodeVerdict {
  return value === "unknown" || value === "ok" || value === "blocked";
}

export function readPartialDecodeRecord(): PartialDecodeRecord {
  const uaKey = getCurrentUaKey();
  if (typeof localStorage === "undefined") {
    return { ...EMPTY_RECORD, uaKey };
  }
  try {
    const raw = localStorage.getItem(PARTIAL_DECODE_STORAGE_KEY);
    if (!raw) {
      return { ...EMPTY_RECORD, uaKey };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return { ...EMPTY_RECORD, uaKey };
    }
    const candidate = parsed as Partial<PartialDecodeRecord>;
    // A verdict recorded against a different build of the browser says nothing about this one.
    if (candidate.uaKey !== uaKey) {
      return { ...EMPTY_RECORD, uaKey };
    }
    return {
      uaKey,
      verdict: isVerdict(candidate.verdict) ? candidate.verdict : "unknown",
      passes: typeof candidate.passes === "number" ? candidate.passes : 0,
      failures: typeof candidate.failures === "number" ? candidate.failures : 0,
      updatedAt: typeof candidate.updatedAt === "number" ? candidate.updatedAt : 0
    };
  } catch {
    return { ...EMPTY_RECORD, uaKey };
  }
}

function writeRecord(record: PartialDecodeRecord): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(PARTIAL_DECODE_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // A full or blocked storage must not break playback; the verdict simply does not persist.
  }
}

let modeOverride: PartialDecodeMode | null = null;

export function getPartialDecodeMode(): PartialDecodeMode {
  if (modeOverride !== null) {
    return modeOverride;
  }
  const flag = readQueryFlag("partial");
  if (flag === "0") {
    return "off";
  }
  if (flag === "1") {
    return "force";
  }
  return "auto";
}

/** Runtime override, for `__mumboxDiag`. Wins over the query flag for the rest of the session. */
export function setPartialDecodeMode(mode: PartialDecodeMode | null): void {
  modeOverride = mode;
}

/**
 * WAV is exempt from the verdict entirely.
 *
 * Its path never invokes the browser's decoder — it is our own Int16-to-Float32 arithmetic — so
 * there is nothing about a device that could make it behave differently, and nothing for a
 * per-browser verdict to describe.
 */
export function isPartialDecodeAllowed(format: "mp3" | "wav" | "unsupported"): boolean {
  if (format === "unsupported") {
    return false;
  }
  const mode = getPartialDecodeMode();
  if (mode === "off") {
    return false;
  }
  if (mode === "force" || format === "wav") {
    return true;
  }
  return readPartialDecodeRecord().verdict !== "blocked";
}

/** Records one verification outcome and blocks the browser on a failure past the minimum. */
export function recordPartialVerification(passed: boolean): PartialDecodeRecord {
  const current = readPartialDecodeRecord();
  const passes = current.passes + (passed ? 1 : 0);
  const failures = current.failures + (passed ? 0 : 1);
  const total = passes + failures;
  let verdict: PartialDecodeVerdict = current.verdict;
  if (!passed && total >= PARTIAL_MIN_VERIFICATIONS) {
    verdict = "blocked";
  } else if (passed && verdict !== "blocked" && total >= PARTIAL_MIN_VERIFICATIONS) {
    verdict = "ok";
  }
  const next: PartialDecodeRecord = {
    uaKey: current.uaKey,
    verdict,
    passes,
    failures,
    updatedAt: Date.now()
  };
  writeRecord(next);
  return next;
}

/** Immediate block, for a failure that needs no tally: a rejected slice the full decode accepts. */
export function blockPartialDecode(): PartialDecodeRecord {
  const current = readPartialDecodeRecord();
  const next: PartialDecodeRecord = {
    ...current,
    verdict: "blocked",
    failures: current.failures + 1,
    updatedAt: Date.now()
  };
  writeRecord(next);
  return next;
}

/** Test and diagnostics seam: forgets the stored verdict and any runtime override. */
export function resetPartialDecodePolicy(): void {
  modeOverride = null;
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.removeItem(PARTIAL_DECODE_STORAGE_KEY);
  } catch {
    // Nothing to do; a stale verdict is not worth throwing over.
  }
}

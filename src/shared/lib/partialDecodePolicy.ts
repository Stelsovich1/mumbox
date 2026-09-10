/**
 * Whether byte-range decoding may be used, and the switches that turn it off.
 *
 * Four independent levels, because the browser this feature is riskiest on — iOS Safari, whose MP3
 * decoding goes through CoreAudio rather than ffmpeg — cannot be covered in CI at all:
 *
 * 1. `?partial=0` disables it for one load; `?partial=1` forces it on even against a stored
 *    verdict, which is how a device gets debugged.
 * 2. A verdict persisted per browser, DERIVED from the runtime verification tally. Survives
 *    reloads, which is what makes it a real safety net on hardware the developer cannot reach —
 *    and derived rather than latched, so a browser that starts passing is allowed back on the
 *    path. See `derivePartialVerdict` for the rule and why it is a ratio.
 * 3. A per-media flag (kept in the probe cache, not here), so one bad file degrades alone. This is
 *    the level that must carry a single unmeasurable file; level 2 describes the BROWSER, and
 *    letting one file speak for it cost 1.5 GiB of resident PCM.
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
  /**
   * Version of the BLOCKING RULE the tally was accumulated under.
   *
   * A mismatch resets the record, exactly as a `uaKey` mismatch does, and for the same reason: a
   * verdict is only meaningful under the rule that produced it. Rule 1 blocked on any single
   * failure past three verifications, so one odd file left `blocked` latched for the life of the
   * browser profile — and a build shipping rule 2 would otherwise inherit that verdict and keep
   * byte-range decoding off for every user who had already hit it.
   */
  policy: number;
  verdict: PartialDecodeVerdict;
  passes: number;
  failures: number;
  /**
   * A capability failure: a slice this browser refused outright while the full decode accepts the
   * same file. No tally can lift it, because it says the feature does not exist here.
   */
  hardBlocked: boolean;
  updatedAt: number;
};

export const PARTIAL_DECODE_STORAGE_KEY = "mumbox:partial-decode:v1";
export const PARTIAL_DECODE_POLICY = 2;
/** How many verifications must land before the tally is allowed to say anything at all. */
export const PARTIAL_MIN_VERIFICATIONS = 3;
/**
 * How many failures must accumulate before the tally may block, and they must also OUTNUMBER the
 * passes.
 *
 * Rule 1 blocked on any failure past `PARTIAL_MIN_VERIFICATIONS`, on the argument that a soundboard
 * playing the wrong thing once in twenty is worse than a slow one. The argument is sound and the
 * threshold was not: measured on a real 16-file library, 14 passes and ONE `windows-disagree`
 * blocked the browser permanently, and the fallback cost 1 539 MiB of resident PCM against 182 MiB
 * with the path on — a mobile tab kill, which is not "merely slower".
 *
 * The two failure kinds are what make a ratio safe here. A browser that cannot do byte-range MP3 at
 * all throws, which is `hardBlocked` and needs no tally. A browser that CAN but decodes ranges
 * wrongly fails the alignment measurement on file after file, so failures dominate quickly. What a
 * ratio no longer punishes is the case it was firing on: one file whose own material cannot be
 * measured — and that file is already off the path through its own probe flag.
 */
export const PARTIAL_MIN_FAILURES = 3;

const EMPTY_RECORD: PartialDecodeRecord = {
  uaKey: "",
  policy: PARTIAL_DECODE_POLICY,
  verdict: "unknown",
  passes: 0,
  failures: 0,
  hardBlocked: false,
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
    // A verdict recorded against a different build of the browser says nothing about this one, and
    // one recorded under a different blocking rule says nothing at all.
    if (candidate.uaKey !== uaKey || candidate.policy !== PARTIAL_DECODE_POLICY) {
      return { ...EMPTY_RECORD, uaKey };
    }
    return {
      uaKey,
      policy: PARTIAL_DECODE_POLICY,
      verdict: isVerdict(candidate.verdict) ? candidate.verdict : "unknown",
      passes: typeof candidate.passes === "number" ? candidate.passes : 0,
      failures: typeof candidate.failures === "number" ? candidate.failures : 0,
      hardBlocked: candidate.hardBlocked === true,
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

/**
 * The verdict is DERIVED from the tally on every write, never latched.
 *
 * Latching is what turned one bad file into a permanent block: the old rule's recovery branch was
 * guarded by `verdict !== "blocked"`, so no number of subsequent passes could ever lift it. Here a
 * browser that starts passing is allowed to come back — the only one-way door is `hardBlocked`,
 * which is a capability, not a score.
 */
export function derivePartialVerdict(record: {
  passes: number;
  failures: number;
  hardBlocked: boolean;
}): PartialDecodeVerdict {
  if (record.hardBlocked) {
    return "blocked";
  }
  if (record.failures >= PARTIAL_MIN_FAILURES && record.failures > record.passes) {
    return "blocked";
  }
  if (record.passes + record.failures >= PARTIAL_MIN_VERIFICATIONS && record.passes > record.failures) {
    return "ok";
  }
  return "unknown";
}

/** Records one verification outcome and re-derives the verdict from the resulting tally. */
export function recordPartialVerification(passed: boolean): PartialDecodeRecord {
  const current = readPartialDecodeRecord();
  const tally = {
    passes: current.passes + (passed ? 1 : 0),
    failures: current.failures + (passed ? 0 : 1),
    hardBlocked: current.hardBlocked
  };
  const next: PartialDecodeRecord = {
    uaKey: current.uaKey,
    policy: PARTIAL_DECODE_POLICY,
    verdict: derivePartialVerdict(tally),
    ...tally,
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
    policy: PARTIAL_DECODE_POLICY,
    verdict: "blocked",
    hardBlocked: true,
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

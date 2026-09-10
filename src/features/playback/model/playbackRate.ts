/**
 * The one sample rate everything decoded for playback must agree on.
 *
 * Before this existed there were three answers. `decodeAudioBlob` forced 44 100; the MP3 range
 * decode forced 44 100; the WAV range decode used the FILE's rate, because it does no decoding at
 * all — it is arithmetic over interleaved samples. Meanwhile playback runs on `new AudioContext()`,
 * whose rate is the hardware's and is commonly 48 000 on Android.
 *
 * Two consequences, both real:
 *
 * - A buffer whose rate differs from the context's is resampled by `AudioBufferSourceNode` on the
 *   audio thread, per playing pad, for the whole cue. So a 48 kHz file was resampled DOWN to 44 100
 *   at decode by a good offline resampler and back UP at playback by an interpolating one — paying
 *   twice to end up worse than not resampling at all.
 * - The same WAV cue could be served at two different rates depending on which path won the race:
 *   the range path (file rate) or the full decode (44 100). Same cell, same trim, different audio.
 *
 * Deliberately DOM-free and dependency-free so the unit tier can load it. The value is a
 * module-level singleton rather than a hook ref because the decode paths are reached from places
 * that hold no reference to the engine — the same reason `playbackBufferCache` is a singleton.
 */

/** Used until an `AudioContext` exists to ask. Also the rate every test fixture is written at. */
export const DEFAULT_ENGINE_SAMPLE_RATE = 44_100;

/** Anything outside this is a broken reading, not a device. */
const MIN_RATE = 8_000;
const MAX_RATE = 384_000;

let engineSampleRate = DEFAULT_ENGINE_SAMPLE_RATE;

export function getEngineSampleRate(): number {
  return engineSampleRate;
}

/**
 * Records the rate of the live context. Returns whether it actually CHANGED.
 *
 * The caller uses that answer to invalidate decoded buffers: everything in the cache is at the
 * engine rate by construction, and a context recreated at a different rate (the iOS recovery path
 * builds a fresh one) would otherwise leave entries that quietly resample on every play.
 */
export function setEngineSampleRate(rate: number): boolean {
  if (!Number.isFinite(rate) || rate < MIN_RATE || rate > MAX_RATE) {
    return false;
  }
  const next = Math.round(rate);
  if (next === engineSampleRate) {
    return false;
  }
  engineSampleRate = next;
  return true;
}

/** Test and diagnostics seam. */
export function resetEngineSampleRate(): void {
  engineSampleRate = DEFAULT_ENGINE_SAMPLE_RATE;
}

/**
 * A rate requested through `?rate=N`, or null.
 *
 * Three jobs, and the first is why it is not optional. Every fixture in this repo is a 44.1 kHz WAV,
 * and the perf tier asserts decoded byte counts with `exact` gates; letting it run at the machine's
 * native rate would move all of them and, worse, push those fixtures off the byte-range path
 * entirely (see `shouldUseNativeRateForWav`). Pinning the rate keeps the committed baseline
 * meaningful and machine-independent.
 *
 * Second, it is the on-device A/B that justifies the change at all: the same Android at
 * `?rate=44100` against `?rate=48000`. Third, it is the escape hatch if a device misbehaves at its
 * own rate — the same family of switch as `?partial=` and `?pcmBudgetMb=`.
 */
export function readRequestedSampleRate(search: string): number | null {
  try {
    const raw = new URLSearchParams(search).get("rate");
    if (raw === null) {
      return null;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < MIN_RATE || value > MAX_RATE) {
      return null;
    }
    return Math.round(value);
  } catch {
    return null;
  }
}

/**
 * Whether a WAV file may be read as a byte range, given the rate the engine runs at.
 *
 * `decodeWavFrames` builds its buffer at the file's rate because it never invokes a decoder — that
 * is the property that makes the WAV path exempt from the per-browser partial-decode verdict, and
 * it is worth keeping. Resampling here would reintroduce device-dependent behaviour on the one path
 * that has none.
 *
 * So instead of resampling, a WAV whose rate differs from the engine's simply falls through to the
 * full decode, which resamples inside `decodeAudioData` where the browser owns the quality. Two
 * lines, no resampler to get wrong, and "one rate" becomes a real invariant rather than an
 * aspiration.
 */
export function shouldUseNativeRateForWav(fileSampleRate: number): boolean {
  return fileSampleRate === engineSampleRate;
}



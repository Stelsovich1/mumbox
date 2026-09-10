/**
 * Measures, per MP3 media, how far an isolated mid-file decode sits from the app's timeline — and
 * refuses the partial path for that media if the two cannot be reconciled.
 *
 * This is the safety keystone, because iOS Safari cannot be reached from CI: its MP3 decoding goes
 * through CoreAudio rather than ffmpeg, so nothing a Chromium test proves transfers. Instead the
 * browser measures itself, on real files, and can permanently take itself off the path.
 *
 * The measurement is ANCHORED and needs no shipped reference asset. The app's timeline is the full
 * decode's timeline, and a decode of the first K frames IS the beginning of that same decode — same
 * bytes, same LAME header, therefore the same gapless decision. So decoding `[0, K)` gives a
 * reference on the right timeline for free, and decoding `[M-k, K)` gives the same audio as an
 * isolated mid-file slice would. Aligning the two measures the offset.
 *
 * Measured on a real 192 kbps LAME file: 2257 samples = 1152 (one preamble frame) + 1105 (LAME's
 * encoder delay, stripped by the full decode because it reads the header, not stripped by an
 * isolated slice). Both terms are file-dependent, which is why this is measured and not computed.
 *
 * Two windows are compared, not one, and that is deliberate: a sustained tone matches at every
 * multiple of its period, so a single window cannot tell a period from a delay. Requiring two
 * windows to agree is what makes the number trustworthy on the tonal material a music soundboard is
 * full of.
 */
import { recordPartialVerificationResult } from "../../../shared/lib/diagnostics";
import { blockPartialDecode, recordPartialVerification } from "../../../shared/lib/partialDecodePolicy";
import { MediaProbe } from "./mediaProbeCache";
import {
  byteRangeForFrames,
  Mp3FrameIndex,
  preambleFrameCount
} from "./mp3FrameIndex";
import { findAlignmentOffset, rms } from "./pcmAlign";

/** Frames decoded as the anchored reference: about 2 s at 44.1 kHz. */
const REFERENCE_FRAMES = 80;
/**
 * Frames the index must already hold before this measurement can run.
 *
 * Exported because the caller has to SCAN that far first, and a VBR table is scanned lazily: a
 * freshly built index has `frameCount === 0`, so handing it straight over made the guard below
 * report "too-short" for every real file, leave `alignDeltaSamples` null, and take every mid-file
 * MP3 window off the range path with no failure recorded anywhere — `skipped` is not `fail`.
 */
export const REQUIRED_INDEX_FRAMES = REFERENCE_FRAMES + 8;
/** Window compared, in samples. */
const COMPARE_SAMPLES = 4096;
/** How far either side of the nominal position to search. */
const SEARCH_SAMPLES = 4096;
/** Residual at or below this counts as a match; identical bytes through one decoder give 0. */
const MAX_RESIDUAL = 1e-3;
/** Below this the window is silence, where a misalignment is inaudible and unmeasurable. */
const SILENCE_RMS = 1e-3;

export type VerificationOutcome =
  | { status: "pass"; alignDeltaSamples: number }
  | { status: "fail"; reason: string }
  | { status: "skipped"; reason: string };

async function decodeRange(
  blob: Blob,
  index: Mp3FrameIndex,
  firstFrame: number,
  lastFrame: number
): Promise<AudioBuffer | null> {
  const range = byteRangeForFrames(index, firstFrame, lastFrame);
  if (!range) {
    return null;
  }
  const bytes = new Uint8Array(await blob.slice(range.start, range.end).arrayBuffer());
  // Decoded at the FILE's rate, deliberately, and not at whatever rate the playback engine runs.
  //
  // `alignDeltaSamples` has a sample rate baked into its unit. The nominal positions this
  // measurement searches for are computed as `frames * samplesPerFrame`, i.e. in file-rate samples,
  // while the buffer they are searched inside is indexed in decode-rate samples. Today those
  // coincide only because both happen to be 44 100 for a 44.1 kHz file.
  //
  // Decode this pair at 48 000 instead and `nominalStart` is off by 8.8 % before the search even
  // starts — roughly 3 500 samples, with `firstProbeOffset` adding another ~4 400. Both land outside
  // the +-4096 search radius, so `findAlignmentOffset` returns null, the media is disabled, and
  // after three of them the browser verdict in `mumbox:partial-decode:v1` becomes "blocked"
  // PERSISTENTLY — byte-range decoding silently off for good, on exactly the 48 kHz Android this
  // work targets.
  //
  // Verification only ever compares a decode against a decode; it never feeds the playback graph.
  // So the file's own rate is both correct and free. `decodeMp3Range`, one file over, DOES feed the
  // graph and therefore uses the engine rate — the two adjacent decode sites disagree on purpose.
  const context = new OfflineAudioContext(1, 1, index.info.sampleRate);
  return context.decodeAudioData(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  );
}

/**
 * Runs the measurement for one media and updates the probe in place.
 *
 * Called from the warm-up, never from the press path: it costs two decodes of about two seconds
 * each. On success the probe gains `alignDeltaSamples`, which is what unlocks mid-file MP3 windows;
 * on failure the media is disabled and the browser's tally is incremented.
 *
 * The reference window grows on a LADDER when every comparison window turns out to be silent.
 * Measured on a real library: one track in sixteen answered `skipped: silent` and was therefore off
 * the byte-range path for good — its whole PCM resident, about 38 MiB — for no reason other than a
 * quiet intro. Both comparison windows live inside the first `REFERENCE_FRAMES`, roughly the first
 * two seconds, so a fade-in is enough to silence both.
 *
 * The reference must still START at frame 0 — that is the entire basis of the anchoring, since only
 * a decode from the first frame shares the full decode's gapless decision — so the retry cannot
 * move the window, only LENGTHEN it. Which means the frame index has to be scanned further, and
 * that scan is injected: paying it up front for every file would spend a header read on the fifteen
 * files in sixteen that never need it.
 */
type AlignmentAttempt =
  | { status: "pass"; alignDeltaSamples: number }
  | { status: "fail"; reason: string }
  | { status: "skipped"; reason: string }
  /** Internal, and the only retry-able outcome: every window was below the silence floor. */
  | { status: "silent" };

/**
 * Reference lengths tried in order, in frames.
 *
 * Three times the base is about 6.3 s at 44.1 kHz, which clears an ordinary fade-in without turning
 * the measurement into a long decode. There is no third rung: a file whose first six seconds are
 * silent is not the case this ladder was measured against, and every rung is paid twice over by the
 * file that ends up failing anyway.
 */
const REFERENCE_FRAME_LADDER = [REFERENCE_FRAMES, REFERENCE_FRAMES * 3] as const;

/** Frames the index must hold for a given reference length; the +8 covers the range that ends it. */
export function framesNeededForReference(referenceFrames: number): number {
  return referenceFrames + 8;
}

async function attemptAlignment(
  blob: Blob,
  index: Mp3FrameIndex,
  referenceFrames: number
): Promise<AlignmentAttempt> {
  const { samplesPerFrame } = index.info;
  // The mid-file slice starts far enough in that its own preamble is available, and ends where the
  // reference ends so both cover the same audio.
  const midFrame = Math.floor(referenceFrames / 2);
  const preamble = preambleFrameCount(index, midFrame);
  if (preamble === null) {
    return { status: "skipped", reason: "no-preamble" };
  }

  let reference: AudioBuffer | null = null;
  let isolated: AudioBuffer | null = null;
  try {
    reference = await decodeRange(blob, index, 0, referenceFrames);
    isolated = await decodeRange(blob, index, midFrame - preamble, referenceFrames);
  } catch {
    // A rejected slice that the full decode would have accepted means this browser cannot do
    // byte-range MP3 at all. The caller turns this one into an immediate block.
    return { status: "fail", reason: "decode-rejected" };
  }

  if (!reference || !isolated) {
    return { status: "skipped", reason: "no-range" };
  }

  const referenceData = reference.getChannelData(0);
  const isolatedData = isolated.getChannelData(0);
  const nominalStart = (midFrame - preamble) * samplesPerFrame;

  // Two windows, well inside the isolated slice so decoder priming cannot contaminate them.
  const firstProbeOffset = preamble * samplesPerFrame + 2 * samplesPerFrame;
  const offsets = [firstProbeOffset, firstProbeOffset + 8 * samplesPerFrame];

  const measured: number[] = [];
  for (const probeOffset of offsets) {
    if (probeOffset + COMPARE_SAMPLES > isolatedData.length) {
      continue;
    }
    const window = isolatedData.subarray(probeOffset, probeOffset + COMPARE_SAMPLES);
    if (rms(window) < SILENCE_RMS) {
      // Silence cannot glitch audibly and cannot be aligned; try the other window.
      continue;
    }
    const result = findAlignmentOffset({
      reference: window,
      haystack: referenceData,
      nominalOffset: nominalStart + probeOffset,
      searchRadius: SEARCH_SAMPLES,
      maxResidual: MAX_RESIDUAL
    });
    if (result.lag === null) {
      // Only here, on the path that permanently disables this media, is the exhaustive survey worth
      // its cost. `verifications.fail` carries no reason on its own, and on a device that cannot be
      // attached to a debugger the peak correlation at the best lag is the only thing that
      // separates "the offset is outside the search radius" from "this is not the same audio" from
      // "the decoder is broken". Paid once per failure, never on the healthy path.
      const survey = findAlignmentOffset({
        reference: window,
        haystack: referenceData,
        nominalOffset: nominalStart + probeOffset,
        searchRadius: SEARCH_SAMPLES,
        maxResidual: MAX_RESIDUAL,
        survey: true
      });
      return {
        status: "fail",
        reason: `no-alignment (peak ${survey.peakCorrelation.toFixed(4)})`
      };
    }
    measured.push(-result.lag);
  }

  const first = measured[0];
  if (first === undefined) {
    // Every window was silent. Retry-able, and NOT a failure: silence proves nothing either way.
    return { status: "silent" };
  }
  // Two windows must agree, or the material is periodic enough that the number cannot be trusted.
  if (measured.some((value) => value !== first)) {
    return { status: "fail", reason: "windows-disagree" };
  }

  return { status: "pass", alignDeltaSamples: first };
}

export async function verifyMp3Alignment(
  blob: Blob,
  probe: MediaProbe,
  /**
   * Scans the frame index out to `frames` frames, for a rung deeper than the caller pre-scanned.
   * Absent means "no deeper rung is available", which simply ends the ladder.
   */
  ensureFrames?: (frames: number) => Promise<void>
): Promise<VerificationOutcome> {
  const index = probe.mp3;
  if (!index || index.frameCount < REQUIRED_INDEX_FRAMES) {
    const outcome: VerificationOutcome = { status: "skipped", reason: "too-short" };
    recordPartialVerificationResult("skipped", probe.mediaId, undefined, outcome.reason);
    return outcome;
  }

  let attempt: AlignmentAttempt = { status: "silent" };
  let deepTried = false;
  for (const [rung, referenceFrames] of REFERENCE_FRAME_LADDER.entries()) {
    const needed = framesNeededForReference(referenceFrames);
    if (rung > 0) {
      if (!ensureFrames) {
        break;
      }
      await ensureFrames(needed);
      // A file simply shorter than this rung ends the ladder; the previous rung's outcome stands.
      if (index.frameCount < needed) {
        break;
      }
      deepTried = true;
    }
    attempt = await attemptAlignment(blob, index, referenceFrames);
    if (attempt.status !== "silent") {
      break;
    }
  }

  if (attempt.status === "silent") {
    // `silent-deep` rather than `silent` once a deeper rung has actually been tried and also come
    // back quiet: the two say different things about the file, and the reason counter is the only
    // place a device without a debugger can tell them apart.
    const reason = deepTried ? "silent-deep" : "silent";
    recordPartialVerificationResult("skipped", probe.mediaId, undefined, reason);
    return { status: "skipped", reason };
  }

  if (attempt.status === "skipped") {
    recordPartialVerificationResult("skipped", probe.mediaId, undefined, attempt.reason);
    return attempt;
  }

  if (attempt.status === "fail") {
    probe.partialDisabled = true;
    probe.verified = "fail";
    if (attempt.reason === "decode-rejected") {
      // No tally is needed to establish a missing capability.
      blockPartialDecode();
    } else {
      recordPartialVerification(false);
    }
    recordPartialVerificationResult("fail", probe.mediaId, undefined, attempt.reason);
    return attempt;
  }

  probe.alignDeltaSamples = attempt.alignDeltaSamples;
  probe.verified = "pass";
  recordPartialVerification(true);
  recordPartialVerificationResult("pass", probe.mediaId, attempt.alignDeltaSamples);
  return { status: "pass", alignDeltaSamples: attempt.alignDeltaSamples };
}

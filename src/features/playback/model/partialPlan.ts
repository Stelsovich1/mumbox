/**
 * Two decisions and one layout, all pure arithmetic in source time.
 *
 * The decisions are ORTHOGONAL, and conflating them was the flaw in the first draft of this
 * feature:
 *
 * - `shouldReadRange` asks "is the window small enough relative to the file that reading only its
 *   bytes beats decoding everything?" — the trimmed-cue case. A whole untrimmed track fails it,
 *   because its window IS the file and there is nothing to skip.
 * - `shouldSegmentWindow` asks "is the window's decoded PCM so large that it must arrive in
 *   pieces?" — the whole-long-track case. A 2-second one-shot fails it, because 0.34 MiB is not
 *   worth a seam.
 *
 * A single gate on window LENGTH would have excluded a 5-second window out of a 180-second file —
 * the single most profitable case there is — from the partial path entirely, while a whole 3-minute
 * track (the dominant shape in real projects) would also have been missed. Hence two gates.
 *
 * The saving thresholds mirror `shouldSliceBuffer` in `decodeAudio.ts` on purpose: the rule that
 * "slicing has to pay for itself" is the same rule, applied one step earlier, and stating it twice
 * with different numbers would make the two paths disagree about the same cue.
 */

/** Decoded PCM is Float32, so this is the cost of one second per channel. */
const BYTES_PER_SAMPLE = 4;

/**
 * Below this the window is decoded in one piece. 4 MiB is about 11.9 s of 44.1 kHz stereo — long
 * enough that every ordinary one-shot and gate sound keeps today's single-source path untouched,
 * which is also what keeps the existing e2e fixtures (2-4 s) numerically unchanged.
 */
export const MIN_SEGMENT_WINDOW_BYTES = 4 * 1024 * 1024;
/** A range read must skip at least this much decoded audio to be worth the extra machinery. */
export const MIN_RANGE_SAVING_BYTES = 2 * 1024 * 1024;
/** And it must skip a real fraction of the file, not just a large absolute amount of a huge one. */
export const MIN_RANGE_RATIO = 0.9;

/** Head length. 0.5 s of stereo is 0.168 MiB, so 144 warm heads are about 24 MiB. */
export const HEAD_SECONDS = 0.5;
/**
 * Real audio carried past each segment's nominal end.
 *
 * The handoff is `prev.stop(T)` and `next.start(T)` at the same absolute time, which is
 * sample-accurate — but the outgoing segment must still have samples to play right up to T even if
 * its own start was quantised. The margin guarantees that; it does not fix alignment, which is what
 * the explicit start time is for.
 */
export const SEGMENT_MARGIN_SECONDS = 0.06;
/**
 * Segment lengths, in order, with the last value repeating.
 *
 * Progressive rather than fixed, purely to cut the number of seams: a fixed 4 s chunk gives a
 * 3-minute track about 45 seams, this ladder gives it 13, at the same memory ceiling. Every seam is
 * a chance to click, so fewer is strictly better, and later segments can afford to be bigger
 * because there is more time to fetch them.
 */
export const SEGMENT_SECONDS_LADDER = [4, 8, 16] as const;
/**
 * How many segments ahead to fetch.
 *
 * The bound it expresses is enforced by `routeSegments.ts`, not by this constant: a route releases
 * each non-last segment as its `onended` fires, and prunes defensively before every push because
 * `onended` is not guaranteed across an iOS audio interruption. Until that existed the comment here
 * described an intention nothing implemented — every segment stayed on the route for the life of
 * the cue, so a 60 s window held 21 273 848 bytes rather than the ~11 MiB claimed. Measured after
 * the fix: 5 468 400 bytes, i.e. the head plus the lookahead.
 */
export const SEGMENT_LOOKAHEAD = 2;
/**
 * Past this much lateness a dropout reads as a broken cue rather than a glitch, so the cue ends
 * honestly instead of leaving a hole.
 */
export const MAX_SEGMENT_LATENESS_SECONDS = 0.25;

export function getPcmBytes(seconds: number, sampleRate: number, channels: number): number {
  return Math.max(0, Math.round(seconds * sampleRate) * channels * BYTES_PER_SAMPLE);
}

export type RangeDecision = {
  sourceSeconds: number;
  windowSeconds: number;
  sampleRate: number;
  channels: number;
};

/**
 * Whether reading only the window's bytes beats decoding the whole file.
 *
 * Measures decoded bytes rather than container bytes so the threshold means the same thing for a
 * 128 kbps MP3 and a WAV of the same duration.
 */
export function shouldReadRange(input: RangeDecision): boolean {
  const sourceBytes = getPcmBytes(input.sourceSeconds, input.sampleRate, input.channels);
  const windowBytes = getPcmBytes(input.windowSeconds, input.sampleRate, input.channels);
  if (windowBytes <= 0) {
    return false;
  }
  return (
    windowBytes < sourceBytes * MIN_RANGE_RATIO &&
    sourceBytes - windowBytes > MIN_RANGE_SAVING_BYTES
  );
}

/** Whether the window's PCM is large enough that it must be streamed in segments. */
export function shouldSegmentWindow(input: {
  windowSeconds: number;
  sampleRate: number;
  channels: number;
}): boolean {
  return (
    getPcmBytes(input.windowSeconds, input.sampleRate, input.channels) > MIN_SEGMENT_WINDOW_BYTES
  );
}

export type PlannedSegment = {
  /** Source-time window this segment is responsible for. */
  startSeconds: number;
  endSeconds: number;
  /**
   * Where this segment's buffer actually ends, including the margin. Only the last segment has no
   * margin, because there is nothing after it to overlap into.
   */
  bufferEndSeconds: number;
  /** Only the last segment ends the cue or restarts a loop. */
  isLast: boolean;
};

export type PlanSegmentsInput = {
  startSeconds: number;
  endSeconds: number;
  /** Duration of the ORIGINAL media, which bounds every margin. */
  sourceDurationSeconds: number;
  headSeconds?: number;
  ladder?: readonly number[];
  marginSeconds?: number;
};

/**
 * Splits a source-time window into a head plus progressively longer segments.
 *
 * Every value returned is a position in the original media, never inside a buffer — the invariant
 * `audioEnvelope.ts` depends on. Buffer-relative offsets are the caller's business and are derived
 * from `sliceStartSeconds`, exactly as the existing single-segment path already does.
 */
export function planSegments(input: PlanSegmentsInput): PlannedSegment[] {
  const start = Math.max(0, input.startSeconds);
  const end = Math.max(start, input.endSeconds);
  if (end <= start) {
    return [];
  }

  const headSeconds = input.headSeconds ?? HEAD_SECONDS;
  const ladder = input.ladder ?? SEGMENT_SECONDS_LADDER;
  const marginSeconds = input.marginSeconds ?? SEGMENT_MARGIN_SECONDS;
  const segments: PlannedSegment[] = [];

  let cursor = start;
  let rung = -1;
  while (cursor < end) {
    const length =
      rung < 0
        ? headSeconds
        : (ladder[Math.min(rung, ladder.length - 1)] ?? ladder[ladder.length - 1] ?? headSeconds);
    const segmentEnd = Math.min(end, cursor + length);
    segments.push({
      startSeconds: cursor,
      endSeconds: segmentEnd,
      bufferEndSeconds: segmentEnd,
      isLast: false
    });
    cursor = segmentEnd;
    rung += 1;
  }

  const last = segments[segments.length - 1];
  if (last) {
    last.isLast = true;
  }
  // Margins are applied after the layout so a margin can never move a boundary: the boundary is
  // what the seam is scheduled on, and the margin only extends what the outgoing buffer holds.
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (segment) {
      segment.bufferEndSeconds = Math.min(
        input.sourceDurationSeconds,
        segment.endSeconds + marginSeconds
      );
    }
  }

  return segments;
}

export type LateSegmentResolution =
  | { action: "schedule"; atSeconds: number; skippedSeconds: number }
  | { action: "give-up"; lateBySeconds: number };

/**
 * What to do with a segment that resolved after the time it was supposed to start.
 *
 * Scheduling it at `now` with its offset advanced by the lateness keeps the cue on its own
 * timeline: the audible result is a dropout exactly as long as the lateness, and the envelope —
 * which is anchored in absolute time on a shared gain — stays in phase. Restarting the segment from
 * its beginning instead would repeat audio and drift out of phase with the fades, which is worse
 * than a hole.
 */
export function resolveLateSegment(input: {
  scheduledAtSeconds: number;
  nowSeconds: number;
  maxLatenessSeconds?: number;
}): LateSegmentResolution {
  const lateBy = input.nowSeconds - input.scheduledAtSeconds;
  if (lateBy <= 0) {
    return { action: "schedule", atSeconds: input.scheduledAtSeconds, skippedSeconds: 0 };
  }
  const limit = input.maxLatenessSeconds ?? MAX_SEGMENT_LATENESS_SECONDS;
  if (lateBy > limit) {
    return { action: "give-up", lateBySeconds: lateBy };
  }
  return { action: "schedule", atSeconds: input.nowSeconds, skippedSeconds: lateBy };
}

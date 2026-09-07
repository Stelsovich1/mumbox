import { expect, test } from "@playwright/test";

import {
  getPcmBytes,
  HEAD_SECONDS,
  MIN_RANGE_SAVING_BYTES,
  MIN_SEGMENT_WINDOW_BYTES,
  planSegments,
  resolveLateSegment,
  SEGMENT_MARGIN_SECONDS,
  shouldReadRange,
  shouldSegmentWindow
} from "../../src/features/playback/model/partialPlan";

const RATE = 44100;
const STEREO = 2;

test.describe("getPcmBytes", () => {
  test("one second of 44.1 kHz stereo Float32 is 352 800 bytes", () => {
    // The number the whole feature is motivated by: 0.336 MiB per second.
    expect(getPcmBytes(1, RATE, STEREO)).toBe(352_800);
    expect(getPcmBytes(180, RATE, STEREO)).toBe(63_504_000);
    expect(getPcmBytes(HEAD_SECONDS, RATE, STEREO)).toBe(176_400);
  });

  test("never negative", () => {
    expect(getPcmBytes(-5, RATE, STEREO)).toBe(0);
  });
});

test.describe("shouldReadRange", () => {
  test("a 5 s window out of a 180 s file is worth a range read", () => {
    // The most profitable case there is, and the one an earlier draft's window-length gate would
    // have excluded outright.
    expect(
      shouldReadRange({ sourceSeconds: 180, windowSeconds: 5, sampleRate: RATE, channels: STEREO })
    ).toBe(true);
  });

  test("an untrimmed whole track is not, because there is nothing to skip", () => {
    expect(
      shouldReadRange({ sourceSeconds: 180, windowSeconds: 180, sampleRate: RATE, channels: STEREO })
    ).toBe(false);
  });

  test("a window covering more than 90 % of the file is not, however large the file", () => {
    // 560 s of 600 s, deliberately: the ratio is 0.933 and the saving is about 14 MB, so the RATIO
    // is the only term that can refuse it. An earlier version of this test used 595 s of 600 s,
    // where the saving floor (1.76 MB < 2 MiB) did the refusing — so it passed for the wrong reason
    // and a mutation of MIN_RANGE_RATIO to 1.0 survived it. Found by a mutation round.
    expect(
      shouldReadRange({ sourceSeconds: 600, windowSeconds: 560, sampleRate: RATE, channels: STEREO })
    ).toBe(false);
    // And the saving really is far above the floor here, so the ratio is doing the work.
    expect(getPcmBytes(40, RATE, STEREO)).toBeGreaterThan(MIN_RANGE_SAVING_BYTES);
  });

  test("the ratio and the saving floor are independent gates", () => {
    // Passes the ratio (0.1), fails the floor: 4.5 s of stereo is 1.59 MB, under the 2 MiB floor.
    expect(
      shouldReadRange({ sourceSeconds: 5, windowSeconds: 0.5, sampleRate: RATE, channels: STEREO })
    ).toBe(false);
    // Passes the floor, fails the ratio.
    expect(
      shouldReadRange({ sourceSeconds: 600, windowSeconds: 560, sampleRate: RATE, channels: STEREO })
    ).toBe(false);
    // Passes both.
    expect(
      shouldReadRange({ sourceSeconds: 600, windowSeconds: 30, sampleRate: RATE, channels: STEREO })
    ).toBe(true);
  });

  test("the saving floor is a threshold, and it is exclusive", () => {
    // Exactly at the floor must be refused: `>` not `>=`, matching `shouldSliceBuffer`.
    const savingSeconds = MIN_RANGE_SAVING_BYTES / (RATE * STEREO * 4);
    const atFloor = shouldReadRange({
      sourceSeconds: savingSeconds + 1,
      windowSeconds: 1,
      sampleRate: RATE,
      channels: STEREO
    });
    const justOver = shouldReadRange({
      sourceSeconds: savingSeconds + 1.01,
      windowSeconds: 1,
      sampleRate: RATE,
      channels: STEREO
    });
    expect(atFloor).toBe(false);
    expect(justOver).toBe(true);
  });

  test("an empty window is never worth reading", () => {
    expect(
      shouldReadRange({ sourceSeconds: 180, windowSeconds: 0, sampleRate: RATE, channels: STEREO })
    ).toBe(false);
  });

  test("a short cue from a short file is left on the classic path", () => {
    expect(
      shouldReadRange({ sourceSeconds: 4, windowSeconds: 1, sampleRate: RATE, channels: STEREO })
    ).toBe(false);
  });
});

test.describe("shouldSegmentWindow", () => {
  test("a whole 3-minute track must be streamed", () => {
    expect(shouldSegmentWindow({ windowSeconds: 180, sampleRate: RATE, channels: STEREO })).toBe(true);
  });

  test("a 2-second one-shot must not be, because a seam buys nothing", () => {
    expect(shouldSegmentWindow({ windowSeconds: 2, sampleRate: RATE, channels: STEREO })).toBe(false);
  });

  test("the existing e2e fixture lengths stay on the single-source path", () => {
    // 2-4 s fixtures are what the current suite is built on, so the numbers those specs assert do
    // not move when this feature lands.
    for (const seconds of [2, 3, 4]) {
      expect(shouldSegmentWindow({ windowSeconds: seconds, sampleRate: RATE, channels: STEREO })).toBe(
        false
      );
    }
  });

  test("the threshold is on decoded bytes, so it is channel-aware", () => {
    const seconds = MIN_SEGMENT_WINDOW_BYTES / (RATE * STEREO * 4);
    expect(shouldSegmentWindow({ windowSeconds: seconds, sampleRate: RATE, channels: STEREO })).toBe(
      false
    );
    expect(
      shouldSegmentWindow({ windowSeconds: seconds + 0.1, sampleRate: RATE, channels: STEREO })
    ).toBe(true);
    // The same duration in mono is half the bytes and therefore below the threshold.
    expect(shouldSegmentWindow({ windowSeconds: seconds, sampleRate: RATE, channels: 1 })).toBe(false);
  });
});

test.describe("planSegments", () => {
  test("a whole 3-minute track becomes a head plus progressively longer segments", () => {
    const segments = planSegments({
      startSeconds: 0,
      endSeconds: 180,
      sourceDurationSeconds: 180
    });

    expect(segments[0]).toMatchObject({ startSeconds: 0, endSeconds: 0.5 });
    expect(segments[1]).toMatchObject({ startSeconds: 0.5, endSeconds: 4.5 });
    expect(segments[2]).toMatchObject({ startSeconds: 4.5, endSeconds: 12.5 });
    expect(segments[3]).toMatchObject({ startSeconds: 12.5, endSeconds: 28.5 });
    expect(segments[4]).toMatchObject({ startSeconds: 28.5, endSeconds: 44.5 });

    // Fourteen segments, so thirteen seams — against about forty-five for a fixed 4 s chunk. Every
    // seam is a chance to click, so the count is the point of the ladder.
    expect(segments).toHaveLength(14);
    expect(segments[segments.length - 1]).toMatchObject({ startSeconds: 172.5, endSeconds: 180 });
    expect(segments.filter((segment) => segment.isLast)).toHaveLength(1);
    expect(segments[segments.length - 1]?.isLast).toBe(true);
  });

  test("segments tile the window exactly, with no gap and no overlap in source time", () => {
    const segments = planSegments({
      startSeconds: 12,
      endSeconds: 97.5,
      sourceDurationSeconds: 200
    });
    expect(segments[0]?.startSeconds).toBe(12);
    expect(segments[segments.length - 1]?.endSeconds).toBe(97.5);
    for (let index = 1; index < segments.length; index += 1) {
      expect(segments[index]?.startSeconds).toBe(segments[index - 1]?.endSeconds);
    }
  });

  test("every non-last segment carries the margin, and the last one does not", () => {
    const segments = planSegments({
      startSeconds: 0,
      endSeconds: 60,
      sourceDurationSeconds: 180
    });
    for (const segment of segments.slice(0, -1)) {
      expect(segment.bufferEndSeconds).toBeCloseTo(segment.endSeconds + SEGMENT_MARGIN_SECONDS, 10);
    }
    const last = segments[segments.length - 1];
    // Nothing follows the last segment, so there is nothing to overlap into.
    expect(last?.bufferEndSeconds).toBe(last?.endSeconds);
  });

  test("the margin never moves a boundary, only what the buffer holds", () => {
    // The boundary is what the seam is scheduled on. If a margin shifted it, the next segment would
    // start late by the margin and the cue would drift.
    const segments = planSegments({
      startSeconds: 0,
      endSeconds: 30,
      sourceDurationSeconds: 180
    });
    expect(segments[1]?.startSeconds).toBe(segments[0]?.endSeconds);
    expect(segments[0]?.bufferEndSeconds).toBeGreaterThan(segments[0]?.endSeconds ?? 0);
  });

  test("a margin is clamped to the source duration, never past the end of the media", () => {
    const segments = planSegments({
      startSeconds: 0,
      endSeconds: 10,
      sourceDurationSeconds: 10.02
    });
    for (const segment of segments) {
      expect(segment.bufferEndSeconds).toBeLessThanOrEqual(10.02);
    }
  });

  test("a window shorter than the head is one segment, and it is last", () => {
    const segments = planSegments({
      startSeconds: 3,
      endSeconds: 3.2,
      sourceDurationSeconds: 180
    });
    expect(segments).toEqual([
      { startSeconds: 3, endSeconds: 3.2, bufferEndSeconds: 3.2, isLast: true }
    ]);
  });

  test("an empty or inverted window plans nothing", () => {
    expect(planSegments({ startSeconds: 5, endSeconds: 5, sourceDurationSeconds: 180 })).toEqual([]);
    expect(planSegments({ startSeconds: 9, endSeconds: 4, sourceDurationSeconds: 180 })).toEqual([]);
  });

  test("a trimmed window starts at the trim, not at zero", () => {
    const segments = planSegments({
      startSeconds: 42,
      endSeconds: 90,
      sourceDurationSeconds: 180
    });
    expect(segments[0]?.startSeconds).toBe(42);
    expect(segments[0]?.endSeconds).toBe(42.5);
  });
});

test.describe("resolveLateSegment", () => {
  test("a segment that is on time keeps its scheduled moment", () => {
    expect(resolveLateSegment({ scheduledAtSeconds: 10, nowSeconds: 9.5 })).toEqual({
      action: "schedule",
      atSeconds: 10,
      skippedSeconds: 0
    });
  });

  test("a slightly late segment starts now and skips exactly the lateness", () => {
    // A skip, not a shift: the cue stays on its own timeline and in phase with the envelope, and
    // the audible result is a dropout as long as the lateness.
    const resolution = resolveLateSegment({ scheduledAtSeconds: 10, nowSeconds: 10.08 });
    expect(resolution.action).toBe("schedule");
    if (resolution.action !== "schedule") {
      throw new Error("unreachable");
    }
    expect(resolution.atSeconds).toBeCloseTo(10.08, 10);
    expect(resolution.skippedSeconds).toBeCloseTo(0.08, 10);
  });

  test("past the tolerance the cue ends honestly instead of leaving a hole", () => {
    const resolution = resolveLateSegment({ scheduledAtSeconds: 10, nowSeconds: 10.6 });
    expect(resolution.action).toBe("give-up");
    if (resolution.action !== "give-up") {
      throw new Error("unreachable");
    }
    expect(resolution.lateBySeconds).toBeCloseTo(0.6, 10);
  });

  test("the tolerance boundary is inclusive of the limit itself", () => {
    expect(
      resolveLateSegment({ scheduledAtSeconds: 10, nowSeconds: 10.25, maxLatenessSeconds: 0.25 })
        .action
    ).toBe("schedule");
    expect(
      resolveLateSegment({ scheduledAtSeconds: 10, nowSeconds: 10.2501, maxLatenessSeconds: 0.25 })
        .action
    ).toBe("give-up");
  });
});

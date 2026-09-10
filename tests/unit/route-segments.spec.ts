import { expect, test } from "@playwright/test";

import { planSegments, SEGMENT_LOOKAHEAD } from "../../src/features/playback/model/partialPlan";
import {
  dropSegment,
  listFinishedSegments,
  pruneFinishedSegments
} from "../../src/features/playback/model/routeSegments";

type Segment = { id: number; isLast: boolean; stopAtContextTime: number | null };

function segment(id: number, isLast: boolean, stopAt: number | null): Segment {
  return { id, isLast, stopAtContextTime: stopAt };
}

test("drops a finished segment by identity", () => {
  const first = segment(1, false, 1);
  const second = segment(2, false, 2);
  const segments = [first, second];
  expect(dropSegment(segments, first)).toBe(true);
  expect(segments).toEqual([second]);
});

test("refuses to drop the last segment", () => {
  // End of cue is detected from the last segment's `onended`, and the rAF watchdog looks for its
  // presence to decide whether a chain died. Removing it would make a finished cue and a broken one
  // indistinguishable.
  const last = segment(1, true, 1);
  const segments = [last];
  expect(dropSegment(segments, last)).toBe(false);
  expect(segments).toEqual([last]);
});

test("ignores a segment that is no longer held", () => {
  // `onended` can arrive after a defensive prune already removed the entry.
  const segments = [segment(1, false, 1)];
  expect(dropSegment(segments, segment(2, false, 2))).toBe(false);
  expect(segments).toHaveLength(1);
});

test("prunes only segments whose stop has passed", () => {
  const segments = [
    segment(1, false, 1),
    segment(2, false, 5),
    segment(3, false, null),
    segment(4, true, 9)
  ];
  expect(pruneFinishedSegments(segments, 3)).toBe(1);
  expect(segments.map((entry) => entry.id)).toEqual([2, 3, 4]);
});

test("removes two ADJACENT finished segments, not every other one", () => {
  // Splicing while walking forward skips whatever shifts into the freed index, so a forward
  // loop released only half of an adjacent run - found by a mutation round. That run is exactly
  // what an iOS audio interruption produces by swallowing several onended callbacks together,
  // which is the case this defensive prune exists for.
  const segments = [segment(1, false, 1), segment(2, false, 1), segment(3, true, null)];
  expect(pruneFinishedSegments(segments, 2)).toBe(2);
  expect(segments.map((entry) => entry.id)).toEqual([3]);
});

test("treats the stop time as exclusive", () => {
  // A segment stopping exactly now may still be sounding; only a stop strictly in the past is over.
  const segments = [segment(1, false, 3)];
  expect(pruneFinishedSegments(segments, 3)).toBe(0);
  expect(pruneFinishedSegments(segments, 3.0001)).toBe(1);
});

test("never prunes a segment with no scheduled stop", () => {
  // Null means nothing has been scheduled yet — the segment is upcoming, not finished.
  const segments = [segment(1, false, null)];
  expect(pruneFinishedSegments(segments, 1e6)).toBe(0);
});

test("pruning an empty array is a no-op", () => {
  const segments: Segment[] = [];
  expect(pruneFinishedSegments(segments, 1)).toBe(0);
});

/**
 * The guard that matters, and the one an e2e can only approximate: drive a real 180 s ladder
 * through the same push/drop cycle the engine performs and assert the retained count never exceeds
 * the documented bound. Before the fix this reached the segment count of the whole window — 14 —
 * and `partialPlan.ts` claimed "head plus about 32 s of resident PCM" the entire time.
 */
test("a full 180 s ladder never retains more than the lookahead allows", () => {
  const planned = planSegments({
    startSeconds: 0,
    endSeconds: 180,
    sourceDurationSeconds: 180
  });
  expect(planned.length).toBeGreaterThan(10);

  const held: Segment[] = [];
  let peak = 0;
  let contextTime = 0;

  planned.forEach((entry, index) => {
    pruneFinishedSegments(held, contextTime);
    const next = segment(index, entry.isLast, entry.isLast ? null : entry.endSeconds);
    held.push(next);
    peak = Math.max(peak, held.length);
    // The previous segment finishes as this one starts.
    contextTime = entry.startSeconds + 0.001;
    const finished = held.find(
      (candidate) =>
        !candidate.isLast &&
        candidate.stopAtContextTime !== null &&
        candidate.stopAtContextTime <= contextTime
    );
    if (finished) {
      dropSegment(held, finished);
    }
  });

  expect(peak).toBeLessThanOrEqual(SEGMENT_LOOKAHEAD + 1);
});

test("lists exactly what the prune will remove, so the caller can disconnect it", () => {
  // Releasing a segment takes two acts and only one of them is in this module: the entry leaves the
  // array, and the node leaves the graph. Dropping the entry alone left the source connected to the
  // route gain - which keeps its buffer reachable - and removed it from the only list `stopRoute`
  // walks, so nothing would ever disconnect it. The prune that bounds memory held all of it.
  const segments = [segment(1, false, 1), segment(2, false, 1), segment(3, false, 9), segment(4, true, null)];
  const finished = listFinishedSegments(segments, 2);
  expect(finished.map((entry) => entry.id)).toEqual([1, 2]);
  // And it agrees with the prune exactly - a disagreement in either direction is a leak or a
  // disconnected node that is still scheduled to play.
  expect(pruneFinishedSegments(segments, 2)).toBe(finished.length);
  expect(segments.map((entry) => entry.id)).toEqual([3, 4]);
});

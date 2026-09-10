/**
 * Retention rules for the segments a streamed route holds.
 *
 * A route kept every segment it ever scheduled. `onended` disconnected the node but left the entry
 * in the array, and an `AudioBufferSourceNode` keeps its `buffer` reachable — so the PCM of the
 * whole cue stayed resident for the cue's whole life. A 180 s window is 14 segments, about 63.8 MB;
 * a 45-minute set is roughly 952 MB. `partialPlan.ts` states the bound as "head plus about 32 s of
 * resident PCM", and nothing enforced it.
 *
 * Pure and DOM-free on purpose — the hook that owns the routes never will be unit-testable, and
 * this is the part with a rule worth pinning. Typed structurally, the same way `decodeAudio.ts`
 * types `ReadableAudioBuffer`, so a test can pass plain objects.
 */

export type RetainedSegment = {
  /**
   * The last segment is never dropped. End of cue for a buffer route is detected from its
   * `onended`, and the rAF watchdog looks for it to decide whether a chain died — remove it and a
   * finished cue would be indistinguishable from a broken one.
   */
  isLast: boolean;
  /** Absolute context time a stop is scheduled for, or null when none is. */
  stopAtContextTime: number | null;
};

/**
 * Removes one finished segment by identity.
 *
 * By identity rather than by index: the array is mutated from `onended` callbacks that fire in
 * whatever order the audio thread delivers them, and an index captured at schedule time would be
 * stale by then.
 */
export function dropSegment<T extends RetainedSegment>(segments: T[], segment: T): boolean {
  if (segment.isLast) {
    return false;
  }
  const index = segments.indexOf(segment);
  if (index === -1) {
    return false;
  }
  segments.splice(index, 1);
  return true;
}

/**
 * Removes every non-last segment whose scheduled stop has already passed.
 *
 * The defensive half of the bound, and not redundant with `dropSegment`: `onended` is not delivered
 * reliably across an iOS audio interruption, and an interrupted session is exactly the one where a
 * cue runs long enough for the accumulation to matter. Pruning before each push makes the bound
 * structural rather than event-dependent.
 */
export function pruneFinishedSegments(
  segments: RetainedSegment[],
  nowContextTime: number
): number {
  let removed = 0;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (!segment || segment.isLast || segment.stopAtContextTime === null) {
      continue;
    }
    if (nowContextTime > segment.stopAtContextTime) {
      segments.splice(index, 1);
      removed += 1;
    }
  }
  return removed;
}

/**
 * The segments `pruneFinishedSegments` would remove, in array order.
 *
 * Split out because releasing a segment takes TWO acts and only one of them belongs in a pure
 * module: the entry has to leave the array, and the node has to leave the graph. Dropping the
 * entry alone left the node connected to the route's gain, which keeps it and its buffer
 * reachable — and removed it from the only list `stopRoute` walks, so nothing would ever
 * disconnect it. The prune that existed to bound memory held all of it instead.
 */
export function listFinishedSegments<T extends RetainedSegment>(
  segments: readonly T[],
  nowContextTime: number
): T[] {
  return segments.filter(
    (segment) =>
      !segment.isLast &&
      segment.stopAtContextTime !== null &&
      nowContextTime > segment.stopAtContextTime
  );
}

/**
 * One shared limit on how many decodes may be in flight at once, anywhere in the engine — plus a
 * separate, small lane for the decodes a cue is already waiting on.
 *
 * The warm-up pool has always had a width, and the reason is written in `useAudioEngine`:
 * simultaneous decodes multiply the transient allocation that gets a mobile tab killed. Segment
 * streaming breaks that guarantee unless it shares the same limit, because a chain is per-route and
 * self-driving: with `stopOthers` off by default, six live pads would otherwise mean six
 * unsynchronised `decodeAudioData` calls on top of whatever the warm-up is doing.
 *
 * TWO LANES, because one FIFO queue starves the only work with a deadline.
 *
 * A warm-up decode is speculative: nobody is listening to it, and it may be thrown away by the next
 * panel switch. A segment decode is not: the cue is audible right now, the head is 0.5 s long, and
 * `MAX_SEGMENT_LATENESS_SECONDS` gives the chain 0.25 s of slack past that. So on a panel of MP3s
 * the whole budget was 0.75 s from the press — spent queued behind warm-up work, where a single
 * alignment verification is two decodes of about two seconds each. The chain lost that race, gave
 * up, and `promoteToLast` ended the cue: a three-minute track audible for half a second. Priority
 * ordering alone does not fix it either, because a decode cannot be cancelled or preempted — a live
 * task that arrives while every slot is held by a long decode still waits for one to finish.
 *
 * So live decodes get their own lane rather than a better place in the queue. That is sound on the
 * memory argument the shared bound exists for, and only on it: a live decode is one segment of the
 * ladder, at most 16 s of stereo PCM (5.6 MB), while the background lane is where a whole-file
 * decode of 105 MB happens. Two lanes of 2 and 4 are bounded by construction; what is NOT allowed
 * is an unbounded number of live decodes, which is the six-pads case the shared gate was added for.
 */

export type DecodeLane = "live" | "background";

export type Semaphore = {
  /** Defaults to the background lane: everything speculative must say nothing and get the bound. */
  run: <T>(task: () => Promise<T>, lane?: DecodeLane) => Promise<T>;
  active: (lane?: DecodeLane) => number;
  waiting: (lane?: DecodeLane) => number;
  limit: (lane?: DecodeLane) => number;
};

/**
 * How many decodes a cue may have in flight at once, across every live route.
 *
 * Two, not the background width: a chain fetches one segment at a time, so this is only ever
 * reached by several pads playing at once — and the point is to bound that, not to widen it.
 */
export const LIVE_DECODE_CONCURRENCY = 2;

export function createSemaphore(limit: number, liveLimit = LIVE_DECODE_CONCURRENCY): Semaphore {
  const lanes = {
    background: { width: Math.max(1, Math.floor(limit)), active: 0, queue: [] as (() => void)[] },
    live: { width: Math.max(1, Math.floor(liveLimit)), active: 0, queue: [] as (() => void)[] }
  };

  const laneOf = (lane: DecodeLane) => lanes[lane];

  return {
    async run(task, lane = "background") {
      const state = laneOf(lane);
      if (state.active >= state.width) {
        await new Promise<void>((resolve) => {
          state.queue.push(resolve);
        });
      }
      state.active += 1;
      try {
        return await task();
      } finally {
        state.active -= 1;
        // Woken here rather than at the head of `run`, so a task released while the lane is full
        // does not admit a second one: the release and the admission are the same event.
        const next = state.queue.shift();
        if (next) {
          next();
        }
      }
    },
    active: (lane = "background") => laneOf(lane).active,
    waiting: (lane = "background") => laneOf(lane).queue.length,
    limit: (lane = "background") => laneOf(lane).width
  };
}

/**
 * Concurrency is deliberately small on a phone: simultaneous decodes multiply the transient memory
 * that gets a tab killed, and a coarse pointer is the best available signal for "phone". Elsewhere
 * it leaves cores for the main thread and the audio thread rather than saturating.
 */
export function getDecodeConcurrency(): number {
  if (typeof window === "undefined") {
    return 1;
  }
  const cores = navigator.hardwareConcurrency || 2;
  const coarsePointer = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  return coarsePointer ? Math.min(2, cores) : Math.min(4, Math.max(2, cores - 2));
}

let shared: Semaphore | null = null;

/** The engine-wide decode gate. Created lazily so the module stays importable without a DOM. */
export function getDecodeSemaphore(): Semaphore {
  shared ??= createSemaphore(getDecodeConcurrency());
  return shared;
}

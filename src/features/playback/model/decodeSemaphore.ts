/**
 * One shared limit on how many decodes may be in flight at once, anywhere in the engine.
 *
 * The warm-up pool has always had a width, and the reason is written in `useAudioEngine`:
 * simultaneous decodes multiply the transient allocation that gets a mobile tab killed. Segment
 * streaming breaks that guarantee unless it shares the same limit, because a chain is per-route and
 * self-driving: with `stopOthers` off by default, six live pads would otherwise mean six
 * unsynchronised `decodeAudioData` calls on top of whatever the warm-up is doing.
 *
 * So both go through here. The warm-up keeps its pool (that is what orders the work and reports
 * progress); this only caps how much of it — plus every live chain — can allocate simultaneously.
 */

export type Semaphore = {
  run: <T>(task: () => Promise<T>) => Promise<T>;
  active: () => number;
  waiting: () => number;
  limit: () => number;
};

export function createSemaphore(limit: number): Semaphore {
  const width = Math.max(1, Math.floor(limit));
  const queue: (() => void)[] = [];
  let active = 0;

  const release = () => {
    active -= 1;
    const next = queue.shift();
    if (next) {
      next();
    }
  };

  return {
    async run(task) {
      if (active >= width) {
        await new Promise<void>((resolve) => {
          queue.push(resolve);
        });
      }
      active += 1;
      try {
        return await task();
      } finally {
        release();
      }
    },
    active: () => active,
    waiting: () => queue.length,
    limit: () => width
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

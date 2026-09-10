/**
 * Byte-budget LRU for decoded playback buffers.
 *
 * Decoded PCM is Float32, so one second of 44.1 kHz stereo is 352 800 bytes — 0.34 MiB. A 15 MB
 * MP3 at 192 kbps expands to roughly 220 MiB, which is why a budget is counted in bytes rather
 * than entries: entry count carries no information about the cost.
 *
 * A `null` budget means unlimited, and that is the default. A cap that is smaller than the project
 * turns every trigger into a cold decode, which is a worse product than a large memory footprint —
 * the app is a soundboard, and a pad that is not instant is not a pad. The limit exists so it can
 * be set deliberately (`?pcmBudgetMb=N`, `__mumboxDiag.setBudgetMb`) when measuring a device, not
 * as a standing policy.
 *
 * Dependency-free on purpose: no DOM globals, no imports, so it can be unit tested under the
 * Playwright runner in Node. Device detection and the singleton live in `playbackBufferCache.ts`.
 */

export type PlaybackBufferEntry = {
  buffer: AudioBuffer;
  bytes: number;
  /** Where this buffer starts inside the original media, in seconds. 0 for a full decode. */
  sliceStartSeconds: number;
  /** Duration of the ORIGINAL media, which is what trim clamping must be measured against. */
  sourceDurationSeconds: number;
  /**
   * Present only when this buffer is the HEAD of a streamed window: the rest arrives as further
   * segments, fetched while the head plays.
   *
   * Optional so nothing else in this module changes — the cache still stores one buffer per key,
   * still charges it by bytes, and `has(key)` still means "this cue starts instantly", because a
   * warm head does. Segments are never cached: they belong to a live route and are released as they
   * finish. Caching a reassembled window would put the whole track's PCM back in memory, and would
   * do it silently, because `protectedBytes` would then include it and the warm-up would start
   * skipping the panel on screen in order to protect it.
   */
  partial?: {
    mediaId: string;
    /** Source time where the head ends and the next segment must continue. */
    headEndSeconds: number;
    /** Source time the whole window ends. */
    windowEndSeconds: number;
    /** Captured at plan time, never re-read: a mid-cue change would alter the channel count. */
    mono: boolean;
  };
};

export type PlaybackBufferKeyInput = {
  mediaId: string;
  trimStartMs: number | null;
  trimEndMs: number | null;
  mono: boolean;
  /**
   * Whether the cell loops.
   *
   * Not a property of the audio, but it changes what may be STORED under the key. A looping cue is
   * deliberately never streamed — one full decode is the right price for something heard over and
   * over — so its entry must never be a streamed head. Without this in the key, a `once` cell
   * sharing the same media, trim and mono would cache its head first and the loop cell would read
   * it, take the streamed branch, and end from the chain's `onended`, which has no loop restart:
   * the pad would play exactly once and go quiet.
   */
  loop: boolean;
};

export type AudioBufferCacheStats = {
  entries: number;
  bytes: number;
  /** `null` means unlimited. */
  budgetBytes: number | null;
  pinnedBytes: number;
  priorityBytes: number;
  /**
   * Bytes held by entries that eviction may not touch: the union of pinned and priority. This is
   * what a caller about to decode must measure itself against — everything else in the cache is
   * another panel's and will be evicted to make room.
   */
  protectedBytes: number;
  hits: number;
  misses: number;
  evictions: number;
  overBudget: boolean;
};

export type AudioBufferCache = {
  get: (key: string) => PlaybackBufferEntry | null;
  peek: (key: string) => PlaybackBufferEntry | null;
  has: (key: string) => boolean;
  set: (key: string, entry: PlaybackBufferEntry) => void;
  delete: (key: string) => boolean;
  deleteByMediaId: (mediaId: string) => number;
  clear: () => void;
  /**
   * Notified for every key removed by BUDGET EVICTION, and only by that.
   *
   * Exists because the warm indicator is engine state keyed by cache key, and nothing invalidated
   * it when the cache dropped an entry underneath: the pad went on claiming to be instant while its
   * buffer was gone, so a tap flickered through a cold decode and the cell suppressed its own
   * re-warm. Invisible until a device had a budget at all — with `null` nothing was ever evicted.
   *
   * Explicit deletions are NOT reported here: `delete`, `deleteByMediaId` and `clear` all have
   * callers who already know what they removed and update the warm state themselves.
   */
  subscribeEvictions: (listener: (key: string) => void) => () => void;
  setPinned: (keys: Iterable<string>) => void;
  setPriority: (keys: Iterable<string>) => void;
  keys: () => string[];
  bytes: () => number;
  /**
   * The budget alone, without walking the entries.
   *
   * `stats()` sums three key sets and allocates a `Set` for each, and the warm-up called it once
   * per target purely to read this field — which is `null` by default on every device, so the walk
   * was discarded unread every time.
   */
  budgetBytes: () => number | null;
  bytesFor: (keys: Iterable<string>) => number;
  size: () => number;
  stats: () => AudioBufferCacheStats;
  setBudgetBytes: (next: number | null) => void;
};

const KEY_SEPARATOR = "|";

/**
 * Media ids are `media-${crypto.randomUUID()}` (and `media-seed-NNNN` in tests), so the separator
 * cannot appear inside the id and the key round-trips.
 *
 * A null and a zero trim start describe the same window and must normalize to one entry,
 * otherwise a cell saved before trimming existed would decode twice. There is deliberately no
 * counterpart for the trim end: normalizing it would need the media duration, which is not known
 * at key time. A trim end written as exactly the duration therefore produces a second key. The
 * byte accounting stays honest either way — keys sharing a buffer are charged once — so the cost
 * is at worst one redundant slice.
 */
export function makePlaybackBufferKey(input: PlaybackBufferKeyInput): string {
  const start = input.trimStartMs ?? 0;
  const end = input.trimEndMs ?? "e";
  // The loop flag sits BEFORE the mono flag so the key still ends in the channel marker — several
  // tests read the tail to tell a mono entry from a stereo one, and the trim pair is still a
  // contiguous `|start|end|` run.
  return [
    input.mediaId,
    String(start),
    String(end),
    input.loop ? "l" : "o",
    input.mono ? "m" : "s"
  ].join(KEY_SEPARATOR);
}

export function getMediaIdFromKey(key: string): string {
  const separatorIndex = key.indexOf(KEY_SEPARATOR);
  return separatorIndex === -1 ? key : key.slice(0, separatorIndex);
}

export function getAudioBufferBytes(buffer: {
  length: number;
  numberOfChannels: number;
}): number {
  return buffer.length * buffer.numberOfChannels * 4;
}

/**
 * Pre-decode estimate from the only metadata a `MediaAsset` carries.
 *
 * The rate is a REQUIRED argument with no default. A default of 44 100 is precisely the assumption
 * this work removed — decoding follows the hardware now — and leaving it in place would have made
 * every estimate on a 48 kHz device 8.8 % low, in the direction that costs a jetsam rather than a
 * skipped warm-up. The channel count is still unknown before decoding, so stereo is assumed.
 */
export function estimatePcmBytes(
  durationMs: number | null,
  mono: boolean,
  sampleRate: number
): number | null {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) {
    return null;
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    return null;
  }
  return Math.round((durationMs / 1000) * sampleRate * (mono ? 1 : 2) * 4);
}

export function createAudioBufferCache(budgetBytes: number | null): AudioBufferCache {
  const entries = new Map<string, PlaybackBufferEntry>();
  /**
   * How many keys point at each distinct buffer.
   *
   * When trimming does not pay, several keys legitimately share one full-decode buffer — a cell
   * with a sub-threshold trim and an untrimmed cell on the same media are two keys and one
   * `AudioBuffer`. Charging each key its full size would make the budget govern a number that is
   * neither an upper nor a lower bound on resident memory, and would make the diagnostics lie.
   * Bytes are therefore counted once per distinct buffer.
   */
  const bufferRefs = new Map<AudioBuffer, number>();
  let pinned = new Set<string>();
  let priority = new Set<string>();
  const normalizeBudget = (next: number | null) =>
    next === null || !Number.isFinite(next) || next <= 0 ? null : Math.floor(next);
  let budget = normalizeBudget(budgetBytes);
  let totalBytes = 0;
  let hits = 0;
  let misses = 0;
  let evictions = 0;
  const evictionListeners = new Set<(key: string) => void>();

  const retainBuffer = (entry: PlaybackBufferEntry) => {
    const count = bufferRefs.get(entry.buffer) ?? 0;
    if (count === 0) {
      totalBytes += entry.bytes;
    }
    bufferRefs.set(entry.buffer, count + 1);
  };

  const releaseBuffer = (entry: PlaybackBufferEntry) => {
    const count = bufferRefs.get(entry.buffer) ?? 1;
    if (count <= 1) {
      bufferRefs.delete(entry.buffer);
      totalBytes -= entry.bytes;
      return;
    }
    bufferRefs.set(entry.buffer, count - 1);
  };

  /** Sums a key set the same way `totalBytes` is kept: once per distinct buffer. */
  const sumDistinctBytes = (keys: Iterable<string>) => {
    const seen = new Set<AudioBuffer>();
    let total = 0;
    for (const key of keys) {
      const entry = entries.get(key);
      if (!entry || seen.has(entry.buffer)) {
        continue;
      }
      seen.add(entry.buffer);
      total += entry.bytes;
    }
    return total;
  };

  const removeKey = (key: string) => {
    const entry = entries.get(key);
    if (!entry) {
      return false;
    }
    entries.delete(key);
    releaseBuffer(entry);
    return true;
  };

  /**
   * Two-tier eviction. Plain LRU is actively harmful here: warm-up fills the cache in cell order,
   * so the least recently used entry is cell 1 — the most likely next tap. Order is therefore
   * pinned (never), then non-priority by LRU, then priority by LRU only if still over budget.
   */
  const evictToBudget = (protectedKey: string | null) => {
    if (budget === null || totalBytes <= budget) {
      return;
    }

    const tiers: string[][] = [[], []];
    for (const key of entries.keys()) {
      if (pinned.has(key) || key === protectedKey) {
        continue;
      }
      tiers[priority.has(key) ? 1 : 0]?.push(key);
    }

    for (const tier of tiers) {
      for (const key of tier) {
        if (totalBytes <= budget) {
          return;
        }
        if (removeKey(key)) {
          evictions += 1;
          for (const listener of evictionListeners) {
            listener(key);
          }
        }
      }
    }
  };

  return {
    subscribeEvictions(listener) {
      evictionListeners.add(listener);
      return () => {
        evictionListeners.delete(listener);
      };
    },
    get(key) {
      const entry = entries.get(key);
      if (!entry) {
        misses += 1;
        return null;
      }
      hits += 1;
      // Reinsert to refresh recency.
      entries.delete(key);
      entries.set(key, entry);
      return entry;
    },
    peek(key) {
      return entries.get(key) ?? null;
    },
    has(key) {
      return entries.has(key);
    },
    set(key, entry) {
      removeKey(key);
      entries.set(key, entry);
      retainBuffer(entry);
      // The freshly inserted entry is never the one evicted: a caller that just decoded is about
      // to play it, and dropping it would guarantee an immediate re-decode.
      evictToBudget(key);
    },
    delete(key) {
      return removeKey(key);
    },
    deleteByMediaId(mediaId) {
      let removed = 0;
      for (const key of [...entries.keys()]) {
        if (getMediaIdFromKey(key) === mediaId && removeKey(key)) {
          removed += 1;
        }
      }
      return removed;
    },
    clear() {
      entries.clear();
      bufferRefs.clear();
      totalBytes = 0;
    },
    setPinned(keys) {
      pinned = new Set(keys);
    },
    setPriority(keys) {
      priority = new Set(keys);
    },
    keys() {
      return [...entries.keys()];
    },
    bytes() {
      return totalBytes;
    },
    budgetBytes() {
      return budget;
    },
    bytesFor(keys) {
      return sumDistinctBytes(keys);
    },
    size() {
      return entries.size;
    },
    stats() {
      const keys = [...entries.keys()];
      const pinnedBytes = sumDistinctBytes(keys.filter((key) => pinned.has(key)));
      const priorityBytes = sumDistinctBytes(keys.filter((key) => priority.has(key)));
      const protectedBytes = sumDistinctBytes(
        keys.filter((key) => pinned.has(key) || priority.has(key))
      );
      return {
        entries: entries.size,
        bytes: totalBytes,
        budgetBytes: budget,
        pinnedBytes,
        priorityBytes,
        protectedBytes,
        hits,
        misses,
        evictions,
        // True when pinned entries alone exceed the budget: correctness wins over the budget,
        // but the diagnostics overlay must surface it. Never true without a budget.
        overBudget: budget !== null && totalBytes > budget
      };
    },
    setBudgetBytes(next) {
      budget = normalizeBudget(next);
      evictToBudget(null);
    }
  };
}

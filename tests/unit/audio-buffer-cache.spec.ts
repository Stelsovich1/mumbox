import { expect, test } from "@playwright/test";

import {
  createAudioBufferCache,
  estimatePcmBytes,
  getAudioBufferBytes,
  getMediaIdFromKey,
  makePlaybackBufferKey
} from "../../src/features/playback/model/audioBufferCache";
import type { PlaybackBufferEntry } from "../../src/features/playback/model/audioBufferCache";

function entry(bytes: number, sliceStartSeconds = 0): PlaybackBufferEntry {
  return {
    buffer: { length: bytes / 4, numberOfChannels: 1 } as unknown as AudioBuffer,
    bytes,
    sliceStartSeconds,
    sourceDurationSeconds: 10
  };
}

test.describe("keys", () => {
  test("a null trim start and an explicit zero normalize to one key", () => {
    const withNull = makePlaybackBufferKey({
      mediaId: "media-1",
      trimStartMs: null,
      trimEndMs: null,
      mono: false,
      loop: false
    });
    const withZero = makePlaybackBufferKey({
      mediaId: "media-1",
      trimStartMs: 0,
      trimEndMs: null,
      mono: false,
      loop: false
    });
    expect(withNull).toBe(withZero);
  });

  test("different trims, channel modes and playback modes produce different keys", () => {
    const base = {
      mediaId: "media-1",
      trimStartMs: 0,
      trimEndMs: null,
      mono: false,
      loop: false
    };
    expect(makePlaybackBufferKey({ ...base, trimStartMs: 1000 })).not.toBe(
      makePlaybackBufferKey(base)
    );
    expect(makePlaybackBufferKey({ ...base, trimEndMs: 1000 })).not.toBe(
      makePlaybackBufferKey(base)
    );
    expect(makePlaybackBufferKey({ ...base, mono: true })).not.toBe(makePlaybackBufferKey(base));
    // A looping cell is never streamed, so it must not share an entry with a `once` cell on the
    // same media and trim — that cell caches a streamed HEAD, and a loop reading it plays once and
    // stops, because the chain's `onended` has no loop restart.
    expect(makePlaybackBufferKey({ ...base, loop: true })).not.toBe(makePlaybackBufferKey(base));
  });

  test("the key still ends in the channel marker and keeps the trim pair contiguous", () => {
    // Both are read by e2e assertions: the tail tells a mono entry from a stereo one, and the trim
    // pair is matched as a run. The loop flag was inserted before the channel marker for that.
    const key = makePlaybackBufferKey({
      mediaId: "media-1",
      trimStartMs: 1200,
      trimEndMs: 7400,
      mono: true,
      loop: true
    });
    expect(key.endsWith("|m")).toBe(true);
    expect(key.includes("|1200|7400|")).toBe(true);
  });

  test("the media id round-trips out of the key", () => {
    const key = makePlaybackBufferKey({
      mediaId: "media-abc-123",
      trimStartMs: 500,
      trimEndMs: 900,
      mono: true,
      loop: false
    });
    expect(getMediaIdFromKey(key)).toBe("media-abc-123");
    expect(getMediaIdFromKey("no-separator")).toBe("no-separator");
  });

  test("a trim end of zero is not confused with an absent trim end", () => {
    const absent = makePlaybackBufferKey({
      mediaId: "m",
      trimStartMs: 0,
      trimEndMs: null,
      mono: false,
      loop: false
    });
    const zero = makePlaybackBufferKey({
      mediaId: "m",
      trimStartMs: 0,
      trimEndMs: 0,
      mono: false,
      loop: false
    });
    expect(absent).not.toBe(zero);
  });
});

test.describe("byte math", () => {
  test("counts four bytes per sample per channel", () => {
    expect(getAudioBufferBytes({ length: 44_100, numberOfChannels: 2 })).toBe(352_800);
    expect(getAudioBufferBytes({ length: 0, numberOfChannels: 2 })).toBe(0);
  });

  test("estimates decoded size from duration, assuming stereo", () => {
    // The rate is explicit now. It used to be hardcoded to 44 100, which stopped being a fact once
    // decoding started following the hardware — and on a 48 kHz device that default would have
    // under-estimated every buffer by 8.8 %, in the direction that costs a jetsam rather than a
    // skipped warm-up.
    expect(estimatePcmBytes(1000, false, 44_100)).toBe(352_800);
    expect(estimatePcmBytes(1000, true, 44_100)).toBe(176_400);
    expect(estimatePcmBytes(1000, false, 48_000)).toBe(384_000);
    expect(estimatePcmBytes(null, false, 44_100)).toBeNull();
    expect(estimatePcmBytes(Number.NaN, false, 44_100)).toBeNull();
    expect(estimatePcmBytes(-1, false, 44_100)).toBeNull();
    expect(estimatePcmBytes(1000, false, 0)).toBeNull();
  });
});

test.describe("byte-budget eviction", () => {
  test("evicts by bytes, not by entry count", () => {
    const cache = createAudioBufferCache(1000);
    cache.set("a", entry(400));
    cache.set("b", entry(400));
    expect(cache.size()).toBe(2);

    cache.set("c", entry(400));
    expect(cache.bytes()).toBeLessThanOrEqual(1000);
    expect(cache.size()).toBe(2);
    expect(cache.has("a")).toBe(false);
    expect(cache.stats().evictions).toBe(1);
  });

  test("never evicts the entry that was just inserted", () => {
    // The inserted entry alone exceeds the budget, so evicting everything else still leaves the
    // cache over. Without the protection, the eviction sweep would go on and drop the entry the
    // caller has just decoded and is about to play — guaranteeing an immediate re-decode.
    const cache = createAudioBufferCache(300);
    cache.set("a", entry(100));
    cache.set("b", entry(400));

    expect(cache.has("b")).toBe(true);
    expect(cache.has("a")).toBe(false);
    expect(cache.bytes()).toBe(400);
    expect(cache.stats().overBudget).toBe(true);
  });

  test("a read refreshes recency so the truly oldest entry goes first", () => {
    const cache = createAudioBufferCache(1000);
    cache.set("a", entry(400));
    cache.set("b", entry(400));
    cache.get("a");

    cache.set("c", entry(400));
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
  });

  test("peek does not refresh recency and does not count as a hit", () => {
    const cache = createAudioBufferCache(1000);
    cache.set("a", entry(400));
    cache.set("b", entry(400));
    cache.peek("a");
    expect(cache.stats().hits).toBe(0);

    cache.set("c", entry(400));
    expect(cache.has("a")).toBe(false);
  });

  test("replacing a key keeps the byte accounting correct", () => {
    const cache = createAudioBufferCache(1000);
    cache.set("a", entry(400));
    cache.set("a", entry(100));
    expect(cache.size()).toBe(1);
    expect(cache.bytes()).toBe(100);
  });

  test("keeps a pinned entry even far over budget and reports it", () => {
    const cache = createAudioBufferCache(500);
    cache.set("a", entry(400));
    cache.setPinned(["a"]);
    cache.set("b", entry(600));
    cache.set("c", entry(600));

    expect(cache.has("a")).toBe(true);
    expect(cache.stats().overBudget).toBe(true);
    expect(cache.stats().pinnedBytes).toBe(400);
  });

  test("evicts a non-priority entry before a priority one even when it is newer", () => {
    // The anti-thrash guarantee. Warm-up fills in cell order, so plain LRU would drop cell 1 —
    // the most likely next tap — and turn every trigger into a cold decode.
    const cache = createAudioBufferCache(1200);
    cache.set("a", entry(400));
    cache.set("b", entry(400));
    cache.set("c", entry(400));
    cache.setPriority(["a", "b"]);

    cache.set("d", entry(400));
    expect(cache.has("c")).toBe(false);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("d")).toBe(true);
  });

  test("falls back to evicting priority entries once nothing else is left", () => {
    const cache = createAudioBufferCache(800);
    cache.set("a", entry(400));
    cache.set("b", entry(400));
    cache.setPriority(["a", "b"]);

    cache.set("c", entry(400));
    expect(cache.has("a")).toBe(false);
    expect(cache.bytes()).toBeLessThanOrEqual(800);
  });

  test("lowering the budget evicts immediately", () => {
    const cache = createAudioBufferCache(2000);
    cache.set("a", entry(400));
    cache.set("b", entry(400));
    cache.set("c", entry(400));

    cache.setBudgetBytes(500);
    expect(cache.bytes()).toBeLessThanOrEqual(500);
    expect(cache.has("c")).toBe(true);
  });

  test("a cache filled exactly to its budget is not over budget", () => {
    // Closes a surviving mutant: `totalBytes > budget` flipped to `>=` passed every other test,
    // because none of them left the cache sitting exactly on the limit. The distinction matters —
    // the overlay reports `overBudget` as a warning, and a cache that fits is not a warning.
    const cache = createAudioBufferCache(800);
    cache.set("a", entry(400));
    cache.set("b", entry(400));

    expect(cache.bytes()).toBe(800);
    expect(cache.size()).toBe(2);
    expect(cache.stats().overBudget).toBe(false);
    expect(cache.stats().evictions).toBe(0);

    // One more entry tips it over, so the sweep runs and drops the oldest — landing back under
    // the budget rather than over it.
    cache.set("c", entry(4));
    expect(cache.has("a")).toBe(false);
    expect(cache.bytes()).toBe(404);
    expect(cache.stats().overBudget).toBe(false);
  });

  test("keys sharing one buffer are charged once", () => {
    // When trimming does not pay, several keys hold the same full-decode buffer. Charging each
    // key separately would make the budget govern a figure that is not the resident size, and
    // would make the diagnostics overlay report double.
    const cache = createAudioBufferCache(10_000);
    const shared = { length: 100, numberOfChannels: 1 } as unknown as AudioBuffer;
    const first: PlaybackBufferEntry = {
      buffer: shared,
      bytes: 400,
      sliceStartSeconds: 0,
      sourceDurationSeconds: 10
    };
    const second: PlaybackBufferEntry = { ...first };

    cache.set("m|0|e|s", first);
    cache.set("m|0|5000|s", second);

    expect(cache.size()).toBe(2);
    expect(cache.bytes()).toBe(400);
    expect(cache.bytesFor(["m|0|e|s", "m|0|5000|s"])).toBe(400);

    // Dropping one key frees nothing, because the buffer is still held by the other.
    cache.delete("m|0|e|s");
    expect(cache.bytes()).toBe(400);
    cache.delete("m|0|5000|s");
    expect(cache.bytes()).toBe(0);
  });

  test("no budget means nothing is ever evicted", () => {
    // The default. A cap smaller than the project turns every trigger into a cold decode, which
    // is a worse product than a large footprint — so the limit is opt-in, not policy.
    const cache = createAudioBufferCache(null);
    expect(cache.stats().budgetBytes).toBeNull();

    for (let index = 0; index < 50; index += 1) {
      cache.set(`k${String(index)}`, entry(400));
    }
    expect(cache.size()).toBe(50);
    expect(cache.bytes()).toBe(20_000);
    expect(cache.stats().evictions).toBe(0);
    expect(cache.stats().overBudget).toBe(false);
  });

  test("a non-finite or non-positive budget reads as no budget", () => {
    const cache = createAudioBufferCache(Number.NaN);
    expect(cache.stats().budgetBytes).toBeNull();

    cache.setBudgetBytes(800);
    expect(cache.stats().budgetBytes).toBe(800);

    // Clearing the limit again must not be expressible only as "zero bytes allowed", which would
    // mean the opposite.
    cache.setBudgetBytes(-100);
    expect(cache.stats().budgetBytes).toBeNull();
    cache.set("a", entry(4000));
    expect(cache.has("a")).toBe(true);
    expect(cache.stats().overBudget).toBe(false);
  });
});

test.describe("invalidation", () => {
  test("deleteByMediaId removes every trim and channel variant of one media", () => {
    const cache = createAudioBufferCache(10_000);
    const keyA = makePlaybackBufferKey({
      mediaId: "m1",
      trimStartMs: 0,
      trimEndMs: null,
      mono: false,
      loop: false
    });
    const keyB = makePlaybackBufferKey({
      mediaId: "m1",
      trimStartMs: 1000,
      trimEndMs: 2000,
      mono: true,
      loop: false
    });
    const keyOther = makePlaybackBufferKey({
      mediaId: "m2",
      trimStartMs: 0,
      trimEndMs: null,
      mono: false,
      loop: false
    });
    cache.set(keyA, entry(400));
    cache.set(keyB, entry(200));
    cache.set(keyOther, entry(100));

    expect(cache.deleteByMediaId("m1")).toBe(2);
    expect(cache.keys()).toEqual([keyOther]);
    expect(cache.bytes()).toBe(100);
  });

  test("protectedBytes is the union of pinned and priority, counted once", () => {
    // This is the figure the warm-up measures itself against: everything else in the cache
    // belongs to another panel and is evictable, so counting it would make the panel the user is
    // looking at refuse to warm in order to protect one they left.
    const cache = createAudioBufferCache(10_000);
    cache.set("a", entry(100));
    cache.set("b", entry(100));
    cache.set("c", entry(100));
    cache.setPinned(["a", "b"]);
    cache.setPriority(["b", "c"]);

    const stats = cache.stats();
    expect(stats.pinnedBytes).toBe(200);
    expect(stats.priorityBytes).toBe(200);
    // "b" is both, and must not be counted twice.
    expect(stats.protectedBytes).toBe(300);
  });

  test("clear resets the byte count", () => {
    const cache = createAudioBufferCache(10_000);
    cache.set("a", entry(400));
    cache.clear();
    expect(cache.bytes()).toBe(0);
    expect(cache.size()).toBe(0);
    expect(cache.keys()).toEqual([]);
  });

  test("bytesFor sums only the requested keys and ignores duplicates", () => {
    const cache = createAudioBufferCache(10_000);
    cache.set("a", entry(400));
    cache.set("b", entry(100));
    expect(cache.bytesFor(["a", "a", "missing"])).toBe(400);
    expect(cache.bytesFor(["a", "b"])).toBe(500);
  });

  test("counts hits and misses", () => {
    const cache = createAudioBufferCache(10_000);
    cache.set("a", entry(100));
    cache.get("a");
    cache.get("a");
    cache.get("b");
    const stats = cache.stats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
  });
});

test("reports the budget without walking the entries", () => {
  // Read on the warm-up hot path once per target, where `stats()` — three passes plus a Set each —
  // was being computed and then discarded, because the budget is null by default on every device.
  const cache = createAudioBufferCache(null);
  expect(cache.budgetBytes()).toBeNull();

  cache.setBudgetBytes(4096);
  expect(cache.budgetBytes()).toBe(4096);
  expect(cache.budgetBytes()).toBe(cache.stats().budgetBytes);

  // Normalisation has to agree with `stats()`, or the two readings disagree about whether a budget
  // exists at all and the warm-up takes the wrong branch.
  cache.setBudgetBytes(0);
  expect(cache.budgetBytes()).toBeNull();
  expect(cache.stats().budgetBytes).toBeNull();
});

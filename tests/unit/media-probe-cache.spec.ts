import { expect, test } from "@playwright/test";

import { createMp3FrameIndex } from "../../src/features/playback/model/mp3FrameIndex";
import { createMediaProbeCache } from "../../src/features/playback/model/mediaProbeCache";
import type { MediaProbe } from "../../src/features/playback/model/mediaProbeCache";

/**
 * The cache is split by LIFETIME, not by size.
 *
 * The facts — format, the measured decoder offset, the verdict, the stream shape — are a few dozen
 * bytes and cost two decodes plus a cross-correlation to re-derive. The frame table is hundreds of
 * kilobytes (a 90-minute MPEG-1 track is 206 700 frames = 827 KB) and costs only range reads. Under
 * one shared budget two long tracks could not both keep a table, and every eviction took the
 * expensive half with it — so `verifyMp3Alignment` ran again on every panel switch.
 */

function makeIndex(frames: number) {
  const index = createMp3FrameIndex({
    version: "mpeg1",
    sampleRate: 44100,
    channels: 2,
    samplesPerFrame: 1152,
    firstFrameOffset: 0,
    audioEndOffset: 10_000_000,
    constantFrameBytes: null,
    hasXingHeader: false,
    declaredFrameCount: null
  });
  index.byteOffsets = new Uint32Array(frames);
  index.frameCount = frames;
  return index;
}

function makeProbe(mediaId: string, frames: number): MediaProbe {
  return {
    mediaId,
    format: "mp3",
    mp3: makeIndex(frames),
    containerDurationSeconds: 600,
    sampleRate: 44100,
    channels: 2,
    alignDeltaSamples: null,
    verified: "unknown",
    partialDisabled: false,
    failures: 0
  };
}

test("charges only the frame table against the budget", () => {
  const cache = createMediaProbeCache(1024 * 1024);
  cache.set(makeProbe("a", 1000));
  // 1000 frames x 4 bytes; the facts themselves are not counted.
  expect(cache.bytes()).toBe(4000);
});

test("evicting a frame table keeps the measured offset", () => {
  // The headline case. Two tables that cannot coexist, and the number that costs two decodes to
  // re-derive must survive the one that costs only range reads.
  const cache = createMediaProbeCache(4096);
  cache.set(makeProbe("a", 1000));
  const first = cache.get("a");
  if (!first) {
    throw new Error("probe was not stored");
  }
  // Written in place, exactly as `verifyMp3Alignment` does — the probe handed out IS the stored
  // facts record, which is what lets that contract survive the split.
  first.alignDeltaSamples = 2257;
  first.verified = "pass";

  cache.set(makeProbe("b", 1000));

  const after = cache.get("a");
  expect(after?.mp3).toBeUndefined();
  expect(after?.alignDeltaSamples).toBe(2257);
  expect(after?.verified).toBe("pass");
  // And the shape the segment planner reads, which used to hang off the evicted table.
  expect(after?.sampleRate).toBe(44100);
  expect(after?.channels).toBe(2);
});

test("keeps every fact resident however many tables are evicted", () => {
  const cache = createMediaProbeCache(4096);
  for (let index = 0; index < 20; index += 1) {
    cache.set(makeProbe(`media-${String(index)}`, 1000));
  }
  expect(cache.size()).toBe(20);
  expect(cache.indexCount()).toBeLessThan(20);
  expect(cache.bytes()).toBeLessThanOrEqual(4096);
});

test("re-attaching a table does not duplicate its bytes", () => {
  const cache = createMediaProbeCache(1024 * 1024);
  cache.set(makeProbe("a", 1000));
  cache.setIndex("a", makeIndex(1000));
  expect(cache.bytes()).toBe(4000);
  expect(cache.indexCount()).toBe(1);
});

test("evicts the least recently used table, not the newest", () => {
  const cache = createMediaProbeCache(8192);
  cache.set(makeProbe("a", 1000));
  cache.set(makeProbe("b", 1000));
  // Touching `a` makes `b` the oldest.
  cache.get("a");
  cache.set(makeProbe("c", 1000));

  expect(cache.get("a")?.mp3).toBeDefined();
  expect(cache.get("b")?.mp3).toBeUndefined();
  expect(cache.get("c")?.mp3).toBeDefined();
});

test("never evicts the table just attached", () => {
  // Otherwise the caller that just paid for a rebuild would find it gone on the next line.
  const cache = createMediaProbeCache(1);
  cache.set(makeProbe("a", 1000));
  expect(cache.get("a")?.mp3).toBeDefined();
});

test("delete removes both halves", () => {
  const cache = createMediaProbeCache(1024 * 1024);
  cache.set(makeProbe("a", 1000));
  expect(cache.delete("a")).toBe(true);
  expect(cache.get("a")).toBeNull();
  expect(cache.bytes()).toBe(0);
  expect(cache.indexCount()).toBe(0);
});

test("clear resets the byte count", () => {
  const cache = createMediaProbeCache(1024 * 1024);
  cache.set(makeProbe("a", 1000));
  cache.set(makeProbe("b", 1000));
  cache.clear();
  expect(cache.size()).toBe(0);
  expect(cache.bytes()).toBe(0);
  expect(cache.indexCount()).toBe(0);
});

test("a probe with no table costs nothing", () => {
  const cache = createMediaProbeCache(1024 * 1024);
  cache.set({
    mediaId: "wav",
    format: "wav",
    containerDurationSeconds: 10,
    sampleRate: 44100,
    channels: 1,
    alignDeltaSamples: 0,
    verified: "pass",
    partialDisabled: false,
    failures: 0
  });
  expect(cache.bytes()).toBe(0);
  expect(cache.get("wav")?.verified).toBe("pass");
});

test("hands back the object it was given, so an in-place result is not lost", () => {
  // The contract the whole feature rests on. `verifyMp3Alignment` records its answer by mutating
  // the probe it was handed, and nothing calls `set` afterwards - so storing a COPY meant a
  // measured `alignDeltaSamples` went to an object the cache did not hold. The next read saw null,
  // the media took a full decode, and the two-decode measurement ran again on every warm-up.
  const cache = createMediaProbeCache();
  const probe = makeProbe("identity", 100);
  cache.set(probe);
  probe.alignDeltaSamples = 2257;
  probe.verified = "pass";
  const read = cache.get("identity");
  expect(read).toBe(probe);
  expect(read?.alignDeltaSamples).toBe(2257);
  expect(read?.verified).toBe("pass");
});

test("setting the same media twice does not charge its table twice", () => {
  // `getMediaProbe` has no in-flight dedup and three awaits between the miss and the `set`, so two
  // warm-up workers on the same media both build and both store. Without the removal at the top of
  // `set`, the second charge is never refunded and the budget evicts tables that are still wanted.
  const cache = createMediaProbeCache();
  cache.set(makeProbe("twice", 1000));
  const once = cache.bytes();
  expect(once).toBeGreaterThan(0);
  cache.set(makeProbe("twice", 1000));
  expect(cache.bytes()).toBe(once);
  expect(cache.indexCount()).toBe(1);
  cache.delete("twice");
  expect(cache.bytes()).toBe(0);
});

test("a table that grows while resident is refunded what it was charged", () => {
  // `indexBytes` reports allocated capacity, and `pushOffset` doubles that capacity in place while
  // a cue plays. Refunding the CURRENT size drove the total negative, after which `evict` returned
  // immediately on every call and the frame-table budget stopped existing for the session.
  const cache = createMediaProbeCache();
  const probe = makeProbe("growing", 1000);
  cache.set(probe);
  const charged = cache.bytes();
  const grown = probe.mp3;
  if (!grown) {
    throw new Error("fixture");
  }
  grown.byteOffsets = new Uint32Array(grown.byteOffsets.length * 8);
  cache.delete("growing");
  expect(cache.bytes()).toBe(0);
  expect(charged).toBeGreaterThan(0);
});

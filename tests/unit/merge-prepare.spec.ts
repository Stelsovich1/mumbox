import { expect, test } from "@playwright/test";

import { prepareMerge } from "../../src/features/project-merge/model/runMerge";
import type { SerializableAppState } from "../../src/app/model/appState";

/**
 * What a merge would write, before anything is written.
 *
 * This file exists because a mutation round found the gap: `selectMediaToHash`'s size-bucket filter
 * had NO test at all, so widening it from `bucket.length > 1` to `> 2` left every command green
 * while silently disabling deduplication for the ordinary case — one copy of a file in each
 * project. The e2e written for this area cannot see it either: its two files are genuinely
 * different and are kept either way.
 *
 * The blob loaders are injected, which is the whole reason this module is reachable from the unit
 * tier: `getMediaBlob` lives behind `react` and `idb-keyval`.
 */

const HASH_A = "a".repeat(64);

function media(patch: { id: string; fileName?: string; size?: number; contentHash?: string }) {
  return {
    id: patch.id,
    fileName: patch.fileName ?? "bell.wav",
    alias: "",
    color: "#ec5aa7",
    mimeType: "audio/wav",
    size: patch.size ?? 1024,
    durationMs: 1000,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...(patch.contentHash ? { contentHash: patch.contentHash } : {})
  };
}

function state(assets: ReturnType<typeof media>[]): SerializableAppState {
  return {
    panels: [{ id: "panel-1", name: "Panel 1", gridSize: 6, cellIds: [] }],
    activePanelId: "panel-1",
    cellsByPanel: { "panel-1": {} },
    media: assets,
    masterVolume: 80,
    masterMuted: false,
    stopOthers: false,
    monoPlayback: false
  };
}

function blob(bytes: number[]): Blob {
  return new Blob([new Uint8Array(bytes)]);
}

function project(assets: ReturnType<typeof media>[], blobs: Record<string, Blob>) {
  return {
    state: state(assets),
    meta: {},
    mediaBlobs: assets.map((asset) => ({
      id: asset.id,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      crc32: 0,
      blob: blobs[asset.id] ?? blob([0])
    }))
  };
}

test("hashes both sides and deduplicates identical bytes", () => {
  // The headline case, and the one the size-bucket filter decides: ONE copy each side, neither
  // hashed, same length. A filter that only hashed buckets of three or more would leave this pair
  // undecided and duplicate the audio, while every test stayed green.
  const bytes = [1, 2, 3, 4];
  const current = state([media({ id: "cur" })]);
  const incoming = project([media({ id: "inc" })], { inc: blob(bytes) });

  return prepareMerge(current, incoming, {
    loadBlob: () => Promise.resolve(blob(bytes))
  }).then((preparation) => {
    expect(preparation.reusedCount).toBe(1);
    expect(preparation.keptIncomingIds).toEqual([]);
    expect(preparation.undecidedCount).toBe(0);
    // Both sides gained a hash, and both are reported so the work is not thrown away.
    expect(preparation.computedHashes).toHaveLength(2);
    expect(preparation.current.media[0]?.contentHash).toBeTruthy();
  });
});

test("same name and size, different bytes, keeps both", async () => {
  // The silent data-substitution bug this whole rule exists to prevent.
  const current = state([media({ id: "cur" })]);
  const incoming = project([media({ id: "inc" })], { inc: blob([9, 9, 9, 9]) });

  const preparation = await prepareMerge(current, incoming, {
    loadBlob: () => Promise.resolve(blob([1, 2, 3, 4]))
  });
  expect(preparation.reusedCount).toBe(0);
  expect(preparation.keptIncomingIds).toEqual(["inc"]);
  expect(preparation.undecidedCount).toBe(0);
});

test("an asset that matches nothing by size is never hashed", async () => {
  // The saving the bucket filter buys: nothing in the other project can share those bytes, so
  // reading the blob at all would be wasted I/O on a file that may be hundreds of megabytes.
  const loaded: string[] = [];
  const current = state([media({ id: "cur", size: 4096 })]);
  const incoming = project([media({ id: "inc", size: 1024 })], { inc: blob([1]) });

  const preparation = await prepareMerge(current, incoming, {
    loadBlob: (id) => {
      loaded.push(id);
      return Promise.resolve(blob([1]));
    }
  });
  expect(loaded).toEqual([]);
  expect(preparation.computedHashes).toEqual([]);
  expect(preparation.keptIncomingIds).toEqual(["inc"]);
});

test("an asset with no recorded size is always hashed", async () => {
  // A legacy `MediaAsset`. The name-and-size fallback can match it across sizes, so it cannot be
  // excluded by bucket.
  const loaded: string[] = [];
  const current = state([media({ id: "cur", size: undefined })]);
  const incoming = project([media({ id: "inc", size: 1024 })], { inc: blob([1, 2]) });

  await prepareMerge(current, incoming, {
    loadBlob: (id) => {
      loaded.push(id);
      return Promise.resolve(blob([1, 2]));
    }
  });
  expect(loaded).toEqual(["cur"]);
});

test("an unreadable current blob leaves the pair undecided rather than matched", async () => {
  // "Cannot be compared" must never collapse into "the same", which is the asymmetry the whole
  // three-valued comparison is built around.
  const current = state([media({ id: "cur" })]);
  const incoming = project([media({ id: "inc" })], { inc: blob([1, 2, 3, 4]) });

  const preparation = await prepareMerge(current, incoming, {
    loadBlob: () => Promise.resolve(undefined)
  });
  expect(preparation.reusedCount).toBe(0);
  expect(preparation.undecidedCount).toBe(1);
  expect(preparation.keptIncomingIds).toEqual(["inc"]);
});

test("without a blob loader the current side stays unhashed and nothing is asserted", async () => {
  const current = state([media({ id: "cur" })]);
  const incoming = project([media({ id: "inc" })], { inc: blob([1, 2, 3, 4]) });

  const preparation = await prepareMerge(current, incoming);
  expect(preparation.reusedCount).toBe(0);
  expect(preparation.undecidedCount).toBe(1);
});

test("an existing hash is trusted and not recomputed", async () => {
  const loaded: string[] = [];
  const current = state([media({ id: "cur", contentHash: HASH_A })]);
  const incoming = project([media({ id: "inc", contentHash: HASH_A })], { inc: blob([1]) });

  const preparation = await prepareMerge(current, incoming, {
    loadBlob: (id) => {
      loaded.push(id);
      return Promise.resolve(blob([1]));
    }
  });
  expect(loaded).toEqual([]);
  expect(preparation.reusedCount).toBe(1);
});

test("survivorBytes counts only what will actually be written", async () => {
  const current = state([media({ id: "cur" })]);
  const incoming = project([media({ id: "kept", size: 2048 }), media({ id: "dupe" })], {
    kept: blob([7, 7, 7, 7, 7, 7]),
    dupe: blob([1, 2, 3, 4])
  });

  const preparation = await prepareMerge(current, incoming, {
    loadBlob: () => Promise.resolve(blob([1, 2, 3, 4]))
  });
  expect(preparation.reusedCount).toBe(1);
  expect(preparation.keptIncomingIds).toEqual(["kept"]);
  expect(preparation.survivorBytes).toBe(6);
});

test("reports progress once per asset it actually hashes", async () => {
  const labels: string[] = [];
  const current = state([media({ id: "cur" })]);
  const incoming = project([media({ id: "inc" })], { inc: blob([1, 2, 3, 4]) });

  await prepareMerge(current, incoming, {
    loadBlob: () => Promise.resolve(blob([1, 2, 3, 4])),
    onProgress: (progress) => {
      labels.push(progress.label);
    }
  });
  expect(labels).toHaveLength(2);
  expect(labels[1]).toContain("2 из 2");
});

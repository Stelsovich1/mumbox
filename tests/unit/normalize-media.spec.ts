import { expect, test } from "@playwright/test";

import { ensureMedia } from "../../src/entities/media/model/normalizeMedia";
import { MediaAsset } from "../../src/entities/media/model/types";

const validHash = "a".repeat(64);

const valid: MediaAsset = {
  id: "media-1",
  fileName: "sound.wav",
  alias: "Звук",
  color: "#ec5aa7",
  mimeType: "audio/wav",
  size: 1024,
  durationMs: 2500,
  createdAt: "2024-01-05T09:07:00.000Z",
  contentHash: validHash
};

test("leaves a well-formed asset deep-equal", () => {
  expect(ensureMedia([valid])).toEqual([valid]);
});

test("returns an empty array for anything that is not an array", () => {
  expect(ensureMedia(undefined)).toEqual([]);
  expect(ensureMedia(null)).toEqual([]);
  expect(ensureMedia({})).toEqual([]);
});

test("drops entries without a usable id", () => {
  expect(ensureMedia([valid, { fileName: "x.wav" }, null, "nope", { id: "" }])).toEqual([valid]);
});

test("preserves order", () => {
  const second = { ...valid, id: "media-2" };

  expect(ensureMedia([second, valid]).map((media) => media.id)).toEqual(["media-2", "media-1"]);
});

test("drops a content hash that is not a 64-character hex digest", () => {
  expect(ensureMedia([{ ...valid, contentHash: "nope" }])[0]?.contentHash).toBeUndefined();
  expect(ensureMedia([{ ...valid, contentHash: "A".repeat(64) }])[0]?.contentHash).toBeUndefined();
  expect(ensureMedia([{ ...valid, contentHash: validHash }])[0]?.contentHash).toBe(validHash);
});

test("keeps size only when it is a finite number", () => {
  expect(ensureMedia([{ ...valid, size: undefined }])[0]?.size).toBeUndefined();
  expect(ensureMedia([{ ...valid, size: Number.NaN }])[0]?.size).toBeUndefined();
  expect(ensureMedia([{ ...valid, size: 10 }])[0]?.size).toBe(10);
});

test("never invents a createdAt for an asset written by an older build", () => {
  const withoutDate: Record<string, unknown> = { ...valid };
  delete withoutDate.createdAt;

  expect(ensureMedia([withoutDate])[0]?.createdAt).toBe("");
});

test("coerces wrong-typed fields instead of throwing", () => {
  const normalized = ensureMedia([{ id: "media-9", fileName: 42, durationMs: "long" }])[0];

  expect(normalized?.fileName).toBe("");
  expect(normalized?.durationMs).toBeNull();
});

import { expect, test } from "@playwright/test";

import {
  decodeMediaDragPayload,
  encodeMediaDragPayload
} from "../../src/shared/lib/mediaDragTransfer";

test("round-trips media ids and their order", () => {
  const ids = ["media-b", "media-a", "media-c"];

  expect(decodeMediaDragPayload(encodeMediaDragPayload(ids))).toEqual(ids);
});

test("rejects an empty or blank payload", () => {
  expect(decodeMediaDragPayload("")).toBeNull();
  expect(decodeMediaDragPayload("   ")).toBeNull();
});

test("rejects a payload that is not JSON", () => {
  expect(decodeMediaDragPayload("{oops")).toBeNull();
});

test("rejects a payload from another version", () => {
  expect(decodeMediaDragPayload('{"version":2,"mediaIds":["a"]}')).toBeNull();
});

test("rejects a payload whose mediaIds is not an array", () => {
  expect(decodeMediaDragPayload('{"version":1,"mediaIds":"a"}')).toBeNull();
});

test("rejects an empty drag", () => {
  expect(decodeMediaDragPayload('{"version":1,"mediaIds":[]}')).toBeNull();
});

test("rejects a payload containing a non-string or empty id", () => {
  expect(decodeMediaDragPayload('{"version":1,"mediaIds":["a",1]}')).toBeNull();
  expect(decodeMediaDragPayload('{"version":1,"mediaIds":["a",""]}')).toBeNull();
});

test("rejects a payload that is not an object", () => {
  expect(decodeMediaDragPayload("42")).toBeNull();
  expect(decodeMediaDragPayload("null")).toBeNull();
});

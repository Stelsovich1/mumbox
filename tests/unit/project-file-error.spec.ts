import { expect, test } from "@playwright/test";

import {
  classifyProjectFileError,
  ProjectFileError
} from "../../src/features/file-config/model/projectFileError";

/**
 * The classifier decides which sentence the user reads after a failed import, and the whole point
 * of it is that those sentences lead to different actions: re-pick the file, free some space, or
 * accept that the file is damaged. Nothing tested it, and the e2e for this area only ever asserts
 * the "повреждён" wording — so four of the six kinds were unpinned end to end and the two
 * `QuotaExceededError` branches could both be deleted with every command green.
 */

test("a thrown ProjectFileError keeps its own kind", () => {
  for (const kind of ["not-a-project", "corrupt", "too-large", "no-space"] as const) {
    expect(classifyProjectFileError(new ProjectFileError(kind, "detail"))).toBe(kind);
  }
});

test("a file that vanished between the pick and the read is unreadable, not corrupt", () => {
  // The distinction that matters: a re-pick fixes this one, and calling it corruption would tell
  // the user their project is damaged when it is intact on disk.
  expect(classifyProjectFileError(new DOMException("gone", "NotFoundError"))).toBe("unreadable");
  expect(classifyProjectFileError(new DOMException("io", "NotReadableError"))).toBe("unreadable");
});

test("a full store is reported as a full store, however it was thrown", () => {
  // Two branches on purpose: not every engine throws a DOMException for a full store, and
  // idb-keyval surfaces whatever the request produced. Dropping the plain-Error branch turns "not
  // enough space" into "unknown", which tells the user nothing they can act on.
  expect(classifyProjectFileError(new DOMException("full", "QuotaExceededError"))).toBe("no-space");
  const plain = new Error("full");
  plain.name = "QuotaExceededError";
  expect(classifyProjectFileError(plain)).toBe("no-space");
});

test("anything else is unknown rather than guessed at", () => {
  expect(classifyProjectFileError(new Error("boom"))).toBe("unknown");
  expect(classifyProjectFileError(new DOMException("nope", "NotAllowedError"))).toBe("unknown");
  expect(classifyProjectFileError("a string")).toBe("unknown");
  expect(classifyProjectFileError(null)).toBe("unknown");
});

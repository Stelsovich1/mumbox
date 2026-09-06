import { expect, test } from "@playwright/test";

import { planMediaDedup } from "../../src/features/project-merge/model/mediaDedup";
import type { DedupCandidate } from "../../src/features/project-merge/model/mediaDedup";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

function candidate(patch: Partial<DedupCandidate> & { id: string }): DedupCandidate {
  return {
    fileName: "sound.wav",
    size: 1024,
    mimeType: "audio/wav",
    ...patch
  };
}

test("reuses a current asset when the content hashes match", () => {
  const plan = planMediaDedup(
    [candidate({ id: "cur", contentHash: hashA })],
    [candidate({ id: "inc", contentHash: hashA })]
  );

  expect(plan.mediaIdMap.get("inc")).toBe("cur");
  expect(plan.keptIncomingIds).toEqual([]);
  expect(plan.reusedCount).toBe(1);
});

test("matches by hash even when the file names differ", () => {
  const plan = planMediaDedup(
    [candidate({ id: "cur", fileName: "kick.wav", contentHash: hashA })],
    [candidate({ id: "inc", fileName: "kick-copy.wav", contentHash: hashA })]
  );

  expect(plan.mediaIdMap.get("inc")).toBe("cur");
  expect(plan.reusedCount).toBe(1);
});

test("keeps both when the hashes differ despite an identical name and size", () => {
  const plan = planMediaDedup(
    [candidate({ id: "cur", contentHash: hashA })],
    [candidate({ id: "inc", contentHash: hashB })]
  );

  expect(plan.mediaIdMap.get("inc")).toBe("inc");
  expect(plan.keptIncomingIds).toEqual(["inc"]);
  expect(plan.reusedCount).toBe(0);
});

test("falls back to name and size when neither side is hashed", () => {
  const plan = planMediaDedup([candidate({ id: "cur" })], [candidate({ id: "inc" })]);

  expect(plan.mediaIdMap.get("inc")).toBe("cur");
  expect(plan.reusedCount).toBe(1);
});

test("falls back to name and size when only one side is hashed", () => {
  const matched = planMediaDedup(
    [candidate({ id: "cur" })],
    [candidate({ id: "inc", contentHash: hashA })]
  );
  expect(matched.mediaIdMap.get("inc")).toBe("cur");

  const different = planMediaDedup(
    [candidate({ id: "cur", size: 4096 })],
    [candidate({ id: "inc", contentHash: hashA })]
  );
  expect(different.mediaIdMap.get("inc")).toBe("inc");
});

test("collapses two copies of one file inside the incoming project", () => {
  const plan = planMediaDedup(
    [],
    [candidate({ id: "inc-1", contentHash: hashA }), candidate({ id: "inc-2", contentHash: hashA })]
  );

  expect(plan.mediaIdMap.get("inc-1")).toBe("inc-1");
  expect(plan.mediaIdMap.get("inc-2")).toBe("inc-1");
  expect(plan.keptIncomingIds).toEqual(["inc-1"]);
  expect(plan.reusedCount).toBe(1);
});

test("survives a missing size without crashing", () => {
  const plan = planMediaDedup(
    [candidate({ id: "cur", size: undefined })],
    [candidate({ id: "inc", size: undefined })]
  );

  expect(plan.mediaIdMap.get("inc")).toBe("cur");
});

test("maps every incoming id exactly once", () => {
  const incoming = [
    candidate({ id: "inc-1", contentHash: hashA }),
    candidate({ id: "inc-2", contentHash: hashB }),
    candidate({ id: "inc-3", fileName: "other.wav" })
  ];
  const plan = planMediaDedup([candidate({ id: "cur", contentHash: hashA })], incoming);

  expect([...plan.mediaIdMap.keys()].sort()).toEqual(["inc-1", "inc-2", "inc-3"]);
});

test("keeps everything when the current project is empty", () => {
  const plan = planMediaDedup([], [candidate({ id: "inc" })]);

  expect(plan.keptIncomingIds).toEqual(["inc"]);
  expect(plan.reusedCount).toBe(0);
});

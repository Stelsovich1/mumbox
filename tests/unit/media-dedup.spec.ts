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

test("refuses to match on name and size alone", () => {
  // The behaviour this replaces, and the reason it had to go: two different files of the same name
  // and length — routine for jingles exported from one preset — were declared identical, the
  // incoming blob was never written, and the cue silently played the other project's audio. The
  // errors are asymmetric: a false duplicate is silent and unrecoverable, a false new one is a
  // visible extra row the user can delete.
  const plan = planMediaDedup([candidate({ id: "cur" })], [candidate({ id: "inc" })]);

  expect(plan.mediaIdMap.get("inc")).toBe("inc");
  expect(plan.keptIncomingIds).toEqual(["inc"]);
  expect(plan.reusedCount).toBe(0);
  expect(plan.undecidedCount).toBe(1);
});

test("keeps an asset when only one side is hashed and the two look alike", () => {
  const plan = planMediaDedup(
    [candidate({ id: "cur" })],
    [candidate({ id: "inc", contentHash: hashA })]
  );
  expect(plan.mediaIdMap.get("inc")).toBe("inc");
  expect(plan.undecidedCount).toBe(1);
});

test("a differing size is still a decided answer, and a cheap one", () => {
  // Split from the case above on purpose: both used to be one test, and only one of them changed.
  // Nothing differing in name or length can be the same bytes, so this is decided without a hash.
  const plan = planMediaDedup(
    [candidate({ id: "cur", size: 4096 })],
    [candidate({ id: "inc", contentHash: hashA })]
  );
  expect(plan.mediaIdMap.get("inc")).toBe("inc");
  expect(plan.undecidedCount).toBe(0);
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

test("survives a missing size without crashing, and still refuses to guess", () => {
  const plan = planMediaDedup(
    [candidate({ id: "cur", size: undefined })],
    [candidate({ id: "inc", size: undefined })]
  );

  expect(plan.mediaIdMap.get("inc")).toBe("inc");
  expect(plan.undecidedCount).toBe(1);
});

test("scales to a thousand assets a side", () => {
  // The old shape compared every incoming asset against every current one. The guard here is the
  // tier timeout rather than a timing assertion, which would be flaky by construction.
  const current = Array.from({ length: 1000 }, (_, index) =>
    candidate({ id: `cur-${String(index)}`, contentHash: String(index).padStart(64, "0") })
  );
  const incoming = Array.from({ length: 1000 }, (_, index) =>
    candidate({ id: `inc-${String(index)}`, contentHash: String(index).padStart(64, "0") })
  );
  const plan = planMediaDedup(current, incoming);
  expect(plan.reusedCount).toBe(1000);
  expect(plan.keptIncomingIds).toHaveLength(0);
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

test("a size-less current asset is still compared against a sized incoming one", () => {
  // The size-less bucket is merged into every comparison pool because the name-and-size
  // fallback can match across sizes. Dropping that merge survived a mutation round: a legacy
  // asset with no recorded size would be reported as no duplicates instead of not checked.
  const plan = planMediaDedup(
    [candidate({ id: "cur", size: undefined })],
    [candidate({ id: "inc", size: 1024 })]
  );
  expect(plan.mediaIdMap.get("inc")).toBe("inc");
  expect(plan.undecidedCount).toBe(1);
});

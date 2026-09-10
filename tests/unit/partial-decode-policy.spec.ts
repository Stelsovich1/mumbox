import { expect, test } from "@playwright/test";

import {
  derivePartialVerdict,
  PARTIAL_MIN_FAILURES,
  PARTIAL_MIN_VERIFICATIONS
} from "../../src/shared/lib/partialDecodePolicy";

/**
 * The blocking rule, in isolation.
 *
 * It is unit-tested rather than left to the e2e tier because the failure it guards against is not
 * observable as a failure at all: a blocked verdict is silent, every pad still plays, and the only
 * symptom is memory. Measured on a real 16-file library under the previous rule — 14 passes and one
 * `windows-disagree` — the browser was blocked permanently and the panel held 1 539 MiB of resident
 * PCM, with the session then killed. (A working panel measures 110-180 MiB, but on other hardware
 * and another project: an order of magnitude, not a paired measurement.)
 *
 * `derivePartialVerdict` is pure on purpose. The tally around it needs `localStorage` and a
 * `navigator`, neither of which the unit tier has, so the decision is the part that is testable
 * here and it is also the part that was wrong.
 */

test("one failure among many passes does not block the browser", () => {
  // The exact shape measured in the field, and the whole reason this rule changed.
  expect(derivePartialVerdict({ passes: 14, failures: 1, hardBlocked: false })).toBe("ok");
});

test("failures block only once they outnumber the passes", () => {
  expect(
    derivePartialVerdict({ passes: PARTIAL_MIN_FAILURES, failures: PARTIAL_MIN_FAILURES, hardBlocked: false })
  ).not.toBe("blocked");
  expect(
    derivePartialVerdict({ passes: PARTIAL_MIN_FAILURES - 1, failures: PARTIAL_MIN_FAILURES, hardBlocked: false })
  ).toBe("blocked");
});

test("a browser that fails everything is blocked, and only past the minimum", () => {
  // Below the minimum nothing is decided: the per-media flag has already taken those files off the
  // path, so there is no need to punish the browser on the strength of one or two samples.
  expect(derivePartialVerdict({ passes: 0, failures: PARTIAL_MIN_FAILURES - 1, hardBlocked: false })).toBe(
    "unknown"
  );
  expect(derivePartialVerdict({ passes: 0, failures: PARTIAL_MIN_FAILURES, hardBlocked: false })).toBe(
    "blocked"
  );
});

test("a blocked tally recovers once passes take the lead again", () => {
  // The old rule could not do this: its recovery branch was guarded by `verdict !== "blocked"`, so
  // the block was a one-way door for the life of the browser profile.
  expect(derivePartialVerdict({ passes: 2, failures: 4, hardBlocked: false })).toBe("blocked");
  expect(derivePartialVerdict({ passes: 5, failures: 4, hardBlocked: false })).toBe("ok");
});

test("a capability failure is not liftable by any tally", () => {
  // `decode-rejected` means the browser refused a slice the full decode accepts. That is not a
  // score, so no number of passes may overturn it.
  expect(derivePartialVerdict({ passes: 1000, failures: 1, hardBlocked: true })).toBe("blocked");
});

test("nothing is decided before the minimum number of verifications", () => {
  expect(
    derivePartialVerdict({ passes: PARTIAL_MIN_VERIFICATIONS - 1, failures: 0, hardBlocked: false })
  ).toBe("unknown");
  expect(
    derivePartialVerdict({ passes: PARTIAL_MIN_VERIFICATIONS, failures: 0, hardBlocked: false })
  ).toBe("ok");
});

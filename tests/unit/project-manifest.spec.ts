import { expect, test } from "@playwright/test";

import {
  isSerializableAppState,
  parseProjectManifest
} from "../../src/features/file-config/model/projectManifest";

/**
 * The predicate the reducer's safety depends on.
 *
 * The old one checked four things and then handed the object to `sanitizeImportedState`, which
 * immediately reads `state.panels.length`. So a hand-edited or corrupt manifest threw a `TypeError`
 * inside the reducer — with no boundary to catch it and, under the old import ordering, after the
 * previous project's audio had already been deleted.
 *
 * The rule is NOT "validate everything". `version` is frozen at 2 precisely so an older build can
 * read a newer file, and rejecting an unknown optional field would break that in both directions.
 * Require exactly what the sanitizer throws on; tolerate what it tolerates. Both halves are tested.
 */

function validState() {
  return {
    panels: [{ id: "panel-1", name: "Panel 1", gridSize: 8, cellIds: ["cell-0"] }],
    activePanelId: "panel-1",
    cellsByPanel: { "panel-1": { "cell-0": { id: "cell-0", mediaId: null } } },
    media: [],
    masterVolume: 80,
    stopOthers: false
  };
}

function validManifest(stateOverride?: unknown) {
  return {
    kind: "mumbox-project",
    version: 2,
    exportedAt: "2026-01-01T00:00:00.000Z",
    state: stateOverride ?? validState(),
    mediaBlobs: []
  };
}

test("accepts a realistic manifest", () => {
  expect(parseProjectManifest(validManifest()).ok).toBe(true);
});

test("rejects anything that is not an object", () => {
  for (const value of [null, undefined, 42, "x", []]) {
    const result = parseProjectManifest(value);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toBe("not-an-object");
  }
});

test("rejects a foreign kind", () => {
  const result = parseProjectManifest({ ...validManifest(), kind: "something-else" });
  expect(result.ok ? "" : result.reason).toBe("wrong-kind");
});

test("compares the version exactly, in both directions", () => {
  // Frozen at 2: an older build must still open a file a newer one writes, so nothing may be
  // accepted "or newer" and nothing older may sneak through either.
  for (const version of [1, 3, "2", null]) {
    const result = parseProjectManifest({ ...validManifest(), version });
    expect(result.ok ? "" : result.reason).toBe("wrong-version");
  }
});

test("rejects a state with no panels array", () => {
  // `sanitizeImportedState` reads `state.panels.length` as its first act.
  const rest: Record<string, unknown> = { ...validState() };
  delete rest.panels;
  const result = parseProjectManifest(validManifest(rest));
  expect(result.ok ? "" : result.reason).toBe("bad-panels");
});

test("rejects a state with no cellsByPanel", () => {
  const rest: Record<string, unknown> = { ...validState() };
  delete rest.cellsByPanel;
  const result = parseProjectManifest(validManifest(rest));
  expect(result.ok ? "" : result.reason).toBe("bad-cells");
});

test("accepts an empty panel list", () => {
  // The sanitizer explicitly substitutes a default panel for this, so rejecting it would refuse a
  // legitimate file.
  const result = parseProjectManifest(validManifest({ ...validState(), panels: [] }));
  expect(result.ok).toBe(true);
});

test("rejects a grid size that is not one of the selectable ones", () => {
  // A non-number does not throw — it makes `Array.from({length: NaN})` produce an empty panel and
  // silently loses every cue in it, which is worse than a throw.
  for (const gridSize of [7, "8", null, undefined]) {
    const state = validState();
    const result = parseProjectManifest(
      validManifest({ ...state, panels: [{ ...state.panels[0], gridSize }] })
    );
    expect(result.ok ? "" : result.reason).toBe("bad-panels");
  }
});

test("rejects a panel whose name is not a string", () => {
  // makeUniquePanelName, rename and copy all treat it as one, and the tab renders it. Dropping
  // this half of the identity check survived a mutation round.
  const state = validState();
  for (const name of [42, null, undefined]) {
    const result = parseProjectManifest(
      validManifest({ ...state, panels: [{ ...state.panels[0], name }] })
    );
    expect(result.ok ? "" : result.reason).toBe("bad-panels");
  }
});

test("rejects a panel with missing or non-string cell ids", () => {
  const state = validState();
  expect(
    parseProjectManifest(validManifest({ ...state, panels: [{ ...state.panels[0], cellIds: [1] }] }))
      .ok
  ).toBe(false);
  const panelRest: Record<string, unknown> = { ...state.panels[0] };
  delete panelRest.cellIds;
  expect(parseProjectManifest(validManifest({ ...state, panels: [panelRest] })).ok).toBe(false);
});

test("rejects a null cell record or a null cell", () => {
  const state = validState();
  expect(
    parseProjectManifest(validManifest({ ...state, cellsByPanel: { "panel-1": null } })).ok
  ).toBe(false);
  expect(
    parseProjectManifest(
      validManifest({ ...state, cellsByPanel: { "panel-1": { "cell-0": null } } })
    ).ok
  ).toBe(false);
});

test("rejects a non-string media id but accepts null and absent", () => {
  const state = validState();
  const withId = (mediaId: unknown) =>
    parseProjectManifest(
      validManifest({ ...state, cellsByPanel: { "panel-1": { "cell-0": { mediaId } } } })
    ).ok;
  expect(withId(42)).toBe(false);
  expect(withId(null)).toBe(true);
  expect(
    parseProjectManifest(
      validManifest({ ...state, cellsByPanel: { "panel-1": { "cell-0": {} } } })
    ).ok
  ).toBe(true);
});

test("requires a finite master volume, and zero is fine", () => {
  // It reaches `masterVolume / 100` and then a gain node, where a NaN throws far from here.
  for (const masterVolume of [undefined, "80", Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = parseProjectManifest(validManifest({ ...validState(), masterVolume }));
    expect(result.ok ? "" : result.reason).toBe("bad-volume");
  }
  expect(parseProjectManifest(validManifest({ ...validState(), masterVolume: 0 })).ok).toBe(true);
});

test("does NOT over-validate the fields the sanitizer tolerates", () => {
  // Each of these is deliberately accepted: `ensureMedia` takes anything, `activePanelId` falls back
  // to the first panel, and the optional flags are optional by type. Rejecting any of them would
  // break the frozen-version contract the moment a build added a field.
  const state = validState();
  const tolerated: unknown[] = [
    { ...state, media: undefined },
    { ...state, media: null },
    { ...state, media: [{ nonsense: true }] },
    { ...state, activePanelId: undefined },
    { ...state, stopOthers: undefined },
    { ...state, masterMuted: undefined },
    { ...state, monoPlayback: undefined },
    { ...state, unknownFutureField: 1 }
  ];
  for (const candidate of tolerated) {
    expect(parseProjectManifest(validManifest(candidate)).ok).toBe(true);
  }
  expect(parseProjectManifest({ ...validManifest(), meta: "garbage" }).ok).toBe(true);
  expect(parseProjectManifest({ ...validManifest(), unknownTopLevel: 1 }).ok).toBe(true);
});

test("validates the media blob list the reader indexes by", () => {
  // The reader looks entries up as `media/${id}` and stamps `mimeType` onto a Blob, so both must be
  // strings before either is used.
  expect(parseProjectManifest({ ...validManifest(), mediaBlobs: null }).ok).toBe(false);
  expect(parseProjectManifest({ ...validManifest(), mediaBlobs: [{ id: 1 }] }).ok).toBe(false);
  expect(parseProjectManifest({ ...validManifest(), mediaBlobs: [{ id: "" }] }).ok).toBe(false);
  expect(
    parseProjectManifest({
      ...validManifest(),
      mediaBlobs: [{ id: "m1", fileName: "a.wav", mimeType: "audio/wav" }]
    }).ok
  ).toBe(true);
});

test("the standalone state predicate agrees with the manifest parser", () => {
  expect(isSerializableAppState(validState())).toBe(true);
  expect(isSerializableAppState(null)).toBe(false);
  expect(isSerializableAppState({ panels: [] })).toBe(false);
});

test("rejects a panel whose id is not a string", () => {
  // `cellsByPanel` is keyed by it, `activePanelId` is compared against it, and `panel/delete`
  // matches on it. Dropping this half of the check survived every command, and a manifest with a
  // numeric id imports into a state where the panel's own cells cannot be found.
  const state = validState();
  for (const id of [42, null, undefined, {}]) {
    const result = parseProjectManifest(
      validManifest({ ...state, panels: [{ ...state.panels[0], id }] })
    );
    expect(result.ok ? "" : result.reason).toBe("bad-panels");
  }
});

test("rejects a media blob entry whose file name or mime type is not a string", () => {
  // Both reach real sinks: the mime type goes to `new Blob(..., {type})` and the file name is
  // rendered in the library and used by the merge's cheap negative comparison. The existing cases
  // all fail on `id` first, so these two clauses could be deleted with the suite green.
  for (const entry of [
    { id: "m1", fileName: 42, mimeType: "audio/wav" },
    { id: "m1", fileName: "a.wav", mimeType: 42 },
    { id: "m1", fileName: "a.wav" }
  ]) {
    const result = parseProjectManifest({ ...validManifest(), mediaBlobs: [entry] });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toBe("bad-media-blobs");
  }
});

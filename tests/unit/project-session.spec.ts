import { expect, test } from "@playwright/test";

import type { AppAction } from "../../src/app/model/appState";
import {
  isDirtyingAction,
  makeUnsavedSession,
  withDirtyTracking
} from "../../src/app/model/projectSession";

type FakeState = { value: number; projectSession: ReturnType<typeof makeUnsavedSession> };

function makeState(dirty = false): FakeState {
  return { value: 0, projectSession: { ...makeUnsavedSession(), dirty } };
}

/** Stands in for the real reducer: bumps a counter, or returns the same object for a no-op. */
const inner = (state: FakeState, action: AppAction): FakeState =>
  action.type === "panel/rename" ? state : { ...state, value: state.value + 1 };

test.describe("isDirtyingAction", () => {
  test("leaves navigation and derived data clean", () => {
    expect(isDirtyingAction("panel/select")).toBe(false);
    expect(isDirtyingAction("editMode/toggle")).toBe(false);
    expect(isDirtyingAction("media/setContentHash")).toBe(false);
    expect(isDirtyingAction("project/meta")).toBe(false);
    expect(isDirtyingAction("project/saved")).toBe(false);
    expect(isDirtyingAction("state/import")).toBe(false);
    expect(isDirtyingAction("state/reset")).toBe(false);
  });

  test("marks layout edits dirty", () => {
    expect(isDirtyingAction("cell/assign")).toBe(true);
    expect(isDirtyingAction("cell/assignMany")).toBe(true);
    expect(isDirtyingAction("media/addMany")).toBe(true);
    expect(isDirtyingAction("media/deleteMany")).toBe(true);
    expect(isDirtyingAction("panel/gridSize")).toBe(true);
  });

  test("marks the settings that end up in the file dirty", () => {
    expect(isDirtyingAction("volume/master")).toBe(true);
    expect(isDirtyingAction("volume/muteToggle")).toBe(true);
    expect(isDirtyingAction("stopOthers/toggle")).toBe(true);
    expect(isDirtyingAction("mono/set")).toBe(true);
  });
});

test.describe("withDirtyTracking", () => {
  const tracked = withDirtyTracking(inner);

  test("marks the project dirty after a real edit", () => {
    const next = tracked(makeState(), { type: "cell/clear", panelId: "p", cellId: "c" });

    expect(next.projectSession.dirty).toBe(true);
    expect(next.value).toBe(1);
  });

  test("leaves the project clean for a non-dirtying action", () => {
    const next = tracked(makeState(), { type: "panel/select", panelId: "p" });

    expect(next.projectSession.dirty).toBe(false);
    expect(next.value).toBe(1);
  });

  test("does not dirty when the reducer returned the same state by identity", () => {
    const state = makeState();
    const next = tracked(state, { type: "panel/rename", panelId: "p", name: "x" });

    expect(next).toBe(state);
    expect(next.projectSession.dirty).toBe(false);
  });

  test("does not rebuild the session when it is already dirty", () => {
    const state = makeState(true);
    const next = tracked(state, { type: "cell/clear", panelId: "p", cellId: "c" });

    expect(next.projectSession).toBe(state.projectSession);
  });
});

test("a fresh session is unsaved and clean", () => {
  expect(makeUnsavedSession()).toEqual({
    projectId: null,
    name: "",
    description: "",
    fileName: null,
    saved: false,
    dirty: false
  });
});

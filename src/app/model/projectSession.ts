// Type-only on purpose: `appState.ts` imports react and idb-keyval, and this module must stay
// loadable from the unit tier, which runs in Node with no browser.
import type { AppAction } from "./appState";

/**
 * Who the current layout is, as a project: which library row it came from, what it is called, and
 * whether it has unsaved edits.
 *
 * Deliberately **not** part of `SerializableAppState`: keeping it out means the `.mumbox` payload
 * and `mumbox:state:v1` stay byte-identical for a project nobody touched. It persists in its own
 * localStorage key instead, so project identity survives a reload.
 */
export type ProjectSession = {
  /** The projects-list row this session came from, when it came from one. */
  projectId: string | null;
  name: string;
  description: string;
  fileName: string | null;
  /** False until the layout has been written to a file at least once. */
  saved: boolean;
  dirty: boolean;
};

export function makeUnsavedSession(): ProjectSession {
  return {
    projectId: null,
    name: "",
    description: "",
    fileName: null,
    saved: false,
    dirty: false
  };
}

/**
 * Actions that must not mark the project dirty.
 *
 * Volume, mute, stopOthers and mono are **not** here on purpose: they are serialized into the file,
 * so pretending they are incidental would lose the user's work silently.
 */
export const NON_DIRTYING_ACTIONS: ReadonlySet<AppAction["type"]> = new Set([
  "panel/select",
  "editMode/toggle",
  "media/setContentHash",
  "project/meta",
  "project/saved",
  "state/import",
  "state/reset"
]);

export function isDirtyingAction(type: AppAction["type"]) {
  return !NON_DIRTYING_ACTIONS.has(type);
}

/**
 * Wraps the reducer instead of editing every `case`. An action only dirties the project when the
 * inner reducer actually produced a new state — a no-op guard returning the same object identity
 * must not count.
 */
export function withDirtyTracking<TState extends { projectSession: ProjectSession }>(
  inner: (state: TState, action: AppAction) => TState
) {
  return (state: TState, action: AppAction): TState => {
    const next = inner(state, action);
    if (next === state || !isDirtyingAction(action.type) || next.projectSession.dirty) {
      return next;
    }

    return { ...next, projectSession: { ...next.projectSession, dirty: true } };
  };
}

import { makeUniqueName } from "../../../shared/lib/uniqueName";
import { Panel } from "./types";

/**
 * Resolves a panel name against the names already taken, appending `_2`, `_3` and so on. Used by
 * panel copy and by project merge, which appends incoming panels to an existing layout.
 */
export function makeUniquePanelName(panels: Panel[], requestedName: string) {
  return makeUniqueName(
    panels.map((panel) => panel.name),
    requestedName,
    "Panel_copy"
  );
}

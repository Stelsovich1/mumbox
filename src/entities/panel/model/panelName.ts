import { Panel } from "./types";

/**
 * Resolves a panel name against the names already taken, appending `_2`, `_3` and so on. Used by
 * panel copy and by project merge, which appends incoming panels to an existing layout.
 */
export function makeUniquePanelName(panels: Panel[], requestedName: string) {
  const trimmedName = requestedName.trim();
  const baseName = trimmedName || "Panel_copy";
  const existingNames = new Set(panels.map((panel) => panel.name));

  if (!existingNames.has(baseName)) {
    return baseName;
  }

  let copyIndex = 2;
  let nextName = `${baseName}_${String(copyIndex)}`;
  while (existingNames.has(nextName)) {
    copyIndex += 1;
    nextName = `${baseName}_${String(copyIndex)}`;
  }

  return nextName;
}

import { GridCell } from "../../cell/model/types";
import { Panel } from "./types";

export type PanelDeletionPlan = {
  panels: Panel[];
  cellsByPanel: Record<string, Record<string, GridCell>>;
  activePanelId: string;
  /** Ids the plan refused: the first panel, or the ones that would empty the project. */
  refusedPanelIds: string[];
};

/**
 * Plans the removal of one or more panels.
 *
 * Two rules carry this, and both are inherited from the single-panel path rather than invented
 * here: the FIRST panel is never deletable, and the project never ends up with none. A batch makes
 * the second rule reachable in a way a loop of single deletes never was — selecting every panel —
 * and a loop would also re-pick `activePanelId` on each step, so a mid-loop fallback could land on
 * a panel the next step deletes.
 *
 * Returns `null` when nothing would change, letting the reducer keep state identity.
 */
export function planPanelDeletion(options: {
  panels: readonly Panel[];
  cellsByPanel: Record<string, Record<string, GridCell>>;
  activePanelId: string;
  panelIds: readonly string[];
}): PanelDeletionPlan | null {
  const { panels, cellsByPanel, activePanelId } = options;
  const requested = new Set(options.panelIds);
  const firstPanel = panels[0];
  if (!firstPanel) {
    return null;
  }

  const refusedPanelIds: string[] = [];
  const doomed = new Set<string>();
  for (const panel of panels) {
    if (!requested.has(panel.id)) {
      continue;
    }
    if (panel.id === firstPanel.id) {
      refusedPanelIds.push(panel.id);
      continue;
    }
    doomed.add(panel.id);
  }
  // Ids naming no panel at all are silently ignored rather than refused: a selection can outlive
  // the panel it pointed at, and reporting a ghost as "refused" would show the user a number they
  // cannot explain.

  if (doomed.size === 0) {
    return null;
  }

  const firstDoomedIndex = panels.findIndex((panel) => doomed.has(panel.id));
  const remaining = panels.filter((panel) => !doomed.has(panel.id));
  const fallbackPanel = remaining[Math.max(0, firstDoomedIndex - 1)] ?? remaining[0];
  if (!fallbackPanel) {
    return null;
  }

  const nextCellsByPanel = Object.fromEntries(
    Object.entries(cellsByPanel).filter(([panelId]) => !doomed.has(panelId))
  );

  return {
    panels: remaining,
    cellsByPanel: nextCellsByPanel,
    activePanelId: doomed.has(activePanelId) ? fallbackPanel.id : activePanelId,
    refusedPanelIds
  };
}

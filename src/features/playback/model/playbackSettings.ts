import { AppSettings, resolvePcmBudget } from "../../../shared/lib/appSettings";
import { hasPartialQueryFlag, setPartialDecodeMode } from "../../../shared/lib/partialDecodePolicy";
import { applyBudgetSetting } from "./playbackBufferCache";

export type AppliedSettings = {
  /** False when a query flag on this load owns the value and the saved one stood down. */
  budgetApplied: boolean;
  partialApplied: boolean;
};

/**
 * Pushes the saved settings into the engine's module-level state.
 *
 * Called once from the boot gate and again whenever the settings dialog applies a change. The pair
 * of "applied" flags is what the dialog shows next to a control that a query flag has taken over,
 * so a user who loaded with `?partial=0` is told why the switch does nothing rather than being left
 * to conclude the setting is broken.
 *
 * Warm-up mode, its budget, the yield and the pool width are NOT here: they are read by the
 * warm-up run itself, which already receives the settings object through React and restarts on it.
 * The diagnostics overlay is not here either — `setAppSettings` mirrors it, so the flag cannot
 * drift from the value `App` renders from.
 */
export function applyPlaybackSettings(settings: AppSettings): AppliedSettings {
  const budgetApplied = applyBudgetSetting(resolvePcmBudget(settings));

  let partialApplied = false;
  if (!hasPartialQueryFlag()) {
    setPartialDecodeMode(settings.performance.partialDecode === "off" ? "off" : null);
    partialApplied = true;
  }

  return { budgetApplied, partialApplied };
}

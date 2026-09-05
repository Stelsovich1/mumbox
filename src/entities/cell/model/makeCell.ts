import { GridCell } from "./types";

/**
 * The single factory for a cell. Every reset path goes through it, and `ensurePanelCells` spreads
 * it *before* the stored cell, so a new `GridCell` field gets its default on both localStorage load
 * and project import without a migration.
 */
export function makeCell(id: string): GridCell {
  return {
    id,
    mediaId: null,
    aliasOverride: "",
    colorOverride: null,
    playbackMode: "once",
    volumeOffset: 0,
    hotkey: "",
    trimStartMs: null,
    trimEndMs: null,
    fadeInEnabled: false,
    fadeInMs: 0,
    fadeOutEnabled: false,
    fadeOutMs: 0
  };
}

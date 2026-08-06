export type PlaybackMode = "loop" | "once" | "gate";

export type GridCell = {
  id: string;
  mediaId: string | null;
  aliasOverride: string;
  colorOverride: string | null;
  playbackMode: PlaybackMode;
  volumeOffset: number;
  hotkey: string;
  trimStartMs: number | null;
  trimEndMs: number | null;
  fadeInEnabled: boolean;
  fadeInMs: number;
  fadeOutEnabled: boolean;
  fadeOutMs: number;
};

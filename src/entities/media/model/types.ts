export type MediaAsset = {
  id: string;
  fileName: string;
  alias: string;
  color: string;
  mimeType: string;
  size?: number;
  durationMs: number | null;
  createdAt: string;
  /**
   * SHA-256 of the file bytes, lowercase hex. Optional: assets imported before project merge
   * existed have none, and merge falls back to the filename+size rule for those.
   */
  contentHash?: string;
};

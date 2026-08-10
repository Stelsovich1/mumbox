export type MediaAsset = {
  id: string;
  fileName: string;
  alias: string;
  color: string;
  mimeType: string;
  size?: number;
  durationMs: number | null;
  createdAt: string;
};

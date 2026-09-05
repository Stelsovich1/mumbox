import { CONTENT_HASH_PATTERN } from "../../../shared/lib/contentHash";
import { MediaAsset } from "./types";

function asString(value: unknown, fallback: string) {
  return typeof value === "string" ? value : fallback;
}

/**
 * The normalizer `sanitizeImportedState` never had: state written by an older build, or a hand-edited
 * `.mumbox` manifest, reaches the reducer as `unknown` shaped data.
 *
 * Two rules are load-bearing:
 * - `createdAt` is **never invented**. `useAppStore` writes state back on every change, so a backfill
 *   would permanently stamp a false date onto every existing project.
 * - `contentHash` is kept only when it is a real 64-hex digest. A garbage hash that happened to
 *   collide would make project merge silently discard a distinct audio file.
 */
export function ensureMedia(value: unknown): MediaAsset[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: MediaAsset[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const candidate = entry as Partial<MediaAsset>;
    if (typeof candidate.id !== "string" || !candidate.id) {
      continue;
    }

    const media: MediaAsset = {
      id: candidate.id,
      fileName: asString(candidate.fileName, ""),
      alias: asString(candidate.alias, ""),
      color: asString(candidate.color, ""),
      mimeType: asString(candidate.mimeType, ""),
      durationMs: typeof candidate.durationMs === "number" ? candidate.durationMs : null,
      createdAt: asString(candidate.createdAt, "")
    };

    if (typeof candidate.size === "number" && Number.isFinite(candidate.size)) {
      media.size = candidate.size;
    }
    if (typeof candidate.contentHash === "string" && CONTENT_HASH_PATTERN.test(candidate.contentHash)) {
      media.contentHash = candidate.contentHash;
    }

    normalized.push(media);
  }

  return normalized;
}

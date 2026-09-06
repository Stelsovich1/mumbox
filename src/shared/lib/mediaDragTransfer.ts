/**
 * The wire contract for dragging media rows onto the grid.
 *
 * A custom MIME type rather than `text/plain`: the cell drop handler treats any `text/plain` as a
 * source cell id and moves cells with it, and the grid container bails out when it sees one.
 */

export const MEDIA_DRAG_MIME = "application/x-mumbox-media";

const PAYLOAD_VERSION = 1;

export function encodeMediaDragPayload(mediaIds: readonly string[]) {
  return JSON.stringify({ version: PAYLOAD_VERSION, mediaIds });
}

/**
 * Returns `null` for anything that is not a well-formed media drag — including an empty list, since
 * a drag carrying no media is not a drag.
 */
export function decodeMediaDragPayload(raw: string): string[] | null {
  if (!raw.trim()) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const candidate = parsed as { version?: unknown; mediaIds?: unknown };
  if (candidate.version !== PAYLOAD_VERSION || !Array.isArray(candidate.mediaIds)) {
    return null;
  }

  const mediaIds: string[] = [];
  for (const entry of candidate.mediaIds) {
    if (typeof entry !== "string" || !entry) {
      return null;
    }
    mediaIds.push(entry);
  }

  return mediaIds.length > 0 ? mediaIds : null;
}

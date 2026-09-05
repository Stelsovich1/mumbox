/**
 * A tiny registry so callers that delete media do not need to know which caches exist.
 *
 * `AppShell` deletes a media asset and says "these ids are gone"; the playback buffer cache and
 * the audio-editor waveform caches purge themselves. Without this, `AppShell` would need a
 * cross-feature import per cache, and adding a fifth cache would mean editing every delete site.
 */

export type MediaCacheSink = {
  name: string;
  /** Removes everything belonging to a media id; returns how many entries went. */
  deleteByMediaId: (mediaId: string) => number;
  clear: () => void;
  bytes?: () => number;
};

const sinks = new Map<string, MediaCacheSink>();
const purgeListeners = new Set<(mediaIds: readonly string[] | null) => void>();

export function registerMediaCache(sink: MediaCacheSink): () => void {
  sinks.set(sink.name, sink);
  return () => {
    sinks.delete(sink.name);
  };
}

/**
 * Notified on every purge. `null` means "everything was cleared". The audio engine listens so it
 * can drop the matching `warmedMedia` entries — a stale "ready" entry would otherwise suppress
 * the re-warm and the cell would never show its ready state again.
 */
export function onMediaCachePurge(
  listener: (mediaIds: readonly string[] | null) => void
): () => void {
  purgeListeners.add(listener);
  return () => {
    purgeListeners.delete(listener);
  };
}

export function purgeMediaCaches(mediaIds: readonly string[]): void {
  if (mediaIds.length === 0) {
    return;
  }
  for (const sink of sinks.values()) {
    for (const mediaId of mediaIds) {
      sink.deleteByMediaId(mediaId);
    }
  }
  for (const listener of purgeListeners) {
    listener(mediaIds);
  }
}

export function clearMediaCaches(): void {
  for (const sink of sinks.values()) {
    sink.clear();
  }
  for (const listener of purgeListeners) {
    listener(null);
  }
}

export function getMediaCacheBytes(): number {
  let total = 0;
  for (const sink of sinks.values()) {
    total += sink.bytes?.() ?? 0;
  }
  return total;
}

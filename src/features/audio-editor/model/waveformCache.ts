import { registerMediaCache } from "../../../shared/lib/mediaCacheRegistry";

export type WaveformPeaks = Float32Array;

export function createWaveformPeakCache(maxEntries: number) {
  const entries = new Map<string, WaveformPeaks>();
  const entryLimit = Math.max(1, Math.floor(maxEntries));

  return {
    get(mediaId: string) {
      const peaks = entries.get(mediaId);
      if (!peaks) {
        return null;
      }
      entries.delete(mediaId);
      entries.set(mediaId, peaks);
      return peaks;
    },
    set(mediaId: string, peaks: WaveformPeaks) {
      if (entries.has(mediaId)) {
        entries.delete(mediaId);
      }
      entries.set(mediaId, peaks);
      while (entries.size > entryLimit) {
        const oldestMediaId = entries.keys().next().value;
        if (typeof oldestMediaId !== "string") {
          return;
        }
        entries.delete(oldestMediaId);
      }
    },
    delete(mediaId: string) {
      return entries.delete(mediaId);
    },
    clear() {
      entries.clear();
    },
    size() {
      return entries.size;
    }
  };
}

export const waveformPeakCache = createWaveformPeakCache(64);

/**
 * Decoded durations live beside the peaks rather than inside them: the peak cache's entry type is
 * a bare Float32Array and its unit tests assert identity on it, so widening that type would be
 * pure churn. Bounded to the same 64 entries — it stores numbers, but an unbounded map in a
 * memory fix is still an unbounded map.
 */
export const decodedDurationCache = createDecodedDurationCache(64);

function createDecodedDurationCache(maxEntries: number) {
  const entries = new Map<string, number>();
  const entryLimit = Math.max(1, Math.floor(maxEntries));

  return {
    get(mediaId: string) {
      return entries.get(mediaId) ?? null;
    },
    set(mediaId: string, durationMs: number) {
      entries.delete(mediaId);
      entries.set(mediaId, durationMs);
      while (entries.size > entryLimit) {
        const oldest = entries.keys().next().value;
        if (typeof oldest !== "string") {
          return;
        }
        entries.delete(oldest);
      }
    },
    delete(mediaId: string) {
      return entries.delete(mediaId);
    },
    clear() {
      entries.clear();
    },
    size() {
      return entries.size;
    }
  };
}

// First production caller of the peak cache's delete/clear: until now nothing purged it, so a
// deleted media kept its peaks for the rest of the session.
registerMediaCache({
  name: "waveform-peaks",
  deleteByMediaId: (mediaId) => {
    const removed = waveformPeakCache.delete(mediaId) ? 1 : 0;
    decodedDurationCache.delete(mediaId);
    return removed;
  },
  clear: () => {
    waveformPeakCache.clear();
    decodedDurationCache.clear();
  }
});

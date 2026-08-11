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
      entries.delete(mediaId);
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

/**
 * Per-media facts a byte-range decode needs: the container format, the MP3 frame table or the WAV
 * header, the measured decoder offset, and whether this media has disqualified itself.
 *
 * Nothing here is persisted. Rebuilding a probe costs two small range reads (a few milliseconds),
 * whereas persisting it would mean a new field on `MediaAsset` — which `ensureMedia` drops unless
 * whitelisted, which the `.mumbox` manifest would then have to carry, and which would go stale the
 * moment media is replaced under it.
 *
 * Bounded by BYTES, not entry count. A 3-minute track at 128 kbps is 6 891 frames = 27.6 KB, but an
 * hour-long DJ set is 137 800 frames = 551 KB, so a 32-entry bound would be 17 MB rather than the
 * 1 MB it looks like.
 */
import { registerMediaCache } from "../../../shared/lib/mediaCacheRegistry";
import { PartialMediaFormat } from "./mediaFormat";
import { indexBytes, Mp3FrameIndex } from "./mp3FrameIndex";
import { WavStreamInfo } from "./wavPartial";

export type MediaProbe = {
  mediaId: string;
  format: PartialMediaFormat;
  mp3?: Mp3FrameIndex;
  wav?: WavStreamInfo;
  /**
   * Duration derived from the container. Kept beside the decoder-derived duration rather than
   * replacing it: a container duration shorter by even one frame would silently shorten every cell
   * whose trim end is "to the end", so the consumer takes the larger of the two.
   */
  containerDurationSeconds: number | null;
  /**
   * Measured samples between where a mid-file decode's audio really sits and where the frame table
   * says it should. Null until measured.
   *
   * Never a constant: measured at 2257 samples on a real 192 kbps LAME file, which is one preamble
   * frame (1152) plus LAME's encoder delay (1105) — and the delay term exists only because the full
   * decode sees the LAME header and a standalone mid-file slice does not. It is a property of the
   * file and the decoder together.
   */
  alignDeltaSamples: number | null;
  verified: "unknown" | "pass" | "fail";
  /** Set after a verification failure or repeated range failures; sends this media to full decode. */
  partialDisabled: boolean;
  failures: number;
};

export type MediaProbeCache = {
  get: (mediaId: string) => MediaProbe | null;
  set: (probe: MediaProbe) => void;
  delete: (mediaId: string) => boolean;
  clear: () => void;
  bytes: () => number;
  size: () => number;
};

/** Roughly 32 three-minute tracks' worth of frame tables, but bounded honestly. */
const DEFAULT_BUDGET_BYTES = 1024 * 1024;
/** Charged to every probe so a cache of tiny WAV headers still has a bound. */
const PROBE_OVERHEAD_BYTES = 256;

export function probeBytes(probe: MediaProbe): number {
  return PROBE_OVERHEAD_BYTES + (probe.mp3 ? indexBytes(probe.mp3) : 0);
}

export function createMediaProbeCache(budgetBytes: number = DEFAULT_BUDGET_BYTES): MediaProbeCache {
  const entries = new Map<string, MediaProbe>();
  let totalBytes = 0;

  const removeKey = (mediaId: string) => {
    const existing = entries.get(mediaId);
    if (!existing) {
      return false;
    }
    entries.delete(mediaId);
    totalBytes -= probeBytes(existing);
    return true;
  };

  const evict = (protectedKey: string) => {
    for (const key of [...entries.keys()]) {
      if (totalBytes <= budgetBytes) {
        return;
      }
      if (key !== protectedKey) {
        removeKey(key);
      }
    }
  };

  return {
    get(mediaId) {
      const probe = entries.get(mediaId);
      if (!probe) {
        return null;
      }
      // Reinsert to refresh recency.
      entries.delete(mediaId);
      entries.set(mediaId, probe);
      return probe;
    },
    set(probe) {
      removeKey(probe.mediaId);
      entries.set(probe.mediaId, probe);
      totalBytes += probeBytes(probe);
      evict(probe.mediaId);
    },
    delete: removeKey,
    clear() {
      entries.clear();
      totalBytes = 0;
    },
    bytes() {
      return totalBytes;
    },
    size() {
      return entries.size;
    }
  };
}

export const mediaProbeCache = createMediaProbeCache();

registerMediaCache({
  name: "media-probes",
  deleteByMediaId: (mediaId) => (mediaProbeCache.delete(mediaId) ? 1 : 0),
  clear: () => {
    mediaProbeCache.clear();
  },
  // Implemented, unlike the waveform sink's — without it `getMediaCacheBytes` would undercount
  // this cache the same way it already undercounts that one.
  bytes: () => mediaProbeCache.bytes()
});

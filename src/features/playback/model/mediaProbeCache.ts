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
   * Stream shape, hoisted out of the frame table on purpose.
   *
   * `planMediaSegments` used to read the rate and the channel count off the frame table. Once that
   * table became evictable those reads would silently fall back to the defaults and mis-gate
   * `shouldSegmentWindow`, so it reads these two fields instead — `probe.channels ?? 2` and
   * `probe.sampleRate ?? DECODE_SAMPLE_RATE`. Two numbers for a correctness guarantee.
   */
  sampleRate: number | null;
  channels: number | null;
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
  /** Attaches (or replaces) the evictable frame table for a media whose facts are already stored. */
  setIndex: (mediaId: string, index: Mp3FrameIndex) => void;
  delete: (mediaId: string) => boolean;
  clear: () => void;
  /** Bytes held by frame tables — the only part that is bounded. */
  bytes: () => number;
  size: () => number;
  /** How many frame tables are resident. Differs from `size` once one has been evicted. */
  indexCount: () => number;
};

/**
 * Budget for the frame tables alone.
 *
 * The number is arbitrary and says so; what matters is that only the REBUILDABLE half is bounded.
 * A 90-minute MPEG-1 track is 206 700 frames = 827 KB, so under the old shared 1 MiB budget two
 * long tracks could not coexist — and evicting a probe took `alignDeltaSamples` with it, forcing
 * `verifyMp3Alignment` (two 2 s decodes plus a cross-correlation) to run again on every panel
 * switch. Rebuilding a table costs range reads and no decode; re-measuring the offset costs both.
 */
const DEFAULT_BUDGET_BYTES = 4 * 1024 * 1024;
/**
 * Facts are kept for every media, unbounded, and that is affordable: tens of bytes each, so a
 * 500-media library is about 25 KB. Only the frame table is charged against the budget.
 *
 * An earlier draft exported a `probeBytes` that added a fixed per-probe overhead. Nothing ever
 * called it and `totalBytes` never included it, so it read as a bound that existed when it did
 * not. Removed rather than wired up: the facts really are meant to be unbounded.
 */

/**
 * Split by LIFETIME, not by size.
 *
 * The facts — format, measured decoder offset, verdict, container duration, stream shape — are a
 * few dozen bytes and are expensive to re-derive: `alignDeltaSamples` costs two decodes and a
 * cross-correlation. The frame table is hundreds of kilobytes and costs only range reads to
 * rebuild. Sharing one budget meant an eviction threw away the expensive half to reclaim the cheap
 * one, and did it on every panel switch once two long tracks were in play.
 *
 * The probe object handed out IS the facts record with the table attached by reference, so
 * `verifyMp3Alignment` mutating `probe.alignDeltaSamples` in place still writes where it must.
 */
export function createMediaProbeCache(budgetBytes: number = DEFAULT_BUDGET_BYTES): MediaProbeCache {
  const facts = new Map<string, MediaProbe>();
  const indexOrder = new Map<string, number>();
  let totalBytes = 0;
  let tick = 0;

  /**
   * What each resident table was CHARGED, refunded verbatim on detach.
   *
   * `indexBytes` reports the array's allocated capacity, and `pushOffset` doubles that capacity in
   * place while a cue plays: a table charged at 4 KiB and detached at 1 MiB drove `totalBytes`
   * negative, after which `evict` returned immediately on every call and the budget stopped
   * existing for the rest of the session.
   */
  const chargedBytes = new Map<string, number>();

  const detachIndex = (mediaId: string) => {
    const probe = facts.get(mediaId);
    if (!probe?.mp3) {
      return;
    }
    totalBytes -= chargedBytes.get(mediaId) ?? indexBytes(probe.mp3);
    chargedBytes.delete(mediaId);
    delete probe.mp3;
    indexOrder.delete(mediaId);
  };

  const removeKey = (mediaId: string) => {
    const existing = facts.get(mediaId);
    if (!existing) {
      return false;
    }
    detachIndex(mediaId);
    facts.delete(mediaId);
    return true;
  };

  const evict = (protectedKey: string) => {
    // Least recently touched table first; the facts it belonged to stay.
    const byAge = [...indexOrder.entries()].sort((first, second) => first[1] - second[1]);
    for (const [mediaId] of byAge) {
      if (totalBytes <= budgetBytes) {
        return;
      }
      if (mediaId !== protectedKey) {
        detachIndex(mediaId);
      }
    }
  };

  const attachIndex = (mediaId: string, index: Mp3FrameIndex) => {
    const probe = facts.get(mediaId);
    if (!probe) {
      return;
    }
    detachIndex(mediaId);
    probe.mp3 = index;
    const charge = indexBytes(index);
    chargedBytes.set(mediaId, charge);
    totalBytes += charge;
    tick += 1;
    indexOrder.set(mediaId, tick);
    evict(mediaId);
  };

  return {
    get(mediaId) {
      const probe = facts.get(mediaId);
      if (!probe) {
        return null;
      }
      if (probe.mp3) {
        tick += 1;
        indexOrder.set(mediaId, tick);
      }
      return probe;
    },
    set(probe) {
      removeKey(probe.mediaId);
      const index = probe.mp3;
      // IDENTITY, not a copy, and the whole feature depends on it. `verifyMp3Alignment` records
      // its result by mutating the probe it was handed, and `getMediaProbe` hands back the object
      // it passed to `set`. Storing a copy meant a measured `alignDeltaSamples` was written to an
      // object the cache did not hold: the next read saw `null`, the media took a full decode, and
      // the two-decode measurement ran again on every warm-up, forever. `partialDisabled` was lost
      // the same way, so a media that failed verification was retried instead of being latched off.
      //
      // The table is detached first so `attachIndex` charges its bytes exactly once.
      delete probe.mp3;
      facts.set(probe.mediaId, probe);
      if (index) {
        attachIndex(probe.mediaId, index);
      }
    },
    setIndex: attachIndex,
    delete: removeKey,
    clear() {
      facts.clear();
      indexOrder.clear();
      chargedBytes.clear();
      totalBytes = 0;
    },
    bytes() {
      return totalBytes;
    },
    size() {
      return facts.size;
    },
    indexCount() {
      return indexOrder.size;
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { GridCell } from "../../../entities/cell/model/types";
import { MediaAsset } from "../../../entities/media/model/types";
import { getMediaBlob } from "../../../app/model/appState";
import {
  markEnd,
  markStart,
  recordDecode,
  recordPanelSwitchEngine,
  recordPartialServed,
  recordSegment,
  recordTimeToFirstSound,
  recordWarmup,
  setMonoState
} from "../../../shared/lib/diagnostics";
import { onMediaCachePurge } from "../../../shared/lib/mediaCacheRegistry";
import {
  estimatePcmBytes,
  getAudioBufferBytes,
  getMediaIdFromKey,
  makePlaybackBufferKey
} from "./audioBufferCache";
import type { PlaybackBufferEntry } from "./audioBufferCache";
import {
  DECODE_SAMPLE_RATE,
  decodeAudioBlob,
  shouldSliceBuffer,
  sliceToAudioBuffer
} from "./decodeAudio";
import {
  planSegments,
  resolveLateSegment,
  shouldReadRange,
  shouldSegmentWindow
} from "./partialPlan";
import { decodeMediaRange, ensureMp3Alignment, planMediaSegments } from "./partialSource";
import { playbackBufferCache, setActivePanelKeys } from "./playbackBufferCache";
import {
  getEnvelopeValue,
  getTrimEndSeconds,
  getTrimStartSeconds,
  scheduleEnvelope
} from "./audioEnvelope";

type PlayingCell = {
  cellKey: string;
  mediaId: string;
  progress: number;
};

export type WarmState = "warming" | "ready";

/**
 * One `AudioBufferSourceNode` and the source-time window it is responsible for.
 *
 * A classic route holds exactly one segment, which is why this refactor changes no behaviour: the
 * single-segment path still schedules `start(0, offset, duration)` and still ends the cue from its
 * own `onended`. Several segments only become possible once a route streams a long window.
 */
type RouteSegment = {
  source: AudioBufferSourceNode;
  /** Source-time window this segment covers. */
  startSeconds: number;
  endSeconds: number;
  /** Absolute context time this segment was scheduled to begin at. */
  atContextTime: number;
  /**
   * Only the last segment ends the cue or restarts a loop. Explicit rather than inferred: with
   * several segments, an `onended` from the head means "the next segment's turn", and code that
   * treated any `onended` as "cue finished" would restart a loop at the seam — audible as a short
   * fragment repeating forever.
   */
  isLast: boolean;
  /**
   * Absolute context time a `stop` is already scheduled for, or null when none is.
   *
   * Measured, not assumed: a later `stop` EXTENDS an earlier one rather than being ignored
   * (`stop(0.3)` then `stop(0.6)` plays to 0.6). So a teardown that blindly called
   * `stop(now + RELEASE)` on a segment already stopping at its handoff would push it past that
   * handoff and overlap the next segment — the same signal twice for a few milliseconds.
   */
  stopAtContextTime: number | null;
};

type AudioRoute = {
  mode: "buffer" | "media";
  context: AudioContext;
  envelopeGain: GainNode;
  volumeGain: GainNode;
  lastVolume: number;
  /** Empty for the media-element route; length 1 on a classic buffer route. */
  segments: RouteSegment[];
  audio?: HTMLAudioElement;
  url?: string;
  startedAtContextTime: number;
  offsetSeconds: number;
  endSeconds: number;
  bufferDurationSeconds: number;
  envelopeSignature: string;
  cacheKey: string;
};

type WarmupTarget = {
  cellId: string;
  mediaId: string;
  cacheKey: string;
  cell: GridCell;
};

const RELEASE_SECONDS = 0.018;
/**
 * How far ahead of `currentTime` a streamed route's first source is scheduled.
 *
 * One render quantum. Measured: a requested time in the future is honoured to the sample, while
 * `start(0)` gives the app no way to learn which frame it landed on — and the handoff time for
 * every later segment is derived from that number, so a guess there is a skipped fragment, audible
 * as a click at every seam. The lead guarantees the requested moment is still in the future even if
 * the main thread was busy when it was scheduled.
 *
 * Only streamed routes pay it. A single-segment route keeps `start(0)` and its 0.5 ms baseline;
 * 2.9 ms on a three-minute backing track is inaudible and sits far under the 20 ms warm ceiling.
 */
const SCHEDULE_LEAD_SECONDS = 128 / 44_100;
/**
 * How long before a segment's handoff its decode is started.
 *
 * Long enough that a slow read cannot miss the boundary, short enough that resident PCM stays
 * bounded: with the ladder's 16 s ceiling this keeps a playing cue at roughly head plus two
 * segments, about 11 MiB, instead of the whole track.
 */
const SEGMENT_PREFETCH_SECONDS = 6;
/** Polling step while waiting for a segment's prefetch window to open. */
const SEGMENT_WAIT_STEP_MS = 120;
const PROGRESS_EPSILON = 0.001;
/**
 * How often a progress change may reach React.
 *
 * The rAF loop keeps running at frame rate — it also syncs volume and restarts media-element
 * loops, and neither may be throttled — but pushing progress into state every frame re-rendered
 * the whole shell 60 times a second: `PROGRESS_EPSILON` only suppresses the push for cues longer
 * than about 17 s, and a soundboard is mostly short ones. A busy main thread is felt as trigger
 * latency on the NEXT tap, so the progress marker settles for 20 Hz. A change in WHICH cells are
 * playing still pushes immediately — that one is a direct response to a press.
 */
const PROGRESS_PUSH_INTERVAL_MS = 50;
/**
 * How long a panel has to stay on screen before its warm-up starts.
 *
 * Short enough to be invisible when a panel is chosen deliberately, long enough that flicking
 * through panels decodes only the one the user stops on. Since a panel switch now drops the
 * previous panel's PCM, an undebounced warm-up would decode a whole panel per switch and throw it
 * away on the next one — more transient memory than the accumulation it replaces.
 */
const WARMUP_DEBOUNCE_MS = 150;
/**
 * Concurrency multiplies the transient memory of in-flight decodes, and that transient is exactly
 * what gets a tab killed on a phone: three simultaneous decodes of 15 MB tracks is two thirds of a
 * gigabyte in flight. So phones get two, and desktops leave cores for the main thread and the
 * audio thread rather than saturating.
 */
function getWarmupConcurrency() {
  if (typeof window === "undefined") {
    return 1;
  }
  const cores = navigator.hardwareConcurrency || 2;
  const coarsePointer = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  return coarsePointer ? Math.min(2, cores) : Math.min(4, Math.max(2, cores - 2));
}

function isMediaId(value: string | null): value is string {
  return Boolean(value);
}

function getCellKey(panelId: string, cellId: string) {
  return `${panelId}:${cellId}`;
}

/**
 * What a cached entry will actually cost once trimming is applied. Estimating the full media
 * would make the warm-up skip cues that comfortably fit.
 */
function getTrimmedDurationMs(cell: GridCell, durationMs: number | null) {
  if (durationMs === null) {
    return null;
  }
  const startMs = Math.min(durationMs, Math.max(0, cell.trimStartMs ?? 0));
  const endMs = Math.min(durationMs, Math.max(startMs, cell.trimEndMs ?? durationMs));
  return endMs - startMs;
}

/**
 * Whether a cell is likely to avoid a full decode — either by reading only its window, or by
 * streaming that window in segments.
 *
 * Both gates, because they answer different questions and each misses the other's case. A 5-second
 * window out of a 180-second file is worth a range read but far too small to stream; a whole
 * untrimmed 3-minute track has nothing to skip but must be streamed. Testing only one of them would
 * leave the dominant shape of a real project on the full-decode path.
 *
 * Judged from the duration and the trim alone, so it can be answered synchronously — which is what
 * lets the warm-up decide whether to stage a shared full decode BEFORE any probe has run. The
 * container is only known after a probe, so this is a hint: a cell that passes here can still fall
 * back, and the only cost of that is one unshared decode.
 *
 * Stereo is assumed, the same assumption `estimatePcmBytes` makes and for the same reason — the
 * channel count is unknown before decoding. The ratio term is channel-independent anyway.
 */
function isPartialPathLikely(cell: GridCell, durationMs: number | null): boolean {
  const sourceSeconds = (durationMs ?? 0) / 1000;
  if (sourceSeconds <= 0) {
    return false;
  }
  const { startSeconds, endSeconds } = getClampedPlaybackRange(cell, sourceSeconds);
  const windowSeconds = endSeconds - startSeconds;
  if (windowSeconds <= 0) {
    return false;
  }
  return (
    shouldReadRange({
      sourceSeconds,
      windowSeconds,
      sampleRate: DECODE_SAMPLE_RATE,
      channels: 2
    }) ||
    shouldSegmentWindow({ windowSeconds, sampleRate: DECODE_SAMPLE_RATE, channels: 2 })
  );
}

/**
 * Only these fields change the scheduled envelope. Rescheduling on every `cells` identity change
 * rebuilt a curve for every live route on an unrelated alias keystroke.
 */
function getEnvelopeSignature(cell: GridCell) {
  return [
    cell.trimStartMs,
    cell.trimEndMs,
    cell.fadeInEnabled,
    cell.fadeInMs,
    cell.fadeOutEnabled,
    cell.fadeOutMs
  ].join("|");
}

function getEffectiveVolume(masterVolume: number, cellVolumeOffset: number) {
  const normalizedMaster = masterVolume / 100;
  const offsetMultiplier = 1 + cellVolumeOffset / 100;
  return Math.min(4, Math.max(0, normalizedMaster * offsetMultiplier));
}

function getHtmlAudioVolume(volume: number) {
  return Math.min(1, Math.max(0, volume));
}

function getAudioContextState(context: AudioContext) {
  return context.state as AudioContextState | "interrupted";
}

function arePlayingCellsEqual(previous: PlayingCell[], next: PlayingCell[]) {
  if (previous.length !== next.length) {
    return false;
  }

  return previous.every((cell, index) => {
    const nextCell = next[index];
    return (
      cell.cellKey === nextCell?.cellKey &&
      cell.mediaId === nextCell.mediaId &&
      Math.abs(cell.progress - nextCell.progress) < PROGRESS_EPSILON
    );
  });
}

function setRouteVolume(route: AudioRoute, volume: number) {
  if (Math.abs(route.lastVolume - volume) < 0.001) {
    return;
  }
  route.volumeGain.gain.setValueAtTime(volume, route.context.currentTime);
  route.lastVolume = volume;
}

function getClampedPlaybackRange(cell: GridCell, durationSeconds: number) {
  const startSeconds = Math.min(durationSeconds, Math.max(0, getTrimStartSeconds(cell)));
  const endSeconds = Math.min(
    durationSeconds,
    Math.max(startSeconds, getTrimEndSeconds(cell, durationSeconds))
  );

  return { startSeconds, endSeconds };
}

function stopRoute(route: AudioRoute) {
  const now = route.context.currentTime;
  route.envelopeGain.gain.cancelScheduledValues(now);
  route.envelopeGain.gain.setValueAtTime(route.envelopeGain.gain.value, now);
  if (typeof route.envelopeGain.gain.linearRampToValueAtTime === "function") {
    route.envelopeGain.gain.linearRampToValueAtTime(0, now + RELEASE_SECONDS);
  } else {
    route.envelopeGain.gain.setValueAtTime(0, now);
  }

  for (const segment of route.segments) {
    // Never later than a stop this segment already has: a later `stop` extends an earlier one, so
    // pushing a segment past its handoff would overlap it with the next one.
    const stopAt =
      segment.stopAtContextTime === null
        ? now + RELEASE_SECONDS
        : Math.min(segment.stopAtContextTime, now + RELEASE_SECONDS);
    try {
      segment.source.stop(stopAt);
      segment.stopAtContextTime = stopAt;
    } catch {
      // The source may already be stopped by the browser.
    }
  }

  if (route.audio) {
    route.audio.pause();
  }

  window.setTimeout(() => {
    for (const segment of route.segments) {
      segment.source.disconnect();
    }
    route.envelopeGain.disconnect();
    route.volumeGain.disconnect();
    if (route.mode === "media") {
      void route.context.close();
    }
    if (route.url) {
      URL.revokeObjectURL(route.url);
    }
  }, RELEASE_SECONDS * 1000 + 8);
}

export function useAudioEngine(
  panelId: string,
  media: MediaAsset[],
  cells: GridCell[],
  masterVolume: number,
  masterMuted: boolean,
  stopOthers: boolean,
  monoPlayback = false
) {
  const contextRef = useRef<AudioContext | null>(null);
  // In-flight decodes are tracked apart from the resolved cache so two concurrent requests share
  // one decode, and — unlike caching the promise itself — a failed decode leaves nothing behind
  // and can be retried after the user re-imports.
  const inflightRef = useRef(new Map<string, Promise<PlaybackBufferEntry | null>>());
  const routeByCellRef = useRef(new Map<string, AudioRoute>());
  const playTokenByCellRef = useRef(new Map<string, number>());
  const cellsRef = useRef(cells);
  const panelIdRef = useRef(panelId);
  const masterVolumeRef = useRef(masterVolume);
  const masterMutedRef = useRef(masterMuted);
  const warmupRunRef = useRef(0);
  const mediaRef = useRef(media);
  const monoRef = useRef(monoPlayback);
  /**
   * Cache keys the panel on screen needs. Read by decodes that land late: a warm-up run that was
   * superseded must not put another panel's PCM back into a cache the panel switch just emptied,
   * but the very same keys may belong to the panel the user has already switched back to.
   */
  const activeKeysRef = useRef(new Set<string>());
  /**
   * Serializes warm-up runs. Two pools in flight at once double the number of simultaneous
   * decodes, and simultaneous decodes are what multiply the transient allocation that gets a tab
   * killed on iOS — precisely the situation a burst of panel switches creates.
   */
  const warmupChainRef = useRef<Promise<void>>(Promise.resolve());
  /**
   * Full decodes shared between cells that trim the SAME media differently.
   *
   * Reference counted, not time based. The previous single slot with a three-second timer was a
   * guess at how long a sibling might still need the buffer; counting how many targets are
   * actually waiting for it answers that exactly, releases the buffer the moment the last one is
   * served, and does not fall over when several decodes run at once. Only media with more than one
   * waiting target is staged at all — for a single target there is nothing to share and no reason
   * to hold a full-length buffer.
   */
  const stagingRef = useRef(
    new Map<string, { promise: Promise<AudioBuffer | null>; pending: number }>()
  );
  /**
   * Bumped on every cache purge. A decode that was already in flight when the media was deleted
   * would otherwise resolve afterwards and put the PCM straight back into the cache.
   */
  const purgeGenerationRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const lastProgressPushRef = useRef(0);
  const playingCellsRef = useRef<PlayingCell[]>([]);
  const [playingCells, setPlayingCells] = useState<PlayingCell[]>([]);
  /**
   * Keyed by cache key, not by media id. Two cells on one media with different trims are two
   * cache entries, and one of them can be skipped by the budget while the other is ready — a
   * media-keyed map would light up both cells and promise an instant start the engine cannot
   * deliver.
   */
  const [warmedKeys, setWarmedKeys] = useState<Record<string, WarmState>>({});

  useEffect(() => {
    cellsRef.current = cells;
    mediaRef.current = media;
  }, [cells, media]);

  useEffect(() => {
    monoRef.current = monoPlayback;
    setMonoState(monoPlayback);
  }, [monoPlayback]);

  useEffect(() => {
    panelIdRef.current = panelId;
    masterVolumeRef.current = masterVolume;
    masterMutedRef.current = masterMuted;
  }, [masterMuted, masterVolume, panelId]);

  const getContext = useCallback(() => {
    const current = contextRef.current;
    if (current && current.state !== "closed") {
      return current;
    }
    const context = new AudioContext();
    contextRef.current = context;
    return context;
  }, []);

  const resumeContext = useCallback(async (context: AudioContext) => {
    const state = getAudioContextState(context);
    if (state === "running" || state === "closed") {
      return context;
    }

    try {
      await context.resume();
    } catch {
      // iOS may reject resume while the page is backgrounded; the next user tap retries.
    }

    return context;
  }, []);

  const bumpCellToken = useCallback((cellKey: string) => {
    const nextToken = (playTokenByCellRef.current.get(cellKey) ?? 0) + 1;
    playTokenByCellRef.current.set(cellKey, nextToken);
    return nextToken;
  }, []);

  const syncPlayingCells = useCallback((next: PlayingCell[]) => {
    if (arePlayingCellsEqual(playingCellsRef.current, next)) {
      return;
    }

    playingCellsRef.current = next;
    setPlayingCells(next);
  }, []);

  const clearActiveRoutes = useCallback(() => {
    routeByCellRef.current.forEach((route, cellKey) => {
      bumpCellToken(cellKey);
      stopRoute(route);
    });
    routeByCellRef.current.clear();
    syncPlayingCells([]);
  }, [bumpCellToken, syncPlayingCells]);

  const getPlayableContext = useCallback(async () => {
    let context = await resumeContext(getContext());
    if (getAudioContextState(context) === "running") {
      return context;
    }

    clearActiveRoutes();
    try {
      await context.close();
    } catch {
      // The context may already be unusable after an iOS audio interruption.
    }
    if (contextRef.current === context) {
      contextRef.current = null;
    }

    context = await resumeContext(getContext());
    return context;
  }, [clearActiveRoutes, getContext, resumeContext]);

  const decodeFullBuffer = useCallback(async (mediaId: string) => {
    const readStartedAt = performance.now();
    const blob = await getMediaBlob(mediaId);
    if (!blob) {
      return null;
    }
    // The IndexedDB read and the decode are timed apart: on iOS the read often dominates.
    const readMs = performance.now() - readStartedAt;
    const decodeStartedAt = performance.now();
    const buffer = await decodeAudioBlob(blob);
    recordDecode(mediaId, readMs, performance.now() - decodeStartedAt, getAudioBufferBytes(buffer));
    return buffer;
  }, []);

  const getFullBuffer = useCallback(
    (mediaId: string) => {
      const staged = stagingRef.current.get(mediaId);
      if (staged) {
        return staged.promise;
      }
      return decodeFullBuffer(mediaId).catch(() => null);
    },
    [decodeFullBuffer]
  );

  /**
   * Decodes just the cell's window straight out of the file, or declines.
   *
   * Declining is the normal outcome for most cells and costs nothing: a short cue, an untrimmed
   * one, or a container without a partial path all fall through to the full decode. The gate is on
   * SAVING, not on window length — a 5-second window out of a 180-second file is the single most
   * profitable case there is, and a length gate would have excluded it.
   */
  const tryDecodeRange = useCallback(
    async (cell: GridCell, mediaId: string, mono: boolean): Promise<PlaybackBufferEntry | null> => {
      const asset = mediaRef.current.find((candidate) => candidate.id === mediaId);
      if (!isPartialPathLikely(cell, asset?.durationMs ?? null)) {
        return null;
      }
      const sourceSeconds = (asset?.durationMs ?? 0) / 1000;
      const { startSeconds, endSeconds } = getClampedPlaybackRange(cell, sourceSeconds);

      try {
        // A window large enough to stream becomes a HEAD plus a plan; the rest arrives while the
        // head plays. The head is what gets cached, so a warm cell still starts instantly.
        //
        // Loops are excluded from streaming in this version, deliberately. A looping cue is by
        // definition one the user hears over and over, so decoding it once in full is the right
        // price rather than a loss — and it sidesteps re-streaming the whole track on every
        // iteration. A loop still benefits from a plain range read of its window.
        const plan =
          cell.playbackMode === "loop"
            ? null
            : await planMediaSegments({ mediaId, startSeconds, endSeconds });
        const head = plan?.segments[0];
        if (plan && head) {
          const result = await decodeMediaRange({
            mediaId,
            startSeconds: head.startSeconds,
            // The margin is real audio past the nominal boundary, so the outgoing segment always
            // has samples to play right up to the handoff.
            endSeconds: head.bufferEndSeconds,
            mono
          });
          if (result) {
            recordPartialServed("streamed");
            return {
              ...result.entry,
              // The larger of the container's and the decoder's idea of the duration. A container
              // duration shorter by one frame would silently shorten every cell whose trim end is
              // "to the end", because the editor measured that against the decoder's.
              sourceDurationSeconds: Math.max(
                result.entry.sourceDurationSeconds,
                plan.sourceDurationSeconds
              ),
              partial: {
                mediaId,
                headEndSeconds: head.endSeconds,
                windowEndSeconds: endSeconds,
                mono
              }
            };
          }
        }

        // Falling back to a plain range read only when it actually pays. Without this check a
        // window that was merely large enough to stream — but had nothing to skip — would be range
        // read in full: correct audio, no saving, and the gate bypassed.
        if (
          !shouldReadRange({
            sourceSeconds,
            windowSeconds: endSeconds - startSeconds,
            sampleRate: DECODE_SAMPLE_RATE,
            channels: 2
          })
        ) {
          recordPartialServed("declined");
          return null;
        }
        const result = await decodeMediaRange({ mediaId, startSeconds, endSeconds, mono });
        recordPartialServed(result ? "range" : "declined");
        return result?.entry ?? null;
      } catch {
        // Never fail a cue from here; the full decode below is the fallback.
        recordPartialServed("declined");
        return null;
      }
    },
    []
  );

  const loadPlaybackEntry = useCallback(
    async (cell: GridCell, mediaId: string, cacheKey: string): Promise<PlaybackBufferEntry | null> => {
      const cached = playbackBufferCache.get(cacheKey);
      if (cached) {
        return cached;
      }

      const inflight = inflightRef.current.get(cacheKey);
      if (inflight) {
        return inflight;
      }

      const mono = monoRef.current;
      const purgeGeneration = purgeGenerationRef.current;
      const promise = (async () => {
        // Byte-range path first, and inside a `try` that swallows everything: the partial path must
        // never be able to fail a cue, only to decline it. Any decline — an unsupported container,
        // a mid-file MP3 window with no measured offset, a blocked browser, a throw from the
        // decoder — falls through to the full decode below, which is unchanged.
        const rangeEntry = await tryDecodeRange(cell, mediaId, mono);
        if (rangeEntry) {
          if (purgeGenerationRef.current === purgeGeneration) {
            playbackBufferCache.set(cacheKey, rangeEntry);
          }
          return rangeEntry;
        }

        const full = await getFullBuffer(mediaId);
        if (!full) {
          return null;
        }

        const { startSeconds, endSeconds } = getClampedPlaybackRange(cell, full.duration);
        const wantsTrim = shouldSliceBuffer(full, { startSeconds, endSeconds, mono });
        const wantsMono = mono && full.numberOfChannels > 1;

        let buffer: AudioBuffer = full;
        let sliceStartSeconds = 0;
        if (wantsTrim || wantsMono) {
          buffer = sliceToAudioBuffer(full, {
            startSeconds: wantsTrim ? startSeconds : 0,
            endSeconds: wantsTrim ? endSeconds : full.duration,
            mono
          });
          sliceStartSeconds = wantsTrim ? startSeconds : 0;
        }

        const entry: PlaybackBufferEntry = {
          buffer,
          bytes: getAudioBufferBytes(buffer),
          sliceStartSeconds,
          // Trim clamping is always measured against the ORIGINAL media, never the slice.
          sourceDurationSeconds: full.duration
        };
        // A purge landed while this decode was in flight, so the media may be gone and the panel
        // may already have been evicted. The caller still gets the buffer it asked for; it simply
        // does not go back into the cache.
        if (purgeGenerationRef.current === purgeGeneration) {
          playbackBufferCache.set(cacheKey, entry);
        }
        return entry;
      })()
        .catch(() => null)
        .finally(() => {
          inflightRef.current.delete(cacheKey);
        });

      inflightRef.current.set(cacheKey, promise);
      return promise;
    },
    [getFullBuffer, tryDecodeRange]
  );

  const getCacheKey = useCallback(
    (cell: GridCell, mediaId: string) =>
      makePlaybackBufferKey({
        mediaId,
        trimStartMs: cell.trimStartMs,
        trimEndMs: cell.trimEndMs,
        mono: monoRef.current
      }),
    []
  );

  const dropWarmedKeys = useCallback((keys: readonly string[]) => {
    const dropped = new Set(keys);
    setWarmedKeys((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([key]) => !dropped.has(key))
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, []);

  const isCacheKeyInUse = useCallback(
    (cacheKey: string) =>
      Array.from(routeByCellRef.current.values()).some((route) => route.cacheKey === cacheKey),
    []
  );

  const warmMedia = useCallback(
    async (target: WarmupTarget, runId: number) => {
      const { mediaId, cacheKey } = target;
      setWarmedKeys((current) =>
        current[cacheKey] ? current : { ...current, [cacheKey]: "warming" }
      );
      const entry = await loadPlaybackEntry(target.cell, mediaId, cacheKey);
      // A decode started before a panel switch resolves after it, and `decodeAudioData` cannot be
      // cancelled — so the buffer lands in a cache the switch has already emptied. It is kept only
      // when the panel now on screen still wants that key (a switch back to where we came from) or
      // a live route is using it; otherwise the one-panel bound would be broken by whatever
      // happened to be in flight.
      if (
        warmupRunRef.current !== runId &&
        !activeKeysRef.current.has(cacheKey) &&
        !isCacheKeyInUse(cacheKey)
      ) {
        playbackBufferCache.delete(cacheKey);
        dropWarmedKeys([cacheKey]);
        return;
      }
      setWarmedKeys((current) => {
        if (!(cacheKey in current)) {
          return current;
        }
        if (!entry) {
          return Object.fromEntries(Object.entries(current).filter(([key]) => key !== cacheKey));
        }
        return current[cacheKey] === "ready" ? current : { ...current, [cacheKey]: "ready" };
      });
    },
    [dropWarmedKeys, isCacheKeyInUse, loadPlaybackEntry]
  );

  const stopCellKey = useCallback(
    (cellKey: string) => {
      bumpCellToken(cellKey);
      const route = routeByCellRef.current.get(cellKey);
      if (route) {
        stopRoute(route);
        routeByCellRef.current.delete(cellKey);
      }
      syncPlayingCells(playingCellsRef.current.filter((cell) => cell.cellKey !== cellKey));
    },
    [bumpCellToken, syncPlayingCells]
  );

  const stopCell = useCallback(
    (cellId: string) => {
      stopCellKey(getCellKey(panelId, cellId));
    },
    [panelId, stopCellKey]
  );

  const stopAll = useCallback(() => {
    Array.from(routeByCellRef.current.keys()).forEach((cellKey) => {
      stopCellKey(cellKey);
    });
  }, [stopCellKey]);

  const isCellPlaying = useCallback(
    (cellId: string) => routeByCellRef.current.has(getCellKey(panelId, cellId)),
    [panelId]
  );

  const startProgressLoop = useCallback(() => {
    if (frameRef.current !== null) {
      return;
    }

    const tick = () => {
      frameRef.current = null;
      const current = playingCellsRef.current;
      if (current.length === 0 && routeByCellRef.current.size === 0) {
        return;
      }

      const endedCellKeys: string[] = [];
      const nextPlayingCells = current.flatMap((cell) => {
        const route = routeByCellRef.current.get(cell.cellKey);
        if (!route) {
          return [];
        }
        const gridCell = cellsRef.current.find(
          (candidate) => getCellKey(panelIdRef.current, candidate.id) === cell.cellKey
        );
        if (!gridCell) {
          return [cell];
        }

        const currentSeconds =
          route.mode === "media" && route.audio
            ? route.audio.currentTime
            : route.offsetSeconds + (route.context.currentTime - route.startedAtContextTime);
        const baseVolume = masterMutedRef.current
          ? 0
          : getEffectiveVolume(masterVolumeRef.current, gridCell.volumeOffset);
        setRouteVolume(route, baseVolume);

        if (route.mode === "media" && route.audio && currentSeconds >= route.endSeconds) {
          if (gridCell.playbackMode === "loop") {
            route.audio.currentTime = getTrimStartSeconds(gridCell);
            scheduleEnvelope(route.envelopeGain, gridCell, route.audio.currentTime, route.endSeconds);
          } else {
            endedCellKeys.push(cell.cellKey);
            return [];
          }
        }

        if (route.mode === "media" && route.audio) {
          route.audio.volume = getHtmlAudioVolume(
            baseVolume * getEnvelopeValue(gridCell, currentSeconds, route.endSeconds)
          );
        }

        // Watchdog for a streamed route whose chain died without reaching its last segment. End of
        // cue is normally detected from a segment's `onended`, so a route with no segment still to
        // come would otherwise stay `data-playing="true"` forever and keep this loop re-arming at
        // 60 Hz for the rest of the session. A one-segment route can never hit this: its only
        // segment is last by construction.
        if (
          route.mode === "buffer" &&
          currentSeconds > route.endSeconds + RELEASE_SECONDS &&
          !route.segments.some((segment) => segment.isLast)
        ) {
          // Counted, because a cue ending HERE rather than from its last segment is a symptom, not
          // a feature: the audible result is the same, so without a counter a broken `isLast` would
          // be silently covered up by its own safety net.
          recordSegment("watchdog");
          endedCellKeys.push(cell.cellKey);
          return [];
        }

        const range = Math.max(0.1, route.endSeconds - route.offsetSeconds);
        return [
          {
            ...cell,
            progress: Math.min(1, Math.max(0, (currentSeconds - route.offsetSeconds) / range))
          }
        ];
      });

      const previous = playingCellsRef.current;
      const membershipChanged =
        previous.length !== nextPlayingCells.length ||
        nextPlayingCells.some((cell, index) => previous[index]?.cellKey !== cell.cellKey);
      const now = performance.now();
      if (membershipChanged || now - lastProgressPushRef.current >= PROGRESS_PUSH_INTERVAL_MS) {
        lastProgressPushRef.current = now;
        // A skipped push leaves a stale `progress` in the ref, which costs nothing: the next tick
        // maps over the ref for identity only and recomputes progress from the route either way.
        syncPlayingCells(nextPlayingCells);
      }
      endedCellKeys.forEach((cellKey) => {
        stopCellKey(cellKey);
      });

      if (routeByCellRef.current.size > 0 || playingCellsRef.current.length > 0) {
        frameRef.current = requestAnimationFrame(tick);
      }
    };

    frameRef.current = requestAnimationFrame(tick);
  }, [stopCellKey, syncPlayingCells]);

  /**
   * Pinning has to track the routes themselves, not just panel switches. A buffer becomes "in
   * use" the moment a route starts, and any eviction in between — a budget change, or another
   * panel filling the cache — would otherwise drop a buffer that is still playing and force a
   * re-decode on the next trigger.
   */
  // Keyed on which cells play, not on `playingCells` itself: that array is rebuilt on every
  // progress push, and pinning the same keys again 20 times a second is pure waste.
  const playingCellKeySignature = playingCells.map((cell) => cell.cellKey).join("|");
  useEffect(() => {
    playbackBufferCache.setPinned(
      Array.from(routeByCellRef.current.values()).map((route) => route.cacheKey)
    );
  }, [playingCellKeySignature]);

  const addPlayingCell = useCallback(
    (cell: PlayingCell) => {
      syncPlayingCells([
        ...playingCellsRef.current.filter((playing) => playing.cellKey !== cell.cellKey),
        cell
      ]);
      startProgressLoop();
    },
    [startProgressLoop, syncPlayingCells]
  );

  const startMediaElementFallback = useCallback(
    async (cell: GridCell, mediaAsset: MediaAsset, blob: Blob, token: number, cellKey: string) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      const durationSeconds = (mediaAsset.durationMs ?? audio.duration * 1000) / 1000 || 0;
      const { startSeconds, endSeconds } = getClampedPlaybackRange(cell, durationSeconds || 10);
      const baseVolume = masterMuted ? 0 : getEffectiveVolume(masterVolume, cell.volumeOffset);
      const context = new AudioContext();
      const source = context.createMediaElementSource(audio);
      const envelopeGain = context.createGain();
      const volumeGain = context.createGain();

      source.connect(envelopeGain);
      envelopeGain.connect(volumeGain);
      volumeGain.connect(context.destination);
      audio.volume = 1;
      audio.currentTime = startSeconds;
      volumeGain.gain.setValueAtTime(baseVolume, context.currentTime);
      scheduleEnvelope(envelopeGain, cell, startSeconds, endSeconds);

      const route: AudioRoute = {
        mode: "media",
        context,
        envelopeGain,
        volumeGain,
        lastVolume: baseVolume,
        // The media-element route drives an HTMLAudioElement, not buffer sources.
        segments: [],
        audio,
        url,
        startedAtContextTime: context.currentTime,
        offsetSeconds: startSeconds,
        endSeconds,
        bufferDurationSeconds: durationSeconds || audio.duration || 10,
        envelopeSignature: getEnvelopeSignature(cell),
        cacheKey: getCacheKey(cell, mediaAsset.id)
      };

      routeByCellRef.current.set(cellKey, route);
      audio.addEventListener("ended", () => {
        if (playTokenByCellRef.current.get(cellKey) !== token) {
          return;
        }
        // Mirrors the route-identity guard the buffer path already has: a stale listener from a
        // superseded route must not touch the live one.
        if (routeByCellRef.current.get(cellKey) !== route) {
          return;
        }
        if (cell.playbackMode === "loop") {
          // Restart the existing element instead of re-entering this function. Re-entering built
          // a fresh AudioContext, object URL and HTMLAudioElement and overwrote the route without
          // calling stopRoute, leaking all three on every loop — and browsers cap concurrent
          // AudioContexts, so the loop eventually threw. Restarting in place also removes the gap
          // at the loop point and matches how the trimmed-loop branch in the rAF loop behaves.
          audio.currentTime = route.offsetSeconds;
          scheduleEnvelope(route.envelopeGain, cell, audio.currentTime, route.endSeconds);
          void audio.play();
          return;
        }
        stopCellKey(cellKey);
      });
      if (context.state === "suspended") {
        await context.resume();
      }
      addPlayingCell({ cellKey, mediaId: mediaAsset.id, progress: 0 });
      await audio.play();
    },
    [addPlayingCell, getCacheKey, masterMuted, masterVolume, stopCellKey]
  );

  /**
   * Marks a segment as the cue's last one and, if it has already finished, ends the cue.
   *
   * The escape hatch for a chain that gives up: without it, `isLast` would never be reached, and a
   * cue would sit `data-playing="true"` forever while the rAF loop spun at 60 Hz for the rest of
   * the session — it re-arms while any route is live, and end-of-cue for a buffer route is only
   * ever detected from a segment's `onended`.
   */
  const promoteToLast = useCallback(
    (route: AudioRoute, cellKey: string, token: number) => {
      const last = route.segments[route.segments.length - 1];
      if (!last) {
        stopCellKey(cellKey);
        return;
      }
      last.isLast = true;
      const ended =
        last.stopAtContextTime !== null && route.context.currentTime >= last.stopAtContextTime;
      if (ended) {
        // Its `onended` already fired and did nothing, because it was not last at the time.
        if (
          routeByCellRef.current.get(cellKey) === route &&
          playTokenByCellRef.current.get(cellKey) === token
        ) {
          stopCellKey(cellKey);
        }
      }
    },
    [stopCellKey]
  );

  /**
   * Fetches and schedules the segments after the head, one at a time, while the cue plays.
   *
   * Every value it works in is source time except the two context times it derives, and the mapping
   * between them is fixed by `t0`: segment n covers source `[start_n, end_n)` at context
   * `[t0 + start_n - windowStart, ...)`. That is what lets a single envelope curve, scheduled once
   * at press time on the shared gain, stay correct across every segment.
   *
   * `mono` and the window come from the plan, captured at press time and never re-read from a ref:
   * a live route is immune to a mid-cue mono toggle today because its cache key is pinned, and a
   * chain that re-read the ref would hand a one-channel buffer to the same gain the two-channel
   * head feeds, collapsing the cue to dual mono partway through.
   */
  const runSegmentChain = useCallback(
    async (input: {
      route: AudioRoute;
      cell: GridCell;
      mediaAsset: MediaAsset;
      token: number;
      cellKey: string;
      partial: NonNullable<PlaybackBufferEntry["partial"]>;
      windowStartSeconds: number;
      windowEndSeconds: number;
      t0: number;
    }) => {
      const { route, cell, mediaAsset, token, cellKey, partial, t0 } = input;
      const context = route.context;
      const isStale = () =>
        routeByCellRef.current.get(cellKey) !== route ||
        playTokenByCellRef.current.get(cellKey) !== token;

      // Everything below runs inside one guard, so a throw anywhere in the scheduling — not only in
      // the decode, which has its own — still ends the cue through the normal path. Without it, an
      // exception outside the inner try would kill the chain silently: the cue would keep its route
      // with no segment left to fire `onended`, and only the rAF watchdog would ever notice. The
      // watchdog is meant to be the second line of defence, not the first.
      try {
        const segments = planSegments({
          startSeconds: input.windowStartSeconds,
          endSeconds: input.windowEndSeconds,
          sourceDurationSeconds: route.bufferDurationSeconds
        });

        for (let index = 1; index < segments.length; index += 1) {
          const planned = segments[index];
          if (!planned || isStale()) {
            return;
          }

          const at = t0 + (planned.startSeconds - input.windowStartSeconds);

          // Wait until the prefetch window opens. Decoding every segment up front would put the whole
          // track's PCM back in memory, which is the thing this feature exists to avoid.
          while (context.currentTime < at - SEGMENT_PREFETCH_SECONDS) {
            await new Promise<void>((resolve) => {
              window.setTimeout(resolve, SEGMENT_WAIT_STEP_MS);
            });
            if (isStale()) {
              return;
            }
          }

          let result: Awaited<ReturnType<typeof decodeMediaRange>> = null;
          try {
            result = await decodeMediaRange({
              mediaId: partial.mediaId,
              startSeconds: planned.startSeconds,
              endSeconds: planned.bufferEndSeconds,
              mono: partial.mono
            });
          } catch {
            result = null;
          }
          if (isStale()) {
            return;
          }
          if (!result) {
            // Nothing to continue with. End the cue the way an ordinary cue ends rather than leaving
            // a route with no live source.
            recordSegment("missed");
            promoteToLast(route, cellKey, token);
            return;
          }

          const resolution = resolveLateSegment({
            scheduledAtSeconds: at,
            nowSeconds: context.currentTime
          });
          if (resolution.action === "give-up") {
            recordSegment("missed");
            promoteToLast(route, cellKey, token);
            return;
          }
          recordSegment(resolution.skippedSeconds > 0 ? "late" : "scheduled");

          const isLast = index === segments.length - 1;
          const nextPlanned = segments[index + 1];
          const nextAt =
            isLast || !nextPlanned
              ? null
              : t0 + (nextPlanned.startSeconds - input.windowStartSeconds);

          const source = context.createBufferSource();
          source.buffer = result.entry.buffer;
          source.connect(route.envelopeGain);

          const segment: RouteSegment = {
            source,
            // A late segment resumes at the correct SOURCE position, so the cue stays on its own
            // timeline: the audible result is a dropout as long as the lateness, not a shift that
            // would drift out of phase with the envelope.
            startSeconds: planned.startSeconds + resolution.skippedSeconds,
            endSeconds: planned.endSeconds,
            atContextTime: resolution.atSeconds,
            isLast,
            stopAtContextTime: null
          };
          route.segments.push(segment);

          source.onended = () => {
            if (isStale()) {
              return;
            }
            if (!segment.isLast) {
              source.disconnect();
              return;
            }
            stopCellKey(cellKey);
          };

          source.start(
            resolution.atSeconds,
            segment.startSeconds - result.entry.sliceStartSeconds
          );
          if (nextAt !== null) {
            source.stop(nextAt);
            segment.stopAtContextTime = nextAt;
          }
        }
          void cell;
          void mediaAsset;
      } catch {
        if (!isStale()) {
          recordSegment("missed");
          promoteToLast(route, cellKey, token);
        }
      }
    },
    [promoteToLast, stopCellKey]
  );

  const startBufferRoute = useCallback(
    (
      cell: GridCell,
      mediaAsset: MediaAsset,
      entry: PlaybackBufferEntry,
      token: number,
      cellKey: string,
      cacheKey: string
    ) => {
      if (playTokenByCellRef.current.get(cellKey) !== token) {
        return false;
      }

      const context = getContext();
      const buffer = entry.buffer;
      // Clamping is measured against the ORIGINAL media duration, which is not the buffer
      // duration once the buffer is a trimmed slice.
      const { startSeconds, endSeconds } = getClampedPlaybackRange(
        cell,
        entry.sourceDurationSeconds
      );
      const playDurationSeconds = endSeconds - startSeconds;
      if (playDurationSeconds <= 0.001) {
        stopCellKey(cellKey);
        return false;
      }

      const source = context.createBufferSource();
      const envelopeGain = context.createGain();
      const volumeGain = context.createGain();
      const baseVolume = masterMuted ? 0 : getEffectiveVolume(masterVolume, cell.volumeOffset);

      source.buffer = buffer;
      source.connect(envelopeGain);
      envelopeGain.connect(volumeGain);
      volumeGain.connect(context.destination);
      volumeGain.gain.setValueAtTime(baseVolume, context.currentTime);
      if (!entry.partial) {
        // A streamed route schedules its envelope below instead, anchored to the same explicit
        // start time as its head. Scheduling here as well would leave two curves on one gain: the
        // second `setValueCurveAtTime` overlaps the first, which the spec makes throw, and the
        // fallback `setValueAtTime` throws too inside a running curve — leaving the gain pinned
        // wherever the cancel stopped it, at full scale, for the rest of the cue.
        scheduleEnvelope(envelopeGain, cell, startSeconds, endSeconds);
      }

      const segment: RouteSegment = {
        source,
        startSeconds,
        endSeconds,
        atContextTime: context.currentTime,
        // A classic route is one segment, so it is the last one by construction and keeps today's
        // end-of-cue behaviour exactly.
        isLast: true,
        stopAtContextTime: null
      };

      const route: AudioRoute = {
        mode: "buffer",
        context,
        envelopeGain,
        volumeGain,
        lastVolume: baseVolume,
        segments: [segment],
        startedAtContextTime: context.currentTime,
        offsetSeconds: startSeconds,
        endSeconds,
        bufferDurationSeconds: entry.sourceDurationSeconds,
        envelopeSignature: getEnvelopeSignature(cell),
        cacheKey
      };

      routeByCellRef.current.set(cellKey, route);
      source.onended = () => {
        if (routeByCellRef.current.get(cellKey) !== route) {
          return;
        }
        if (playTokenByCellRef.current.get(cellKey) !== token) {
          return;
        }
        // Only the last segment ends the cue. A non-last segment finishing means the next one is
        // already playing, so its node is simply released.
        if (!segment.isLast) {
          source.disconnect();
          return;
        }
        if (cell.playbackMode === "loop") {
          // An AudioBufferSourceNode cannot be restarted, so a loop must build a new one. The
          // gains it fed are finished as well; disconnecting them releases the chain
          // deterministically instead of leaving it to the collector.
          for (const finished of route.segments) {
            finished.source.disconnect();
          }
          envelopeGain.disconnect();
          volumeGain.disconnect();
          startBufferRoute(cell, mediaAsset, entry, token, cellKey, cacheKey);
          return;
        }
        stopCellKey(cellKey);
      };
      // Buffer time, not source time: a sliced buffer starts at `sliceStartSeconds`.
      if (entry.partial) {
        // Streamed window. The head is scheduled with an EXPLICIT time rather than `start(0)`,
        // because `start(0)` never reports which frame it actually landed on — the browser begins
        // it on the next render quantum, up to 128 frames later — and the handoff time for the next
        // segment is computed from this number. Measured: a requested time in the future is honoured
        // to the sample, while `start(0)` leaves the app guessing.
        const t0 = context.currentTime + SCHEDULE_LEAD_SECONDS;
        const headEnd = Math.min(entry.partial.headEndSeconds, endSeconds);
        const handoffAt = t0 + (headEnd - startSeconds);

        segment.atContextTime = t0;
        segment.endSeconds = headEnd;
        segment.isLast = headEnd >= endSeconds;
        route.startedAtContextTime = t0;

        // The envelope must be anchored to the same t0, or the fades would run ahead of the sound
        // by the lead. One curve covers the whole window on the shared gain, so no segment ever
        // reschedules it.
        scheduleEnvelope(envelopeGain, cell, startSeconds, endSeconds, t0);

        // No `duration`: the segment is bounded by its `stop` at the shared handoff time, which is
        // sample-accurate on both sides and therefore leaves no gap and no overlap.
        source.start(t0, startSeconds - entry.sliceStartSeconds);
        if (!segment.isLast) {
          source.stop(handoffAt);
          segment.stopAtContextTime = handoffAt;
          void runSegmentChain({
            route,
            cell,
            mediaAsset,
            token,
            cellKey,
            partial: entry.partial,
            windowStartSeconds: startSeconds,
            windowEndSeconds: endSeconds,
            t0
          });
        }

        addPlayingCell({ cellKey, mediaId: mediaAsset.id, progress: 0 });
        return true;
      }

      source.start(0, startSeconds - entry.sliceStartSeconds, playDurationSeconds);
      addPlayingCell({ cellKey, mediaId: mediaAsset.id, progress: 0 });
      return true;
    },
    [addPlayingCell, getContext, masterMuted, masterVolume, runSegmentChain, stopCellKey]
  );

  const playCell = useCallback(
    async (cell: GridCell) => {
      if (!cell.mediaId) {
        return;
      }
      const mediaAsset = media.find((candidate) => candidate.id === cell.mediaId);
      if (!mediaAsset) {
        return;
      }

      const cellKey = getCellKey(panelId, cell.id);
      const triggeredAt = performance.now();

      if (stopOthers) {
        stopAll();
      } else {
        stopCellKey(cellKey);
      }
      const token = bumpCellToken(cellKey);

      // Fast path, and the reason everything above it is synchronous: an `async` body runs to its
      // first `await` inside the caller's task, so a warm cell on a running context reaches
      // `source.start()` in the very task that handled the press — no microtask hop, and still
      // inside the user gesture, which is what iOS wants. The slow path below is unchanged and
      // covers a suspended context, a cold cache and the media-element browsers.
      const warmContext = contextRef.current;
      const warmCacheKey = getCacheKey(cell, cell.mediaId);
      if (
        warmContext &&
        getAudioContextState(warmContext) === "running" &&
        typeof warmContext.createBufferSource === "function"
      ) {
        const warmEntry = playbackBufferCache.get(warmCacheKey);
        if (
          warmEntry &&
          startBufferRoute(cell, mediaAsset, warmEntry, token, cellKey, warmCacheKey)
        ) {
          recordTimeToFirstSound(performance.now() - triggeredAt);
          return;
        }
      }

      const context = await getPlayableContext();

      const canUseBufferSource = typeof context.createBufferSource === "function";
      if (canUseBufferSource) {
        const cacheKey = warmCacheKey;
        const entry = await loadPlaybackEntry(cell, cell.mediaId, cacheKey);
        if (!entry || playTokenByCellRef.current.get(cellKey) !== token) {
          return;
        }
        if (startBufferRoute(cell, mediaAsset, entry, token, cellKey, cacheKey)) {
          recordTimeToFirstSound(performance.now() - triggeredAt);
        }
        return;
      }

      const blob = await getMediaBlob(cell.mediaId);
      if (!blob || playTokenByCellRef.current.get(cellKey) !== token) {
        return;
      }
      await startMediaElementFallback(cell, mediaAsset, blob, token, cellKey);
      recordTimeToFirstSound(performance.now() - triggeredAt);
    },
    [
      bumpCellToken,
      getCacheKey,
      getPlayableContext,
      loadPlaybackEntry,
      media,
      panelId,
      startBufferRoute,
      startMediaElementFallback,
      stopAll,
      stopCellKey,
      stopOthers
    ]
  );

  useEffect(() => {
    const recoverContext = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      const context = contextRef.current;
      if (!context || getAudioContextState(context) === "closed") {
        return;
      }
      void resumeContext(context);
    };

    window.addEventListener("pageshow", recoverContext);
    window.addEventListener("focus", recoverContext);
    document.addEventListener("visibilitychange", recoverContext);
    return () => {
      window.removeEventListener("pageshow", recoverContext);
      window.removeEventListener("focus", recoverContext);
      document.removeEventListener("visibilitychange", recoverContext);
    };
  }, [resumeContext]);

  const toggleCell = useCallback(
    async (cell: GridCell) => {
      if (isCellPlaying(cell.id)) {
        stopCell(cell.id);
        return;
      }

      await playCell(cell);
    },
    [isCellPlaying, playCell, stopCell]
  );

  /**
   * The warm-up used to depend on `cells`, whose identity changes on any cell edit — so a single
   * alias keystroke restarted the whole serial walk and re-paid its inter-decode gaps. Depending
   * on the cache keys instead means only a change that affects what must be decoded restarts it.
   */
  const warmupTargets = useMemo(
    () =>
      cells.flatMap<WarmupTarget>((cell) =>
        isMediaId(cell.mediaId)
          ? [
              {
                cellId: cell.id,
                mediaId: cell.mediaId,
                cacheKey: makePlaybackBufferKey({
                  mediaId: cell.mediaId,
                  trimStartMs: cell.trimStartMs,
                  trimEndMs: cell.trimEndMs,
                  mono: monoPlayback
                }),
                cell
              }
            ]
          : []
      ),
    [cells, monoPlayback]
  );

  const warmupTargetsRef = useRef(warmupTargets);
  useEffect(() => {
    warmupTargetsRef.current = warmupTargets;
  }, [warmupTargets]);

  const warmupSignature = useMemo(
    () => warmupTargets.map((target) => target.cacheKey).join(","),
    [warmupTargets]
  );

  /**
   * Panel-scoped eviction. Declared before the warm-up so priority and pinning are in place
   * before anything is decoded.
   */
  useEffect(() => {
    markStart("panelSwitch");

    const currentKeys = Array.from(
      new Set(warmupTargetsRef.current.map((target) => target.cacheKey))
    );
    activeKeysRef.current = new Set(currentKeys);

    // Pinning is computed from EVERY live route, not from the active panel: switching panels
    // does not stop playback and stopOthers is off by default, so a route belonging to another
    // panel can still be using its buffer.
    const pinnedKeys = Array.from(routeByCellRef.current.values()).map((route) => route.cacheKey);

    playbackBufferCache.setPinned(pinnedKeys);
    playbackBufferCache.setPriority(currentKeys);
    setActivePanelKeys(currentKeys);

    // One panel warm at a time. Everything outside the panel on screen is dropped on the switch,
    // so resident PCM is bounded by that panel plus whatever a live route is still using, rather
    // than by every panel the session has visited. Keeping other panels cached was measurably
    // better on a desktop with headroom and is what kills the tab on a phone, where the whole
    // library never fits; the cost paid for the bound is a cold warm-up when the user comes back.
    //
    // Live routes survive on purpose: switching panels does not stop playback and `stopOthers` is
    // off by default, so a route belonging to another panel can still be using its buffer.
    const liveKeys = new Set([...pinnedKeys, ...currentKeys]);
    const evictedKeys: string[] = [];
    for (const key of playbackBufferCache.keys()) {
      if (!liveKeys.has(key) && playbackBufferCache.delete(key)) {
        evictedKeys.push(key);
      }
    }
    // The warm state has to go with the buffer. A key left as "ready" after its PCM was evicted
    // makes the cell promise an instant start on the next visit and suppresses its re-warm.
    if (evictedKeys.length > 0) {
      dropWarmedKeys(evictedKeys);
    }

    const switchMs = markEnd("panelSwitch");
    if (switchMs !== null) {
      recordPanelSwitchEngine(switchMs);
    }
  }, [dropWarmedKeys, panelId, warmupSignature]);

  useEffect(() => {
    // Bumped synchronously, before the debounce: every run already in flight has to know it is
    // superseded as early as possible, even though its current decode cannot be cancelled.
    const runId = warmupRunRef.current + 1;
    warmupRunRef.current = runId;

    const seen = new Set<string>();
    const uniqueTargets = warmupTargetsRef.current.filter((target) => {
      if (seen.has(target.cacheKey)) {
        return false;
      }
      seen.add(target.cacheKey);
      return true;
    });

    // One state update for everything already cached, instead of one per entry.
    const readyKeys = uniqueTargets
      .filter((target) => playbackBufferCache.has(target.cacheKey))
      .map((target) => target.cacheKey);
    if (readyKeys.length > 0) {
      setWarmedKeys((current) => {
        const missing = readyKeys.filter((key) => current[key] !== "ready");
        if (missing.length === 0) {
          return current;
        }
        const next = { ...current };
        for (const key of missing) {
          next[key] = "ready";
        }
        return next;
      });
    }

    // Media that more than one target needs is staged so its full decode is shared instead of
    // repeated. Counted up front, because that is exactly how many releases to expect.
    //
    // Targets that will take the byte-range path are excluded, and that exclusion is load-bearing:
    // staging kicks off a FULL decode before the targets are processed, so leaving a range-bound
    // media in the count means paying the whole 220-330 MiB transient anyway and then not using it.
    // Sharing a decode is what staging is for, and two range reads have nothing to share — each is
    // about ten milliseconds of work on a different part of the file.
    //
    // The test is a hint, not a guarantee: eligibility is judged from the duration and trim, which
    // are known synchronously, while the container is only known after a probe. A wrong hint costs
    // one unshared decode, never a wrong buffer.
    const pendingByMedia = new Map<string, number>();
    for (const target of uniqueTargets) {
      const asset = mediaRef.current.find((candidate) => candidate.id === target.mediaId);
      if (isPartialPathLikely(target.cell, asset?.durationMs ?? null)) {
        continue;
      }
      pendingByMedia.set(target.mediaId, (pendingByMedia.get(target.mediaId) ?? 0) + 1);
    }
    const startWarmup = async () => {
      if (warmupRunRef.current !== runId) {
        return;
      }
      // Safe to reset here and not before the await: runs are serialized, so no worker of an
      // earlier run is still holding a staged decode by the time this one starts.
      stagingRef.current.clear();
      markStart(`warmup:${String(runId)}`);
      let warmed = 0;
      let skipped = 0;
      // Cell order, so the visually first cells are decoded first.
      let cursor = 0;
      // Bytes promised to decodes that have not landed in the cache yet. Without this every
      // worker checks the budget before any of them has finished, they all see it empty, and the
      // pool overshoots by its own width.
      let reservedBytes = 0;

      const releaseStaged = (mediaId: string) => {
        const staged = stagingRef.current.get(mediaId);
        if (!staged) {
          return;
        }
        staged.pending -= 1;
        if (staged.pending <= 0) {
          stagingRef.current.delete(mediaId);
        }
      };

      const runWorker = async () => {
        for (;;) {
          const target = uniqueTargets[cursor];
          cursor += 1;
          if (!target || warmupRunRef.current !== runId) {
            return;
          }
          if (playbackBufferCache.has(target.cacheKey)) {
            releaseStaged(target.mediaId);
            continue;
          }

          // Predictive skip: decoding something that would be evicted on arrival costs a full
          // decode plus a transient allocation spike, for nothing.
          const asset = mediaRef.current.find((candidate) => candidate.id === target.mediaId);
          const estimate = estimatePcmBytes(
            getTrimmedDurationMs(target.cell, asset?.durationMs ?? null),
            monoRef.current
          );
          const stats = playbackBufferCache.stats();
          const budgetBytes = stats.budgetBytes;
          // Measured against what eviction may NOT touch — the active panel plus anything a live
          // route is using — rather than against everything cached. Other panels' buffers are
          // evictable, so counting them here would make the panel the user is actually looking at
          // refuse to warm in order to protect one they left.
          //
          // No margin below the budget: the estimate already errs high, because the channel count
          // is unknown before decoding and stereo is assumed.
          const unavoidableBytes = stats.protectedBytes + reservedBytes;
          const affordable =
            budgetBytes === null ||
            (estimate === null
              ? unavoidableBytes < budgetBytes
              : unavoidableBytes + estimate <= budgetBytes);
          if (!affordable) {
            skipped += 1;
            releaseStaged(target.mediaId);
            continue;
          }

          const waiting = pendingByMedia.get(target.mediaId) ?? 1;
          if (waiting > 1 && !stagingRef.current.has(target.mediaId)) {
            stagingRef.current.set(target.mediaId, {
              promise: decodeFullBuffer(target.mediaId).catch(() => null),
              pending: waiting
            });
          }

          // A cue starting mid-file needs the decoder offset measured before its window can be
          // read as a range at all, and measuring costs two short decodes — so it happens here, in
          // the warm-up, and only for the cells that actually need it. A cue starting at the head
          // never does: a decode from byte 0 is already on the app's timeline.
          if ((target.cell.trimStartMs ?? 0) > 0) {
            await ensureMp3Alignment(target.mediaId).catch(() => false);
            if (warmupRunRef.current !== runId) {
              releaseStaged(target.mediaId);
              return;
            }
          }

          reservedBytes += estimate ?? 0;
          try {
            await warmMedia(target, runId);
          } finally {
            // The bytes are in the cache now, where `protectedBytes` accounts for them.
            reservedBytes -= estimate ?? 0;
          }
          warmed += 1;
          releaseStaged(target.mediaId);
        }
      };

      // A bounded pool rather than one decode at a time. The old fixed 70 ms pause between decodes
      // was a hand-tuned way of letting the browser breathe; with several decodes in flight the
      // awaits provide those yields on their own.
      await Promise.all(
        Array.from({ length: Math.min(getWarmupConcurrency(), uniqueTargets.length) }, runWorker)
      );
      stagingRef.current.clear();

      const totalMs = markEnd(`warmup:${String(runId)}`);
      if (totalMs !== null && warmupRunRef.current === runId) {
        recordWarmup(totalMs, warmed, skipped);
      }
    };

    // Debounced, then chained. The debounce collapses a burst of panel switches into a single
    // warm-up of the panel the user actually stopped on; the chain guarantees that even when a
    // burst outlives it, the pool of the superseded run has drained before the next one allocates.
    // Without both, "drop the previous panel" makes memory worse rather than better: every switch
    // adds another pool of concurrent decodes on top of the ones still running.
    const timer = window.setTimeout(() => {
      warmupChainRef.current = warmupChainRef.current.then(startWarmup, startWarmup);
    }, WARMUP_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [decodeFullBuffer, warmupSignature, warmMedia]);

  /**
   * A purge must also drop the matching warm state: a stale "ready" entry would suppress the
   * re-warm and the cell would never show its ready animation again.
   */
  useEffect(
    () =>
      onMediaCachePurge((mediaIds) => {
        purgeGenerationRef.current += 1;

        setWarmedKeys((current) => {
          if (mediaIds === null) {
            return Object.keys(current).length === 0 ? current : {};
          }
          const dropped = new Set(mediaIds);
          const next = Object.fromEntries(
            Object.entries(current).filter(([key]) => !dropped.has(getMediaIdFromKey(key)))
          );
          return Object.keys(next).length === Object.keys(current).length ? current : next;
        });

        for (const key of [...inflightRef.current.keys()]) {
          if (mediaIds === null || mediaIds.includes(getMediaIdFromKey(key))) {
            inflightRef.current.delete(key);
          }
        }

        // Staged full decodes of purged media would otherwise be sliced into fresh cache
        // entries moments after the purge.
        for (const mediaId of [...stagingRef.current.keys()]) {
          if (mediaIds === null || mediaIds.includes(mediaId)) {
            stagingRef.current.delete(mediaId);
          }
        }
      }),
    []
  );

  useEffect(() => {
    routeByCellRef.current.forEach((route, cellId) => {
      const cell = cellsRef.current.find((candidate) => getCellKey(panelId, candidate.id) === cellId);
      const nextVolume = masterMuted ? 0 : getEffectiveVolume(masterVolume, cell?.volumeOffset ?? 0);
      setRouteVolume(route, nextVolume);
    });
  }, [cells, masterMuted, masterVolume, panelId]);

  useEffect(() => {
    routeByCellRef.current.forEach((route, cellId) => {
      const cell = cellsRef.current.find((candidate) => getCellKey(panelId, candidate.id) === cellId);
      if (!cell) {
        return;
      }
      const nextSignature = getEnvelopeSignature(cell);
      if (route.envelopeSignature === nextSignature) {
        return;
      }
      route.envelopeSignature = nextSignature;
      const currentSeconds =
        route.mode === "media" && route.audio
          ? route.audio.currentTime
          : route.offsetSeconds + (route.context.currentTime - route.startedAtContextTime);
      const { endSeconds } = getClampedPlaybackRange(cell, route.bufferDurationSeconds);
      scheduleEnvelope(route.envelopeGain, cell, currentSeconds, endSeconds);
    });
  }, [cells, panelId]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      stagingRef.current.clear();
    },
    []
  );

  useEffect(
    () => () => {
      stopAll();
      void contextRef.current?.close();
      contextRef.current = null;
    },
    [stopAll]
  );

  const warmedCells = useMemo(() => {
    const byCellId: Record<string, WarmState> = {};
    for (const target of warmupTargets) {
      const state = warmedKeys[target.cacheKey];
      if (state) {
        byCellId[target.cellId] = state;
      }
    }
    return byCellId;
  }, [warmedKeys, warmupTargets]);

  return { playingCells, warmedCells, playCell, toggleCell, stopCell, stopAll, isCellPlaying };
}

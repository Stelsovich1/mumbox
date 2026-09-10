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
  recordLiveSegments,
  recordWarmup,
  setMonoState,
  setRoutePcmSource
} from "../../../shared/lib/diagnostics";
import { clearProgress, writeProgress } from "../../../shared/lib/cellVisuals";
import { onMediaCachePurge } from "../../../shared/lib/mediaCacheRegistry";
import {
  estimatePcmBytes,
  getAudioBufferBytes,
  getMediaIdFromKey,
  makePlaybackBufferKey
} from "./audioBufferCache";
import type { PlaybackBufferEntry } from "./audioBufferCache";
import {
  decodeAudioBlob,
  shouldSliceBuffer,
  sliceToAudioBuffer
} from "./decodeAudio";
import {
  HEAD_SECONDS,
  planSegments,
  resolveLateSegment,
  SEGMENT_MARGIN_SECONDS,
  shouldReadRange,
  shouldSegmentWindow
} from "./partialPlan";
import { DecodeLane } from "./decodeSemaphore";
import { decodeMediaRange, ensureMp3Alignment, planMediaSegments } from "./partialSource";
import {
  getEngineSampleRate,
  readRequestedSampleRate,
  setEngineSampleRate
} from "./playbackRate";
import { playbackBufferCache, setActivePanelKeys } from "./playbackBufferCache";
import { getCellGainValue, getEffectiveVolume, getMasterGainValue } from "./volume";
import { dropSegment, listFinishedSegments, pruneFinishedSegments } from "./routeSegments";
import {
  getEnvelopeValue,
  getTrimEndSeconds,
  getTrimStartSeconds,
  scheduleEnvelope
} from "./audioEnvelope";

/**
 * Which cells are playing. Membership only.
 *
 * `progress` and `mediaId` used to live here. `progress` is now written straight to the DOM through
 * `cellVisuals` — pushing it through React re-rendered the whole shell twenty times a second — and
 * `mediaId` had no consumer at all: it survived only inside the equality check that compared these
 * objects, which a set of keys does not need.
 */
type PlayingCell = string;

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
      sampleRate: getEngineSampleRate(),
      channels: 2
    }) ||
    shouldSegmentWindow({ windowSeconds, sampleRate: getEngineSampleRate(), channels: 2 })
  );
}

/**
 * What warming this cell will actually put in the cache.
 *
 * NOT the same as the PCM of its window, and conflating the two is what left half a panel cold on a
 * phone the moment a default budget existed. A STREAMED cell caches its head — 0.5 s, about 0.2 MiB
 * — and nothing else; the segments that follow are never cache entries. Estimating it at its window
 * instead means an untrimmed three-minute track is judged at ~38 MiB, so eighteen of them come to
 * ~680 MiB, the budget is "exhausted" after the first handful, and every cell after that is skipped
 * for good: the warm-up does not revisit a skipped target, so those pads stay dim for the life of
 * the panel with nothing on screen to explain it.
 *
 * A HINT, like `isPartialPathLikely`, and it errs LOW on purpose. The container is unknown until a
 * probe runs, so an ogg cell counted as streamable will cost its full decode instead — and being
 * wrong that way costs an eviction, which the two-tier LRU handles and which never touches a
 * playing cue. Being wrong the other way costs a cell that is never warm again.
 */
function estimateWarmBytes(
  cell: GridCell,
  durationMs: number | null,
  mono: boolean,
  sampleRate: number
): number | null {
  const windowMs = getTrimmedDurationMs(cell, durationMs);
  if (windowMs === null) {
    // No duration means no estimate, which the caller reads as "unknown" rather than as zero.
    return null;
  }
  if (
    cell.playbackMode !== "loop" &&
    shouldSegmentWindow({ windowSeconds: windowMs / 1000, sampleRate, channels: 2 })
  ) {
    return estimatePcmBytes((HEAD_SECONDS + SEGMENT_MARGIN_SECONDS) * 1000, mono, sampleRate);
  }
  return estimatePcmBytes(windowMs, mono, sampleRate);
}

/**
 * Whether the decoder offset has to be measured for this cell before its audio can be read.
 *
 * Any decode that does not start at the first frame needs it, and there are two ways to get there.
 * A trimmed cue starts mid-file outright. An untrimmed long track starts at byte 0 but is STREAMED,
 * and every segment after the head starts mid-file — so gating on the trim alone left those
 * segments refused, the cue promoted to its head, and a three-minute track playing 0.5 seconds.
 *
 * Judged from the duration and the trim alone so it can be answered synchronously, the same way
 * `isPartialPathLikely` is. A false positive costs one measurement that is then cached and unused;
 * a false negative costs the cue.
 */
function needsAlignmentMeasurement(cell: GridCell, durationMs: number | null): boolean {
  if ((cell.trimStartMs ?? 0) > 0) {
    return true;
  }
  const sourceSeconds = (durationMs ?? 0) / 1000;
  if (sourceSeconds <= 0) {
    return false;
  }
  const { startSeconds, endSeconds } = getClampedPlaybackRange(cell, sourceSeconds);
  const windowSeconds = endSeconds - startSeconds;
  if (windowSeconds <= 0) {
    return false;
  }
  return shouldSegmentWindow({
    windowSeconds,
    sampleRate: getEngineSampleRate(),
    channels: 2
  });
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

function getHtmlAudioVolume(volume: number) {
  return Math.min(1, Math.max(0, volume));
}

function getAudioContextState(context: AudioContext) {
  return context.state as AudioContextState | "interrupted";
}

function arePlayingCellsEqual(previous: PlayingCell[], next: PlayingCell[]) {
  return (
    previous.length === next.length && previous.every((cellKey, index) => cellKey === next[index])
  );
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

  /**
   * Reports PCM held by live routes to the diagnostics, and counts the segments holding it.
   *
   * The cache accounting is structurally blind here — a streamed route owns its segments and they
   * are never cache entries — and that blindness is why segment accumulation went unnoticed while
   * every memory assertion in the suite kept passing. Registered once; the closure reads the live
   * map, so it needs no dependencies.
   */
  useEffect(() => {
    setRoutePcmSource(() => {
      let bytes = 0;
      let live = 0;
      for (const route of routeByCellRef.current.values()) {
        for (const segment of route.segments) {
          const buffer = segment.source.buffer;
          if (buffer) {
            bytes += buffer.length * buffer.numberOfChannels * 4;
          }
          live += 1;
        }
      }
      void live;
      return bytes;
    });
    return () => {
      setRoutePcmSource(() => 0);
    };
  }, []);

  /**
   * Publishes how many segments are held right now.
   *
   * Called from every mutation point rather than from the accounting closure. Sampling it when
   * diagnostics happen to be read makes `peakLive` a record of when someone looked, not of what the
   * engine held — measured exactly that way: a route holding all six segments of a window reported
   * a peak of 3, because nothing read the number until the cue was over.
   */
  const syncLiveSegments = useCallback(() => {
    let live = 0;
    for (const route of routeByCellRef.current.values()) {
      live += route.segments.length;
    }
    recordLiveSegments(live);
  }, []);
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
  /**
   * The AUTHORITATIVE warm state, not a mirror of `warmedKeys`.
   *
   * It has to be the ref rather than the state, because `warmMedia` resumes after an `await` and
   * asks whether its key is still tracked. Syncing the ref from an effect leaves a window between
   * the flush that empties the queue and the commit that updates the state where the key is in
   * neither — and in that window a finished decode looks untracked and its `ready` transition is
   * dropped, leaving the cell on `warming` for good. Measured as exactly that: two cells sharing
   * one media, one reaching `ready` and one not.
   */
  const warmedKeysRef = useRef(warmedKeys);

  /**
   * Lookup indexes for the hot paths, rebuilt only when their source changes.
   *
   * The rAF tick used to resolve a route's cell with `cellsRef.current.find(...)` and a template
   * literal per candidate: 144 cells x 6 playing x 60 fps is about 52 000 string allocations a
   * second, and the GC pause that buys is audible. The media scans are the same shape — the warm-up
   * did one per target, so 144 targets against a 500-media library is 72 000 comparisons, twice.
   *
   * The cell key stays panel-qualified. A route survives a panel switch (`stopOthers` is off by
   * default), so its key can name a panel that is not on screen; the lookup then correctly misses
   * and the tick keeps the branch it already has for that.
   */
  const cellByKeyRef = useRef(new Map<string, GridCell>());
  const mediaByIdRef = useRef(new Map<string, MediaAsset>());

  useEffect(() => {
    cellsRef.current = cells;
    mediaRef.current = media;
    cellByKeyRef.current = new Map(cells.map((cell) => [getCellKey(panelId, cell.id), cell]));
    mediaByIdRef.current = new Map(media.map((asset) => [asset.id, asset]));
  }, [cells, media, panelId]);

  useEffect(() => {
    monoRef.current = monoPlayback;
    setMonoState(monoPlayback);
  }, [monoPlayback]);

  useEffect(() => {
    panelIdRef.current = panelId;
    masterVolumeRef.current = masterVolume;
    masterMutedRef.current = masterMuted;
  }, [masterMuted, masterVolume, panelId]);

  /**
   * Set once the warm-state machinery below exists.
   *
   * `getContext` runs before that in source order but only ever after it at runtime, and a rate
   * change can only happen when a context is built. The same mutated-ref idiom `WorkspaceGrid` uses
   * for its cell controller, and for the same reason: the alternative is reordering a 1800-line
   * hook around one call.
   */
  const dropWarmedKeysRef = useRef<(keys: readonly string[]) => void>(() => undefined);
  /**
   * The shared output node, one per context.
   *
   * Master volume used to be folded into every route's own gain, which meant the rAF loop rewrote
   * that gain for every playing route on every frame just to keep them in sync. With a shared node
   * a master change is one `setValueAtTime` on one node, and a route's gain only ever moves when
   * that cell's own offset does.
   *
   * The media-element fallback cannot use it: that route builds its own `AudioContext` and its own
   * `destination`, so nothing on this context can reach it. It keeps the combined form.
   */
  const masterGainRef = useRef<GainNode | null>(null);

  const getContext = useCallback(() => {
    const current = contextRef.current;
    if (current && current.state !== "closed") {
      return current;
    }
    // `?rate=N` asks for a specific rate; anything else takes the hardware's. The request is
    // attempted inside a try because a device may reject a rate it cannot run — falling back to the
    // default keeps the switch a debugging aid rather than a way to break playback.
    const requested = readRequestedSampleRate(window.location.search);
    let context: AudioContext | null = null;
    if (requested !== null) {
      try {
        context = new AudioContext({ sampleRate: requested });
      } catch {
        context = null;
      }
    }
    context ??= new AudioContext();
    contextRef.current = context;
    masterGainRef.current = null;

    // Everything in the buffer cache is decoded at the engine rate by construction. A context
    // recreated at a different rate — the iOS recovery path builds a fresh one — would otherwise
    // leave entries that quietly resample on every play, which is the cost this change removes.
    if (setEngineSampleRate(context.sampleRate)) {
      const stale = playbackBufferCache.keys();
      playbackBufferCache.clear();
      dropWarmedKeysRef.current(stale);
    }
    return context;
  }, []);

  /**
   * Builds the context once, on mount, purely to learn the hardware's sample rate.
   *
   * It used to be built by the first pad press. On any device that does not run at 44 100 — 48 000
   * is the common Android rate — that meant the whole panel was decoded at the DEFAULT rate, every
   * pad went `ready`, and then the first tap constructed the context, saw a different rate, and
   * cleared the cache and the warm state it had just filled. That tap paid a cold decode, and the
   * panel was never re-warmed because `warmupSignature` had not changed.
   *
   * On mount rather than at the head of the warm-up so it cannot contend with the decode pool, and
   * so a panel switch does not touch it at all. A context constructed without a user gesture starts
   * suspended, which is all this needs — the first press still resumes it.
   */
  useEffect(() => {
    try {
      getContext();
    } catch {
      // A device that refuses to construct one here will construct it on the first press, which is
      // the behaviour this replaces. Never a reason to fail the mount.
    }
  }, [getContext]);

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

  const getMasterGain = useCallback((context: AudioContext) => {
    const existing = masterGainRef.current;
    if (existing?.context === context) {
      return existing;
    }
    const gain = context.createGain();
    gain.gain.setValueAtTime(
      getMasterGainValue(masterVolumeRef.current, masterMutedRef.current),
      context.currentTime
    );
    gain.connect(context.destination);
    masterGainRef.current = gain;
    return gain;
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
      // Same duty `stopCellKey` has. This path is the iOS stuck-context recovery, so without it
      // every cell that was playing keeps its marker frozen mid-track while `data-playing` is
      // false — and the registry replays that stale value on the next remount.
      clearProgress(cellKey);
    });
    routeByCellRef.current.clear();
    syncLiveSegments();
    syncPlayingCells([]);
  }, [bumpCellToken, syncLiveSegments, syncPlayingCells]);

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
    async (
      cell: GridCell,
      mediaId: string,
      mono: boolean,
      // Background by default, so only the press path has to name the deadline it is under.
      lane: DecodeLane = "background"
    ): Promise<PlaybackBufferEntry | null> => {
      const asset = mediaByIdRef.current.get(mediaId);
      if (!isPartialPathLikely(cell, asset?.durationMs ?? null)) {
        // Counted, not silent. This is the ordinary decline — a short one-shot with nothing to skip
        // and nothing worth streaming — and it is also what a missing duration looks like, which is
        // NOT ordinary: the window would then be judged against zero and every cell on the panel
        // would take a full decode with no other trace anywhere.
        recordPartialServed("declined", asset?.durationMs ? "no-payoff-hint" : "no-duration");
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
            : await planMediaSegments({
                mediaId,
                startSeconds,
                endSeconds,
                // The same duration this window was clamped against two lines up, handed down so a
                // file with no Xing/Info frame can still be streamed. Without it the container has
                // no duration to offer and the whole track takes a full decode.
                fallbackDurationSeconds: sourceSeconds
              });
        const head = plan?.segments[0];
        if (plan && head) {
          const result = await decodeMediaRange(
            {
              mediaId,
              startSeconds: head.startSeconds,
              // The margin is real audio past the nominal boundary, so the outgoing segment always
              // has samples to play right up to the handoff.
              endSeconds: head.bufferEndSeconds,
              mono
            },
            lane
          );
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
            sampleRate: getEngineSampleRate(),
            channels: 2
          })
        ) {
          // Three distinguishable shapes, and the whole point of separating them is that they call
          // for different answers. A loop is excluded by design and costs a full decode knowingly;
          // a plan that came back null means the browser verdict, the container or the missing
          // alignment measurement took the cue off the path; a head that failed after a plan
          // existed means the read itself did not work.
          recordPartialServed(
            "declined",
            cell.playbackMode === "loop" ? "loop" : plan ? "head-failed" : "no-plan"
          );
          return null;
        }
        const result = await decodeMediaRange({ mediaId, startSeconds, endSeconds, mono }, lane);
        recordPartialServed(result ? "range" : "declined", result ? undefined : "range-empty");
        return result?.entry ?? null;
      } catch {
        // Never fail a cue from here; the full decode below is the fallback.
        recordPartialServed("declined", "threw");
        return null;
      }
    },
    []
  );

  const loadPlaybackEntry = useCallback(
    async (
      cell: GridCell,
      mediaId: string,
      cacheKey: string,
      lane: DecodeLane = "background"
    ): Promise<PlaybackBufferEntry | null> => {
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
        const rangeEntry = await tryDecodeRange(cell, mediaId, mono, lane);
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
        mono: monoRef.current,
        loop: cell.playbackMode === "loop"
      }),
    []
  );

  /**
   * Warm-state transitions, buffered and flushed once per frame.
   *
   * `warmMedia` writes twice per target — `warming` before the decode, `ready` after — with an
   * `await` between them, so React cannot batch the pair: each landed in its own task and its own
   * render of the whole shell. A cold 144-cell panel is up to 288 root renders, spread over the
   * ~7.3 s the warm-up takes, which is ~39 renders a second — the same order as the 20 Hz progress
   * push. Coalescing them into one render per frame bounds that at 60/s regardless of how wide the
   * decode pool is.
   *
   * EVERY writer goes through this queue, including the drops. Mixing buffered writes with direct
   * ones inverts their order: a queued `ready` landing after a synchronous eviction would resurrect
   * a key whose PCM is gone, and a cell claiming to be warm without a buffer promises an instant
   * start the engine cannot deliver and suppresses its own re-warm. The one exception is a purge,
   * which clears the buffer before writing so nothing in flight can outlive it.
   */
  const pendingWarmRef = useRef(new Map<string, WarmState | null>());
  const warmFlushFrameRef = useRef<number | null>(null);

  const flushWarmedKeys = useCallback(() => {
    warmFlushFrameRef.current = null;
    const pending = pendingWarmRef.current;
    if (pending.size === 0) {
      return;
    }
    const queued = new Map(pending);
    pending.clear();

    const current = warmedKeysRef.current;
    const next: Record<string, WarmState> = {};
    let changed = false;
    for (const [key, value] of Object.entries(current)) {
      const update = queued.get(key);
      if (update === null) {
        changed = true;
        continue;
      }
      const resolved = update ?? value;
      next[key] = resolved;
      if (resolved !== value) {
        changed = true;
      }
    }
    for (const [key, value] of queued) {
      if (value !== null && !(key in current)) {
        next[key] = value;
        changed = true;
      }
    }
    if (!changed) {
      return;
    }
    // Ref first, synchronously: the very next `warmMedia` to resume reads it, and it must not see
    // the pre-flush value.
    warmedKeysRef.current = next;
    setWarmedKeys(next);
  }, []);

  const queueWarmedKeys = useCallback(
    (updates: Iterable<readonly [string, WarmState | null]>) => {
      for (const [key, state] of updates) {
        pendingWarmRef.current.set(key, state);
      }
      if (pendingWarmRef.current.size > 0 && warmFlushFrameRef.current === null) {
        warmFlushFrameRef.current = requestAnimationFrame(flushWarmedKeys);
      }
    },
    [flushWarmedKeys]
  );

  const dropWarmedKeys = useCallback(
    (keys: readonly string[]) => {
      queueWarmedKeys(keys.map((key) => [key, null] as const));
    },
    [queueWarmedKeys]
  );

  useEffect(() => {
    // A hidden tab stops firing `requestAnimationFrame`, so a transition queued just before the
    // switch would sit there until the user came back. Invisible while hidden, but a dropped
    // transition leaves a cell stuck on `warming` for good, which is the one failure mode here that
    // a user would notice.
    const flushNow = () => {
      if (warmFlushFrameRef.current !== null) {
        cancelAnimationFrame(warmFlushFrameRef.current);
        warmFlushFrameRef.current = null;
      }
      flushWarmedKeys();
    };
    document.addEventListener("visibilitychange", flushNow);
    return () => {
      document.removeEventListener("visibilitychange", flushNow);
      flushNow();
    };
  }, [flushWarmedKeys]);

  dropWarmedKeysRef.current = dropWarmedKeys;

  const isCacheKeyInUse = useCallback(
    (cacheKey: string) =>
      Array.from(routeByCellRef.current.values()).some((route) => route.cacheKey === cacheKey),
    []
  );

  const warmMedia = useCallback(
    async (target: WarmupTarget, runId: number) => {
      const { mediaId, cacheKey } = target;
      // Queued, not written: the pair of transitions this function makes is separated by an
      // `await`, so React cannot batch them and each one used to re-render the whole shell.
      if (!warmedKeysRef.current[cacheKey] && !pendingWarmRef.current.has(cacheKey)) {
        queueWarmedKeys([[cacheKey, "warming"]]);
      }
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
      // A key the queue no longer tracks and the state does not hold was dropped while this decode
      // was in flight — by a panel switch or a purge — and must not be revived.
      const tracked =
        cacheKey in warmedKeysRef.current || pendingWarmRef.current.get(cacheKey) !== undefined;
      if (!tracked) {
        return;
      }
      queueWarmedKeys([[cacheKey, entry ? "ready" : null]]);
    },
    [dropWarmedKeys, isCacheKeyInUse, loadPlaybackEntry, queueWarmedKeys]
  );

  const stopCellKey = useCallback(
    (cellKey: string) => {
      bumpCellToken(cellKey);
      const route = routeByCellRef.current.get(cellKey);
      if (route) {
        stopRoute(route);
        routeByCellRef.current.delete(cellKey);
        syncLiveSegments();
      }
      // A stopped pad must not keep the marker where it stopped.
      clearProgress(cellKey);
      syncPlayingCells(playingCellsRef.current.filter((key) => key !== cellKey));
    },
    [bumpCellToken, syncLiveSegments, syncPlayingCells]
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
      const now = performance.now();
      // Progress reaches the DOM at the same 20 Hz it reached React at, deliberately: this is a
      // pure performance change and the visible cadence must be identical, so any difference is a
      // regression rather than a design decision. Raising it is a separate question with its own
      // measurement.
      const writeProgressNow = now - lastProgressPushRef.current >= PROGRESS_PUSH_INTERVAL_MS;
      const nextPlayingCells = current.flatMap((cellKey) => {
        const route = routeByCellRef.current.get(cellKey);
        if (!route) {
          return [];
        }
        const gridCell = cellByKeyRef.current.get(cellKey);
        if (!gridCell) {
          return [cellKey];
        }

        const currentSeconds =
          route.mode === "media" && route.audio
            ? route.audio.currentTime
            : route.offsetSeconds + (route.context.currentTime - route.startedAtContextTime);
        // The combined value, still needed by the media-element route below — it has its own
        // context and destination, so the shared master bus cannot reach it.
        const baseVolume = masterMutedRef.current
          ? 0
          : getEffectiveVolume(masterVolumeRef.current, gridCell.volumeOffset);
        if (route.mode === "media") {
          setRouteVolume(route, baseVolume);
        }

        if (route.mode === "media" && route.audio && currentSeconds >= route.endSeconds) {
          if (gridCell.playbackMode === "loop") {
            route.audio.currentTime = getTrimStartSeconds(gridCell);
            scheduleEnvelope(route.envelopeGain, gridCell, route.audio.currentTime, route.endSeconds);
          } else {
            endedCellKeys.push(cellKey);
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
          endedCellKeys.push(cellKey);
          return [];
        }

        if (writeProgressNow) {
          const range = Math.max(0.1, route.endSeconds - route.offsetSeconds);
          writeProgress(
            cellKey,
            Math.min(1, Math.max(0, (currentSeconds - route.offsetSeconds) / range))
          );
        }
        return [cellKey];
      });

      if (writeProgressNow) {
        lastProgressPushRef.current = now;
      }
      // Membership is the only thing React still hears about, and it changes on a press.
      syncPlayingCells(nextPlayingCells);
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
  const playingCellKeySignature = playingCells.join("|");
  useEffect(() => {
    playbackBufferCache.setPinned(
      Array.from(routeByCellRef.current.values()).map((route) => route.cacheKey)
    );
  }, [playingCellKeySignature]);

  const addPlayingCell = useCallback(
    (cellKey: string) => {
      // Reset before the first frame, so a re-triggered pad never shows the previous cue's tail.
      writeProgress(cellKey, 0);
      syncPlayingCells([...playingCellsRef.current.filter((key) => key !== cellKey), cellKey]);
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
      addPlayingCell(cellKey);
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
   * Continues an audible cue whose next segment could not be decoded, using the full decode.
   *
   * The rule this enforces is the pair of the one `planMediaSegments` enforces. That one says a cue
   * that cannot be continued must never be STARTED; this one says a cue that has been started must
   * never be DROPPED. Before it, a single failed range read ended the cue at whatever had already
   * been scheduled — most visibly the 0.5 s head, which is what a user reports as "the pad plays
   * half a second and stops". Silence is the one outcome worse than any amount of memory.
   *
   * Cost, stated rather than hidden: the whole file is decoded, and the tail of the window is
   * copied out of it — the same price the app paid for every cue before byte-range decoding
   * existed. It is paid only on a path that would otherwise have produced silence, and
   * `partial.segments.recovered` counts every time it happens, because a recovered cue sounds
   * nearly right and would otherwise hide a range path that had stopped working.
   *
   * The resume position is derived from the clock AFTER the decode, and scheduled no earlier than
   * the handoff the outgoing segment is already stopping at: earlier would overlap two sources on
   * one gain, later would leave a hole longer than the failure itself.
   */
  const recoverRouteFromFullDecode = useCallback(
    async (input: {
      route: AudioRoute;
      cellKey: string;
      mediaId: string;
      mono: boolean;
      t0: number;
      windowStartSeconds: number;
      windowEndSeconds: number;
      isStale: () => boolean;
    }): Promise<boolean> => {
      const { route, cellKey, isStale } = input;
      const context = route.context;

      const full = await getFullBuffer(input.mediaId);
      if (!full || isStale()) {
        return false;
      }

      let at = context.currentTime + SCHEDULE_LEAD_SECONDS;
      for (const segment of route.segments) {
        if (segment.stopAtContextTime !== null && segment.stopAtContextTime > at) {
          at = segment.stopAtContextTime;
        }
      }
      const resumeSeconds = input.windowStartSeconds + (at - input.t0);
      if (resumeSeconds >= input.windowEndSeconds) {
        // Nothing of the window is left to play, so there is nothing to recover: the cue is simply
        // over, and the caller ends it the ordinary way.
        return false;
      }

      // Sliced rather than played whole: the source must start at the resume position with the
      // window's own end, and holding the entire track on the route would undo the bound the
      // segments exist for. `mono` comes from the plan captured at press time, so the tail cannot
      // change channel count mid-cue.
      const tail = sliceToAudioBuffer(full, {
        startSeconds: resumeSeconds,
        endSeconds: input.windowEndSeconds,
        mono: input.mono
      });
      if (isStale()) {
        return false;
      }

      const source = context.createBufferSource();
      source.buffer = tail;
      source.connect(route.envelopeGain);
      const segment: RouteSegment = {
        source,
        startSeconds: resumeSeconds,
        endSeconds: input.windowEndSeconds,
        atContextTime: at,
        isLast: true,
        stopAtContextTime: null
      };
      for (const finished of listFinishedSegments(route.segments, context.currentTime)) {
        finished.source.disconnect();
      }
      pruneFinishedSegments(route.segments, context.currentTime);
      route.segments.push(segment);
      syncLiveSegments();

      source.onended = () => {
        if (isStale()) {
          return;
        }
        stopCellKey(cellKey);
      };
      // Offset 0: the slice already begins at the resume position.
      source.start(at, 0);
      recordSegment("recovered");
      return true;
    },
    [getFullBuffer, stopCellKey, syncLiveSegments]
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
            result = await decodeMediaRange(
              {
                mediaId: partial.mediaId,
                startSeconds: planned.startSeconds,
                endSeconds: planned.bufferEndSeconds,
                mono: partial.mono
              },
              // The cue is audible and the head is 0.5 s long: this decode has a deadline, and the
              // background lane is where a whole-file warm-up decode sits for seconds.
              "live"
            );
          } catch {
            result = null;
          }
          if (isStale()) {
            return;
          }
          if (!result) {
            // A range read that failed is not a reason to stop audio the user is listening to. The
            // full decode still works — it is what every cue used before this feature — so the cue
            // continues from where the clock is now, with a dropout as long as the failure.
            const recovered = await recoverRouteFromFullDecode({
              route,
              cellKey,
              mediaId: partial.mediaId,
              mono: partial.mono,
              t0,
              windowStartSeconds: input.windowStartSeconds,
              windowEndSeconds: input.windowEndSeconds,
              isStale
            });
            if (isStale()) {
              return;
            }
            if (!recovered) {
              // Even the full decode could not produce audio, or the window had already run out.
              // End the cue the way an ordinary cue ends rather than leaving a route with no live
              // source.
              recordSegment("missed");
              promoteToLast(route, cellKey, token);
            }
            return;
          }

          const resolution = resolveLateSegment({
            scheduledAtSeconds: at,
            nowSeconds: context.currentTime,
            // The segment's OWN length, not a fixed 0.25 s. Lateness within it is played as a
            // dropout — the segment resumes at its correct source position — and only a segment
            // whose audio is entirely in the past has nothing left to schedule. The fixed limit
            // meant a chain that lost a quarter of a second to a busy decoder ended the cue,
            // which on a warming panel is the common case rather than the rare one.
            maxLatenessSeconds: Math.max(0, planned.endSeconds - planned.startSeconds)
          });
          if (resolution.action === "give-up") {
            recordSegment("missed");
            if (index < segments.length - 1) {
              // Skip it and keep the chain: the hole is this segment, not the rest of the track.
              continue;
            }
            // It was the last one, so nothing after it would ever fire `onended` and end the cue.
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
          // Structural half of the bound: `onended` is not guaranteed across an iOS audio
          // interruption, which is the session where a cue runs long enough for this to matter.
          //
          // Disconnected as well as dropped. Removing the entry is not enough on its own: the node
          // stays wired to `envelopeGain`, so the graph keeps it and its buffer reachable, and
          // `route.segments` - the only list `stopRoute` walks - no longer names it. On the exact
          // path this prune exists for, that put every segment of the cue back into memory.
          for (const finished of listFinishedSegments(route.segments, context.currentTime)) {
            finished.source.disconnect();
          }
          pruneFinishedSegments(route.segments, context.currentTime);
          route.segments.push(segment);
          syncLiveSegments();

          source.onended = () => {
            if (isStale()) {
              return;
            }
            if (!segment.isLast) {
              source.disconnect();
              // Releases the segment's PCM. Disconnecting the node is not enough: the entry stayed
              // in `route.segments`, and a source keeps its `buffer` reachable.
              dropSegment(route.segments, segment);
              syncLiveSegments();
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
    [promoteToLast, recoverRouteFromFullDecode, stopCellKey, syncLiveSegments]
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
      // The cell term ONLY. Master volume and mute are carried by the shared bus this route
      // connects into, and `volume.ts` pins that the split reproduces the combined value exactly —
      // including a +300 % boost, which must keep working.
      const baseVolume = getCellGainValue(cell.volumeOffset);

      source.buffer = buffer;
      source.connect(envelopeGain);
      envelopeGain.connect(volumeGain);
      // Into the shared master bus, not straight to the destination: master volume and mute live on
      // one node now, so a change is one write instead of one per playing route per frame.
      volumeGain.connect(getMasterGain(context));
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
          // The head of a streamed route, finished and handed off. Same reason as in the chain:
          // the node keeps its buffer reachable until the entry goes.
          dropSegment(route.segments, segment);
          syncLiveSegments();
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

        addPlayingCell(cellKey);
        return true;
      }

      source.start(0, startSeconds - entry.sliceStartSeconds, playDurationSeconds);
      addPlayingCell(cellKey);
      return true;
    },
    // No `masterVolume` or `masterMuted` here any more: this route only ever writes the CELL term,
    // and the shared master node carries the rest. Dropping them stops `startBufferRoute` — and
    // through it `playCell` and the global hotkey listener — from being rebuilt on every tick of the
    // volume slider.
    [addPlayingCell, getContext, getMasterGain, runSegmentChain, stopCellKey, syncLiveSegments]
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
        // The live lane: this decode is what the user is waiting to hear, and the background lane
        // may be full of warm-up work for cells nobody has touched.
        const entry = await loadPlaybackEntry(cell, cell.mediaId, cacheKey, "live");
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
                  mono: monoPlayback,
                  loop: cell.playbackMode === "loop"
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
      queueWarmedKeys(readyKeys.map((key) => [key, "ready"] as const));
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
      const asset = mediaByIdRef.current.get(target.mediaId);
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
          // decode plus a transient allocation spike, for nothing. Measured against what will
          // actually be CACHED — a streamed cell keeps only its head; see `estimateWarmBytes`.
          const asset = mediaByIdRef.current.get(target.mediaId);
          const estimate = estimateWarmBytes(
            target.cell,
            asset?.durationMs ?? null,
            monoRef.current,
            getEngineSampleRate()
          );
          // `stats()` walks every entry three times and allocates a Set each time. The budget is
          // null on every device by default, so this used to be pure waste on the warm-up hot path
          // for every user — computed, then discarded by the very next line.
          const budgetBytes = playbackBufferCache.budgetBytes();
          const stats = budgetBytes === null ? null : playbackBufferCache.stats();
          // Measured against what eviction may NOT touch — the active panel plus anything a live
          // route is using — rather than against everything cached. Other panels' buffers are
          // evictable, so counting them here would make the panel the user is actually looking at
          // refuse to warm in order to protect one they left.
          //
          // No margin below the budget: the estimate already errs high, because the channel count
          // is unknown before decoding and stereo is assumed.
          const unavoidableBytes = (stats?.protectedBytes ?? 0) + reservedBytes;
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

          // A cue that reads any frame other than the first needs the decoder offset measured
          // before that range can be decoded at all, and measuring costs two short decodes — so it
          // happens here, in the warm-up, and only for the cells that actually need it.
          //
          // Two ways to need it, and gating on the first alone broke the second. A TRIMMED cue
          // starts mid-file, which is obvious. An UNTRIMMED long track starts at byte 0 and needs
          // nothing for its head — but every segment after the head starts mid-file, so
          // `decodeMp3Range` refused all of them, `promoteToLast` ended the cue at the head, and a
          // three-minute track played 0.5 seconds and went silent. Invisible until the container
          // duration fix made untrimmed MP3s reach the streaming path at all.
          if (needsAlignmentMeasurement(target.cell, asset?.durationMs ?? null)) {
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
  }, [decodeFullBuffer, queueWarmedKeys, warmupSignature, warmMedia]);

  /**
   * A purge must also drop the matching warm state: a stale "ready" entry would suppress the
   * re-warm and the cell would never show its ready animation again.
   */
  useEffect(
    () =>
      onMediaCachePurge((mediaIds) => {
        purgeGenerationRef.current += 1;

        // The queue is emptied first, and this write is direct rather than queued. A purge is the
        // one case that must not be overtaken: a buffered `ready` for media that no longer exists
        // would land a frame later and light up a cell whose PCM and blob are both gone.
        if (mediaIds === null) {
          pendingWarmRef.current.clear();
        } else {
          for (const key of [...pendingWarmRef.current.keys()]) {
            if (mediaIds.includes(getMediaIdFromKey(key))) {
              pendingWarmRef.current.delete(key);
            }
          }
        }

        const current = warmedKeysRef.current;
        let purged: Record<string, WarmState> = current;
        if (mediaIds === null) {
          purged = {};
        } else {
          const dropped = new Set(mediaIds);
          purged = Object.fromEntries(
            Object.entries(current).filter(([key]) => !dropped.has(getMediaIdFromKey(key)))
          );
        }
        if (Object.keys(purged).length !== Object.keys(current).length) {
          warmedKeysRef.current = purged;
          setWarmedKeys(purged);
        }

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
    // One write for master and mute, on one node.
    const master = masterGainRef.current;
    if (master) {
      master.gain.setValueAtTime(
        getMasterGainValue(masterVolume, masterMuted),
        master.context.currentTime
      );
    }
    routeByCellRef.current.forEach((route, cellId) => {
      const cell = cellByKeyRef.current.get(cellId);
      if (route.mode === "media") {
        // No shared bus on this path; it keeps the combined value.
        setRouteVolume(route, masterMuted ? 0 : getEffectiveVolume(masterVolume, cell?.volumeOffset ?? 0));
        return;
      }
      setRouteVolume(route, getCellGainValue(cell?.volumeOffset ?? 0));
    });
  }, [cells, masterMuted, masterVolume, panelId]);

  useEffect(() => {
    routeByCellRef.current.forEach((route, cellId) => {
      const cell = cellByKeyRef.current.get(cellId);
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

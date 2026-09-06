import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { GridCell } from "../../../entities/cell/model/types";
import { MediaAsset } from "../../../entities/media/model/types";
import { getMediaBlob } from "../../../app/model/appState";
import {
  markEnd,
  markStart,
  recordDecode,
  recordPanelSwitchEngine,
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
import { decodeAudioBlob, shouldSliceBuffer, sliceToAudioBuffer } from "./decodeAudio";
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

type AudioRoute = {
  mode: "buffer" | "media";
  context: AudioContext;
  envelopeGain: GainNode;
  volumeGain: GainNode;
  lastVolume: number;
  source?: AudioBufferSourceNode;
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

  if (route.source) {
    try {
      route.source.stop(now + RELEASE_SECONDS);
    } catch {
      // The source may already be stopped by the browser.
    }
  }

  if (route.audio) {
    route.audio.pause();
  }

  window.setTimeout(() => {
    route.source?.disconnect();
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
    [getFullBuffer]
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
      scheduleEnvelope(envelopeGain, cell, startSeconds, endSeconds);

      const route: AudioRoute = {
        mode: "buffer",
        context,
        envelopeGain,
        volumeGain,
        lastVolume: baseVolume,
        source,
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
        if (cell.playbackMode === "loop") {
          // An AudioBufferSourceNode cannot be restarted, so a loop must build a new one. The
          // gains it fed are finished as well; disconnecting them releases the chain
          // deterministically instead of leaving it to the collector.
          source.disconnect();
          envelopeGain.disconnect();
          volumeGain.disconnect();
          startBufferRoute(cell, mediaAsset, entry, token, cellKey, cacheKey);
          return;
        }
        stopCellKey(cellKey);
      };
      // Buffer time, not source time: a sliced buffer starts at `sliceStartSeconds`.
      source.start(0, startSeconds - entry.sliceStartSeconds, playDurationSeconds);
      addPlayingCell({ cellKey, mediaId: mediaAsset.id, progress: 0 });
      return true;
    },
    [addPlayingCell, getContext, masterMuted, masterVolume, stopCellKey]
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
    const pendingByMedia = new Map<string, number>();
    for (const target of uniqueTargets) {
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

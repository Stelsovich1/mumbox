import { useCallback, useEffect, useRef, useState } from "react";

import { GridCell } from "../../../entities/cell/model/types";
import { MediaAsset } from "../../../entities/media/model/types";
import { getMediaBlob } from "../../../app/model/appState";
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

type WarmedMediaState = {
  mediaId: string;
  state: "warming" | "ready";
};

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
};

const RELEASE_SECONDS = 0.018;
const PROGRESS_EPSILON = 0.001;

function isMediaId(value: string | null): value is string {
  return Boolean(value);
}

function getCellKey(panelId: string, cellId: string) {
  return `${panelId}:${cellId}`;
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

async function decodeAudioBlob(blob: Blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const context = new OfflineAudioContext(1, 1, 44_100);
  return context.decodeAudioData(arrayBuffer);
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
  stopOthers: boolean
) {
  const contextRef = useRef<AudioContext | null>(null);
  const bufferByMediaRef = useRef(new Map<string, Promise<AudioBuffer | null>>());
  const routeByCellRef = useRef(new Map<string, AudioRoute>());
  const playTokenByCellRef = useRef(new Map<string, number>());
  const cellsRef = useRef(cells);
  const panelIdRef = useRef(panelId);
  const masterVolumeRef = useRef(masterVolume);
  const masterMutedRef = useRef(masterMuted);
  const warmupRunRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const playingCellsRef = useRef<PlayingCell[]>([]);
  const [playingCells, setPlayingCells] = useState<PlayingCell[]>([]);
  const [warmedMedia, setWarmedMedia] = useState<WarmedMediaState[]>([]);

  useEffect(() => {
    cellsRef.current = cells;
  }, [cells]);

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

  const loadAudioBuffer = useCallback(
    (mediaId: string) => {
      const cached = bufferByMediaRef.current.get(mediaId);
      if (cached) {
        return cached;
      }

      const promise = getMediaBlob(mediaId)
        .then(async (blob) => {
          if (!blob) {
            return null;
          }
          return decodeAudioBlob(blob);
        })
        .catch(() => null);

      bufferByMediaRef.current.set(mediaId, promise);
      return promise;
    },
    []
  );

  const warmMedia = useCallback(
    async (mediaId: string) => {
      setWarmedMedia((current) => {
        if (current.some((item) => item.mediaId === mediaId)) {
          return current;
        }
        return [...current, { mediaId, state: "warming" }];
      });
      const buffer = await loadAudioBuffer(mediaId);
      setWarmedMedia((current) => {
        if (!current.some((item) => item.mediaId === mediaId)) {
          return current;
        }
        if (!buffer) {
          return current.filter((item) => item.mediaId !== mediaId);
        }
        return current.map((item) =>
          item.mediaId === mediaId
            ? {
                ...item,
                state: "ready"
              }
            : item
        );
      });
    },
    [loadAudioBuffer]
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
        bufferDurationSeconds: durationSeconds || audio.duration || 10
      };

      routeByCellRef.current.set(cellKey, route);
      audio.addEventListener("ended", () => {
        if (playTokenByCellRef.current.get(cellKey) !== token) {
          return;
        }
        if (cell.playbackMode === "loop") {
          void startMediaElementFallback(cell, mediaAsset, blob, token, cellKey);
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
    [addPlayingCell, masterMuted, masterVolume, stopCellKey]
  );

  const startBufferRoute = useCallback(
    (cell: GridCell, mediaAsset: MediaAsset, buffer: AudioBuffer, token: number, cellKey: string) => {
      if (playTokenByCellRef.current.get(cellKey) !== token) {
        return;
      }

      const context = getContext();
      const { startSeconds, endSeconds } = getClampedPlaybackRange(cell, buffer.duration);
      const playDurationSeconds = endSeconds - startSeconds;
      if (playDurationSeconds <= 0.001) {
        stopCellKey(cellKey);
        return;
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
        bufferDurationSeconds: buffer.duration
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
          startBufferRoute(cell, mediaAsset, buffer, token, cellKey);
          return;
        }
        stopCellKey(cellKey);
      };
      source.start(0, startSeconds, playDurationSeconds);
      addPlayingCell({ cellKey, mediaId: mediaAsset.id, progress: 0 });
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

      if (stopOthers) {
        stopAll();
      } else {
        stopCellKey(cellKey);
      }
      const token = bumpCellToken(cellKey);

      const context = await getPlayableContext();

      const canUseBufferSource = typeof context.createBufferSource === "function";
      if (canUseBufferSource) {
        const buffer = await loadAudioBuffer(cell.mediaId);
        if (!buffer || playTokenByCellRef.current.get(cellKey) !== token) {
          return;
        }
        startBufferRoute(cell, mediaAsset, buffer, token, cellKey);
        return;
      }

      const blob = await getMediaBlob(cell.mediaId);
      if (!blob || playTokenByCellRef.current.get(cellKey) !== token) {
        return;
      }
      await startMediaElementFallback(cell, mediaAsset, blob, token, cellKey);
    },
    [
      bumpCellToken,
      getPlayableContext,
      loadAudioBuffer,
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

  useEffect(() => {
    const runId = warmupRunRef.current + 1;
    warmupRunRef.current = runId;
    const mediaIds = Array.from(new Set(cells.map((cell) => cell.mediaId).filter(isMediaId)));

    void (async () => {
      for (const mediaId of mediaIds) {
        if (warmupRunRef.current !== runId) {
          return;
        }
        if (bufferByMediaRef.current.has(mediaId)) {
          setWarmedMedia((current) => {
            if (current.some((item) => item.mediaId === mediaId)) {
              return current;
            }
            return [...current, { mediaId, state: "ready" }];
          });
          continue;
        }
        await warmMedia(mediaId);
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, 70);
        });
      }
    })();
  }, [cells, warmMedia]);

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

  return { playingCells, warmedMedia, playCell, toggleCell, stopCell, stopAll, isCellPlaying };
}

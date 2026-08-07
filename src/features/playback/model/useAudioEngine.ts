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
  cellId: string;
  mediaId: string;
  progress: number;
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

function getEffectiveVolume(masterVolume: number, cellVolumeOffset: number) {
  const normalizedMaster = masterVolume / 100;
  const offsetMultiplier = 1 + cellVolumeOffset / 100;
  return Math.min(2, Math.max(0, normalizedMaster * offsetMultiplier));
}

function getHtmlAudioVolume(volume: number) {
  return Math.min(1, Math.max(0, volume));
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
  const frameRef = useRef<number | null>(null);
  const [playingCells, setPlayingCells] = useState<PlayingCell[]>([]);

  useEffect(() => {
    cellsRef.current = cells;
  }, [cells]);

  const getContext = useCallback(() => {
    const current = contextRef.current;
    if (current && current.state !== "closed") {
      return current;
    }
    const context = new AudioContext();
    contextRef.current = context;
    return context;
  }, []);

  const bumpCellToken = useCallback((cellId: string) => {
    const nextToken = (playTokenByCellRef.current.get(cellId) ?? 0) + 1;
    playTokenByCellRef.current.set(cellId, nextToken);
    return nextToken;
  }, []);

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
          const context = getContext();
          return context.decodeAudioData(await blob.arrayBuffer());
        })
        .catch(() => null);

      bufferByMediaRef.current.set(mediaId, promise);
      return promise;
    },
    [getContext]
  );

  const stopCell = useCallback(
    (cellId: string) => {
      bumpCellToken(cellId);
      const route = routeByCellRef.current.get(cellId);
      if (route) {
        stopRoute(route);
        routeByCellRef.current.delete(cellId);
      }
      setPlayingCells((current) => current.filter((cell) => cell.cellId !== cellId));
    },
    [bumpCellToken]
  );

  const stopAll = useCallback(() => {
    Array.from(routeByCellRef.current.keys()).forEach((cellId) => {
      stopCell(cellId);
    });
  }, [stopCell]);

  const isCellPlaying = useCallback((cellId: string) => routeByCellRef.current.has(cellId), []);

  const startMediaElementFallback = useCallback(
    async (cell: GridCell, mediaAsset: MediaAsset, blob: Blob, token: number) => {
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

      routeByCellRef.current.set(cell.id, route);
      audio.addEventListener("ended", () => {
        if (playTokenByCellRef.current.get(cell.id) !== token) {
          return;
        }
        if (cell.playbackMode === "loop") {
          void startMediaElementFallback(cell, mediaAsset, blob, token);
          return;
        }
        stopCell(cell.id);
      });
      if (context.state === "suspended") {
        await context.resume();
      }
      setPlayingCells((current) => [
        ...current.filter((playing) => playing.cellId !== cell.id),
        { cellId: cell.id, mediaId: mediaAsset.id, progress: 0 }
      ]);
      await audio.play();
    },
    [masterMuted, masterVolume, stopCell]
  );

  const startBufferRoute = useCallback(
    (cell: GridCell, mediaAsset: MediaAsset, buffer: AudioBuffer, token: number) => {
      if (playTokenByCellRef.current.get(cell.id) !== token) {
        return;
      }

      const context = getContext();
      const { startSeconds, endSeconds } = getClampedPlaybackRange(cell, buffer.duration);
      const playDurationSeconds = endSeconds - startSeconds;
      if (playDurationSeconds <= 0.001) {
        stopCell(cell.id);
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

      routeByCellRef.current.set(cell.id, route);
      source.onended = () => {
        if (routeByCellRef.current.get(cell.id) !== route) {
          return;
        }
        if (playTokenByCellRef.current.get(cell.id) !== token) {
          return;
        }
        if (cell.playbackMode === "loop") {
          startBufferRoute(cell, mediaAsset, buffer, token);
          return;
        }
        stopCell(cell.id);
      };
      source.start(0, startSeconds, playDurationSeconds);
      setPlayingCells((current) => [
        ...current.filter((playing) => playing.cellId !== cell.id),
        { cellId: cell.id, mediaId: mediaAsset.id, progress: 0 }
      ]);
    },
    [getContext, masterMuted, masterVolume, stopCell]
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

      if (stopOthers) {
        stopAll();
      } else {
        stopCell(cell.id);
      }
      const token = bumpCellToken(cell.id);

      const context = getContext();
      if (context.state === "suspended") {
        await context.resume();
      }

      const canUseBufferSource = typeof context.createBufferSource === "function";
      if (canUseBufferSource) {
        const buffer = await loadAudioBuffer(cell.mediaId);
        if (!buffer || playTokenByCellRef.current.get(cell.id) !== token) {
          return;
        }
        startBufferRoute(cell, mediaAsset, buffer, token);
        return;
      }

      const blob = await getMediaBlob(cell.mediaId);
      if (!blob || playTokenByCellRef.current.get(cell.id) !== token) {
        return;
      }
      await startMediaElementFallback(cell, mediaAsset, blob, token);
    },
    [
      bumpCellToken,
      getContext,
      loadAudioBuffer,
      media,
      startBufferRoute,
      startMediaElementFallback,
      stopAll,
      stopCell,
      stopOthers
    ]
  );

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
    routeByCellRef.current.forEach((route, cellId) => {
      const cell = cellsRef.current.find((candidate) => candidate.id === cellId);
      const nextVolume = masterMuted ? 0 : getEffectiveVolume(masterVolume, cell?.volumeOffset ?? 0);
      setRouteVolume(route, nextVolume);
    });
  }, [cells, masterMuted, masterVolume]);

  useEffect(() => {
    routeByCellRef.current.forEach((route, cellId) => {
      const cell = cellsRef.current.find((candidate) => candidate.id === cellId);
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
  }, [cells]);

  useEffect(() => {
    const tick = () => {
      setPlayingCells((current) =>
        current.map((cell) => {
          const route = routeByCellRef.current.get(cell.cellId);
          if (!route) {
            return cell;
          }
          const gridCell = cellsRef.current.find((candidate) => candidate.id === cell.cellId);
          if (!gridCell) {
            return cell;
          }

          const currentSeconds =
            route.mode === "media" && route.audio
              ? route.audio.currentTime
              : route.offsetSeconds + (route.context.currentTime - route.startedAtContextTime);
          const baseVolume = masterMuted ? 0 : getEffectiveVolume(masterVolume, gridCell.volumeOffset);
          setRouteVolume(route, baseVolume);

          if (route.mode === "media" && route.audio && currentSeconds >= route.endSeconds) {
            if (gridCell.playbackMode === "loop") {
              route.audio.currentTime = getTrimStartSeconds(gridCell);
              scheduleEnvelope(route.envelopeGain, gridCell, route.audio.currentTime, route.endSeconds);
            } else {
              stopCell(gridCell.id);
            }
          }

          if (route.mode === "media" && route.audio) {
            route.audio.volume = getHtmlAudioVolume(
              baseVolume * getEnvelopeValue(gridCell, currentSeconds, route.endSeconds)
            );
          }

          const range = Math.max(0.1, route.endSeconds - route.offsetSeconds);
          return {
            ...cell,
            progress: Math.min(1, Math.max(0, (currentSeconds - route.offsetSeconds) / range))
          };
        })
      );
      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, [masterMuted, masterVolume, stopCell]);

  useEffect(
    () => () => {
      stopAll();
      void contextRef.current?.close();
      contextRef.current = null;
    },
    [stopAll]
  );

  return { playingCells, playCell, toggleCell, stopCell, stopAll, isCellPlaying };
}

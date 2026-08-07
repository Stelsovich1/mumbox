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
  context: AudioContext;
  envelopeGain: GainNode;
  volumeGain: GainNode;
  lastVolume: number;
};

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

export function useAudioEngine(
  media: MediaAsset[],
  cells: GridCell[],
  masterVolume: number,
  masterMuted: boolean,
  stopOthers: boolean
) {
  const audioByCellRef = useRef(new Map<string, HTMLAudioElement>());
  const urlByCellRef = useRef(new Map<string, string>());
  const routeByCellRef = useRef(new Map<string, AudioRoute>());
  const cellsRef = useRef(cells);
  const frameRef = useRef<number | null>(null);
  const [playingCells, setPlayingCells] = useState<PlayingCell[]>([]);

  useEffect(() => {
    cellsRef.current = cells;
  }, [cells]);

  const stopCell = useCallback((cellId: string) => {
    const audio = audioByCellRef.current.get(cellId);
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
      audioByCellRef.current.delete(cellId);
    }
    const route = routeByCellRef.current.get(cellId);
    if (route) {
      void route.context.close();
      routeByCellRef.current.delete(cellId);
    }
    const url = urlByCellRef.current.get(cellId);
    if (url) {
      URL.revokeObjectURL(url);
      urlByCellRef.current.delete(cellId);
    }
    setPlayingCells((current) => current.filter((cell) => cell.cellId !== cellId));
  }, []);

  const stopAll = useCallback(() => {
    Array.from(audioByCellRef.current.keys()).forEach((cellId) => {
      stopCell(cellId);
    });
  }, [stopCell]);

  const isCellPlaying = useCallback((cellId: string) => audioByCellRef.current.has(cellId), []);

  const playCell = useCallback(
    async (cell: GridCell) => {
      if (!cell.mediaId) {
        return;
      }
      const mediaAsset = media.find((candidate) => candidate.id === cell.mediaId);
      const blob = await getMediaBlob(cell.mediaId);
      if (!mediaAsset || !blob) {
        return;
      }

      if (stopOthers) {
        stopAll();
      } else {
        stopCell(cell.id);
      }

      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.loop = false;
      const baseVolume = masterMuted ? 0 : getEffectiveVolume(masterVolume, cell.volumeOffset);
      audio.volume = getHtmlAudioVolume(baseVolume);
      audio.currentTime = getTrimStartSeconds(cell);
      try {
        const context = new AudioContext();
        const source = context.createMediaElementSource(audio);
        const envelopeGain = context.createGain();
        const volumeGain = context.createGain();
        source.connect(envelopeGain);
        envelopeGain.connect(volumeGain);
        volumeGain.connect(context.destination);
        audio.volume = 1;
        volumeGain.gain.setValueAtTime(baseVolume, context.currentTime);
        scheduleEnvelope(
          envelopeGain,
          cell,
          getTrimStartSeconds(cell),
          getTrimEndSeconds(cell, audio.duration || (mediaAsset.durationMs ?? 0) / 1000)
        );
        if (context.state === "suspended") {
          void context.resume();
        }
        routeByCellRef.current.set(cell.id, { context, envelopeGain, volumeGain, lastVolume: baseVolume });
      } catch {
        audio.volume = getHtmlAudioVolume(baseVolume);
      }
      audioByCellRef.current.set(cell.id, audio);
      urlByCellRef.current.set(cell.id, url);
      audio.addEventListener("ended", () => {
        if (cell.playbackMode === "loop") {
          const startTime = getTrimStartSeconds(cell);
          const endTime = getTrimEndSeconds(cell, audio.duration);
          audio.currentTime = startTime;
          const route = routeByCellRef.current.get(cell.id);
          if (route) {
            setRouteVolume(route, masterMuted ? 0 : getEffectiveVolume(masterVolume, cell.volumeOffset));
            scheduleEnvelope(route.envelopeGain, cell, startTime, endTime);
          }
          void audio.play();
          return;
        }
        stopCell(cell.id);
      });
      setPlayingCells((current) => [
        ...current.filter((playing) => playing.cellId !== cell.id),
        { cellId: cell.id, mediaId: mediaAsset.id, progress: 0 }
      ]);
      await audio.play();
    },
    [masterMuted, masterVolume, media, stopAll, stopCell, stopOthers]
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
    audioByCellRef.current.forEach((audio, cellId) => {
      const cell = cellsRef.current.find((candidate) => candidate.id === cellId);
      const route = routeByCellRef.current.get(cellId);
      const nextVolume = masterMuted ? 0 : getEffectiveVolume(masterVolume, cell?.volumeOffset ?? 0);
      if (route && cell) {
        setRouteVolume(route, nextVolume);
        return;
      }
      audio.volume = getHtmlAudioVolume(nextVolume);
    });
  }, [cells, masterMuted, masterVolume]);

  useEffect(() => {
    audioByCellRef.current.forEach((audio, cellId) => {
      const cell = cellsRef.current.find((candidate) => candidate.id === cellId);
      const route = routeByCellRef.current.get(cellId);
      if (route && cell && audio.duration && !Number.isNaN(audio.duration)) {
        scheduleEnvelope(route.envelopeGain, cell, audio.currentTime, getTrimEndSeconds(cell, audio.duration));
      }
    });
  }, [cells]);

  useEffect(() => {
    const tick = () => {
      setPlayingCells((current) =>
        current.map((cell) => {
          const audio = audioByCellRef.current.get(cell.cellId);
          if (!audio?.duration || Number.isNaN(audio.duration)) {
            return cell;
          }
          const gridCell = cellsRef.current.find((candidate) => candidate.id === cell.cellId);
          if (!gridCell) {
            return cell;
          }
          const startTime = getTrimStartSeconds(gridCell);
          const endTime = getTrimEndSeconds(gridCell, audio.duration);
          const baseVolume = masterMuted ? 0 : getEffectiveVolume(masterVolume, gridCell.volumeOffset);
          if (audio.currentTime >= endTime) {
            if (gridCell.playbackMode === "loop") {
              audio.currentTime = startTime;
              const route = routeByCellRef.current.get(gridCell.id);
              if (route) {
                setRouteVolume(route, baseVolume);
                scheduleEnvelope(route.envelopeGain, gridCell, startTime, endTime);
              }
            } else {
              stopCell(gridCell.id);
            }
          }
          const route = routeByCellRef.current.get(gridCell.id);
          if (!route) {
            audio.volume = getHtmlAudioVolume(
              baseVolume * getEnvelopeValue(gridCell, audio.currentTime, endTime)
            );
          } else {
            setRouteVolume(route, baseVolume);
          }
          const range = Math.max(0.1, endTime - startTime);
          return {
            ...cell,
            progress: Math.min(1, Math.max(0, (audio.currentTime - startTime) / range))
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
    },
    [stopAll]
  );

  return { playingCells, playCell, toggleCell, stopCell, stopAll, isCellPlaying };
}

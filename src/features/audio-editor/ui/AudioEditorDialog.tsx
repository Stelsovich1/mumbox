import CloseIcon from "@mui/icons-material/Close";
import LoopIcon from "@mui/icons-material/Loop";
import PauseIcon from "@mui/icons-material/Pause";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import StopIcon from "@mui/icons-material/Stop";
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Slider,
  TextField,
  Tooltip,
  Typography
} from "@mui/material";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AppAction, getMediaBlob } from "../../../app/model/appState";
import { GridCell } from "../../../entities/cell/model/types";
import { MediaAsset } from "../../../entities/media/model/types";
import {
  getEnvelopeValue,
  getTrimEndSeconds,
  getTrimStartSeconds,
  scheduleEnvelope
} from "../../playback/model/audioEnvelope";
import { formatDuration } from "../../../shared/lib/duration";

type AudioEditorDialogProps = {
  open: boolean;
  panelId: string;
  cell: GridCell;
  media: MediaAsset;
  dispatch: React.Dispatch<AppAction>;
  onClose: () => void;
};

type AudioEditDraft = Pick<
  GridCell,
  | "trimStartMs"
  | "trimEndMs"
  | "fadeInEnabled"
  | "fadeInMs"
  | "fadeOutEnabled"
  | "fadeOutMs"
  | "volumeOffset"
>;

type PreviewRoute = {
  context: AudioContext;
  envelopeGain: GainNode;
  volumeGain: GainNode;
};

const WAVEFORM_POINTS = 420;

function getDurationMs(media: MediaAsset) {
  return media.durationMs ?? 10_000;
}

function makeDraft(cell: GridCell): AudioEditDraft {
  return {
    trimStartMs: cell.trimStartMs,
    trimEndMs: cell.trimEndMs,
    fadeInEnabled: cell.fadeInEnabled,
    fadeInMs: cell.fadeInMs,
    fadeOutEnabled: cell.fadeOutEnabled,
    fadeOutMs: cell.fadeOutMs,
    volumeOffset: cell.volumeOffset
  };
}

function makeFallbackWaveform() {
  return Array.from({ length: WAVEFORM_POINTS }, () => 0);
}

function getPreviewVolume(volumeOffset: number) {
  return Math.min(1, Math.max(0, 1 + volumeOffset / 100));
}

async function buildWaveform(mediaId: string) {
  const blob = await getMediaBlob(mediaId);
  if (!blob) {
    return makeFallbackWaveform();
  }

  const audioContext = new AudioContext();
  try {
    const audioBuffer = await audioContext.decodeAudioData(await blob.arrayBuffer());
    const channel = audioBuffer.getChannelData(0);
    const bucketSize = Math.max(1, Math.floor(channel.length / WAVEFORM_POINTS));
    return Array.from({ length: WAVEFORM_POINTS }, (_, index) => {
      const start = index * bucketSize;
      const end = Math.min(channel.length, start + bucketSize);
      let sum = 0;
      for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
        const sample = channel[sampleIndex] ?? 0;
        sum += sample * sample;
      }
      return Math.min(1, Math.sqrt(sum / Math.max(1, end - start)) * 2.4);
    });
  } catch {
    return makeFallbackWaveform();
  } finally {
    await audioContext.close();
  }
}

function Waveform({
  durationMs,
  draft,
  zoom,
  waveform,
  playheadMs,
  onSeek
}: {
  durationMs: number;
  draft: AudioEditDraft;
  zoom: number;
  waveform: number[];
  playheadMs: number;
  onSeek: (timeMs: number) => void;
}) {
  const startPercent = ((draft.trimStartMs ?? 0) / durationMs) * 100;
  const endPercent = ((draft.trimEndMs ?? durationMs) / durationMs) * 100;
  const fadeInPercent = draft.fadeInEnabled ? (draft.fadeInMs / durationMs) * 100 : 0;
  const fadeOutPercent = draft.fadeOutEnabled ? (draft.fadeOutMs / durationMs) * 100 : 0;
  const playheadPercent = (playheadMs / durationMs) * 100;
  const upperPoints = waveform.map((amplitude, index) => {
    const x = (index / Math.max(1, waveform.length - 1)) * 1000;
    const y = 50 - amplitude * 44;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const lowerPoints = waveform
    .map((amplitude, index) => {
      const x = (index / Math.max(1, waveform.length - 1)) * 1000;
      const y = 50 + amplitude * 44;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .reverse();
  const waveformPolygon = [...upperPoints, ...lowerPoints].join(" ");

  return (
    <Box
      data-testid="audio-editor-timeline"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const position = Math.min(
          1,
          Math.max(0, (event.clientX - rect.left + event.currentTarget.scrollLeft) / (rect.width * zoom))
        );
        onSeek(Math.round(position * durationMs));
      }}
      sx={{
        position: "relative",
        height: 210,
        overflowX: "auto",
        border: 1,
        borderColor: "rgba(255, 107, 138, 0.42)",
        borderRadius: 2,
        backgroundColor: "rgba(29, 5, 12, 0.72)",
        p: 2
      }}
    >
      <Box
        sx={{
          position: "relative",
          width: `${String(100 * zoom)}%`,
          minWidth: "100%",
          height: "100%",
          overflow: "hidden"
        }}
      >
        <Box
          component="svg"
          viewBox="0 0 1000 100"
          preserveAspectRatio="none"
          aria-hidden="true"
          sx={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        >
          <line x1="0" y1="50" x2="1000" y2="50" stroke="rgba(247, 251, 255, 0.22)" strokeWidth="1" />
          <polygon
            data-testid="audio-editor-waveform"
            points={waveformPolygon}
            fill="rgba(255, 74, 108, 0.64)"
            stroke="#ff9aad"
            strokeWidth="1.4"
          />
        </Box>
        <Box
          data-testid="audio-editor-playhead"
          sx={{
            position: "absolute",
            left: `${String(playheadPercent)}%`,
            top: 0,
            bottom: 0,
            width: 2,
            backgroundColor: "#f7fbff",
            boxShadow: "0 0 14px rgba(247, 251, 255, 0.9)",
            pointerEvents: "none"
          }}
        />
        <Box
          data-testid="trim-start-flag"
          sx={{
            position: "absolute",
            left: `${String(startPercent)}%`,
            top: 0,
            bottom: 0,
            width: 3,
            backgroundColor: "#ffcc66",
            boxShadow: "0 0 14px rgba(255, 204, 102, 0.8)"
          }}
        />
        <Box
          data-testid="trim-end-flag"
          sx={{
            position: "absolute",
            left: `${String(endPercent)}%`,
            top: 0,
            bottom: 0,
            width: 3,
            backgroundColor: "#8cf8ff",
            boxShadow: "0 0 14px rgba(140, 248, 255, 0.8)"
          }}
        />
        {draft.fadeInEnabled ? (
          <Box
            data-testid="fade-in-region"
            sx={{
              position: "absolute",
              left: `${String(startPercent)}%`,
              top: 0,
              width: `${String(fadeInPercent)}%`,
              height: "100%",
              minWidth: 4,
              pointerEvents: "none"
            }}
          >
            <Box component="svg" viewBox="0 0 100 100" preserveAspectRatio="none" sx={{ width: "100%", height: "100%" }}>
              <line x1="0" y1="84" x2="100" y2="16" stroke="#ffcc66" strokeWidth="4" />
            </Box>
          </Box>
        ) : null}
        {draft.fadeOutEnabled ? (
          <Box
            data-testid="fade-out-region"
            sx={{
              position: "absolute",
              right: `${String(100 - endPercent)}%`,
              top: 0,
              width: `${String(fadeOutPercent)}%`,
              height: "100%",
              minWidth: 4,
              pointerEvents: "none"
            }}
          >
            <Box component="svg" viewBox="0 0 100 100" preserveAspectRatio="none" sx={{ width: "100%", height: "100%" }}>
              <line x1="0" y1="16" x2="100" y2="84" stroke="#8cf8ff" strokeWidth="4" />
            </Box>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

export function AudioEditorDialog({
  open,
  panelId,
  cell,
  media,
  dispatch,
  onClose
}: AudioEditorDialogProps) {
  const durationMs = getDurationMs(media);
  const [draft, setDraft] = useState<AudioEditDraft>(() => makeDraft(cell));
  const [zoom, setZoom] = useState(1);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [previewLoop, setPreviewLoop] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [waveform, setWaveform] = useState<number[]>(() => makeFallbackWaveform());
  const [playheadMs, setPlayheadMs] = useState(cell.trimStartMs ?? 0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const previewRouteRef = useRef<PreviewRoute | null>(null);
  const draftRef = useRef(draft);
  const previewLoopRef = useRef(false);
  const previewFrameRef = useRef<number | null>(null);
  const rangeValue = useMemo<[number, number]>(
    () => [(draft.trimStartMs ?? 0) / 1000, (draft.trimEndMs ?? durationMs) / 1000],
    [draft.trimEndMs, draft.trimStartMs, durationMs]
  );

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const stopPreview = useCallback(() => {
    audioRef.current?.pause();
    if (audioRef.current) {
      audioRef.current.currentTime = getTrimStartSeconds(draftRef.current);
    }
    if (previewFrameRef.current) {
      cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    const route = previewRouteRef.current;
    if (route) {
      void route.context.close();
      previewRouteRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
    }
    audioRef.current = null;
    objectUrlRef.current = null;
    setPreviewPlaying(false);
    setPlayheadMs(draftRef.current.trimStartMs ?? 0);
  }, []);

  useEffect(() => {
    const status = { cancelled: false };

    if (open) {
      setDraft(makeDraft(cell));
      setPreviewPlaying(false);
      setWaveform(makeFallbackWaveform());
      setPlayheadMs(cell.trimStartMs ?? 0);
      void buildWaveform(media.id).then((nextWaveform) => {
        if (!status.cancelled) {
          setWaveform(nextWaveform);
        }
      });
    }

    return () => {
      status.cancelled = true;
    };
  }, [cell, media.id, open]);

  useEffect(() => {
    previewLoopRef.current = previewLoop;
  }, [previewLoop]);

  useEffect(() => () => {
    stopPreview();
  }, [stopPreview]);

  const updatePreviewVolumeAndPosition = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    if (!previewRouteRef.current) {
      audio.volume =
        getPreviewVolume(draftRef.current.volumeOffset) *
        getEnvelopeValue(draftRef.current, audio.currentTime, getTrimEndSeconds(draftRef.current, durationMs / 1000));
    }
    setPlayheadMs(Math.round(audio.currentTime * 1000));
    previewFrameRef.current = requestAnimationFrame(updatePreviewVolumeAndPosition);
  }, [durationMs]);

  const schedulePreviewEnvelope = useCallback(() => {
    const audio = audioRef.current;
    const route = previewRouteRef.current;
    if (!audio || !route) {
      return;
    }
    const startSeconds = getTrimStartSeconds(draftRef.current);
    const endSeconds = getTrimEndSeconds(draftRef.current, durationMs / 1000);
    if (audio.currentTime < startSeconds || audio.currentTime >= endSeconds) {
      audio.currentTime = startSeconds;
    }
    route.volumeGain.gain.setValueAtTime(getPreviewVolume(draftRef.current.volumeOffset), route.context.currentTime);
    try {
      scheduleEnvelope(route.envelopeGain, draftRef.current, audio.currentTime, endSeconds);
    } catch {
      void route.context.close();
      previewRouteRef.current = null;
      audio.volume =
        getPreviewVolume(draftRef.current.volumeOffset) *
        getEnvelopeValue(draftRef.current, audio.currentTime, endSeconds);
    }
  }, [durationMs]);

  useEffect(() => {
    schedulePreviewEnvelope();
  }, [draft, schedulePreviewEnvelope]);

  const playPreview = async () => {
    if (audioRef.current?.paused) {
      schedulePreviewEnvelope();
      await audioRef.current.play();
      setPreviewPlaying(true);
      updatePreviewVolumeAndPosition();
      return;
    }
    if (audioRef.current) {
      return;
    }
    const blob = await getMediaBlob(media.id);
    if (!blob) {
      return;
    }
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    const startSeconds = getTrimStartSeconds(draftRef.current);
    const endSeconds = getTrimEndSeconds(draftRef.current, durationMs / 1000);
    audio.currentTime = startSeconds;
    audio.volume =
      getPreviewVolume(draftRef.current.volumeOffset) *
      getEnvelopeValue(draftRef.current, startSeconds, endSeconds);
    try {
      const context = new AudioContext();
      const source = context.createMediaElementSource(audio);
      const envelopeGain = context.createGain();
      const volumeGain = context.createGain();
      source.connect(envelopeGain);
      envelopeGain.connect(volumeGain);
      volumeGain.connect(context.destination);
      audio.volume = 1;
      volumeGain.gain.setValueAtTime(getPreviewVolume(draftRef.current.volumeOffset), context.currentTime);
      previewRouteRef.current = { context, envelopeGain, volumeGain };
      if (context.state === "suspended") {
        void context.resume();
      }
    } catch {
      previewRouteRef.current = null;
    }
    audio.addEventListener("timeupdate", () => {
      const latestDraft = draftRef.current;
      const latestStartSeconds = getTrimStartSeconds(latestDraft);
      const endSeconds = getTrimEndSeconds(latestDraft, durationMs / 1000);
      if (audio.currentTime < endSeconds) {
        return;
      }
      if (previewLoopRef.current) {
        audio.currentTime = latestStartSeconds;
        schedulePreviewEnvelope();
        void audio.play();
        return;
      }
      stopPreview();
    });
    audio.addEventListener("ended", () => {
      const latestStartSeconds = getTrimStartSeconds(draftRef.current);
      if (previewLoopRef.current) {
        audio.currentTime = latestStartSeconds;
        schedulePreviewEnvelope();
        void audio.play();
        return;
      }
      stopPreview();
    });
    objectUrlRef.current = url;
    audioRef.current = audio;
    schedulePreviewEnvelope();
    await audio.play();
    setPreviewPlaying(true);
    updatePreviewVolumeAndPosition();
  };

  const pausePreview = () => {
    audioRef.current?.pause();
    if (previewFrameRef.current) {
      cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    setPreviewPlaying(false);
  };

  const seekPreview = (timeMs: number) => {
    const startMs = draft.trimStartMs ?? 0;
    const endMs = draft.trimEndMs ?? durationMs;
    const nextTimeMs = Math.min(endMs, Math.max(startMs, timeMs));
    setPlayheadMs(nextTimeMs);
    if (audioRef.current) {
      audioRef.current.currentTime = nextTimeMs / 1000;
      schedulePreviewEnvelope();
    }
  };

  const saveAndClose = () => {
    stopPreview();
    dispatch({
      type: "cell/update",
      panelId,
      cellId: cell.id,
      patch: draft
    });
    onClose();
  };

  const resetDraft = () => {
    setDraft({
      trimStartMs: null,
      trimEndMs: null,
      fadeInEnabled: false,
      fadeInMs: 0,
      fadeOutEnabled: false,
      fadeOutMs: 0,
      volumeOffset: 0
    });
    setResetConfirmOpen(false);
  };

  return (
    <>
      <Dialog open={open} onClose={saveAndClose} fullWidth maxWidth="lg">
        <DialogTitle sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          Редактор аудио
          <IconButton aria-label="Закрыть редактор аудио" onClick={saveAndClose}>
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent sx={{ display: "grid", gap: 2 }}>
          <Box sx={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 2, alignItems: "center" }}>
            <Box sx={{ display: "flex", gap: 1 }}>
              <Tooltip title={previewPlaying ? "Пауза" : "Плей"}>
                <IconButton
                  aria-label={previewPlaying ? "Пауза редактора" : "Плей редактора"}
                  onClick={() => {
                    if (previewPlaying) {
                      pausePreview();
                      return;
                    }
                    void playPreview();
                  }}
                >
                  {previewPlaying ? <PauseIcon /> : <PlayArrowIcon />}
                </IconButton>
              </Tooltip>
              <Tooltip title="Стоп">
                <IconButton
                  aria-label="Стоп редактора"
                  onClick={() => {
                    stopPreview();
                  }}
                >
                  <StopIcon />
                </IconButton>
              </Tooltip>
              <Tooltip title="Зациклить preview">
                <IconButton
                  aria-label="Зациклить preview"
                  color={previewLoop ? "secondary" : "default"}
                  aria-pressed={previewLoop}
                  onClick={() => {
                    setPreviewLoop((current) => !current);
                  }}
                >
                  <LoopIcon />
                </IconButton>
              </Tooltip>
            </Box>
            <Box>
              <Typography gutterBottom>Масштаб: {zoom.toFixed(1)}x</Typography>
              <Slider
                aria-label="Масштаб таймлайна"
                min={1}
                max={8}
                step={0.1}
                value={zoom}
                onChange={(_, value: number | number[]) => {
                  setZoom(Array.isArray(value) ? value[0] ?? 1 : value);
                }}
              />
            </Box>
          </Box>
          <Typography color="text.secondary">
            {media.fileName} · {formatDuration(durationMs)}
          </Typography>
          <Waveform
            durationMs={durationMs}
            draft={draft}
            zoom={zoom}
            waveform={waveform}
            playheadMs={playheadMs}
            onSeek={seekPreview}
          />
          <Box>
            <Typography gutterBottom>
              Диапазон: {rangeValue[0].toFixed(2)}с - {rangeValue[1].toFixed(2)}с
            </Typography>
            <Slider
              aria-label="Диапазон воспроизведения"
              min={0}
              max={durationMs / 1000}
              step={0.01}
              value={rangeValue}
              onChange={(_, value: number | number[]) => {
                const nextValue = Array.isArray(value) ? value : [0, value];
                setDraft((current) => ({
                  ...current,
                  trimStartMs: Math.round((nextValue[0] ?? 0) * 1000),
                  trimEndMs: Math.round((nextValue[1] ?? durationMs / 1000) * 1000)
                }));
              }}
            />
            <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, mt: 1 }}>
              <TextField
                label="Начало сек"
                type="number"
                size="small"
                value={rangeValue[0]}
                slotProps={{ htmlInput: { step: 0.01, min: 0, max: durationMs / 1000 } }}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    trimStartMs: Math.round(Math.max(0, Number(event.target.value)) * 1000)
                  }));
                }}
              />
              <TextField
                label="Конец сек"
                type="number"
                size="small"
                value={rangeValue[1]}
                slotProps={{ htmlInput: { step: 0.01, min: 0, max: durationMs / 1000 } }}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    trimEndMs: Math.round(Math.min(durationMs / 1000, Number(event.target.value)) * 1000)
                  }));
                }}
              />
            </Box>
          </Box>
          <Box>
            <Typography gutterBottom>Громкость аудио: {draft.volumeOffset}</Typography>
            <Slider
              aria-label="Громкость аудио в редакторе"
              min={-100}
              max={100}
              value={draft.volumeOffset}
              onChange={(_, value: number | number[]) => {
                const volumeOffset = Array.isArray(value) ? value[0] ?? 0 : value;
                setDraft((current) => ({ ...current, volumeOffset }));
              }}
            />
            <TextField
              label="Значение громкости аудио в редакторе"
              type="number"
              size="small"
              fullWidth
              value={draft.volumeOffset}
              slotProps={{ htmlInput: { min: -100, max: 100, step: 1 } }}
              onChange={(event) => {
                const nextValue = Number(event.target.value);
                if (!Number.isFinite(nextValue)) {
                  return;
                }
                setDraft((current) => ({
                  ...current,
                  volumeOffset: Math.min(100, Math.max(-100, nextValue))
                }));
              }}
            />
          </Box>
          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 2 }}>
            <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={draft.fadeInEnabled}
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, fadeInEnabled: event.target.checked }));
                    }}
                  />
                }
                label="Нарастание"
              />
              <TextField
                label="Секунды"
                type="number"
                size="small"
                value={draft.fadeInMs / 1000}
                slotProps={{ htmlInput: { step: 0.1, min: 0 } }}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    fadeInMs: Math.max(0, Number(event.target.value) * 1000)
                  }));
                }}
              />
            </Box>
            <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={draft.fadeOutEnabled}
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, fadeOutEnabled: event.target.checked }));
                    }}
                  />
                }
                label="Затухание"
              />
              <TextField
                label="Секунды"
                type="number"
                size="small"
                value={draft.fadeOutMs / 1000}
                slotProps={{ htmlInput: { step: 0.1, min: 0 } }}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    fadeOutMs: Math.max(0, Number(event.target.value) * 1000)
                  }));
                }}
              />
            </Box>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button
            color="warning"
            onClick={() => {
              setResetConfirmOpen(true);
            }}
          >
            Сбросить
          </Button>
          <Button variant="contained" aria-label="Сохранить редактор аудио" onClick={saveAndClose}>
            Ок
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={resetConfirmOpen}
        onClose={() => {
          setResetConfirmOpen(false);
        }}
        aria-labelledby="audio-reset-confirm-title"
      >
        <DialogTitle id="audio-reset-confirm-title">Сброс настроек аудиозаписи</DialogTitle>
        <DialogContent>
          <Typography>Вы действительно хотите сбросить настройки аудиозаписи?</Typography>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setResetConfirmOpen(false);
            }}
          >
            Отмена
          </Button>
          <Button color="warning" variant="contained" onClick={resetDraft}>
            Сбросить
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

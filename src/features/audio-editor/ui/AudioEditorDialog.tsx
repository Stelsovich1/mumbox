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
const VOLUME_OFFSET_MIN = -100;
const VOLUME_OFFSET_MAX = 100;

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
  return Math.min(2, Math.max(0, 1 + volumeOffset / 100));
}

function formatVolumeOffset(volumeOffset: number) {
  return `${volumeOffset > 0 ? "+" : ""}${String(volumeOffset)}%`;
}

function formatVolumeMultiplier(volumeOffset: number) {
  return getPreviewVolume(volumeOffset).toFixed(2).replace(/\.?0+$/, "");
}

function getHtmlAudioVolume(volume: number) {
  return Math.min(1, Math.max(0, volume));
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
        height: { xs: 76, sm: 210 },
        overflowX: "auto",
        touchAction: "pan-x",
        border: 1,
        borderColor: "rgba(255, 107, 138, 0.42)",
        borderRadius: 2,
        backgroundColor: "rgba(29, 5, 12, 0.72)",
        p: { xs: 1, sm: 2 },
        "@media (max-height: 480px)": {
          gridArea: "wave",
          alignSelf: "stretch",
          height: "auto",
          minHeight: 104,
          p: 0.5,
          borderRadius: 1
        }
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
        getHtmlAudioVolume(
          getPreviewVolume(draftRef.current.volumeOffset) *
            getEnvelopeValue(
              draftRef.current,
              audio.currentTime,
              getTrimEndSeconds(draftRef.current, durationMs / 1000)
            )
        );
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
        getHtmlAudioVolume(
          getPreviewVolume(draftRef.current.volumeOffset) *
            getEnvelopeValue(draftRef.current, audio.currentTime, endSeconds)
        );
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
      getHtmlAudioVolume(
        getPreviewVolume(draftRef.current.volumeOffset) *
          getEnvelopeValue(draftRef.current, startSeconds, endSeconds)
      );
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
  const compactNumberFieldSx = {
    "& .MuiInputBase-input": {
      py: { xs: 0.55, sm: 1 },
      fontSize: { xs: 12, sm: 14 }
    },
    "& .MuiInputLabel-root": {
      fontSize: { xs: 12, sm: 14 }
    },
    "@media (max-height: 480px)": {
      "& .MuiInputBase-input": {
        py: 0.25,
        px: 0.75,
        fontSize: 11
      },
      "& .MuiInputLabel-root": {
        fontSize: 11,
        transform: "translate(8px, 5px) scale(1)"
      },
      "& .MuiInputLabel-shrink": {
        transform: "translate(10px, -6px) scale(0.72)"
      }
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onClose={saveAndClose}
        fullWidth
        maxWidth="lg"
        slotProps={{
          paper: {
            sx: {
              width: { xs: "95vw", sm: "calc(100vw - 64px)" },
              maxWidth: { xs: "95vw", sm: "1200px" },
              height: { xs: "95dvh", sm: "auto" },
              maxHeight: { xs: "95dvh", sm: "calc(100dvh - 64px)" },
              m: { xs: 0, sm: 4 },
              "& .MuiDialogTitle-root": {
                px: { xs: 1, sm: 3 },
                py: { xs: 0.5, sm: 2 },
                fontSize: { xs: 16, sm: 20 }
              },
              "& .MuiDialogActions-root": {
                px: { xs: 1, sm: 3 },
                py: { xs: 0.5, sm: 1 }
              },
              "& .MuiIconButton-root": {
                width: { xs: 32, sm: 40 },
                height: { xs: 32, sm: 40 }
              },
              "& .MuiSvgIcon-root": {
                fontSize: { xs: 19, sm: 24 }
              },
              "@media (max-height: 480px)": {
                width: "95vw",
                maxWidth: "95vw",
                height: "95dvh",
                maxHeight: "95dvh",
                display: "flex",
                flexDirection: "column",
                "& .MuiDialogTitle-root": {
                  minHeight: 0,
                  px: 0.75,
                  py: 0.25,
                  fontSize: 14,
                  lineHeight: 1.1
                },
                "& .MuiDialogActions-root": {
                  minHeight: 0,
                  px: 0.75,
                  py: 0.25,
                  gap: 0.5
                },
                "& .MuiDialogActions-root .MuiButton-root": {
                  minHeight: 24,
                  px: 1,
                  py: 0.125,
                  fontSize: 11
                },
                "& .MuiIconButton-root": {
                  width: 24,
                  height: 24,
                  p: 0.25
                },
                "& .MuiSvgIcon-root": {
                  fontSize: 15
                }
              }
            }
          }
        }}
      >
        <DialogTitle sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          Редактор аудио
          <IconButton aria-label="Закрыть редактор аудио" onClick={saveAndClose}>
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "minmax(0, 1.15fr) minmax(200px, 0.85fr)", sm: "1fr" },
            alignContent: "start",
            gap: { xs: "15px", sm: 2 },
            overflowY: { xs: "hidden", sm: "auto" },
            px: { xs: 1, sm: 3 },
            py: { xs: 0.75, sm: 2 },
            "@media (max-height: 480px)": {
              gridTemplateColumns: "minmax(0, 1.1fr) minmax(180px, 0.9fr)",
              gridTemplateRows: "auto minmax(104px, 1.2fr) minmax(92px, 1fr)",
              gridTemplateAreas: `
                "controls controls"
                "wave volume"
                "range fades"
              `,
              alignContent: "stretch",
              gap: "15px",
              flex: 1,
              minHeight: 0,
              overflowY: "hidden",
              px: 0.75,
              py: 0.35,
              "& .MuiSlider-root": {
                py: 0.25
              },
              "& .MuiSlider-thumb": {
                width: 10,
                height: 10
              },
              "& .MuiSlider-track, & .MuiSlider-rail": {
                height: 3
              },
              "& .MuiCheckbox-root": {
                p: 0.2
              }
            }
          }}
        >
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "auto minmax(0, 1fr)",
              gap: { xs: 0.75, sm: 2 },
              alignItems: "stretch",
              gridColumn: { xs: "1 / -1", sm: "auto" },
              "@media (max-height: 480px)": {
                gridColumn: "1 / -1",
                gridArea: "controls",
                gridTemplateColumns: "auto minmax(0, 0.75fr) minmax(0, 1fr)",
                gap: 0.5,
                minWidth: 0
              }
            }}
          >
            <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", "@media (max-height: 480px)": { gap: 0.25 } }}>
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
            <Box sx={{ minWidth: 0, "@media (max-height: 480px)": { pl: 0.5 } }}>
              <Typography
                gutterBottom
                sx={{
                  fontSize: { xs: 12, sm: 14 },
                  mb: { xs: 0, sm: 0.5 },
                  "@media (max-height: 480px)": { fontSize: 10, lineHeight: 1, mb: 0 }
                }}
              >
                Масштаб: {zoom.toFixed(1)}x
              </Typography>
              <Slider
                aria-label="Масштаб таймлайна"
                min={1}
                max={8}
                step={0.1}
                value={zoom}
                onChange={(_, value: number | number[]) => {
                  setZoom(Array.isArray(value) ? value[0] ?? 1 : value);
                }}
                size="small"
                sx={{ "@media (max-height: 480px)": { ml: 0.75, width: "calc(100% - 12px)" } }}
              />
            </Box>
            <Typography
              color="text.secondary"
              sx={{
                display: { xs: "none", sm: "none" },
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                "@media (max-height: 480px)": {
                  display: "block",
                  alignSelf: "center",
                  fontSize: 10,
                  lineHeight: 1.1,
                  minWidth: 0
                }
              }}
            >
              {media.fileName} · {formatDuration(durationMs)}
            </Typography>
          </Box>
          <Typography
            color="text.secondary"
            sx={{
              gridColumn: { xs: "1 / -1", sm: "auto" },
              fontSize: { xs: 11, sm: 14 },
              lineHeight: 1.2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              "@media (max-height: 480px)": {
                display: "none"
              }
            }}
          >
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
          <Box
            sx={{
              minWidth: 0,
              "@media (max-height: 480px)": {
                gridArea: "range",
                display: "grid",
                alignContent: "space-evenly",
                minHeight: 0
              }
            }}
          >
            <Typography
              gutterBottom
              sx={{
                fontSize: { xs: 12, sm: 14 },
                mb: { xs: 0, sm: 0.5 },
                "@media (max-height: 480px)": { fontSize: 10, lineHeight: 1, mb: 0 }
              }}
            >
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
              size="small"
            />
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
                gap: 1,
                mt: 1,
                "@media (max-height: 480px)": {
                  gridTemplateColumns: "1fr 1fr",
                  gap: 0.5,
                  mt: 0.25
                }
              }}
            >
              <TextField
                label="Начало сек"
                type="number"
                size="small"
                value={rangeValue[0]}
                slotProps={{ htmlInput: { step: 0.01, min: 0, max: durationMs / 1000 } }}
                sx={compactNumberFieldSx}
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
                sx={compactNumberFieldSx}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    trimEndMs: Math.round(Math.min(durationMs / 1000, Number(event.target.value)) * 1000)
                  }));
                }}
              />
            </Box>
          </Box>
          <Box
            sx={{
              minWidth: 0,
              gridColumn: { xs: 2, sm: "auto" },
              gridRow: { xs: 3, sm: "auto" },
              "@media (max-height: 480px)": {
                alignSelf: "stretch",
                gridColumn: 2,
                gridRow: 3,
                gridArea: "volume",
                display: "grid",
                alignContent: "space-evenly",
                minHeight: 0
              }
            }}
          >
            <Typography
              gutterBottom
              sx={{
                fontSize: { xs: 12, sm: 14 },
                mb: { xs: 0, sm: 0.5 },
                "@media (max-height: 480px)": { fontSize: 10, lineHeight: 1, mb: 0 }
              }}
            >
              Настройка громкости: {formatVolumeOffset(draft.volumeOffset)} · x{formatVolumeMultiplier(draft.volumeOffset)}
            </Typography>
            <Slider
              aria-label="Громкость аудио в редакторе"
              min={VOLUME_OFFSET_MIN}
              max={VOLUME_OFFSET_MAX}
              marks={[
                { value: VOLUME_OFFSET_MIN, label: "-100%" },
                { value: 0, label: "0%" },
                { value: VOLUME_OFFSET_MAX, label: "+100%" }
              ]}
              value={draft.volumeOffset}
              onChange={(_, value: number | number[]) => {
                const volumeOffset = Array.isArray(value) ? value[0] ?? 0 : value;
                setDraft((current) => ({ ...current, volumeOffset }));
              }}
              size="small"
              sx={{
                "& .MuiSlider-markLabel": {
                  display: { xs: "none", sm: "block" }
                }
              }}
            />
            <TextField
              label="Значение громкости аудио в редакторе"
              type="number"
              size="small"
              fullWidth
              value={draft.volumeOffset}
              slotProps={{ htmlInput: { min: VOLUME_OFFSET_MIN, max: VOLUME_OFFSET_MAX, step: 1 } }}
              sx={compactNumberFieldSx}
              onChange={(event) => {
                const nextValue = Number(event.target.value);
                if (!Number.isFinite(nextValue)) {
                  return;
                }
                setDraft((current) => ({
                  ...current,
                  volumeOffset: Math.min(VOLUME_OFFSET_MAX, Math.max(VOLUME_OFFSET_MIN, nextValue))
                }));
              }}
            />
          </Box>
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
              gap: { xs: 0.75, sm: 2 },
              gridColumn: { xs: 2, sm: "auto" },
              gridRow: { xs: 4, sm: "auto" },
              minWidth: 0,
              "& .MuiFormControlLabel-label": {
                fontSize: { xs: 12, sm: 14 }
              },
              "@media (max-height: 480px)": {
                gridColumn: 2,
                gridRow: 4,
                gridArea: "fades",
                display: "flex",
                flexWrap: "wrap",
                alignContent: "space-evenly",
                alignItems: "center",
                gap: "6px",
                minHeight: 0,
                "& .MuiFormControlLabel-label": {
                  fontSize: 10,
                  lineHeight: 1
                }
              }
            }}
          >
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: { xs: "1fr", sm: "auto minmax(120px, 1fr)" },
                gap: 1,
                alignItems: "center",
                "@media (max-height: 480px)": {
                  gridTemplateColumns: "78px minmax(0, 1fr)",
                  gap: 0.4
                }
              }}
            >
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
                sx={compactNumberFieldSx}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    fadeInMs: Math.max(0, Number(event.target.value) * 1000)
                  }));
                }}
              />
            </Box>
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: { xs: "1fr", sm: "auto minmax(120px, 1fr)" },
                gap: 1,
                alignItems: "center",
                "@media (max-height: 480px)": {
                  gridTemplateColumns: "78px minmax(0, 1fr)",
                  gap: 0.4
                }
              }}
            >
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
                sx={compactNumberFieldSx}
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
        <DialogActions sx={{ flexWrap: "wrap" }}>
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
        slotProps={{
          paper: {
            sx: {
              width: { xs: "calc(100vw - 24px)", sm: "auto" },
              maxWidth: { xs: "calc(100vw - 24px)", sm: 520 },
              maxHeight: "calc(100dvh - 24px)",
              m: { xs: 1.5, sm: 4 }
            }
          }
        }}
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

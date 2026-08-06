import DeleteIcon from "@mui/icons-material/Delete";
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
  IconButton,
  Snackbar,
  TextField,
  Tooltip,
  Typography
} from "@mui/material";
import { useEffect, useMemo, useRef, useState } from "react";

import { makeMediaDraft, saveImportedMedia } from "../../../app/model/appState";
import { MediaAsset } from "../../../entities/media/model/types";
import { CELL_COLORS } from "../../../shared/config/colorPalette";
import { formatDuration, readAudioDurationMs } from "../../../shared/lib/duration";
import { ColorSwatches } from "../../../shared/ui/ColorSwatches";

type MediaDraft = ReturnType<typeof makeMediaDraft>;

type AudioImportDialogProps = {
  files: File[];
  open: boolean;
  onCancel: () => void;
  onSave: (media: MediaAsset[]) => void;
  onReady: () => void;
  onLoadingChange: (loading: boolean) => void;
};

const IMPORT_ROW_HEIGHT = 74;
const IMPORT_VIEWPORT_HEIGHT = 460;
const IMPORT_COLUMNS =
  "48px minmax(180px, 1.4fr) 86px 120px minmax(220px, 1.2fr) 180px 90px";
const DURATION_BATCH_SIZE = 24;

function waitForPaint() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

export function AudioImportDialog({
  files,
  open,
  onCancel,
  onSave,
  onReady,
  onLoadingChange
}: AudioImportDialogProps) {
  const [drafts, setDrafts] = useState<MediaDraft[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const status = { cancelled: false };

    if (open) {
      onLoadingChange(true);
      const nextDrafts = files.map((file, index) => makeMediaDraft(file, index));
      setDrafts(nextDrafts);
      setSelectedIds([]);
      setScrollTop(0);
      if (bodyRef.current) {
        bodyRef.current.scrollTop = 0;
      }
      void (async () => {
        for (let index = 0; index < nextDrafts.length; index += DURATION_BATCH_SIZE) {
          const batch = nextDrafts.slice(index, index + DURATION_BATCH_SIZE);
          const durations = await Promise.all(
            batch.map(async (draft) => ({
              id: draft.id,
              durationMs: await readAudioDurationMs(draft.file)
            }))
          );
          if (status.cancelled) {
            return;
          }
          setDrafts((current) =>
            current.map((draft) => ({
              ...draft,
              durationMs:
                durations.find((duration) => duration.id === draft.id)?.durationMs ?? draft.durationMs
            }))
          );
          await waitForPaint();
        }
        if (!status.cancelled) {
          setScrollTop(0);
          if (bodyRef.current) {
            bodyRef.current.scrollTop = 0;
          }
          onLoadingChange(false);
          onReady();
        }
      })();
    }

    return () => {
      status.cancelled = true;
    };
  }, [files, onLoadingChange, onReady, open]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const virtualStart = Math.max(0, Math.floor(scrollTop / IMPORT_ROW_HEIGHT) - 6);
  const virtualEnd = Math.min(
    drafts.length,
    Math.ceil((scrollTop + IMPORT_VIEWPORT_HEIGHT) / IMPORT_ROW_HEIGHT) + 6
  );
  const visibleDrafts = drafts.slice(virtualStart, virtualEnd);

  const stopPreview = () => {
    audioRef.current?.pause();
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
    }
    objectUrlRef.current = null;
    audioRef.current = null;
    setPlayingId(null);
  };

  const playPreview = (draft: MediaDraft) => {
    if (playingId === draft.id) {
      audioRef.current?.pause();
      setPlayingId(null);
      return;
    }
    stopPreview();
    const url = URL.createObjectURL(draft.file);
    const audio = new Audio(url);
    objectUrlRef.current = url;
    audioRef.current = audio;
    audio.addEventListener("ended", stopPreview);
    setPlayingId(draft.id);
    void audio.play();
  };

  const updateDraft = (id: string, patch: Partial<Pick<MediaDraft, "alias" | "color">>) => {
    setDrafts((current) =>
      current.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft))
    );
  };

  const applyColorToAll = (color: string) => {
    setDrafts((current) => current.map((draft) => ({ ...draft, color })));
  };

  const deleteSelected = () => {
    const ids = selectedIds.length > 0 ? selectedIds : drafts[0] ? [drafts[0].id] : [];
    setDrafts((current) => current.filter((draft) => !ids.includes(draft.id)));
    setSelectedIds([]);
    setConfirmDeleteOpen(false);
  };

  const handleSave = async () => {
    stopPreview();
    onLoadingChange(true);
    const media = await saveImportedMedia(drafts.filter((draft) => selectedSet.has(draft.id)));
    onLoadingChange(false);
    onSave(media);
  };

  useEffect(() => stopPreview, []);

  return (
    <>
      <Dialog open={open} onClose={onCancel} fullWidth maxWidth="lg">
        <DialogTitle>Импорт аудио</DialogTitle>
        <DialogContent>
          <Box role="table" aria-label="Импортируемые аудио" sx={{ minWidth: 980 }}>
            <Box
              role="row"
              sx={{
                display: "grid",
                gridTemplateColumns: IMPORT_COLUMNS,
                alignItems: "center",
                borderBottom: 1,
                borderColor: "divider",
                backgroundColor: "rgba(5, 7, 13, 0.92)"
              }}
            >
              <Box role="columnheader" sx={{ px: 1 }}>
                  <Checkbox
                    aria-label="Выбрать все аудио"
                    checked={drafts.length > 0 && selectedIds.length === drafts.length}
                    indeterminate={selectedIds.length > 0 && selectedIds.length < drafts.length}
                    onChange={(event) => {
                      setSelectedIds(event.target.checked ? drafts.map((draft) => draft.id) : []);
                    }}
                  />
              </Box>
              <Typography role="columnheader" sx={{ px: 1, py: 1.25 }}>
                Название файла
              </Typography>
              <Typography role="columnheader" sx={{ px: 1, py: 1.25 }}>
                Время
              </Typography>
              <Typography role="columnheader" sx={{ px: 1, py: 1.25 }}>
                Играть
              </Typography>
              <Box role="columnheader" sx={{ px: 1, py: 1.25 }}>
                  <Box sx={{ display: "grid", gap: 1 }}>
                    <Typography variant="body2">Цвет</Typography>
                    <ColorSwatches
                      value={CELL_COLORS[0]}
                      onChange={applyColorToAll}
                      label="Цвет для всех импортов"
                    />
                  </Box>
              </Box>
              <Typography role="columnheader" sx={{ px: 1, py: 1.25 }}>
                Псевдоним
              </Typography>
              <Typography role="columnheader" sx={{ px: 1, py: 1.25 }}>
                Удалить
              </Typography>
            </Box>
            <Box
              ref={bodyRef}
              role="rowgroup"
              onScroll={(event) => {
                setScrollTop(event.currentTarget.scrollTop);
              }}
              sx={{
                display: "block",
                maxHeight: IMPORT_VIEWPORT_HEIGHT,
                overflowY: "auto",
                position: "relative",
                height: drafts.length > 80 ? IMPORT_VIEWPORT_HEIGHT : "auto"
              }}
            >
              <Box
                sx={{
                  height: drafts.length > 80 ? drafts.length * IMPORT_ROW_HEIGHT : "auto",
                  position: "relative"
                }}
              >
              {(drafts.length > 80 ? visibleDrafts : drafts).map((draft, visibleIndex) => (
                <Box
                  key={draft.id}
                  role="row"
                  sx={{
                    display: "grid",
                    gridTemplateColumns: IMPORT_COLUMNS,
                    alignItems: "center",
                    minHeight: IMPORT_ROW_HEIGHT,
                    borderBottom: 1,
                    borderColor: "rgba(169, 183, 207, 0.12)",
                    backgroundColor: selectedSet.has(draft.id)
                      ? "rgba(140, 248, 255, 0.08)"
                      : "transparent",
                    transition: "background-color 160ms ease",
                    "&:hover": {
                      backgroundColor: "rgba(140, 248, 255, 0.06)"
                    },
                    ...(drafts.length > 80
                      ? {
                          position: "absolute",
                          left: 0,
                          right: 0,
                          top: (virtualStart + visibleIndex) * IMPORT_ROW_HEIGHT
                        }
                      : {})
                  }}
                >
                  <Box role="cell" sx={{ px: 1 }}>
                    <Checkbox
                      aria-label={`Выбрать ${draft.fileName}`}
                      checked={selectedSet.has(draft.id)}
                      onChange={(event) => {
                        setSelectedIds((current) =>
                          event.target.checked
                            ? [...current, draft.id]
                            : current.filter((id) => id !== draft.id)
                        );
                      }}
                    />
                  </Box>
                  <Typography role="cell" sx={{ px: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {draft.fileName}
                  </Typography>
                  <Typography role="cell" sx={{ px: 1 }}>
                    {formatDuration(draft.durationMs)}
                  </Typography>
                  <Box role="cell" sx={{ px: 1 }}>
                    <Tooltip title={playingId === draft.id ? "Пауза" : "Плей"}>
                      <IconButton
                        aria-label={`${playingId === draft.id ? "Пауза" : "Плей"} ${draft.fileName}`}
                        onClick={() => {
                          playPreview(draft);
                        }}
                      >
                        {playingId === draft.id ? <PauseIcon /> : <PlayArrowIcon />}
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Стоп">
                      <IconButton
                        aria-label={`Стоп ${draft.fileName}`}
                        onClick={stopPreview}
                      >
                        <StopIcon />
                      </IconButton>
                    </Tooltip>
                  </Box>
                  <Box role="cell" sx={{ px: 1 }}>
                    <ColorSwatches
                      value={draft.color}
                      onChange={(color) => {
                        updateDraft(draft.id, { color });
                      }}
                      label={`Цвет ${draft.fileName}`}
                    />
                  </Box>
                  <Box role="cell" sx={{ px: 1 }}>
                    <TextField
                      value={draft.alias}
                      size="small"
                      slotProps={{
                        htmlInput: {
                          "aria-label": `Псевдоним ${draft.fileName}`
                        }
                      }}
                      onChange={(event) => {
                        updateDraft(draft.id, { alias: event.target.value });
                      }}
                    />
                  </Box>
                  <Box role="cell" sx={{ px: 1 }}>
                    <IconButton
                      aria-label={`Удалить ${draft.fileName}`}
                      onClick={() => {
                        setSelectedIds([draft.id]);
                        setConfirmDeleteOpen(true);
                      }}
                    >
                      <DeleteIcon />
                    </IconButton>
                  </Box>
                </Box>
              ))}
              </Box>
            </Box>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={onCancel}>Отменить</Button>
          <Button
            variant="contained"
            disabled={selectedIds.length === 0}
            onClick={() => {
              void handleSave();
            }}
          >
            Сохранить
          </Button>
        </DialogActions>
      </Dialog>
      <Snackbar
        open={confirmDeleteOpen}
        anchorOrigin={{ vertical: "top", horizontal: "center" }}
        sx={{
          top: "50% !important",
          left: "50% !important",
          right: "auto !important",
          bottom: "auto !important",
          transform: "translate(-50%, -50%) !important"
        }}
        message="Вы действительно хотите удалить выбранные аудио?"
        action={
          <>
            <Button color="inherit" onClick={deleteSelected}>
              Удалить
            </Button>
            <Button
              color="inherit"
              onClick={() => {
                setConfirmDeleteOpen(false);
              }}
            >
              Отмена
            </Button>
          </>
        }
      />
    </>
  );
}

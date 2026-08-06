import CheckIcon from "@mui/icons-material/Check";
import ClearIcon from "@mui/icons-material/Clear";
import CloseIcon from "@mui/icons-material/Close";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import KeyboardIcon from "@mui/icons-material/Keyboard";
import SearchIcon from "@mui/icons-material/Search";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormLabel,
  IconButton,
  InputAdornment,
  Radio,
  RadioGroup,
  Slider,
  Snackbar,
  TextField,
  Tooltip,
  Typography
} from "@mui/material";
import { KeyboardEvent, useEffect, useMemo, useState } from "react";

import { AppAction } from "../../../app/model/appState";
import { GridCell, PlaybackMode } from "../../../entities/cell/model/types";
import { MediaAsset } from "../../../entities/media/model/types";
import { AudioEditorDialog } from "../../../features/audio-editor";
import { formatDuration } from "../../../shared/lib/duration";
import { ColorSwatches } from "../../../shared/ui/ColorSwatches";

const MEDIA_PICKER_ROW_HEIGHT = 52;
const MEDIA_PICKER_VIEWPORT_HEIGHT = 360;
const MEDIA_PICKER_COLUMNS = "minmax(260px, 1.4fr) minmax(160px, 1fr) 74px 164px 48px";

type CellSettingsDrawerProps = {
  open: boolean;
  panelId: string;
  cell: GridCell | null;
  media: MediaAsset[];
  dispatch: React.Dispatch<AppAction>;
  onClose: () => void;
  onClearCell: (cellId: string) => void;
  panelCells: GridCell[];
  onDeleteMedia: (mediaId: string) => void;
};

export function CellSettingsDrawer({
  open,
  panelId,
  cell,
  media,
  dispatch,
  onClose,
  onClearCell,
  panelCells,
  onDeleteMedia
}: CellSettingsDrawerProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [colorFilter, setColorFilter] = useState("");
  const [pickerScrollTop, setPickerScrollTop] = useState(0);
  const [hotkeyDialogOpen, setHotkeyDialogOpen] = useState(false);
  const [capturedHotkey, setCapturedHotkey] = useState("");
  const [hotkeyError, setHotkeyError] = useState("");
  const [pendingDeleteMediaId, setPendingDeleteMediaId] = useState<string | null>(null);
  const [audioEditorOpen, setAudioEditorOpen] = useState(false);
  const selectedMedia = media.find((item) => item.id === cell?.mediaId) ?? null;
  const filteredMedia = useMemo(
    () =>
      media.filter((item) => {
        const haystack = `${item.fileName} ${item.alias}`.toLowerCase();
        return haystack.includes(query.toLowerCase()) && (!colorFilter || item.color === colorFilter);
      }),
    [colorFilter, media, query]
  );

  useEffect(() => {
    if (open && cell && !selectedMedia) {
      setPickerOpen(true);
    }
  }, [cell, open, selectedMedia]);

  if (!open || !cell) {
    return null;
  }

  const shownName = cell.aliasOverride.trim()
    ? cell.aliasOverride
    : selectedMedia?.alias.trim()
      ? selectedMedia.alias
      : selectedMedia?.fileName ?? "";
  const shownColor = cell.colorOverride ?? selectedMedia?.color ?? "#8cf8ff";
  const pendingDeleteMedia = media.find((item) => item.id === pendingDeleteMediaId) ?? null;
  const pickerStart = Math.max(0, Math.floor(pickerScrollTop / MEDIA_PICKER_ROW_HEIGHT) - 6);
  const pickerEnd = Math.min(
    filteredMedia.length,
    Math.ceil((pickerScrollTop + MEDIA_PICKER_VIEWPORT_HEIGHT) / MEDIA_PICKER_ROW_HEIGHT) + 6
  );
  const visibleMedia = filteredMedia.length > 80 ? filteredMedia.slice(pickerStart, pickerEnd) : filteredMedia;

  const captureHotkey = (event: KeyboardEvent) => {
    event.preventDefault();
    const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
    setCapturedHotkey(
      [
        event.ctrlKey ? "Ctrl" : "",
        event.altKey ? "Alt" : "",
        event.shiftKey ? "Shift" : "",
        event.metaKey ? "Meta" : "",
        key
      ]
        .filter(Boolean)
        .join(" + ")
    );
    setHotkeyError("");
  };

  const saveHotkey = () => {
    if (!capturedHotkey) {
      return;
    }
    const alreadyUsed = panelCells.some(
      (candidate) => candidate.id !== cell.id && candidate.hotkey === capturedHotkey
    );
    if (alreadyUsed) {
      setHotkeyError("Эта комбинация уже используется на текущей панели");
      return;
    }
    dispatch({
      type: "cell/update",
      panelId,
      cellId: cell.id,
      patch: { hotkey: capturedHotkey }
    });
    setHotkeyDialogOpen(false);
  };

  return (
    <Box
      data-noselect
      component="aside"
      aria-label="Настройки ячейки"
      sx={{
        minWidth: 0,
        minHeight: 0,
        width: "100%",
        overflow: "hidden",
        backgroundColor: "rgba(13, 18, 31, 0.96)",
        backdropFilter: "blur(18px)",
        border: 1,
        borderColor: "divider",
        borderRadius: 2
      }}
    >
      <Box sx={{ height: "100%", p: 2, display: "grid", gap: 2, overflowY: "auto" }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Tooltip title="Закрыть настройки">
            <IconButton aria-label="Закрыть настройки ячейки" size="small" onClick={onClose}>
              <CloseIcon />
            </IconButton>
          </Tooltip>
          <Typography variant="h6">Настройки ячейки</Typography>
        </Box>

        {selectedMedia ? (
          <>
            <Box
              role="button"
              tabIndex={0}
              aria-label="Открыть редактор аудио"
              onClick={() => {
                setAudioEditorOpen(true);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  setAudioEditorOpen(true);
                }
              }}
              sx={{
                position: "relative",
                height: 78,
                border: 1,
                borderColor: "rgba(255, 107, 138, 0.42)",
                borderRadius: 2,
                overflow: "hidden",
                cursor: "pointer",
                backgroundColor: "rgba(42, 8, 16, 0.74)",
                display: "flex",
                alignItems: "center",
                gap: 0.5,
                px: 1,
                transition: "border-color 160ms ease, box-shadow 160ms ease",
                "&:hover": {
                  borderColor: "error.main",
                  boxShadow: "0 0 18px rgba(255, 107, 138, 0.22)"
                }
              }}
            >
              {Array.from({ length: 34 }, (_, index) => (
                <Box
                  key={String(index)}
                  sx={{
                    flex: 1,
                    height: `${String(18 + Math.abs(Math.sin(index * 0.62)) * 42)}px`,
                    borderRadius: 999,
                    background: "linear-gradient(180deg, #ff9aad, #ff355d 55%, #6f0d20)"
                  }}
                />
              ))}
              <IconButton
                aria-label="Редактировать аудио"
                sx={{
                  position: "absolute",
                  right: 8,
                  top: "50%",
                  transform: "translateY(-50%)",
                  width: 42,
                  height: 42,
                  borderRadius: 1,
                  backgroundColor: "rgba(5, 7, 13, 0.86)",
                  border: 1,
                  borderColor: "rgba(255, 107, 138, 0.42)"
                }}
              >
                <EditIcon />
              </IconButton>
            </Box>
            <TextField
              label="Псевдоним"
              value={shownName}
              slotProps={{
                htmlInput: {
                  "aria-label": "Псевдоним ячейки"
                }
              }}
              onChange={(event) => {
                dispatch({
                  type: "cell/update",
                  panelId,
                  cellId: cell.id,
                  patch: { aliasOverride: event.target.value }
                });
              }}
            />
            <Typography color="text.secondary">
              Длительность: {formatDuration(selectedMedia.durationMs)}
            </Typography>
            <Box sx={{ display: "grid", gap: 1 }}>
              <Typography>Комбинация клавиш</Typography>
              <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
                <Button
                  startIcon={<KeyboardIcon />}
                  variant="outlined"
                  onClick={() => {
                    setCapturedHotkey(cell.hotkey);
                    setHotkeyError("");
                    setHotkeyDialogOpen(true);
                  }}
                  sx={{ flex: 1, justifyContent: "flex-start" }}
                >
                  {cell.hotkey || "Назначить"}
                </Button>
                {cell.hotkey ? (
                  <>
                    <Tooltip title="Изменить комбинацию">
                      <IconButton
                        aria-label="Изменить комбинацию клавиш"
                        onClick={() => {
                          setCapturedHotkey(cell.hotkey);
                          setHotkeyError("");
                          setHotkeyDialogOpen(true);
                        }}
                      >
                        <EditIcon />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Очистить комбинацию">
                      <IconButton
                        aria-label="Очистить комбинацию клавиш"
                        onClick={() => {
                          dispatch({
                            type: "cell/update",
                            panelId,
                            cellId: cell.id,
                            patch: { hotkey: "" }
                          });
                        }}
                      >
                        <DeleteIcon />
                      </IconButton>
                    </Tooltip>
                  </>
                ) : null}
              </Box>
            </Box>
            <FormControl>
              <FormLabel>Тип проигрывания</FormLabel>
              <RadioGroup
                value={cell.playbackMode}
                onChange={(event) => {
                  dispatch({
                    type: "cell/update",
                    panelId,
                    cellId: cell.id,
                    patch: { playbackMode: event.target.value as PlaybackMode }
                  });
                }}
              >
                <FormControlLabel value="loop" control={<Radio />} label="Loop" />
                <FormControlLabel value="gate" control={<Radio />} label="Gate" />
                <FormControlLabel value="once" control={<Radio />} label="Once" />
              </RadioGroup>
            </FormControl>
            <Box>
              <Typography gutterBottom>Громкость аудио: {cell.volumeOffset}</Typography>
              <Slider
                aria-label="Громкость аудио"
                min={-100}
                max={100}
                value={cell.volumeOffset}
                onChange={(_, value: number | number[]) => {
                  const volumeOffset = Array.isArray(value) ? value[0] ?? 0 : value;
                  dispatch({
                    type: "cell/update",
                    panelId,
                    cellId: cell.id,
                    patch: { volumeOffset }
                  });
                }}
              />
              <TextField
                label="Значение громкости аудио"
                type="number"
                size="small"
                fullWidth
                value={cell.volumeOffset}
                slotProps={{
                  htmlInput: {
                    min: -100,
                    max: 100,
                    step: 1
                  }
                }}
                onChange={(event) => {
                  const nextValue = Number(event.target.value);
                  if (!Number.isFinite(nextValue)) {
                    return;
                  }
                  dispatch({
                    type: "cell/update",
                    panelId,
                    cellId: cell.id,
                    patch: { volumeOffset: Math.min(100, Math.max(-100, nextValue)) }
                  });
                }}
              />
            </Box>
            <Box sx={{ display: "grid", gap: 1 }}>
              <Typography>Цвет</Typography>
              <ColorSwatches
                value={shownColor}
                onChange={(color) => {
                  dispatch({
                    type: "cell/update",
                    panelId,
                    cellId: cell.id,
                    patch: { colorOverride: color }
                  });
                }}
                label="Цвет ячейки"
              />
            </Box>
          </>
        ) : null}

        {pickerOpen ? (
          <Box sx={{ display: "grid", gap: 1, minWidth: 0 }}>
            <TextField
              label="Поиск"
              value={query}
              size="small"
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              slotProps={{
                htmlInput: {
                  "aria-label": "Поиск медиа"
                },
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon fontSize="small" />
                    </InputAdornment>
                  )
                }
              }}
            />
            <Box sx={{ display: "grid", gap: 1 }}>
              <Typography variant="body2" color="text.secondary">
                Фильтр по цвету
              </Typography>
              <Box sx={{ display: "flex", gap: 1, alignItems: "center", minWidth: 0 }}>
                <ColorSwatches
                  value={colorFilter}
                  onChange={(color) => {
                    setColorFilter((current) => (current === color ? "" : color));
                    setPickerScrollTop(0);
                  }}
                  label="Фильтр по цвету медиа"
                />
                <Button
                  size="small"
                  disabled={!colorFilter}
                  onClick={() => {
                    setColorFilter("");
                  }}
                >
                  Сбросить
                </Button>
              </Box>
            </Box>
            <Box role="table" aria-label="Выбор медиа" sx={{ minWidth: 0, maxWidth: "100%", overflowX: "auto" }}>
              <Box sx={{ width: 720, maxWidth: "max-content" }}>
              <Box
                role="row"
                sx={{
                  display: "grid",
                  gridTemplateColumns: MEDIA_PICKER_COLUMNS,
                  alignItems: "center",
                  borderBottom: 1,
                  borderColor: "divider",
                  backgroundColor: "rgba(5, 7, 13, 0.92)"
                }}
              >
                <Typography role="columnheader" sx={{ px: 1, py: 1 }}>
                  Название файла
                </Typography>
                <Typography role="columnheader" sx={{ px: 1, py: 1 }}>
                  Псевдоним
                </Typography>
                <Typography role="columnheader" sx={{ px: 1, py: 1 }}>
                  Время
                </Typography>
                <Typography role="columnheader" sx={{ px: 1, py: 1 }}>
                  Цвет
                </Typography>
                <Box role="columnheader" />
              </Box>
              <Box
                role="rowgroup"
                onScroll={(event) => {
                  setPickerScrollTop(event.currentTarget.scrollTop);
                }}
                sx={{
                  display: "block",
                  maxHeight: MEDIA_PICKER_VIEWPORT_HEIGHT,
                  overflowY: "auto",
                  position: "relative",
                  height: filteredMedia.length > 80 ? MEDIA_PICKER_VIEWPORT_HEIGHT : "auto"
                }}
              >
                <Box
                  component="div"
                  sx={{
                    height: filteredMedia.length > 80 ? filteredMedia.length * MEDIA_PICKER_ROW_HEIGHT : "auto",
                    position: "relative"
                  }}
                >
                {visibleMedia.map((item, visibleIndex) => (
                  <Box
                    key={item.id}
                    tabIndex={0}
                    role="button"
                    aria-label={`Выбрать ${item.fileName}`}
                    onClick={() => {
                      dispatch({
                        type: "cell/assign",
                        panelId,
                        cellId: cell.id,
                        mediaId: item.id
                      });
                      setPickerOpen(false);
                    }}
                    sx={{
                      display: "grid",
                      gridTemplateColumns: MEDIA_PICKER_COLUMNS,
                      alignItems: "center",
                      minHeight: MEDIA_PICKER_ROW_HEIGHT,
                      borderBottom: 1,
                      borderColor: "rgba(169, 183, 207, 0.12)",
                      cursor: "pointer",
                      ...(filteredMedia.length > 80
                        ? {
                            position: "absolute",
                            left: 0,
                            right: 0,
                            top: (pickerStart + visibleIndex) * MEDIA_PICKER_ROW_HEIGHT
                          }
                        : {}),
                      "& .media-delete-button": {
                        opacity: 0,
                        pointerEvents: "none",
                        transition: "opacity 140ms ease"
                      },
                      "&:hover .media-delete-button, &:focus-within .media-delete-button": {
                        opacity: 1,
                        pointerEvents: "auto"
                      }
                    }}
                  >
                    <Typography sx={{ px: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {item.fileName}
                    </Typography>
                    <Typography sx={{ px: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {item.alias || "..."}
                    </Typography>
                    <Typography sx={{ px: 1, whiteSpace: "nowrap" }}>
                      {formatDuration(item.durationMs)}
                    </Typography>
                    <Box sx={{ px: 1 }}>
                      <Box
                        aria-label={`Цвет ${item.fileName}`}
                        sx={{
                          width: 28,
                          height: 18,
                          borderRadius: 0.75,
                          backgroundColor: item.color,
                          border: "1px solid rgba(247, 251, 255, 0.5)"
                        }}
                      />
                    </Box>
                    <Box sx={{ px: 0.5, textAlign: "right" }}>
                      <Tooltip title="Удалить из медиатеки">
                        <IconButton
                          className="media-delete-button"
                          aria-label={`Удалить из медиатеки ${item.fileName}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setPendingDeleteMediaId(item.id);
                          }}
                        >
                          <DeleteIcon />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  </Box>
                ))}
                {filteredMedia.length === 0 ? (
                  <Box
                    role="row"
                    sx={{
                      minHeight: MEDIA_PICKER_ROW_HEIGHT,
                      display: "flex",
                      alignItems: "center",
                      px: 1,
                      borderBottom: 1,
                      borderColor: "rgba(169, 183, 207, 0.12)"
                    }}
                  >
                    <Typography color="text.secondary">Нет аудио</Typography>
                  </Box>
                ) : null}
                </Box>
              </Box>
              </Box>
            </Box>
          </Box>
        ) : null}

        <Box sx={{ display: "flex", gap: 1, mt: "auto" }}>
          <Button
            startIcon={<CheckIcon />}
            variant="contained"
            aria-label="Сохранить настройки ячейки"
            onClick={onClose}
          >
            Ок
          </Button>
          <Button
            startIcon={<ClearIcon />}
            color="warning"
            onClick={() => {
              onClearCell(cell.id);
              }}
          >
            Очистить
          </Button>
        </Box>
      </Box>
      <Dialog
        open={hotkeyDialogOpen}
        onClose={() => {
          setHotkeyDialogOpen(false);
        }}
      >
        <DialogTitle>Комбинация клавиш</DialogTitle>
        <DialogContent>
          <Box
            autoFocus
            tabIndex={0}
            role="button"
            aria-label="Нажмите комбинацию клавиш"
            onKeyDown={captureHotkey}
            sx={{
              mt: 1,
              width: 360,
              minHeight: 96,
              border: 1,
              borderColor: hotkeyError ? "error.main" : "divider",
              borderRadius: 2,
              display: "grid",
              placeItems: "center",
              color: capturedHotkey ? "primary.main" : "text.secondary",
              backgroundColor: "rgba(5, 7, 13, 0.7)"
            }}
          >
            {capturedHotkey || "Нажмите клавишу или комбинацию"}
          </Box>
          {hotkeyError ? (
            <Typography color="error" sx={{ mt: 1 }}>
              {hotkeyError}
            </Typography>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setHotkeyDialogOpen(false);
            }}
          >
            Отмена
          </Button>
          <Button variant="contained" disabled={!capturedHotkey} onClick={saveHotkey}>
            Сохранить
          </Button>
        </DialogActions>
      </Dialog>
      <Snackbar
        open={Boolean(pendingDeleteMedia)}
        anchorOrigin={{ vertical: "top", horizontal: "center" }}
        sx={{
          top: "50% !important",
          left: "50% !important",
          right: "auto !important",
          bottom: "auto !important",
          transform: "translate(-50%, -50%) !important"
        }}
        message={
          pendingDeleteMedia
            ? `Вы действительно хотите удалить "${pendingDeleteMedia.fileName}" из медиатеки?`
            : ""
        }
        action={
          <>
            <Button
              color="inherit"
              onClick={() => {
                if (pendingDeleteMediaId) {
                  onDeleteMedia(pendingDeleteMediaId);
                }
                setPendingDeleteMediaId(null);
              }}
            >
              Удалить
            </Button>
            <Button
              color="inherit"
              onClick={() => {
                setPendingDeleteMediaId(null);
              }}
            >
              Отмена
            </Button>
          </>
        }
      />
      {selectedMedia ? (
        <AudioEditorDialog
          open={audioEditorOpen}
          panelId={panelId}
          cell={cell}
          media={selectedMedia}
          dispatch={dispatch}
          onClose={() => {
            setAudioEditorOpen(false);
          }}
        />
      ) : null}
    </Box>
  );
}

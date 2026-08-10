import DeleteIcon from "@mui/icons-material/Delete";
import {
  Box,
  Button,
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
import { useMemo, useRef, useState } from "react";

import { AppAction } from "../../../app/model/appState";
import { MediaAsset } from "../../../entities/media/model/types";
import { CELL_COLORS } from "../../../shared/config/colorPalette";
import { formatDuration } from "../../../shared/lib/duration";
import { ColorSwatches } from "../../../shared/ui/ColorSwatches";

type MediaLibraryDialogProps = {
  open: boolean;
  media: MediaAsset[];
  dispatch: React.Dispatch<AppAction>;
  onClose: () => void;
  onDeleteMedia: (mediaId: string) => void;
};

const MEDIA_LIBRARY_COLUMNS = "minmax(220px, 1.25fr) minmax(180px, 1fr) 72px minmax(220px, max-content) 52px";

export function MediaLibraryDialog({
  open,
  media,
  dispatch,
  onClose,
  onDeleteMedia
}: MediaLibraryDialogProps) {
  const [query, setQuery] = useState("");
  const [colorFilter, setColorFilter] = useState("");
  const [editingAliasId, setEditingAliasId] = useState<string | null>(null);
  const [draftAlias, setDraftAlias] = useState("");
  const [colorEditorId, setColorEditorId] = useState<string | null>(null);
  const [pendingDeleteMediaId, setPendingDeleteMediaId] = useState<string | null>(null);
  const lastAliasTapRef = useRef<{ id: string; time: number } | null>(null);

  const filteredMedia = useMemo(
    () =>
      media.filter((item) => {
        const haystack = `${item.fileName} ${item.alias}`.toLowerCase();
        return haystack.includes(query.trim().toLowerCase()) && (!colorFilter || item.color === colorFilter);
      }),
    [colorFilter, media, query]
  );
  const pendingDeleteMedia = media.find((item) => item.id === pendingDeleteMediaId) ?? null;

  const beginAliasEdit = (item: MediaAsset) => {
    setEditingAliasId(item.id);
    setDraftAlias(item.alias);
  };

  const finishAliasEdit = () => {
    setEditingAliasId(null);
  };

  const handleAliasPointerUp = (item: MediaAsset) => {
    const now = window.performance.now();
    const lastTap = lastAliasTapRef.current;
    lastAliasTapRef.current = { id: item.id, time: now };
    if (lastTap?.id === item.id && now - lastTap.time < 360) {
      beginAliasEdit(item);
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        fullWidth
        maxWidth="lg"
        slotProps={{
          paper: {
            sx: {
              width: { xs: "calc(100vw - 24px)", sm: "calc(100vw - 64px)" },
              maxWidth: { xs: "calc(100vw - 24px)", sm: 980 },
              maxHeight: { xs: "calc(100dvh - 24px)", sm: "calc(100dvh - 64px)" },
              m: { xs: 1.5, sm: 4 }
            }
          }
        }}
      >
        <DialogTitle>Медиатека</DialogTitle>
        <DialogContent sx={{ overflowX: "auto", p: { xs: 1, sm: 3 } }}>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1.5, alignItems: "center", mb: 2 }}>
            <TextField
              label="Поиск по имени"
              value={query}
              size="small"
              sx={{ width: { xs: "100%", sm: 340 } }}
              slotProps={{ htmlInput: { "aria-label": "Поиск по медиатеке" } }}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75, alignItems: "center" }}>
              <Button
                size="small"
                variant={colorFilter ? "outlined" : "contained"}
                onClick={() => {
                  setColorFilter("");
                }}
              >
                Все
              </Button>
              {CELL_COLORS.map((color) => (
                <Tooltip title={`Фильтр ${color}`} key={color}>
                  <IconButton
                    size="small"
                    aria-label={`Фильтр по цвету ${color}`}
                    onClick={() => {
                      setColorFilter((current) => (current === color ? "" : color));
                    }}
                    sx={{
                      width: 30,
                      height: 30,
                      border: colorFilter === color ? "2px solid" : "1px solid",
                      borderColor: colorFilter === color ? "primary.main" : "rgba(247, 251, 255, 0.32)",
                      backgroundColor: color,
                      "&:hover": { backgroundColor: color }
                    }}
                  />
                </Tooltip>
              ))}
            </Box>
          </Box>

          <Box role="table" aria-label="Медиатека" sx={{ minWidth: 760 }}>
            <Box
              role="row"
              sx={{
                display: "grid",
                gridTemplateColumns: MEDIA_LIBRARY_COLUMNS,
                alignItems: "center",
                minHeight: 42,
                borderBottom: 1,
                borderColor: "divider",
                backgroundColor: "rgba(5, 7, 13, 0.92)"
              }}
            >
              {["Файл", "Псевдоним", "Время", "Цвет", ""].map((title) => (
                <Typography key={title} role="columnheader" sx={{ px: 1, fontWeight: 700 }}>
                  {title}
                </Typography>
              ))}
            </Box>
            {filteredMedia.map((item) => (
              <Box
                role="row"
                key={item.id}
                sx={{
                  display: "grid",
                  gridTemplateColumns: MEDIA_LIBRARY_COLUMNS,
                  alignItems: "center",
                  minHeight: 58,
                  borderBottom: 1,
                  borderColor: "rgba(169, 183, 207, 0.12)",
                  "& .media-delete-button": {
                    opacity: 0,
                    pointerEvents: "none",
                    transition: "opacity 140ms ease"
                  },
                  "&:hover .media-delete-button, &:focus-within .media-delete-button": {
                    opacity: 1,
                    pointerEvents: "auto"
                  },
                  "@media (hover: none)": {
                    "& .media-delete-button": {
                      opacity: 1,
                      pointerEvents: "auto"
                    }
                  }
                }}
              >
                <Typography
                  title={item.fileName}
                  sx={{ minWidth: 0, px: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {item.fileName}
                </Typography>
                <Box
                  sx={{ minWidth: 0, px: 1 }}
                  onDoubleClick={() => {
                    beginAliasEdit(item);
                  }}
                  onPointerUp={() => {
                    handleAliasPointerUp(item);
                  }}
                >
                  {editingAliasId === item.id ? (
                    <TextField
                      autoFocus
                      value={draftAlias}
                      size="small"
                      fullWidth
                      aria-label={`Псевдоним ${item.fileName}`}
                      onChange={(event) => {
                        const alias = event.target.value;
                        setDraftAlias(alias);
                        dispatch({ type: "media/update", mediaId: item.id, alias });
                      }}
                      onBlur={finishAliasEdit}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          finishAliasEdit();
                        }
                        if (event.key === "Escape") {
                          setEditingAliasId(null);
                        }
                      }}
                    />
                  ) : (
                    <Typography
                      title={item.alias || undefined}
                      sx={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      {item.alias || "..."}
                    </Typography>
                  )}
                </Box>
                <Typography sx={{ px: 1, whiteSpace: "nowrap" }}>{formatDuration(item.durationMs)}</Typography>
                <Box sx={{ px: 1, minWidth: 0 }}>
                  <IconButton
                    aria-label={`Изменить цвет ${item.fileName}`}
                    onClick={() => {
                      setColorEditorId((current) => (current === item.id ? null : item.id));
                    }}
                    sx={{
                      width: 34,
                      height: 26,
                      borderRadius: 1,
                      backgroundColor: item.color,
                      border: "1px solid rgba(247, 251, 255, 0.5)",
                      "&:hover": { backgroundColor: item.color }
                    }}
                  />
                  {colorEditorId === item.id ? (
                    <Box sx={{ mt: 1, width: "max-content" }}>
                      <ColorSwatches
                        value={item.color}
                        label={`Цвет ${item.fileName}`}
                        onChange={(color) => {
                          dispatch({ type: "media/update", mediaId: item.id, color });
                          setColorEditorId(null);
                        }}
                      />
                    </Box>
                  ) : null}
                </Box>
                <Box
                  sx={{
                    display: "flex",
                    justifyContent: "center",
                    px: 0.5
                  }}
                >
                  <Tooltip title="Удалить из медиатеки">
                    <IconButton
                      size="small"
                      className="media-delete-button"
                      aria-label={`Удалить из медиатеки ${item.fileName}`}
                      onClick={() => {
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
                  minHeight: 58,
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
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Закрыть</Button>
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
          transform: "translate(-50%, -50%) !important",
          width: { xs: "calc(100vw - 24px)", sm: "auto" },
          maxWidth: { xs: "calc(100vw - 24px)", sm: 560 }
        }}
        message={pendingDeleteMedia ? `Удалить "${pendingDeleteMedia.fileName}" из медиатеки?` : ""}
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
    </>
  );
}

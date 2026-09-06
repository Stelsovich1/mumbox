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
  Tooltip,
  Typography
} from "@mui/material";
import { useEffect, useMemo, useRef, useState } from "react";

import { AppAction } from "../../../app/model/appState";
import { countCellsUsingMedia } from "../../../entities/cell/model/cellUsage";
import { GridCell } from "../../../entities/cell/model/types";
import {
  buildAffectedCellsNote,
  buildMediaDeletionHeadline
} from "../../../entities/media/model/mediaDeletion";
import {
  MEDIA_COMPARATORS,
  MediaSortKey
} from "../../../entities/media/model/mediaSort";
import { MediaAsset } from "../../../entities/media/model/types";
import {
  CELL_COLORS,
  SELECTED_ROW_BACKGROUND,
  SELECTED_ROW_HOVER_BACKGROUND
} from "../../../shared/config/colorPalette";
import { formatDuration } from "../../../shared/lib/duration";
import { formatCreatedAt } from "../../../shared/lib/formatDate";
import { getSelectAllState } from "../../../shared/lib/rowSelection";
import { cycleSortState, SortState, sortRows } from "../../../shared/lib/tableSort";
import { useRowSelection } from "../../../shared/lib/useRowSelection";
import { ColorSwatches } from "../../../shared/ui/ColorSwatches";
import { MobileLandscapeTextField } from "../../../shared/ui/MobileLandscapeTextField";
import { RowSelectCheckbox, SelectAllCheckbox } from "../../../shared/ui/RowSelectionControls";
import { SortableColumnHeader } from "../../../shared/ui/SortableColumnHeader";

type MediaLibraryDialogProps = {
  open: boolean;
  media: MediaAsset[];
  cellsByPanel: Record<string, Record<string, GridCell>>;
  dispatch: React.Dispatch<AppAction>;
  onClose: () => void;
  onDeleteMedia: (mediaIds: string[]) => void;
};

// The date track is a fixed width on purpose: the header and every row are separate grids, so a
// content-derived track resolves differently for the header than for "05.01.2024 09:07" and
// the columns stop lining up. The colour track stays wide enough for its inline swatch popover.
const MEDIA_LIBRARY_COLUMNS =
  "44px minmax(200px, 1.25fr) minmax(160px, 1fr) 72px 124px minmax(200px, max-content) 52px";
const MEDIA_LIBRARY_MIN_WIDTH = 860;

export function MediaLibraryDialog({
  open,
  media,
  cellsByPanel,
  dispatch,
  onClose,
  onDeleteMedia
}: MediaLibraryDialogProps) {
  const [query, setQuery] = useState("");
  const [colorFilter, setColorFilter] = useState("");
  const [editingAliasId, setEditingAliasId] = useState<string | null>(null);
  const [draftAlias, setDraftAlias] = useState("");
  const [colorEditorId, setColorEditorId] = useState<string | null>(null);
  const [pendingDeleteIds, setPendingDeleteIds] = useState<string[]>([]);
  const [sort, setSort] = useState<SortState<MediaSortKey>>(null);
  const lastAliasTapRef = useRef<{ id: string; time: number } | null>(null);
  const { selectedIds, toggle, setMany, clear, prune } = useRowSelection();

  const filteredMedia = useMemo(
    () =>
      media.filter((item) => {
        const haystack = `${item.fileName} ${item.alias}`.toLowerCase();
        return haystack.includes(query.trim().toLowerCase()) && (!colorFilter || item.color === colorFilter);
      }),
    [colorFilter, media, query]
  );
  const sortedMedia = useMemo(
    () => sortRows(filteredMedia, sort, MEDIA_COMPARATORS),
    [filteredMedia, sort]
  );
  const filteredIds = useMemo(() => filteredMedia.map((item) => item.id), [filteredMedia]);
  const selectAllState = getSelectAllState(selectedIds, filteredIds);
  const pendingDeleteTargets = useMemo(
    () => media.filter((item) => pendingDeleteIds.includes(item.id)),
    [media, pendingDeleteIds]
  );
  const pendingDeleteHeadline = buildMediaDeletionHeadline(pendingDeleteTargets);
  const pendingAffectedCellsNote = buildAffectedCellsNote(
    countCellsUsingMedia(cellsByPanel, pendingDeleteIds)
  );

  // A deleted or re-imported asset must not linger in the selection and keep the bulk bar counting
  // rows that no longer exist.
  useEffect(() => {
    prune(media.map((item) => item.id));
  }, [media, prune]);

  useEffect(() => {
    if (!open) {
      clear();
      setPendingDeleteIds([]);
    }
  }, [clear, open]);

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
            <MobileLandscapeTextField
              label="Поиск по имени"
              value={query}
              size="small"
              sx={{ width: { xs: "100%", sm: 340 } }}
              slotProps={{ htmlInput: { "aria-label": "Поиск по медиатеке" } }}
              onValueChange={(value) => {
                setQuery(value);
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

          {selectedIds.size > 0 ? (
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1.5,
                flexWrap: "wrap",
                mb: 1.5
              }}
            >
              <Typography>Выбрано: {String(selectedIds.size)}</Typography>
              <Button
                size="small"
                color="error"
                variant="outlined"
                startIcon={<DeleteIcon />}
                onClick={() => {
                  setPendingDeleteIds([...selectedIds]);
                }}
              >
                Удалить выбранное
              </Button>
              <Button size="small" onClick={clear}>
                Снять выделение
              </Button>
            </Box>
          ) : null}

          <Box role="table" aria-label="Медиатека" sx={{ minWidth: MEDIA_LIBRARY_MIN_WIDTH }}>
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
              <Box role="columnheader" sx={{ display: "grid", placeItems: "center" }}>
                <SelectAllCheckbox
                  label="Выбрать все в медиатеке"
                  state={selectAllState}
                  onChange={(checked) => {
                    setMany(filteredIds, checked);
                  }}
                />
              </Box>
              {(
                [
                  { key: "fileName", title: "Файл" },
                  { key: "alias", title: "Псевдоним" },
                  { key: "durationMs", title: "Время" },
                  { key: "createdAt", title: "Добавлено" },
                  { key: "color", title: "Цвет" }
                ] as const
              ).map((column) => (
                <SortableColumnHeader
                  key={column.key}
                  columnKey={column.key}
                  title={column.title}
                  sort={sort}
                  onSort={(key) => {
                    setSort((current) => cycleSortState(current, key));
                  }}
                />
              ))}
              <Box role="columnheader" />
            </Box>
            {sortedMedia.map((item) => (
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
                  backgroundColor: selectedIds.has(item.id) ? SELECTED_ROW_BACKGROUND : "transparent",
                  transition: "background-color 160ms ease",
                  "&:hover": {
                    backgroundColor: selectedIds.has(item.id)
                      ? SELECTED_ROW_BACKGROUND
                      : SELECTED_ROW_HOVER_BACKGROUND
                  },
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
                <Box role="cell" sx={{ display: "grid", placeItems: "center" }}>
                  <RowSelectCheckbox
                    label={`Выбрать запись ${item.fileName}`}
                    checked={selectedIds.has(item.id)}
                    onChange={() => {
                      toggle(item.id);
                    }}
                  />
                </Box>
                <Typography
                  title={item.fileName}
                  sx={{ minWidth: 0, px: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {item.fileName}
                </Typography>
                <Box
                  sx={{
                    minWidth: 0,
                    px: 1,
                    cursor: "text",
                    "&:hover": {
                      textDecoration: editingAliasId === item.id ? "none" : "underline"
                    }
                  }}
                  onDoubleClick={() => {
                    beginAliasEdit(item);
                  }}
                  onPointerUp={() => {
                    handleAliasPointerUp(item);
                  }}
                >
                  {editingAliasId === item.id ? (
                    <MobileLandscapeTextField
                      autoFocus
                      value={draftAlias}
                      size="small"
                      fullWidth
                      aria-label={`Псевдоним ${item.fileName}`}
                      onValueChange={(value) => {
                        setDraftAlias(value);
                        dispatch({ type: "media/update", mediaId: item.id, alias: value });
                      }}
                      onMobileCommit={finishAliasEdit}
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
                <Typography sx={{ px: 1, whiteSpace: "nowrap" }}>
                  {formatCreatedAt(item.createdAt)}
                </Typography>
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
                        setPendingDeleteIds([item.id]);
                      }}
                    >
                      <DeleteIcon />
                    </IconButton>
                  </Tooltip>
                </Box>
              </Box>
            ))}
            {sortedMedia.length === 0 ? (
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
        <Snackbar
          open={pendingDeleteIds.length > 0}
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
          message={
            <Box sx={{ display: "grid", gap: 0.5 }}>
              <Typography>{pendingDeleteHeadline}</Typography>
              {pendingAffectedCellsNote ? (
                <Typography color="warning.main">{pendingAffectedCellsNote}</Typography>
              ) : null}
            </Box>
          }
          action={
            <>
              <Button
                color="inherit"
                onClick={() => {
                  onDeleteMedia(pendingDeleteIds);
                  clear();
                  setPendingDeleteIds([]);
                }}
              >
                Удалить
              </Button>
              <Button
                color="inherit"
                onClick={() => {
                  setPendingDeleteIds([]);
                }}
              >
                Отмена
              </Button>
            </>
          }
        />
      </Dialog>
    </>
  );
}

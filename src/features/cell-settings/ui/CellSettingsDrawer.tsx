import CheckIcon from "@mui/icons-material/Check";
import ClearIcon from "@mui/icons-material/Clear";
import CloseIcon from "@mui/icons-material/Close";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DeleteIcon from "@mui/icons-material/Delete";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
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
  MenuItem,
  Radio,
  RadioGroup,
  Snackbar,
  TextField,
  Tooltip,
  Typography
} from "@mui/material";
import useMediaQuery from "@mui/material/useMediaQuery";
import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

import { AppAction } from "../../../app/model/appState";
import { countCellsUsingMedia } from "../../../entities/cell/model/cellUsage";
import { GridCell, PlaybackMode } from "../../../entities/cell/model/types";
import {
  buildAffectedCellsNote,
  buildMediaDeletionHeadline
} from "../../../entities/media/model/mediaDeletion";
import { MEDIA_COMPARATORS, MediaSortKey } from "../../../entities/media/model/mediaSort";
import { MediaAsset } from "../../../entities/media/model/types";
import { Panel } from "../../../entities/panel/model/types";
import { AudioEditorDialog } from "../../../features/audio-editor";
import {
  SELECTED_ROW_BACKGROUND,
  SELECTED_ROW_HOVER_BACKGROUND
} from "../../../shared/config/colorPalette";
import { formatDuration } from "../../../shared/lib/duration";

import {
  beginNativeMediaDrag,
  beginPointerMediaDrag,
  cancelMediaDrag,
  endNativeMediaDrag
} from "../../../shared/lib/mediaDragSession";
import { encodeMediaDragPayload, MEDIA_DRAG_MIME } from "../../../shared/lib/mediaDragTransfer";
import {
  resolveDraggedMediaIds
} from "../../../shared/lib/mediaDistribution";
import { isInteractiveRowTarget } from "../../../shared/lib/interactiveTarget";
import { getSelectAllState } from "../../../shared/lib/rowSelection";
import { cycleSortState, SortState, sortRows } from "../../../shared/lib/tableSort";
import { useRowSelection } from "../../../shared/lib/useRowSelection";
import { ColorSwatches } from "../../../shared/ui/ColorSwatches";
import { MobileLandscapeTextField } from "../../../shared/ui/MobileLandscapeTextField";
import { CreatedAtCell } from "../../../shared/ui/CreatedAtCell";
import { RowSelectCheckbox, SelectAllCheckbox } from "../../../shared/ui/RowSelectionControls";
import { SortableColumnHeader } from "../../../shared/ui/SortableColumnHeader";

// Covers the sticky header as well as the rows now that both live in one scroller, so the row area
// stays about as tall as it was before the header grew to two lines.
const MEDIA_PICKER_VIEWPORT_HEIGHT = 420;
/** Clipped, so a value can never render on top of the next column. */
const PICKER_VALUE_CELL = {
  minWidth: 0,
  px: 0.75,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap"
} as const;
const MEDIA_PICKER_ROW_HEIGHT = 52;
// 32 + 36 + 120 + 64 + 52 + 84 + 52 + 36. Keeping the arithmetic exact is what stops the header
// grid and the body grids drifting apart, which the column-alignment e2e pins. The date track is
// fixed rather than content-derived for the same reason, and sized for the SHORT date the picker
// renders plus its padding.
//
// The colour track holds a 26px swatch: at 36px minus the cell padding there was only 20px of
// content box, so the swatch overflowed onto the delete button. Every value cell now clips, so a
// too-long value can never reach its neighbour again.
//
// Eight columns still cannot fit a 460px panel (412px of table viewport), so a modest horizontal
// scroll remains by design; the panel is resizable for when the table is the focus.
// Every sortable track is at least as wide as its own label plus the sort icon, measured at 13px
// JetBrains Mono: label + 4px gap + 16px icon + 12px padding. Nothing is ever clipped, and the two
// text columns grow with the panel up to a cap rather than swallowing it.
//   Файл 36+32 · Псевдоним 80+32 · Время 44+32 · Добавлено 80+32 · Цвет 36+32
// Plus 6px of slack each: at exactly the computed width sub-pixel rounding still clipped the last
// glyph. The table needs 616px against 412px of visible panel, so it scrolls horizontally by
// design; the panel is resizable for when the table is the focus.
const MEDIA_PICKER_COLUMNS =
  "32px 36px minmax(120px, 320px) minmax(118px, 200px) 82px 118px 74px 36px";
const MEDIA_PICKER_MIN_WIDTH = 616;

type CellSettingsDrawerProps = {
  open: boolean;
  panelId: string;
  cell: GridCell | null;
  panels: Panel[];
  cellsByPanel: Record<string, Record<string, GridCell>>;
  media: MediaAsset[];
  dispatch: React.Dispatch<AppAction>;
  onClose: () => void;
  onClearCell: (cellId: string) => void;
  panelCells: GridCell[];
  onDeleteMedia: (mediaIds: string[]) => void;
};

export function CellSettingsDrawer({
  open,
  panelId,
  cell,
  panels,
  cellsByPanel,
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
  const [pendingDeleteIds, setPendingDeleteIds] = useState<string[]>([]);
  const [sort, setSort] = useState<SortState<MediaSortKey>>(null);
  const [audioEditorOpen, setAudioEditorOpen] = useState(false);
  const [copyDialogOpen, setCopyDialogOpen] = useState(false);
  const [copyTargetPanelId, setCopyTargetPanelId] = useState("");
  const [aliasDraft, setAliasDraft] = useState("");
  const hotkeyCaptureRef = useRef<HTMLDivElement | null>(null);
  const pickerBodyRef = useRef<HTMLDivElement | null>(null);
  const { selectedIds, toggle, setMany, clear, prune } = useRowSelection();
  const aliasDraftSeedRef = useRef("");
  const hideHotkeySettings = useMediaQuery("(hover: none), (max-width: 700px)");
  // One drag mechanism per input type. On a coarse pointer the row is not `draggable` at all, so
  // iOS Safari cannot start a native long-press drag while our pointer session is running.
  const coarsePointer = useMediaQuery("(hover: none) and (pointer: coarse)");
  const cellId = cell?.id ?? null;
  const cellMediaId = cell?.mediaId ?? null;
  const selectedMedia = media.find((item) => item.id === cell?.mediaId) ?? null;
  const defaultAliasName = selectedMedia?.alias.trim()
    ? selectedMedia.alias
    : selectedMedia?.fileName ?? "";
  const filteredMedia = useMemo(
    () =>
      media.filter((item) => {
        const haystack = `${item.fileName} ${item.alias}`.toLowerCase();
        return haystack.includes(query.toLowerCase()) && (!colorFilter || item.color === colorFilter);
      }),
    [colorFilter, media, query]
  );
  const copyPanelOptions = useMemo(
    () =>
      panels
        .map((panel) => {
          const cells = cellsByPanel[panel.id] ?? {};
          const freeCellId = panel.cellIds.find((id) => !cells[id]?.mediaId);
          return freeCellId ? { panel, freeCellId } : null;
        })
        .filter((option): option is { panel: Panel; freeCellId: string } => Boolean(option)),
    [cellsByPanel, panels]
  );
  const canCopyCell = Boolean(cellMediaId) && copyPanelOptions.length > 0;
  const selectedCopyOption =
    copyPanelOptions.find((option) => option.panel.id === copyTargetPanelId) ?? copyPanelOptions[0] ?? null;

  useEffect(() => {
    prune(media.map((item) => item.id));
  }, [media, prune]);

  // Closing the drawer mid-drag must not strand a pointer session on the window.
  useEffect(() => cancelMediaDrag, []);

  useEffect(() => {
    if (!open) {
      clear();
      setPendingDeleteIds([]);
    }
  }, [clear, open]);

  useEffect(() => {
    if (!open || !cellId) {
      setPickerOpen(false);
      return;
    }

    if (selectedMedia) {
      setPickerOpen(false);
      return;
    }

    setPickerOpen(true);
  }, [cellId, cellMediaId, open, selectedMedia]);

  useEffect(() => {
    if (!copyDialogOpen) {
      return;
    }
    if (selectedCopyOption && selectedCopyOption.panel.id !== copyTargetPanelId) {
      setCopyTargetPanelId(selectedCopyOption.panel.id);
    }
  }, [copyDialogOpen, copyTargetPanelId, selectedCopyOption]);

  useEffect(() => {
    if (!hotkeyDialogOpen) {
      return;
    }

    window.requestAnimationFrame(() => {
      hotkeyCaptureRef.current?.focus();
    });
  }, [hotkeyDialogOpen]);

  useEffect(() => {
    if (!open || !cellId || !selectedMedia) {
      aliasDraftSeedRef.current = "";
      setAliasDraft("");
      return;
    }

    const seedKey = `${cellId}:${cellMediaId ?? ""}`;
    if (aliasDraftSeedRef.current === seedKey) {
      return;
    }
    aliasDraftSeedRef.current = seedKey;
    setAliasDraft(cell?.aliasOverride.trim() ? cell.aliasOverride : defaultAliasName);
  }, [cell?.aliasOverride, cellId, cellMediaId, defaultAliasName, open, selectedMedia]);

  const sortedMedia = useMemo(
    () => sortRows(filteredMedia, sort, MEDIA_COMPARATORS),
    [filteredMedia, sort]
  );
  const filteredIds = useMemo(() => filteredMedia.map((item) => item.id), [filteredMedia]);
  // Selection is order-insensitive, but a multi-row drag distributes in display order, so it
  // must read the sorted list rather than the merely filtered one.
  const sortedIds = useMemo(() => sortedMedia.map((item) => item.id), [sortedMedia]);
  const selectAllState = getSelectAllState(selectedIds, filteredIds);
  const pendingDeleteTargets = useMemo(
    () => media.filter((item) => pendingDeleteIds.includes(item.id)),
    [media, pendingDeleteIds]
  );
  const pendingDeleteHeadline = buildMediaDeletionHeadline(pendingDeleteTargets);
  const pendingAffectedCellsNote = buildAffectedCellsNote(
    countCellsUsingMedia(cellsByPanel, pendingDeleteIds)
  );

  if (!open || !cell) {
    return null;
  }

  const shownColor = cell.colorOverride ?? selectedMedia?.color ?? "#ec5aa7";
  const canClearCell =
    Boolean(cell.mediaId) ||
    cell.aliasOverride.length > 0 ||
    cell.colorOverride !== null ||
    cell.hotkey.length > 0 ||
    cell.playbackMode !== "once" ||
    cell.volumeOffset !== 0 ||
    cell.trimStartMs !== null ||
    cell.trimEndMs !== null ||
    cell.fadeInEnabled ||
    cell.fadeInMs !== 0 ||
    cell.fadeOutEnabled ||
    cell.fadeOutMs !== 0;
  // `pickerScrollTop` now comes from the scroller that also holds the sticky header, so it is
  // ahead of the row offsets by the header height (~45px, under one row). The six-row overscan
  // below absorbs that entirely, which is why no header measurement is needed.
  const pickerStart = Math.max(0, Math.floor(pickerScrollTop / MEDIA_PICKER_ROW_HEIGHT) - 6);
  const pickerEnd = Math.min(
    sortedMedia.length,
    Math.ceil((pickerScrollTop + MEDIA_PICKER_VIEWPORT_HEIGHT) / MEDIA_PICKER_ROW_HEIGHT) + 6
  );
  const visibleMedia = sortedMedia.length > 80 ? sortedMedia.slice(pickerStart, pickerEnd) : sortedMedia;
  const emptyPickerText = colorFilter ? "по фильтру нет аудио" : "Нет аудио";

  const resetPickerScroll = () => {
    setPickerScrollTop(0);
    if (pickerBodyRef.current) {
      pickerBodyRef.current.scrollTop = 0;
    }
  };

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
      <Box
        sx={{
          height: "100%",
          p: { xs: 1.5, sm: 2.5 },
          display: "grid",
          gridTemplateRows: "minmax(0, 1fr) auto",
          alignContent: "start",
          gap: { xs: 1, sm: 2 },
          overflow: "hidden"
        }}
      >
        <Box
          sx={{
            minHeight: 0,
            display: "grid",
            alignContent: "start",
            gap: { xs: 1, sm: 2 },
            overflowY: "auto",
            pr: { xs: 0.25, sm: 0.75 }
          }}
        >
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
            <MobileLandscapeTextField
              label="Псевдоним"
              value={aliasDraft}
              slotProps={{
                htmlInput: {
                  "aria-label": "Псевдоним ячейки",
                  placeholder: defaultAliasName
                }
              }}
              onValueChange={(value) => {
                setAliasDraft(value);
                dispatch({
                  type: "cell/update",
                  panelId,
                  cellId: cell.id,
                  patch: { aliasOverride: value }
                });
              }}
            />
            <Typography color="text.secondary">
              Длительность: {formatDuration(selectedMedia.durationMs)}
            </Typography>
            {!hideHotkeySettings ? (
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
            ) : null}
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
            <MobileLandscapeTextField
              label="Поиск"
              value={query}
              size="small"
              onValueChange={(value) => {
                setQuery(value);
                resetPickerScroll();
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
              <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, alignItems: "center", minWidth: 0 }}>
                <Box sx={{ pl: 0.5 }}>
                  <ColorSwatches
                    value={colorFilter}
                    onChange={(color) => {
                      setColorFilter((current) => (current === color ? "" : color));
                      resetPickerScroll();
                    }}
                    label="Фильтр по цвету медиа"
                  />
                </Box>
                <Button
                  size="small"
                  disabled={!colorFilter}
                  onClick={() => {
                    setColorFilter("");
                    resetPickerScroll();
                  }}
                >
                  Сбросить
                </Button>
              </Box>
            </Box>
            {selectedIds.size > 0 ? (
              <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
                <Typography variant="body2">Выбрано: {String(selectedIds.size)}</Typography>
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
            <Box
              role="table"
              aria-label="Выбор медиа"
              ref={pickerBodyRef}
              onScroll={(event) => {
                setPickerScrollTop(event.currentTarget.scrollTop);
              }}
              sx={{
                minWidth: 0,
                maxWidth: "100%",
                // Both axes on one element: two nested scrollers gave the panel two horizontal
                // scrollbars, and made the rows' content box narrower than the header's by the
                // width of the vertical scrollbar, so the last column was clipped.
                overflow: "auto",
                maxHeight: MEDIA_PICKER_VIEWPORT_HEIGHT
              }}
            >
              <Box sx={{ width: `max(100%, ${String(MEDIA_PICKER_MIN_WIDTH)}px)` }}>
              <Box
                role="row"
                sx={{
                  display: "grid",
                  gridTemplateColumns: MEDIA_PICKER_COLUMNS,
                  alignItems: "center",
                  borderBottom: 1,
                  borderColor: "divider",
                  backgroundColor: "rgba(5, 7, 13, 0.92)",
                  // The header scrolls with the rows horizontally and stays put vertically.
                  position: "sticky",
                  top: 0,
                  zIndex: 1
                }}
              >
                <Box role="columnheader" />
                <Box role="columnheader" sx={{ display: "grid", placeItems: "center" }}>
                  <SelectAllCheckbox
                    size="small"
                    label="Выбрать все медиа"
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
                      resetPickerScroll();
                    }}
                  />
                ))}
                  <Box role="columnheader" />
              </Box>
              <Box role="rowgroup" sx={{ display: "block", position: "relative" }}>
                <Box
                  component="div"
                  sx={{
                    height: sortedMedia.length > 80 ? sortedMedia.length * MEDIA_PICKER_ROW_HEIGHT : "auto",
                    position: "relative"
                  }}
                >
                {visibleMedia.map((item, visibleIndex) => (
                  <Box
                    key={item.id}
                    tabIndex={0}
                    role="button"
                    data-media-row
                    data-media-id={item.id}
                    draggable={!coarsePointer}
                    aria-label={`Выбрать ${item.fileName}`}
                    onDragStart={(event) => {
                      const dragged = resolveDraggedMediaIds({
                        draggedMediaId: item.id,
                        selectedMediaIds: selectedIds,
                        displayOrder: sortedIds
                      });
                      beginNativeMediaDrag(dragged);
                      event.dataTransfer.effectAllowed = "copy";
                      event.dataTransfer.setData(MEDIA_DRAG_MIME, encodeMediaDragPayload(dragged));
                    }}
                    onDragEnd={() => {
                      endNativeMediaDrag();
                    }}
                    onClick={(event) => {
                      // The checkbox and the delete button live inside the row; neither may assign.
                      if (isInteractiveRowTarget(event.target, event.currentTarget)) {
                        return;
                      }
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
                      backgroundColor: selectedIds.has(item.id)
                        ? SELECTED_ROW_BACKGROUND
                        : "transparent",
                      transition: "background-color 160ms ease",
                      "&:hover": {
                        backgroundColor: selectedIds.has(item.id)
                          ? SELECTED_ROW_BACKGROUND
                          : SELECTED_ROW_HOVER_BACKGROUND
                      },
                      ...(sortedMedia.length > 80
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
                      },
                      "@media (hover: none)": {
                        "& .media-delete-button": {
                          opacity: 1,
                          pointerEvents: "auto"
                        }
                      }
                    }}
                  >
                    <Box sx={{ display: "grid", placeItems: "center" }}>
                      <Tooltip title="Перетащить на ячейку">
                        <Box
                          role="button"
                          tabIndex={-1}
                          data-media-drag-handle
                          aria-label={`Перетащить ${item.fileName}`}
                          onClick={(event) => {
                            // Without this the synthesised click after a touch drag bubbles to the
                            // row and assigns the media to the selected cell.
                            event.stopPropagation();
                          }}
                          onPointerDown={(event) => {
                            // Every pointer type, not just touch. Gating this on `pointerType` made
                            // the handle inert under devtools device emulation and on hybrid
                            // laptops, and the row body cannot be the touch source — there it
                            // scrolls the list.
                            event.preventDefault();
                            beginPointerMediaDrag({
                              mediaIds: resolveDraggedMediaIds({
                                draggedMediaId: item.id,
                                selectedMediaIds: selectedIds,
                                displayOrder: sortedIds
                              }),
                              pointerId: event.pointerId,
                              clientX: event.clientX,
                              clientY: event.clientY,
                              sourceElement: event.currentTarget
                            });
                          }}
                          sx={{
                            display: "grid",
                            placeItems: "center",
                            width: 30,
                            height: 30,
                            borderRadius: 1,
                            color: "text.secondary",
                            cursor: "grab",
                            // Scoped to the handle: `touch-action: none` on the row itself would
                            // kill both the vertical list scroll and the horizontal table scroll.
                            touchAction: "none"
                          }}
                        >
                          <DragIndicatorIcon fontSize="small" />
                        </Box>
                      </Tooltip>
                    </Box>
                    <Box sx={{ display: "grid", placeItems: "center" }}>
                      <RowSelectCheckbox
                        size="small"
                        label={`Отметить ${item.fileName}`}
                        checked={selectedIds.has(item.id)}
                        onChange={() => {
                          toggle(item.id);
                        }}
                      />
                    </Box>
                    <Typography
                      title={item.fileName}
                      sx={{
                        minWidth: 0,
                        px: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap"
                      }}
                    >
                      {item.fileName}
                    </Typography>
                    <Typography
                      title={item.alias || undefined}
                      sx={{
                        minWidth: 0,
                        px: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap"
                      }}
                    >
                      {item.alias || "..."}
                    </Typography>
                    <Typography sx={PICKER_VALUE_CELL}>{formatDuration(item.durationMs)}</Typography>
                    <CreatedAtCell value={item.createdAt} />
                    <Box sx={{ display: "grid", placeItems: "center", minWidth: 0 }}>
                      <Box
                        aria-label={`Цвет ${item.fileName}`}
                        sx={{
                          width: 26,
                          height: 18,
                          borderRadius: 0.75,
                          backgroundColor: item.color,
                          border: "1px solid rgba(247, 251, 255, 0.5)"
                        }}
                      />
                    </Box>
                    <Box sx={{ display: "grid", placeItems: "center", justifySelf: "stretch" }}>
                      <Tooltip title="Удалить из медиатеки">
                        <IconButton
                          size="small"
                          className="media-delete-button"
                          aria-label={`Удалить из медиатеки ${item.fileName}`}
                          onClick={(event) => {
                            event.stopPropagation();
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
                      minHeight: MEDIA_PICKER_ROW_HEIGHT,
                      display: "flex",
                      alignItems: "center",
                      px: 1,
                      borderBottom: 1,
                      borderColor: "rgba(169, 183, 207, 0.12)"
                    }}
                  >
                    <Typography color="text.secondary">{emptyPickerText}</Typography>
                  </Box>
                ) : null}
                </Box>
              </Box>
              </Box>
            </Box>
          </Box>
          ) : null}
        </Box>

        {selectedMedia ? (
          <Box
            sx={{
              display: "grid",
              pt: { xs: 0.25, sm: 0 },
              borderTop: 1,
              borderColor: "rgba(169, 183, 207, 0.1)"
            }}
          >
            <Button
              startIcon={<ContentCopyIcon />}
              variant="outlined"
              disabled={!canCopyCell}
              onClick={() => {
                if (!selectedCopyOption) {
                  return;
                }
                setCopyTargetPanelId(selectedCopyOption.panel.id);
                setCopyDialogOpen(true);
              }}
              sx={{ justifySelf: "stretch" }}
            >
              Скопировать
            </Button>
          </Box>
        ) : null}

        <Box
          sx={{
            display: "flex",
            flexWrap: "wrap",
            gap: 1,
            pt: { xs: 0.75, sm: 1 },
            pb: "calc(8px + var(--app-safe-area-bottom))",
            borderTop: 1,
            borderColor: "rgba(169, 183, 207, 0.16)",
            backgroundColor: "rgba(13, 18, 31, 0.96)"
          }}
        >
          <Button
            startIcon={<CheckIcon />}
            variant="contained"
            aria-label="Сохранить настройки ячейки"
            onClick={onClose}
          >
            Ок
          </Button>
          {canClearCell ? (
            <Button
              startIcon={<ClearIcon />}
              color="warning"
              onClick={() => {
                onClearCell(cell.id);
              }}
            >
              Очистить
            </Button>
          ) : null}
        </Box>
      </Box>
      <Dialog
        open={copyDialogOpen}
        onClose={() => {
          setCopyDialogOpen(false);
        }}
        slotProps={{
          paper: {
            sx: {
              width: { xs: "calc(100vw - 24px)", sm: 420 },
              maxWidth: { xs: "calc(100vw - 24px)", sm: 420 },
              maxHeight: "calc(100dvh - 24px)",
              m: { xs: 1.5, sm: 4 }
            }
          }
        }}
      >
        <DialogTitle>Скопировать</DialogTitle>
        <DialogContent>
          <Box sx={{ display: "grid", gap: 1.5, pt: 1 }}>
            <TextField
              select
              label="Панель"
              value={selectedCopyOption?.panel.id ?? ""}
              onChange={(event) => {
                setCopyTargetPanelId(event.target.value);
              }}
              fullWidth
            >
              {copyPanelOptions.map((option) => (
                <MenuItem key={option.panel.id} value={option.panel.id}>
                  {option.panel.name}
                </MenuItem>
              ))}
            </TextField>
            {selectedCopyOption ? (
              <Typography color="text.secondary">
                Копия будет помещена в первую свободную ячейку: {selectedCopyOption.freeCellId.replace("cell-", "#")}
              </Typography>
            ) : (
              <Typography color="text.secondary">Нет панелей со свободными ячейками.</Typography>
            )}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setCopyDialogOpen(false);
            }}
          >
            Отмена
          </Button>
          <Button
            variant="contained"
            disabled={!selectedCopyOption}
            onClick={() => {
              if (!selectedCopyOption) {
                return;
              }
              dispatch({
                type: "cell/copy",
                fromPanelId: panelId,
                fromCellId: cell.id,
                toPanelId: selectedCopyOption.panel.id,
                toCellId: selectedCopyOption.freeCellId
              });
              setCopyDialogOpen(false);
            }}
          >
            Скопировать
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={hotkeyDialogOpen}
        onClose={() => {
          setHotkeyDialogOpen(false);
        }}
        slotProps={{
          paper: {
            sx: {
              width: { xs: "calc(100vw - 24px)", sm: "auto" },
              maxWidth: { xs: "calc(100vw - 24px)", sm: 444 },
              maxHeight: "calc(100dvh - 24px)",
              m: { xs: 1.5, sm: 4 }
            }
          }
        }}
      >
        <DialogTitle>Комбинация клавиш</DialogTitle>
        <DialogContent>
          <Box
            ref={hotkeyCaptureRef}
            autoFocus
            tabIndex={0}
            role="button"
            aria-label="Нажмите комбинацию клавиш"
            onKeyDown={captureHotkey}
            sx={{
              mt: 1,
              width: { xs: "100%", sm: 360 },
              minHeight: 96,
              border: 1,
              borderColor: hotkeyError ? "error.main" : "divider",
              borderRadius: 2,
              display: "grid",
              placeItems: "center",
              color: capturedHotkey ? "primary.main" : "text.secondary",
              backgroundColor: "rgba(5, 7, 13, 0.7)",
              cursor: "default"
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
                resetPickerScroll();
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

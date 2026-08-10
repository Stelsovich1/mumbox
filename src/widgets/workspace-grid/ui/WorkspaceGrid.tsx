import { Box, Typography } from "@mui/material";
import { useMemo, useRef, useState } from "react";

import { GridCell, PlaybackMode } from "../../../entities/cell/model/types";
import { MediaAsset } from "../../../entities/media/model/types";
import { GridSize } from "../../../entities/panel/model/types";
import { getReadableTextColor } from "../../../shared/lib/contrast";

type WorkspaceGridProps = {
  panelId: string;
  gridSize: GridSize;
  cells: GridCell[];
  media: MediaAsset[];
  editMode: boolean;
  selectedCellId: string | null;
  playingCells: { cellKey: string; progress: number }[];
  warmedMedia: { mediaId: string; state: "warming" | "ready" }[];
  onCellClick: (cell: GridCell) => void;
  onGateStart: (cell: GridCell) => void;
  onGateEnd: (cell: GridCell) => void;
  onCellMove: (fromCellId: string, toCellId: string) => void;
};

type PlaybackIndicatorProps = {
  mode: PlaybackMode;
  progress: number;
  active: boolean;
  color: string;
};

type TouchDragState = {
  fromCellId: string;
  overCellId: string | null;
  active: boolean;
};

function mixHexColor(hexColor: string, targetHexColor: string, amount: number) {
  if (!/^#[\da-f]{6}$/i.test(hexColor) || !/^#[\da-f]{6}$/i.test(targetHexColor)) {
    return hexColor;
  }

  const normalized = hexColor.replace("#", "");
  const target = targetHexColor.replace("#", "");
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  const targetRed = Number.parseInt(target.slice(0, 2), 16);
  const targetGreen = Number.parseInt(target.slice(2, 4), 16);
  const targetBlue = Number.parseInt(target.slice(4, 6), 16);
  const channel = (value: number, targetValue: number) =>
    Math.round(value + (targetValue - value) * amount)
      .toString(16)
      .padStart(2, "0");

  return `#${channel(red, targetRed)}${channel(green, targetGreen)}${channel(blue, targetBlue)}`;
}

function PlaybackIndicator({ mode, progress, active, color }: PlaybackIndicatorProps) {
  const guideColor = `color-mix(in srgb, ${color} ${active ? "40%" : "62%"}, transparent)`;
  const markerColor = `color-mix(in srgb, ${color} ${active ? "92%" : "86%"}, transparent)`;

  if (mode === "loop") {
    const angle = progress * Math.PI * 2 - Math.PI / 2;
    const radius = 14;
    const center = 18;
    const dotX = center + Math.cos(angle) * radius;
    const dotY = center + Math.sin(angle) * radius;

    return (
      <Box
        component="svg"
        viewBox="0 0 36 36"
        aria-hidden="true"
        sx={{ width: "clamp(12px, 34cqw, 42px)" }}
      >
        <circle
          cx="18"
          cy="18"
          r="14"
          fill="none"
          stroke={guideColor}
          strokeWidth="3"
        />
        <circle cx={dotX} cy={dotY} r="2.25" fill={color} />
      </Box>
    );
  }

  return (
    <Box
      aria-hidden="true"
      data-playback-indicator={mode}
      sx={{
        position: "relative",
        width: "clamp(14px, 48cqw, 58px)",
        height: "clamp(9px, 18cqh, 20px)",
        overflow: "visible"
      }}
    >
      {mode === "once" ? (
        <>
          <Box
            data-testid="once-left-boundary"
            sx={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: "clamp(2px, 5cqw, 4px)",
              borderRadius: 999,
              backgroundColor: markerColor,
              boxShadow: `0 0 6px ${markerColor}`
            }}
          />
          <Box
            data-testid="once-right-boundary"
            sx={{
              position: "absolute",
              right: 0,
              top: 0,
              bottom: 0,
              width: "clamp(2px, 5cqw, 4px)",
              borderRadius: 999,
              backgroundColor: markerColor,
              boxShadow: `0 0 6px ${markerColor}`
            }}
          />
        </>
      ) : null}
      <Box
        sx={{
          position: "absolute",
          left: mode === "once" ? 2 : 0,
          right: mode === "once" ? 2 : 0,
          top: "50%",
          height: 2,
          backgroundColor: guideColor,
          transform: "translateY(-50%)"
        }}
      />
      <Box
        sx={{
          position: "absolute",
          left: `${String(progress * 100)}%`,
          top: "50%",
          width: "clamp(3px, 5cqw, 5px)",
          height: "clamp(3px, 5cqw, 5px)",
          borderRadius: "50%",
          backgroundColor: color,
          transform: "translate(-50%, -50%)"
        }}
      />
    </Box>
  );
}

export function WorkspaceGrid({
  panelId,
  gridSize,
  cells,
  media,
  editMode,
  selectedCellId,
  playingCells,
  warmedMedia,
  onCellClick,
  onGateStart,
  onGateEnd,
  onCellMove
}: WorkspaceGridProps) {
  const [dragOverCellId, setDragOverCellId] = useState<string | null>(null);
  const [draggingCellId, setDraggingCellId] = useState<string | null>(null);
  const [touchDrag, setTouchDrag] = useState<TouchDragState | null>(null);
  const pointerActivatedCellIdRef = useRef<string | null>(null);
  const touchDragRef = useRef<TouchDragState | null>(null);
  const touchDragTimerRef = useRef<number | null>(null);
  const suppressClickTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const playingByCellKey = useMemo(
    () => new Map(playingCells.map((cell) => [cell.cellKey, cell.progress])),
    [playingCells]
  );

  const clearTouchDragTimer = () => {
    if (touchDragTimerRef.current) {
      window.clearTimeout(touchDragTimerRef.current);
      touchDragTimerRef.current = null;
    }
  };

  const finishTouchDrag = (move: boolean) => {
    clearTouchDragTimer();
    const current = touchDragRef.current;
    touchDragRef.current = null;
    setTouchDrag(null);
    setDragOverCellId(null);
    if (move && current?.active && current.overCellId && current.overCellId !== current.fromCellId) {
      onCellMove(current.fromCellId, current.overCellId);
    }
  };

  const suppressNextClick = () => {
    suppressClickRef.current = true;
    if (suppressClickTimerRef.current) {
      window.clearTimeout(suppressClickTimerRef.current);
    }
    suppressClickTimerRef.current = window.setTimeout(() => {
      suppressClickRef.current = false;
      suppressClickTimerRef.current = null;
    }, 300);
  };

  const beginTouchDrag = (cellId: string) => {
    const nextDrag = { fromCellId: cellId, overCellId: cellId, active: false };
    touchDragRef.current = nextDrag;
    setTouchDrag(nextDrag);
    clearTouchDragTimer();
    touchDragTimerRef.current = window.setTimeout(() => {
      const activeDrag = { ...nextDrag, active: true };
      suppressNextClick();
      touchDragRef.current = activeDrag;
      setTouchDrag(activeDrag);
      setDragOverCellId(cellId);
    }, 180);
  };

  const updateTouchDragTarget = (clientX: number, clientY: number) => {
    const currentDrag = touchDragRef.current;
    if (!currentDrag?.active) {
      return;
    }
    const targetCell = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>("[data-cell-id]");
    const overCellId = targetCell?.dataset.cellId ?? currentDrag.overCellId;
    if (overCellId && overCellId !== currentDrag.overCellId) {
      const nextDrag = { ...currentDrag, overCellId };
      touchDragRef.current = nextDrag;
      setTouchDrag(nextDrag);
      setDragOverCellId(overCellId);
    }
  };

  return (
    <Box
      data-noselect
      aria-label={`Рабочая сетка ${String(gridSize)} на ${String(gridSize)}`}
      sx={{
        minWidth: 0,
        minHeight: 0,
        containerType: "size",
        display: "grid",
        placeItems: "center",
        border: 1,
        borderColor: editMode ? "secondary.main" : "divider",
        borderRadius: 2,
        backgroundColor: "rgba(7, 11, 20, 0.62)",
        p: { xs: 0.5, md: 0.75 },
        boxShadow: editMode
          ? "0 0 0 1px rgba(255, 204, 102, 0.42), 0 0 22px rgba(255, 204, 102, 0.18), inset 0 0 36px rgba(255, 204, 102, 0.05)"
          : "inset 0 0 36px rgba(236, 90, 167, 0.07)",
        transition: "border-color 160ms ease, box-shadow 160ms ease"
      }}
    >
      <Box
        sx={{
          width: "100%",
          height: "100%",
          maxWidth: "100%",
          maxHeight: "100%",
          display: "grid",
          gridTemplateColumns: `repeat(${String(gridSize)}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${String(gridSize)}, minmax(0, 1fr))`,
          gap: { xs: 0.5, md: 0.75 },
          "@media (orientation: portrait) and (max-width: 700px)": {
            width: "min(100cqw, 100cqh)",
            height: "min(100cqw, 100cqh)",
            aspectRatio: "1 / 1"
          }
        }}
      >
        {cells.map((cell, index) => {
          const cellKey = `${panelId}:${cell.id}`;
          const mediaAsset = media.find((item) => item.id === cell.mediaId) ?? null;
          const label = cell.aliasOverride.trim()
            ? cell.aliasOverride
            : mediaAsset?.alias.trim()
              ? mediaAsset.alias
              : mediaAsset?.fileName ?? "";
          const color = cell.colorOverride ?? mediaAsset?.color ?? "rgba(34, 43, 60, 0.76)";
          const playingProgress = playingByCellKey.get(cellKey);
          const isPlaying = playingProgress !== undefined;
          const isSelected = editMode && selectedCellId === cell.id;
          const isDragging =
            draggingCellId === cell.id || (touchDrag?.active && touchDrag.fromCellId === cell.id);
          const progress = playingProgress ?? 0;
          const warmState = cell.mediaId
            ? warmedMedia.find((item) => item.mediaId === cell.mediaId)?.state ?? "idle"
            : "idle";
          const activeDragOverCellId = touchDrag?.overCellId ?? dragOverCellId;
          const displayColor = mediaAsset
            ? isPlaying
              ? mixHexColor(color, "#ffffff", 0.24)
              : mixHexColor(color, "#070b14", 0.54)
            : "rgba(34, 43, 60, 0.76)";
          const textColor = mediaAsset ? getReadableTextColor(displayColor) : "#a9b7cf";
          const innerMutedColor = `color-mix(in srgb, ${textColor} 82%, transparent)`;

          return (
            <Box
              key={cellKey}
              component="button"
              type="button"
              data-cell-id={cell.id}
              data-playing={isPlaying ? "true" : "false"}
              data-warm-state={warmState}
              data-playback-mode={cell.playbackMode}
              data-hotkey={cell.hotkey}
              data-volume-offset={cell.volumeOffset}
              data-trim-start-ms={cell.trimStartMs ?? ""}
              data-trim-end-ms={cell.trimEndMs ?? ""}
              data-fade-in-ms={cell.fadeInEnabled ? cell.fadeInMs : ""}
              data-fade-out-ms={cell.fadeOutEnabled ? cell.fadeOutMs : ""}
              data-selected={isSelected ? "true" : "false"}
              draggable={editMode && Boolean(mediaAsset)}
              aria-label={
                label ? `Ячейка ${String(index + 1)} ${label}` : `Пустая ячейка ${String(index + 1)}`
              }
              onDragStart={(event) => {
                if (!editMode || !mediaAsset) {
                  event.preventDefault();
                  return;
                }
                setDraggingCellId(cell.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", cell.id);
              }}
              onDragEnd={() => {
                suppressNextClick();
                setDraggingCellId(null);
                setDragOverCellId(null);
              }}
              onDragOver={(event) => {
                if (!editMode) {
                  return;
                }
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDragOverCellId(cell.id);
              }}
              onDragLeave={() => {
                setDragOverCellId((current) => (current === cell.id ? null : current));
              }}
              onDrop={(event) => {
                event.preventDefault();
                setDraggingCellId(null);
                setDragOverCellId(null);
                const fromCellId = event.dataTransfer.getData("text/plain");
                if (fromCellId) {
                  suppressNextClick();
                  onCellMove(fromCellId, cell.id);
                }
              }}
              onClick={() => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                if (pointerActivatedCellIdRef.current === cell.id) {
                  pointerActivatedCellIdRef.current = null;
                  return;
                }
                onCellClick(cell);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
              }}
              onPointerDown={(event) => {
                if (editMode) {
                  if (event.pointerType !== "mouse" && mediaAsset) {
                    event.currentTarget.setPointerCapture(event.pointerId);
                    beginTouchDrag(cell.id);
                  }
                  return;
                }
                if (cell.playbackMode === "gate") {
                  onGateStart(cell);
                  return;
                }
                if (event.pointerType !== "mouse") {
                  pointerActivatedCellIdRef.current = cell.id;
                  event.currentTarget.blur();
                  onCellClick(cell);
                }
              }}
              onPointerMove={(event) => {
                const currentDrag = touchDragRef.current;
                if (!editMode || !currentDrag?.active) {
                  return;
                }
                event.preventDefault();
                updateTouchDragTarget(event.clientX, event.clientY);
              }}
              onTouchStart={() => {
                if (editMode && mediaAsset) {
                  beginTouchDrag(cell.id);
                }
              }}
              onTouchMove={(event) => {
                const currentDrag = touchDragRef.current;
                if (!editMode || !currentDrag?.active) {
                  return;
                }
                event.preventDefault();
                const touch = event.touches[0];
                if (touch) {
                  updateTouchDragTarget(touch.clientX, touch.clientY);
                }
              }}
              onTouchEnd={(event) => {
                if (!editMode || !touchDragRef.current) {
                  return;
                }
                const wasActive = touchDragRef.current.active;
                if (wasActive) {
                  event.preventDefault();
                }
                finishTouchDrag(wasActive);
              }}
              onPointerUp={(event) => {
                event.currentTarget.blur();
                if (editMode && touchDragRef.current) {
                  const wasActive = touchDragRef.current.active;
                  if (wasActive) {
                    event.preventDefault();
                  }
                  finishTouchDrag(wasActive);
                  return;
                }
                if (!editMode && cell.playbackMode === "gate") {
                  onGateEnd(cell);
                }
              }}
              onPointerCancel={() => {
                pointerActivatedCellIdRef.current = null;
                if (editMode && touchDragRef.current) {
                  suppressNextClick();
                  finishTouchDrag(false);
                  return;
                }
                if (!editMode && cell.playbackMode === "gate") {
                  onGateEnd(cell);
                }
              }}
              onPointerLeave={(event) => {
                event.currentTarget.blur();
                if (!editMode && cell.playbackMode === "gate") {
                  onGateEnd(cell);
                }
              }}
              sx={{
                position: "relative",
                minWidth: 0,
                minHeight: 0,
                containerType: "size",
                overflow: "hidden",
                border: 1,
                borderColor:
                  activeDragOverCellId === cell.id
                    ? "secondary.main"
                    : isSelected
                    ? "secondary.main"
                    : isPlaying
                      ? "primary.main"
                      : "rgba(169, 183, 207, 0.2)",
                borderRadius: 1,
                color: textColor,
                backgroundColor: displayColor,
                display: "grid",
                placeItems: "center",
                cursor: isDragging
                  ? "grabbing"
                  : editMode && mediaAsset
                    ? "grab"
                    : editMode || mediaAsset
                      ? "pointer"
                      : "default",
                transition:
                  "transform 160ms ease, border-color 160ms ease, filter 160ms ease, background-color 160ms ease",
                filter:
                  isPlaying || activeDragOverCellId === cell.id
                    ? "brightness(1.12) saturate(1.22)"
                    : "none",
                boxShadow:
                  activeDragOverCellId === cell.id
                    ? "0 0 0 2px rgba(255, 204, 102, 0.54), 0 0 18px rgba(255, 204, 102, 0.26)"
                    : "none",
                "&[data-warm-state='warming']": {
                  animation: "mumbox-cell-warm 720ms ease-in-out infinite"
                },
                "&[data-warm-state='ready']:not([data-playing='true'])": {
                  animation: "mumbox-cell-ready 620ms ease-out 1"
                },
                "&:hover": {
                  transform: "translateY(-1px)",
                  borderColor: "primary.main"
                },
                '&[draggable="true"]:active': {
                  cursor: "grabbing"
                },
                "&:focus-visible": {
                  outline: "2px solid",
                  outlineColor: "primary.main",
                  outlineOffset: 2
                },
                "@media (hover: none), (pointer: coarse)": {
                  WebkitTapHighlightColor: "transparent",
                  touchAction: "manipulation",
                  "&:hover": {
                    transform: "none"
                  },
                  "&:focus, &:focus-visible": {
                    outline: "none"
                  }
                }
              }}
            >
              {mediaAsset ? (
                <Box
                  sx={{
                    position: "absolute",
                    inset: 0,
                    display: "grid",
                    gridTemplateRows: "minmax(0, 1fr) auto",
                    placeItems: "center",
                    gap: "clamp(1px, 4cqh, 6px)",
                    p: "clamp(2px, 6cqw, 6px)"
                  }}
                >
                  {cell.hotkey ? (
                    <Typography
                      component="span"
                      data-testid={`cell-hotkey-${cell.id}`}
                      aria-label={`Комбинация клавиш ${cell.hotkey}`}
                      sx={{
                        position: "absolute",
                        top: 4,
                        right: 4,
                        maxWidth: "68%",
                        px: "clamp(2px, 4cqw, 4px)",
                        py: "clamp(1px, 2cqh, 2px)",
                        border: "1px solid rgba(247, 251, 255, 0.18)",
                        borderRadius: 0.75,
                        backgroundColor:
                          textColor === "#031014"
                            ? "rgba(247, 251, 255, 0.28)"
                            : "rgba(5, 7, 13, 0.42)",
                        color: textColor,
                        fontSize: "clamp(5px, 9cqw, 9px)",
                        lineHeight: 1.2,
                        opacity: 0.72,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        pointerEvents: "none"
                      }}
                    >
                      {cell.hotkey}
                    </Typography>
                  ) : null}
                  <PlaybackIndicator
                    mode={cell.playbackMode}
                    progress={progress}
                    active={isPlaying}
                    color={innerMutedColor}
                  />
                  <Typography
                    variant="caption"
                    sx={{
                      alignSelf: "end",
                      maxWidth: "100%",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: "clamp(6px, 11cqw, 11px)",
                      lineHeight: 1.15
                    }}
                  >
                    {label}
                  </Typography>
                </Box>
              ) : null}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

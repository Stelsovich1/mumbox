import { Box, Typography } from "@mui/material";
import { memo, useMemo, useRef, useState } from "react";

import { GridCell, PlaybackMode } from "../../../entities/cell/model/types";
import { MediaAsset } from "../../../entities/media/model/types";
import { GridSize } from "../../../entities/panel/model/types";
import { getReadableTextColor } from "../../../shared/lib/contrast";

type FileSystemEntryLike = {
  isFile: boolean;
  isDirectory: boolean;
  file: (callback: (file: File) => void, errorCallback?: (error: Error) => void) => void;
  createReader: () => {
    readEntries: (
      callback: (entries: FileSystemEntryLike[]) => void,
      errorCallback?: (error: Error) => void
    ) => void;
  };
};

type WorkspaceGridProps = {
  panelId: string;
  gridSize: GridSize;
  cells: GridCell[];
  media: MediaAsset[];
  editMode: boolean;
  selectedCellId: string | null;
  playingCells: { cellKey: string; progress: number }[];
  /** Warm state per cell id. Keyed by cell, not by media: two cells on one media can have
   * different trims, hence different cache entries, hence different warm states. */
  warmedCells: Record<string, "warming" | "ready">;
  onCellClick: (cell: GridCell) => void;
  onGateStart: (cell: GridCell) => void;
  onGateEnd: (cell: GridCell) => void;
  onCellMove: (fromCellId: string, toCellId: string) => void;
  onAudioDrop?: (files: File[]) => void;
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

function supportsPointerEvents() {
  return "PointerEvent" in window;
}

type CellController = {
  editMode: boolean;
  onCellClick: (cell: GridCell) => void;
  onGateStart: (cell: GridCell) => void;
  onGateEnd: (cell: GridCell) => void;
  onCellMove: (fromCellId: string, toCellId: string) => void;
  setDraggingCellId: (next: string | null) => void;
  setDragOverCellId: (next: string | null | ((current: string | null) => string | null)) => void;
  suppressNextClick: () => void;
  beginTouchDrag: (cellId: string) => void;
  updateTouchDragTarget: (clientX: number, clientY: number) => void;
  finishTouchDrag: (move: boolean) => void;
  suppressClickRef: { current: boolean };
  pointerActivatedCellIdRef: { current: string | null };
  activeTouchPointerIdRef: { current: number | null };
  touchDragRef: { current: TouchDragState | null };
};

type WorkspaceGridCellProps = {
  cell: GridCell;
  index: number;
  mediaAsset: MediaAsset | null;
  isPlaying: boolean;
  progress: number;
  warmState: "idle" | "warming" | "ready";
  isSelected: boolean;
  isDragging: boolean;
  activeDragOverCellId: string | null;
  editMode: boolean;
  /**
   * A ref, not a plain object: its identity must never change, or memoising the cell buys
   * nothing. Handlers read `controller.current` at call time, so they always see the latest
   * parent state without the parent invalidating every cell.
   */
  controller: { current: CellController };
};

/**
 * Memoised on purpose, and it is not a micro-optimisation.
 *
 * Every warm-up state change re-rendered the whole grid. Measured on a 12x12 panel with 40 media:
 * 89 long tasks totalling 5.6 s of blocked main thread, against 287 ms for the same work on a 6x6
 * panel — the cost scales with cell count, not with decoding. That is what made the hover
 * highlight stutter while cells were warming.
 */
const WorkspaceGridCell = memo(function WorkspaceGridCell({
  cell,
  index,
  mediaAsset,
  isPlaying,
  progress,
  warmState,
  isSelected,
  isDragging,
  activeDragOverCellId,
  editMode,
  controller
}: WorkspaceGridCellProps) {
  // Derived here rather than in the parent: these are four string builds and two colour parses
  // per cell, and running them in the parent meant paying them for all 144 cells every time one
  // cell's warm state changed.
  const label = cell.aliasOverride.trim()
    ? cell.aliasOverride
    : mediaAsset?.alias.trim()
      ? mediaAsset.alias
      : mediaAsset?.fileName ?? "";
  const color = cell.colorOverride ?? mediaAsset?.color ?? "rgba(34, 43, 60, 0.76)";
  const baseColor = mediaAsset
    ? isPlaying
      ? mixHexColor(color, "#ffffff", 0.24)
      : mixHexColor(color, "#070b14", 0.54)
    : "rgba(34, 43, 60, 0.76)";
  // A cell holding media that is not decoded yet is a third state, and it needs to look like one:
  // until now it was indistinguishable from a ready cell, so there was no way to tell which pads
  // would start instantly and which would pay for a decode.
  const displayColor =
    mediaAsset && warmState === "idle" ? mixHexColor(baseColor, "#000000", 0.3) : baseColor;
  const textColor = mediaAsset ? getReadableTextColor(displayColor) : "#a9b7cf";
  const innerMutedColor = `color-mix(in srgb, ${textColor} 82%, transparent)`;

  return (
    <Box
        component="button"
        type="button"
        data-cell-id={cell.id}
        data-playing={isPlaying ? "true" : "false"}
        data-progress={progress.toFixed(4)}
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
          controller.current.setDraggingCellId(cell.id);
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", cell.id);
        }}
        onDragEnd={() => {
          controller.current.suppressNextClick();
          controller.current.setDraggingCellId(null);
          controller.current.setDragOverCellId(null);
        }}
        onDragOver={(event) => {
          if (!editMode) {
            return;
          }
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          controller.current.setDragOverCellId(cell.id);
        }}
        onDragLeave={() => {
          controller.current.setDragOverCellId((current) => (current === cell.id ? null : current));
        }}
        onDrop={(event) => {
          event.preventDefault();
          controller.current.setDraggingCellId(null);
          controller.current.setDragOverCellId(null);
          const fromCellId = event.dataTransfer.getData("text/plain");
          if (fromCellId) {
            controller.current.suppressNextClick();
            controller.current.onCellMove(fromCellId, cell.id);
          }
        }}
        onClick={() => {
          if (controller.current.suppressClickRef.current) {
            controller.current.suppressClickRef.current = false;
            return;
          }
          if (controller.current.pointerActivatedCellIdRef.current === cell.id) {
            controller.current.pointerActivatedCellIdRef.current = null;
            return;
          }
          controller.current.onCellClick(cell);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
        }}
        onPointerDown={(event) => {
          if (editMode) {
            if (event.pointerType !== "mouse" && mediaAsset) {
              event.preventDefault();
              try {
                event.currentTarget.setPointerCapture(event.pointerId);
              } catch {
                // Synthetic and older mobile pointer streams may not be capturable.
              }
              controller.current.activeTouchPointerIdRef.current = event.pointerId;
              controller.current.beginTouchDrag(cell.id);
            }
            return;
          }
          if (cell.playbackMode === "gate") {
            controller.current.onGateStart(cell);
            return;
          }
          if (event.pointerType !== "mouse") {
            controller.current.pointerActivatedCellIdRef.current = cell.id;
            event.currentTarget.blur();
            controller.current.onCellClick(cell);
          }
        }}
        onPointerMove={(event) => {
          const currentDrag = controller.current.touchDragRef.current;
          if (
            !editMode ||
            !currentDrag?.active ||
            (event.pointerType !== "mouse" && controller.current.activeTouchPointerIdRef.current !== event.pointerId)
          ) {
            return;
          }
          event.preventDefault();
          controller.current.updateTouchDragTarget(event.clientX, event.clientY);
        }}
        onTouchStart={() => {
          if (supportsPointerEvents()) {
            return;
          }
          if (editMode && mediaAsset) {
            controller.current.beginTouchDrag(cell.id);
          }
        }}
        onTouchMove={(event) => {
          if (supportsPointerEvents()) {
            return;
          }
          const currentDrag = controller.current.touchDragRef.current;
          if (!editMode || !currentDrag?.active) {
            return;
          }
          event.preventDefault();
          const touch = event.touches[0];
          if (touch) {
            controller.current.updateTouchDragTarget(touch.clientX, touch.clientY);
          }
        }}
        onTouchEnd={(event) => {
          if (supportsPointerEvents()) {
            return;
          }
          if (!editMode || !controller.current.touchDragRef.current) {
            return;
          }
          const wasActive = controller.current.touchDragRef.current.active;
          if (wasActive) {
            event.preventDefault();
          }
          controller.current.finishTouchDrag(wasActive);
        }}
        onPointerUp={(event) => {
          event.currentTarget.blur();
          if (editMode && controller.current.touchDragRef.current) {
            const wasActive = controller.current.touchDragRef.current.active;
            if (wasActive) {
              event.preventDefault();
              controller.current.updateTouchDragTarget(event.clientX, event.clientY);
            }
            if (
              event.pointerType !== "mouse" &&
              controller.current.activeTouchPointerIdRef.current !== null &&
              controller.current.activeTouchPointerIdRef.current !== event.pointerId
            ) {
              return;
            }
            controller.current.finishTouchDrag(wasActive);
            return;
          }
          if (!editMode && cell.playbackMode === "gate") {
            controller.current.onGateEnd(cell);
          }
        }}
        onPointerCancel={() => {
          controller.current.pointerActivatedCellIdRef.current = null;
          if (editMode && controller.current.touchDragRef.current) {
            controller.current.suppressNextClick();
            controller.current.finishTouchDrag(false);
            return;
          }
          if (!editMode && cell.playbackMode === "gate") {
            controller.current.onGateEnd(cell);
          }
        }}
        onPointerLeave={(event) => {
          event.currentTarget.blur();
          if (!editMode && cell.playbackMode === "gate") {
            controller.current.onGateEnd(cell);
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
          // The warm-up pulse is a status signal, not decoration. The global
          // `prefers-reduced-motion` rule in global.css collapses every animation to a
          // single 0.01 ms frame, which here does not calm the motion down — it deletes the
          // information and leaves a twitch. Respect the setting by dropping the motion and
          // keeping the state visible statically.
          "@media (prefers-reduced-motion: reduce)": {
            "&[data-warm-state='warming']": {
              opacity: 0.6,
              borderStyle: "dashed",
              borderColor: "primary.main"
            }
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
            touchAction: editMode ? "none" : "manipulation",
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
              data-testid={`cell-label-${cell.id}`}
              sx={{
                alignSelf: "end",
                maxWidth: "100%",
                overflow: "hidden",
                display: "-webkit-box",
                WebkitBoxOrient: "vertical",
                WebkitLineClamp: 2,
                textOverflow: "ellipsis",
                whiteSpace: "normal",
                overflowWrap: "anywhere",
                wordBreak: "break-word",
                hyphens: "auto",
                textAlign: "center",
                fontSize: "clamp(9px, min(15cqw, 18cqh), 16px)",
                lineHeight: 1.05
              }}
            >
              {label}
            </Typography>
          </Box>
        ) : null}
      </Box>
  );
});

export function WorkspaceGrid({
  panelId,
  gridSize,
  cells,
  media,
  editMode,
  selectedCellId,
  playingCells,
  warmedCells,
  onCellClick,
  onGateStart,
  onGateEnd,
  onCellMove,
  onAudioDrop
}: WorkspaceGridProps) {
  const [dragOverCellId, setDragOverCellId] = useState<string | null>(null);
  const [draggingCellId, setDraggingCellId] = useState<string | null>(null);
  const [touchDrag, setTouchDrag] = useState<TouchDragState | null>(null);
  const [isAudioDragOver, setIsAudioDragOver] = useState(false);
  const pointerActivatedCellIdRef = useRef<string | null>(null);
  const touchDragRef = useRef<TouchDragState | null>(null);
  const activeTouchPointerIdRef = useRef<number | null>(null);
  const touchDragTimerRef = useRef<number | null>(null);
  const suppressClickTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const playingByCellKey = useMemo(
    () => new Map(playingCells.map((cell) => [cell.cellKey, cell.progress])),
    [playingCells]
  );
  // A linear scan per cell made this O(cells x media) on every repaint — 5 760 comparisons for a
  // 144-cell panel with 40 media, repeated on every frame of playback.
  const mediaById = useMemo(() => new Map(media.map((item) => [item.id, item])), [media]);

  /**
   * Mutated in place on every render so its identity never changes. Passing the callbacks
   * directly would give each cell new props every render and defeat the memoisation entirely.
   */
  const controllerRef = useRef<CellController>({
    editMode,
    onCellClick,
    onGateStart,
    onGateEnd,
    onCellMove,
    setDraggingCellId,
    setDragOverCellId,
    suppressNextClick: () => undefined,
    beginTouchDrag: () => undefined,
    updateTouchDragTarget: () => undefined,
    finishTouchDrag: () => undefined,
    suppressClickRef: { current: false },
    pointerActivatedCellIdRef: { current: null },
    activeTouchPointerIdRef: { current: null },
    touchDragRef: { current: null }
  });

  const clearTouchDragTimer = () => {
    if (touchDragTimerRef.current) {
      window.clearTimeout(touchDragTimerRef.current);
      touchDragTimerRef.current = null;
    }
  };

  const finishTouchDrag = (move: boolean) => {
    clearTouchDragTimer();
    const current = touchDragRef.current;
    activeTouchPointerIdRef.current = null;
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

  // Refreshed after every handler above is defined, so the cells always call the current ones
  // while the ref itself stays identical.
  controllerRef.current = {
    editMode,
    onCellClick,
    onGateStart,
    onGateEnd,
    onCellMove,
    setDraggingCellId,
    setDragOverCellId,
    suppressNextClick,
    beginTouchDrag,
    updateTouchDragTarget,
    finishTouchDrag,
    suppressClickRef,
    pointerActivatedCellIdRef,
    activeTouchPointerIdRef,
    touchDragRef
  };

  const handleGridDragOver = (event: React.DragEvent) => {
    if (!editMode || !onAudioDrop) {
      return;
    }
    // Only handle file drops, not cell drags
    // Cell drags don't have "Files" type, only file drops do
    const hasFiles = event.dataTransfer.types.includes("Files");
    if (!hasFiles) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsAudioDragOver(true);
  };

  const handleGridDragLeave = (event: React.DragEvent) => {
    if (!editMode || !onAudioDrop) {
      return;
    }
    // Only handle file drops, not cell drags
    const hasFiles = event.dataTransfer.types.includes("Files");
    if (!hasFiles) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX;
    const y = event.clientY;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      setIsAudioDragOver(false);
    }
  };

  const handleGridDrop = async (event: React.DragEvent) => {
    if (!editMode || !onAudioDrop) {
      return;
    }
    // Check if this is a cell drag (has cell data)
    const cellData = event.dataTransfer.getData("text/plain");
    if (cellData) {
      return; // Let cell handlers handle it
    }
    // Only handle file drops
    const hasFiles = event.dataTransfer.types.includes("Files");
    if (!hasFiles) {
      return;
    }
    event.preventDefault();
    setIsAudioDragOver(false);

    const items = Array.from(event.dataTransfer.items);
    const files: File[] = [];

    if (items.length > 0 && items[0] && "webkitGetAsEntry" in items[0]) {
      const entries = items
        .map((item) =>
          (
            item as unknown as { webkitGetAsEntry: () => FileSystemEntryLike | null }
          ).webkitGetAsEntry()
        )
        .filter((entry): entry is FileSystemEntryLike => entry !== null);

      const processEntry = async (entry: FileSystemEntryLike): Promise<void> => {
        if (entry.isFile) {
          const file = await new Promise<File>((resolve, reject) => {
            entry.file(resolve, reject);
          });
          files.push(file);
        } else if (entry.isDirectory) {
          const dirReader = entry.createReader();
          const readEntries = async (): Promise<void> => {
            const childEntries = await new Promise<FileSystemEntryLike[]>((resolve, reject) => {
              dirReader.readEntries(resolve, reject);
            });
            for (const childEntry of childEntries) {
              await processEntry(childEntry);
            }
            if (childEntries.length > 0) {
              await readEntries();
            }
          };
          await readEntries();
        }
      };

      for (const entry of entries) {
        await processEntry(entry);
      }
    }

    // A drag whose items carry no filesystem entry (a programmatic DataTransfer, and some
    // non-explorer sources) yields no entries at all. Falling back to `files` keeps those drops
    // working instead of swallowing them silently.
    if (files.length === 0) {
      files.push(...Array.from(event.dataTransfer.files));
    }

    if (files.length > 0) {
      onAudioDrop(files);
    }
  };

  return (
    <Box
      data-noselect
      aria-label={`Рабочая сетка ${String(gridSize)} на ${String(gridSize)}`}
      onDragOver={handleGridDragOver}
      onDragLeave={handleGridDragLeave}
      onDrop={(event) => {
        void handleGridDrop(event);
      }}
      sx={{
        minWidth: 0,
        minHeight: 0,
        containerType: "size",
        display: "grid",
        placeItems: "center",
        border: 1,
        borderColor: isAudioDragOver ? "primary.main" : editMode ? "secondary.main" : "divider",
        borderRadius: 2,
        backgroundColor: isAudioDragOver ? "rgba(236, 90, 167, 0.12)" : "rgba(7, 11, 20, 0.62)",
        p: { xs: 0.5, md: 0.75 },
        boxShadow: isAudioDragOver
          ? "0 0 0 2px rgba(236, 90, 167, 0.54), 0 0 18px rgba(236, 90, 167, 0.26)"
          : editMode
            ? "0 0 0 1px rgba(255, 204, 102, 0.42), 0 0 22px rgba(255, 204, 102, 0.18), inset 0 0 36px rgba(255, 204, 102, 0.05)"
          : "inset 0 0 36px rgba(236, 90, 167, 0.07)",
        transition: "border-color 160ms ease, box-shadow 160ms ease, background-color 160ms ease"
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
          const mediaAsset = cell.mediaId ? (mediaById.get(cell.mediaId) ?? null) : null;
          const playingProgress = playingByCellKey.get(cellKey);
          const isPlaying = playingProgress !== undefined;
          const isSelected = editMode && selectedCellId === cell.id;
          const isDragging =
            draggingCellId === cell.id || (touchDrag?.active && touchDrag.fromCellId === cell.id);
          const progress = playingProgress ?? 0;
          const warmState = cell.mediaId ? (warmedCells[cell.id] ?? "idle") : "idle";
          const activeDragOverCellId = touchDrag?.overCellId ?? dragOverCellId;

          return (
            <WorkspaceGridCell
              key={cellKey}
              cell={cell}
              index={index}
              mediaAsset={mediaAsset}
              isPlaying={isPlaying}
              progress={progress}
              warmState={warmState}
              isSelected={isSelected}
              isDragging={Boolean(isDragging)}
              activeDragOverCellId={activeDragOverCellId}
              editMode={editMode}
              controller={controllerRef}
            />
          );
        })}
      </Box>
    </Box>
  );
}

import { Box, Typography } from "@mui/material";
import { useRef, useState } from "react";

import { GridCell, PlaybackMode } from "../../../entities/cell/model/types";
import { MediaAsset } from "../../../entities/media/model/types";
import { GridSize } from "../../../entities/panel/model/types";
import { getReadableTextColor } from "../../../shared/lib/contrast";

type WorkspaceGridProps = {
  gridSize: GridSize;
  cells: GridCell[];
  media: MediaAsset[];
  editMode: boolean;
  selectedCellId: string | null;
  playingCells: { cellId: string; progress: number }[];
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
      sx={{
        position: "relative",
        width: "clamp(14px, 48cqw, 58px)",
        height: "clamp(6px, 14cqh, 16px)",
        overflow: "visible"
      }}
    >
      {mode === "once" ? (
        <>
          <Box
            sx={{
              position: "absolute",
              left: 0,
              top: 2,
              bottom: 2,
              width: 2,
              backgroundColor: guideColor
            }}
          />
          <Box
            sx={{
              position: "absolute",
              right: 0,
              top: 2,
              bottom: 2,
              width: 2,
              backgroundColor: guideColor
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
  gridSize,
  cells,
  media,
  editMode,
  selectedCellId,
  playingCells,
  onCellClick,
  onGateStart,
  onGateEnd,
  onCellMove
}: WorkspaceGridProps) {
  const [dragOverCellId, setDragOverCellId] = useState<string | null>(null);
  const pointerActivatedCellIdRef = useRef<string | null>(null);

  return (
    <Box
      data-noselect
      aria-label={`Рабочая сетка ${String(gridSize)} на ${String(gridSize)}`}
      sx={{
        minWidth: 0,
        minHeight: 0,
        display: "grid",
        placeItems: "center",
        border: 1,
        borderColor: editMode ? "secondary.main" : "divider",
        borderRadius: 2,
        backgroundColor: "rgba(7, 11, 20, 0.62)",
        p: { xs: 0.5, md: 0.75 },
        boxShadow: editMode
          ? "0 0 0 1px rgba(255, 204, 102, 0.42), 0 0 22px rgba(255, 204, 102, 0.18), inset 0 0 36px rgba(255, 204, 102, 0.05)"
          : "inset 0 0 36px rgba(140, 248, 255, 0.06)",
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
          gap: { xs: 0.5, md: 0.75 }
        }}
      >
        {cells.map((cell, index) => {
          const mediaAsset = media.find((item) => item.id === cell.mediaId) ?? null;
          const label = cell.aliasOverride.trim()
            ? cell.aliasOverride
            : mediaAsset?.alias.trim()
              ? mediaAsset.alias
              : mediaAsset?.fileName ?? "";
          const color = cell.colorOverride ?? mediaAsset?.color ?? "rgba(34, 43, 60, 0.76)";
          const isPlaying = playingCells.some((item) => item.cellId === cell.id);
          const progress = playingCells.find((item) => item.cellId === cell.id)?.progress ?? 0;
          const displayColor = mediaAsset
            ? isPlaying
              ? mixHexColor(color, "#ffffff", 0.24)
              : mixHexColor(color, "#070b14", 0.54)
            : "rgba(34, 43, 60, 0.76)";
          const textColor = mediaAsset ? getReadableTextColor(displayColor) : "#a9b7cf";
          const innerMutedColor = `color-mix(in srgb, ${textColor} 82%, transparent)`;

          return (
            <Box
              key={cell.id}
              component="button"
              type="button"
              data-cell-id={cell.id}
              data-playing={isPlaying ? "true" : "false"}
              data-playback-mode={cell.playbackMode}
              data-hotkey={cell.hotkey}
              data-volume-offset={cell.volumeOffset}
              data-trim-start-ms={cell.trimStartMs ?? ""}
              data-trim-end-ms={cell.trimEndMs ?? ""}
              data-fade-in-ms={cell.fadeInEnabled ? cell.fadeInMs : ""}
              data-fade-out-ms={cell.fadeOutEnabled ? cell.fadeOutMs : ""}
              draggable={editMode && Boolean(mediaAsset)}
              aria-label={
                label ? `Ячейка ${String(index + 1)} ${label}` : `Пустая ячейка ${String(index + 1)}`
              }
              onDragStart={(event) => {
                if (!editMode || !mediaAsset) {
                  event.preventDefault();
                  return;
                }
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", cell.id);
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
                setDragOverCellId(null);
                const fromCellId = event.dataTransfer.getData("text/plain");
                if (fromCellId) {
                  onCellMove(fromCellId, cell.id);
                }
              }}
              onClick={() => {
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
              onPointerUp={(event) => {
                event.currentTarget.blur();
                if (!editMode && cell.playbackMode === "gate") {
                  onGateEnd(cell);
                }
              }}
              onPointerCancel={() => {
                pointerActivatedCellIdRef.current = null;
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
                  dragOverCellId === cell.id
                    ? "secondary.main"
                    : selectedCellId === cell.id
                    ? "secondary.main"
                    : isPlaying
                      ? "primary.main"
                      : "rgba(169, 183, 207, 0.2)",
                borderRadius: 1,
                color: textColor,
                backgroundColor: displayColor,
                display: "grid",
                placeItems: "center",
                cursor: "pointer",
                transition:
                  "transform 160ms ease, border-color 160ms ease, filter 160ms ease, background-color 160ms ease",
                filter:
                  isPlaying || dragOverCellId === cell.id
                    ? "brightness(1.12) saturate(1.22)"
                    : "none",
                boxShadow:
                  dragOverCellId === cell.id
                    ? "0 0 0 2px rgba(255, 204, 102, 0.54), 0 0 18px rgba(255, 204, 102, 0.26)"
                    : "none",
                "&:hover": {
                  transform: "translateY(-1px)",
                  borderColor: "primary.main"
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

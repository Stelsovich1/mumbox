import { Box, Typography } from "@mui/material";
import { useState } from "react";

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

function PlaybackIndicator({ mode, progress, active }: PlaybackIndicatorProps) {
  const guideOpacity = active ? 0.1 : 0.38;

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
        sx={{ width: "40%", maxWidth: 42, minWidth: 22 }}
      >
        <circle
          cx="18"
          cy="18"
          r="14"
          fill="none"
          stroke={`rgba(247, 251, 255, ${String(guideOpacity)})`}
          strokeWidth="3"
        />
        <circle cx={dotX} cy={dotY} r="2.25" fill="#f7fbff" />
      </Box>
    );
  }

  return (
    <Box
      aria-hidden="true"
      sx={{
        position: "relative",
        width: "56%",
        maxWidth: 58,
        minWidth: 24,
        height: 16,
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
              backgroundColor: `rgba(247, 251, 255, ${String(guideOpacity)})`
            }}
          />
          <Box
            sx={{
              position: "absolute",
              right: 0,
              top: 2,
              bottom: 2,
              width: 2,
              backgroundColor: `rgba(247, 251, 255, ${String(guideOpacity)})`
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
          backgroundColor: `rgba(247, 251, 255, ${String(guideOpacity)})`,
          transform: "translateY(-50%)"
        }}
      />
      <Box
        sx={{
          position: "absolute",
          left: `${String(progress * 100)}%`,
          top: "50%",
          width: 5,
          height: 5,
          borderRadius: "50%",
          backgroundColor: "#f7fbff",
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
          width: "min(100%, calc((100vh - 84px) * 1))",
          height: "min(100%, calc(100vw - 116px))",
          maxWidth: "100%",
          maxHeight: "100%",
          aspectRatio: "1 / 1",
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
                onCellClick(cell);
              }}
              onPointerDown={() => {
                if (!editMode && cell.playbackMode === "gate") {
                  onGateStart(cell);
                }
              }}
              onPointerUp={() => {
                if (!editMode && cell.playbackMode === "gate") {
                  onGateEnd(cell);
                }
              }}
              onPointerLeave={() => {
                if (!editMode && cell.playbackMode === "gate") {
                  onGateEnd(cell);
                }
              }}
              sx={{
                position: "relative",
                minWidth: 0,
                minHeight: 0,
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
                    gap: 0.5,
                    p: 0.75
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
                        px: 0.5,
                        py: 0.15,
                        border: "1px solid rgba(247, 251, 255, 0.18)",
                        borderRadius: 0.75,
                        backgroundColor: "rgba(5, 7, 13, 0.42)",
                        color: "#f7fbff",
                        fontSize: { xs: 8, md: 9 },
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
                  <PlaybackIndicator mode={cell.playbackMode} progress={progress} active={isPlaying} />
                  <Typography
                    variant="caption"
                    sx={{
                      alignSelf: "end",
                      maxWidth: "100%",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: { xs: 9, md: 11 }
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

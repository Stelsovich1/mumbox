import AppsIcon from "@mui/icons-material/Apps";
import ChecklistIcon from "@mui/icons-material/Checklist";
import EditNoteIcon from "@mui/icons-material/EditNote";
import Filter1Icon from "@mui/icons-material/Filter1";
import StopCircleIcon from "@mui/icons-material/StopCircle";
import VolumeOffIcon from "@mui/icons-material/VolumeOff";
import VolumeUpIcon from "@mui/icons-material/VolumeUp";
import {
  Box,
  IconButton,
  Popover,
  Slider,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography
} from "@mui/material";
import { memo, MouseEvent, useState } from "react";

import { AppAction } from "../../../app/model/appState";
import { GRID_SIZES } from "../../../entities/panel/model/hiddenCells";
import { GridSize } from "../../../entities/panel/model/types";
import { formatCountRu } from "../../../shared/lib/pluralizeRu";

type RightToolbarProps = {
  masterVolume: number;
  masterMuted: boolean;
  editMode: boolean;
  selectionMode: boolean;
  stopOthers: boolean;
  gridSize: GridSize;
  panelId: string;
  /** Cells holding media that the current grid size does not render. */
  hiddenMediaCount: number;
  /** Smallest size that would show all of them, or `null` when the panel has no media at all. */
  minGridSize: GridSize | null;
  dispatch: React.Dispatch<AppAction>;
  onStopAll: () => void;
  onToggleSelectionMode: () => void;
};

/**
 * Memoised. Its props change only when the panel layout or a mode does, but `AppShell`
 * re-renders on every progress push while anything plays — 20 times a second — and each of those
 * renders re-serialized every `sx` object in here for nothing.
 */
export const RightToolbar = memo(function RightToolbar({
  masterVolume,
  masterMuted,
  editMode,
  selectionMode,
  stopOthers,
  gridSize,
  panelId,
  hiddenMediaCount,
  minGridSize,
  dispatch,
  onStopAll,
  onToggleSelectionMode
}: RightToolbarProps) {
  const [gridAnchor, setGridAnchor] = useState<HTMLElement | null>(null);
  /**
   * What the thumb shows while a finger is on it.
   *
   * The slider used to render `masterVolume` directly, so every frame of a touch drag depended on a
   * full dispatch-render round trip landing before the next `touchmove`. Anything that drops or
   * defers one of those dispatches leaves the thumb rendering the OLD value, and on release the
   * gesture ends with the slider back where it started — the reported glitch, and a class of bug
   * rather than one path. Holding the dragged value locally makes the thumb independent of that
   * round trip, and `onChangeCommitted` dispatches the final value even if every intermediate
   * change was lost.
   */
  const [dragVolume, setDragVolume] = useState<number | null>(null);
  const hasHiddenMedia = hiddenMediaCount > 0;
  const hiddenLabel = formatCountRu(hiddenMediaCount, ["ячейка", "ячейки", "ячеек"]);

  const openGridMenu = (event: MouseEvent<HTMLButtonElement>) => {
    setGridAnchor(event.currentTarget);
  };

  return (
    <Stack
      data-noselect
      component="aside"
      aria-label="Панель управления"
      alignItems="center"
      sx={{
        minWidth: 0,
        minHeight: 0,
        height: "100%",
        overflowX: "hidden",
        overflowY: "auto",
        // The aside scrolls on a short viewport, and a vertical drag that the browser hands to the
        // scroller instead of the slider rubber-bands the whole column and springs back — which
        // reads as the slider snapping back. `contain` keeps that gesture from leaving the box.
        overscrollBehavior: "contain",
        justifyContent: "space-between",
        border: 1,
        borderColor: "divider",
        borderRadius: 2,
        py: { xs: 0.75, sm: 1.5 },
        backgroundColor: "rgba(13, 18, 31, 0.82)",
        backdropFilter: "blur(18px)",
        "& .MuiIconButton-root": {
          width: { xs: "calc(100% - 12px)", sm: 44 },
          maxWidth: { xs: 62, sm: 44 },
          aspectRatio: "1 / 1",
          height: "auto",
          p: { xs: 0.75, sm: 0.75 }
        },
        "& .MuiSvgIcon-root": {
          width: "72%",
          height: "72%",
          fontSize: "inherit"
        },
        "@media (max-height: 480px)": {
          py: 0.25,
          px: 0,
          borderRadius: 1,
          "& .MuiIconButton-root": {
            width: "calc(100% - 8px)",
            maxWidth: 38,
            height: "auto",
            p: 0.35
          },
          "& .MuiSvgIcon-root": {
            width: "74%",
            height: "74%"
          }
        }
      }}
    >
      <Box
        sx={{
          display: "grid",
          justifyItems: "center",
          alignItems: "center",
          gap: { xs: 1, sm: 1.5 },
          "@media (max-height: 480px)": {
            gap: 0.75
          }
        }}
      >
        <Tooltip title={masterMuted ? "Включить звук" : "Отключить звук"} disableInteractive>
          <IconButton
            aria-label={masterMuted ? "Включить звук" : "Отключить звук"}
            color={masterMuted ? "default" : "primary"}
            aria-pressed={masterMuted}
            onClick={() => {
              dispatch({ type: "volume/muteToggle" });
            }}
          >
            {masterMuted ? <VolumeOffIcon /> : <VolumeUpIcon />}
          </IconButton>
        </Tooltip>
        <Box
          sx={{
            // 30 % longer than it was (120/180/88): a longer travel is finer control per pixel,
            // and the sidebar scrolls if a short viewport cannot fit it.
            height: { xs: 156, sm: 234 },
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            px: { xs: 0.25, sm: 0.5 },
            "@media (max-height: 480px)": {
              height: 114,
              px: 0.25
            }
          }}
        >
          <Slider
            aria-label="Общая громкость"
            orientation="vertical"
            value={dragVolume ?? masterVolume}
            disabled={masterMuted}
            min={0}
            max={100}
            onChange={(_, value: number | number[]) => {
              const nextVolume = Array.isArray(value) ? value[0] ?? masterVolume : value;
              setDragVolume(nextVolume);
              dispatch({
                type: "volume/master",
                value: nextVolume
              });
            }}
            onChangeCommitted={(_, value: number | number[]) => {
              const nextVolume = Array.isArray(value) ? value[0] ?? masterVolume : value;
              setDragVolume(null);
              dispatch({
                type: "volume/master",
                value: nextVolume
              });
            }}
            sx={{
              // Rail and thumb are wider than the visual design would ask for: this is the only
              // continuous control in the app and it is driven by a thumb on a phone.
              width: { xs: 44, sm: 52 },
              // MUI pads a vertical slider by 20 px each side for the hit area. The sidebar column
              // is 46-64 px wide and `overflowX` is hidden, so that padding was clipped and the
              // grabbable strip ended at the column edge anyway. Dropping it and paying for the
              // width in the rail and the thumb makes the whole control reachable.
              p: 0,
              // MUI restates that padding inside `@media (pointer: coarse)`, so a plain `p: 0`
              // wins on desktop and loses on every touch device — the one place it matters.
              "@media (pointer: coarse)": {
                p: 0
              },
              touchAction: "none",
              "& .MuiSlider-thumb": {
                width: { xs: 26, sm: 30 },
                height: { xs: 26, sm: 30 }
              },
              "& .MuiSlider-track, & .MuiSlider-rail": {
                width: { xs: 12, sm: 16 }
              },
              "@media (max-height: 480px)": {
                // The sidebar column is 46 px wide there, so this is the widest the control fits.
                width: 28,
                "& .MuiSlider-thumb": {
                  width: 18,
                  height: 18
                },
                "& .MuiSlider-track, & .MuiSlider-rail": {
                  width: 8
                }
              }
            }}
          />
        </Box>
      </Box>
      <Box
        sx={{
          display: "grid",
          justifyItems: "center",
          gap: { xs: 0.75, sm: 1 },
          "@media (max-height: 480px)": {
            gap: 0.25
          }
        }}
      >
        {editMode ? (
          /* Above «Режим редактирования», not below it: appearing below would push the grid-size
             and stop-others buttons down the moment edit mode is entered. */
          <Tooltip title="Режим выбора" disableInteractive>
            <IconButton
              aria-label="Режим выбора"
              color={selectionMode ? "secondary" : "default"}
              aria-pressed={selectionMode}
              onClick={onToggleSelectionMode}
              sx={selectionMode ? undefined : { color: "common.white" }}
            >
              <ChecklistIcon />
            </IconButton>
          </Tooltip>
        ) : null}
        <Tooltip title="Режим редактирования" disableInteractive>
          <IconButton
            aria-label="Режим редактирования"
            color={editMode ? "secondary" : "primary"}
            aria-pressed={editMode}
            onClick={() => {
              dispatch({ type: "editMode/toggle" });
            }}
          >
            <EditNoteIcon />
          </IconButton>
        </Tooltip>
        <Tooltip
          title={
            hasHiddenMedia ? `Размер сетки — вне сетки ${hiddenLabel} с аудио` : "Размер сетки"
          }
          disableInteractive
        >
          {/* The gradient is the only place a hidden cue can be announced: the grid cannot show
              what it does not render, and the cell is still reachable from its hotkey. The label
              stays "Размер сетки" — the suite selects this button by it. */}
          <IconButton
            aria-label="Размер сетки"
            data-hidden-media={hasHiddenMedia ? String(hiddenMediaCount) : undefined}
            onClick={openGridMenu}
            sx={
              hasHiddenMedia
                ? {
                    background: (theme) =>
                      `linear-gradient(135deg, ${theme.palette.warning.main} 0%, ${theme.palette.secondary.main} 100%)`,
                    color: "common.black",
                    "&:hover": {
                      background: (theme) =>
                        `linear-gradient(135deg, ${theme.palette.warning.light} 0%, ${theme.palette.secondary.light} 100%)`
                    }
                  }
                : undefined
            }
          >
            <AppsIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title="Останавливать другие ячейки" disableInteractive>
          <IconButton
            aria-label="Останавливать другие ячейки"
            color={stopOthers ? "secondary" : "default"}
            aria-pressed={stopOthers}
            onClick={() => {
              dispatch({ type: "stopOthers/toggle" });
            }}
          >
            <Filter1Icon />
          </IconButton>
        </Tooltip>
      </Box>
      <Popover
        open={Boolean(gridAnchor)}
        anchorEl={gridAnchor}
        onClose={() => {
          setGridAnchor(null);
        }}
        anchorOrigin={{ vertical: "center", horizontal: "left" }}
        transformOrigin={{ vertical: "center", horizontal: "right" }}
      >
        <ToggleButtonGroup
          exclusive
          value={gridSize}
          aria-label="Выбор размера сетки"
          sx={{ p: 1, display: "grid", gridTemplateColumns: "repeat(2, 72px)", gap: 1 }}
          onChange={(_, value: GridSize | null) => {
            if (value) {
              dispatch({ type: "panel/gridSize", panelId, gridSize: value });
              setGridAnchor(null);
            }
          }}
        >
          {GRID_SIZES.map((size) => (
            <ToggleButton key={size} value={size} aria-label={`${String(size)}x${String(size)}`}>
              {String(size)}x{String(size)}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        {hasHiddenMedia && minGridSize !== null ? (
          <Typography
            data-testid="grid-hidden-media-hint"
            sx={{ px: 1, pb: 1, maxWidth: 160, fontSize: 12, color: "text.secondary" }}
          >
            {`Вне сетки ${hiddenLabel} с аудио. Всё видно при ${String(minGridSize)}x${String(minGridSize)}.`}
          </Typography>
        ) : null}
      </Popover>
      <Box
        sx={{
          display: "grid",
          justifyItems: "center",
          "@media (max-height: 480px)": {
            mb: 0.25
          }
        }}
      >
        <Tooltip title="Остановить все аудио" disableInteractive>
          <IconButton
            aria-label="Остановить все аудио"
            color="error"
            onClick={onStopAll}
            sx={{
              border: 1,
              borderColor: "error.main",
              backgroundColor: "rgba(255, 107, 138, 0.08)",
              "&:hover": {
                backgroundColor: "rgba(255, 107, 138, 0.18)"
              }
            }}
          >
            <StopCircleIcon />
          </IconButton>
        </Tooltip>
      </Box>
    </Stack>
  );
});

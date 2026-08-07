import AppsIcon from "@mui/icons-material/Apps";
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
  Tooltip
} from "@mui/material";
import { MouseEvent, useState } from "react";

import { AppAction } from "../../../app/model/appState";
import { GridSize } from "../../../entities/panel/model/types";

const gridSizes: GridSize[] = [6, 8, 10, 12];

type RightToolbarProps = {
  masterVolume: number;
  masterMuted: boolean;
  editMode: boolean;
  stopOthers: boolean;
  gridSize: GridSize;
  panelId: string;
  dispatch: React.Dispatch<AppAction>;
  onStopAll: () => void;
};

export function RightToolbar({
  masterVolume,
  masterMuted,
  editMode,
  stopOthers,
  gridSize,
  panelId,
  dispatch,
  onStopAll
}: RightToolbarProps) {
  const [gridAnchor, setGridAnchor] = useState<HTMLElement | null>(null);

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
            height: { xs: 120, sm: 180 },
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            px: { xs: 0.25, sm: 0.5 },
            "@media (max-height: 480px)": {
              height: 88,
              px: 0.25
            }
          }}
        >
          <Slider
            aria-label="Общая громкость"
            orientation="vertical"
            value={masterVolume}
            disabled={masterMuted}
            min={0}
            max={100}
            onChange={(_, value: number | number[]) => {
              const nextVolume = Array.isArray(value) ? value[0] ?? masterVolume : value;
              dispatch({
                type: "volume/master",
                value: nextVolume
              });
            }}
            sx={{
              width: { xs: 35, sm: 44 },
              "& .MuiSlider-thumb": {
                width: { xs: 22, sm: 28 },
                height: { xs: 22, sm: 28 }
              },
              "& .MuiSlider-track, & .MuiSlider-rail": {
                width: { xs: 7, sm: 10 }
              },
              "@media (max-height: 480px)": {
                width: 18,
                "& .MuiSlider-thumb": {
                  width: 12,
                  height: 12
                },
                "& .MuiSlider-track, & .MuiSlider-rail": {
                  width: 4
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
        <Tooltip title="Размер сетки" disableInteractive>
          <IconButton aria-label="Размер сетки" onClick={openGridMenu}>
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
          {gridSizes.map((size) => (
            <ToggleButton key={size} value={size} aria-label={`${String(size)}x${String(size)}`}>
              {String(size)}x{String(size)}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
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
}

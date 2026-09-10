import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import LayersClearIcon from "@mui/icons-material/LayersClear";
import SelectAllIcon from "@mui/icons-material/SelectAll";
import { Box, Button, Stack, Tooltip, Typography } from "@mui/material";
import { memo } from "react";

import { formatCountRu } from "../../../shared/lib/pluralizeRu";

type SelectionActionBarProps = {
  selectedCellCount: number;
  selectedPanelCount: number;
  /** Cells of the active panel that hold anything worth selecting. */
  selectableCellCount: number;
  onSelectAllCells: () => void;
  onResetSelection: () => void;
  onClearCells: () => void;
  onCopyCells: () => void;
  onDeletePanels: () => void;
};

/**
 * The bulk action surface for selection mode.
 *
 * Fixed to the bottom of the viewport rather than placed in the header: the header row is already
 * full on mobile landscape, where the whole app is 430 px tall, and a bar that pushes the grid
 * would resize every cell the moment the user starts selecting.
 *
 * Every control carries a Russian `aria-label` — the e2e suite selects by accessible name.
 */
export const SelectionActionBar = memo(function SelectionActionBar({
  selectedCellCount,
  selectedPanelCount,
  selectableCellCount,
  onSelectAllCells,
  onResetSelection,
  onClearCells,
  onCopyCells,
  onDeletePanels
}: SelectionActionBarProps) {
  const hasCells = selectedCellCount > 0;
  const hasPanels = selectedPanelCount > 0;

  return (
    <Box
      data-noselect
      data-testid="selection-action-bar"
      role="toolbar"
      aria-label="Действия с выбранным"
      sx={{
        position: "fixed",
        left: "50%",
        transform: "translateX(-50%)",
        bottom: { xs: 8, sm: 16 },
        zIndex: (theme) => theme.zIndex.drawer - 1,
        maxWidth: "calc(100vw - 16px)",
        px: { xs: 1, sm: 1.5 },
        py: { xs: 0.5, sm: 0.75 },
        borderRadius: 2,
        border: 1,
        borderColor: "secondary.main",
        backgroundColor: "rgba(13, 18, 31, 0.94)",
        backdropFilter: "blur(18px)",
        boxShadow: "0 10px 30px rgba(0, 0, 0, 0.45)",
        "@media (orientation: landscape) and (max-height: 430px)": {
          bottom: 4,
          px: 0.5,
          // 20 % taller than the first landscape pass (py 0.25 with 30 px buttons): the bar read as
          // a sliver against the grid and its buttons were the smallest tap targets in the app.
          py: 0.375,
          borderRadius: 1.5
        }
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        sx={{
          gap: { xs: 0.5, sm: 1 },
          // Wrapping on a narrow portrait viewport rather than scrolling: a horizontally
          // scrolling action bar hides its own buttons, and the one that ends up off-screen is
          // whichever the user has not used yet.
          flexWrap: { xs: "wrap", sm: "nowrap" },
          justifyContent: "center",
          rowGap: { xs: 0.5, sm: 0 },
          overflowX: { xs: "visible", sm: "auto" },
          "@media (orientation: landscape) and (max-height: 430px)": {
            flexWrap: "nowrap",
            overflowX: "auto"
          },
          "& .MuiButton-root": {
            minWidth: 0,
            minHeight: 34,
            px: { xs: 0.75, sm: 1.25 },
            whiteSpace: "nowrap",
            "@media (orientation: landscape) and (max-height: 430px)": {
              minHeight: 36,
              px: 0.5,
              fontSize: 11
            }
          }
        }}
      >
        <Typography
          data-testid="selection-count"
          sx={{
            fontSize: { xs: 12, sm: 13 },
            color: "text.secondary",
            whiteSpace: "nowrap",
            "@media (orientation: landscape) and (max-height: 430px)": { fontSize: 11 }
          }}
        >
          {`Выбрано: ${formatCountRu(selectedCellCount, ["ячейка", "ячейки", "ячеек"])}`}
          {hasPanels
            ? `, ${formatCountRu(selectedPanelCount, ["панель", "панели", "панелей"])}`
            : ""}
        </Typography>
        <Tooltip title="Выбрать все ячейки с аудио" disableInteractive>
          <Button
            aria-label="Выбрать все ячейки"
            size="small"
            color="inherit"
            startIcon={<SelectAllIcon />}
            disabled={selectableCellCount === 0}
            onClick={onSelectAllCells}
          >
            Все
          </Button>
        </Tooltip>
        <Tooltip title="Скопировать выбранные ячейки на панель" disableInteractive>
          <Button
            aria-label="Скопировать выбранные ячейки"
            size="small"
            color="primary"
            startIcon={<ContentCopyIcon />}
            disabled={!hasCells}
            onClick={onCopyCells}
          >
            Копировать
          </Button>
        </Tooltip>
        <Tooltip title="Очистить выбранные ячейки" disableInteractive>
          <Button
            aria-label="Очистить выбранные ячейки"
            size="small"
            color="warning"
            startIcon={<LayersClearIcon />}
            disabled={!hasCells}
            onClick={onClearCells}
          >
            Очистить
          </Button>
        </Tooltip>
        <Tooltip title="Удалить выбранные панели" disableInteractive>
          <Button
            aria-label="Удалить выбранные панели"
            size="small"
            color="error"
            startIcon={<DeleteSweepIcon />}
            disabled={!hasPanels}
            onClick={onDeletePanels}
          >
            Панели
          </Button>
        </Tooltip>
        <Button
          aria-label="Снять выбор"
          size="small"
          color="inherit"
          disabled={!hasCells && !hasPanels}
          onClick={onResetSelection}
        >
          Снять
        </Button>
      </Stack>
    </Box>
  );
});

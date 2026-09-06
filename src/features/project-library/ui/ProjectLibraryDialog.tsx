import DeleteIcon from "@mui/icons-material/Delete";
import MergeTypeIcon from "@mui/icons-material/MergeType";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Snackbar,
  Tooltip,
  Typography
} from "@mui/material";
import { useMemo, useState } from "react";

import { ProjectLibraryRow, ProjectRowStatus } from "../../../entities/project/model/types";
import {
  SELECTED_ROW_BACKGROUND,
  SELECTED_ROW_HOVER_BACKGROUND
} from "../../../shared/config/colorPalette";
import { formatCreatedAt } from "../../../shared/lib/formatDate";
import { isInteractiveRowTarget } from "../../../shared/lib/interactiveTarget";
import { getSelectAllState } from "../../../shared/lib/rowSelection";
import { useRowSelection } from "../../../shared/lib/useRowSelection";
import { RowSelectCheckbox, SelectAllCheckbox } from "../../../shared/ui/RowSelectionControls";
import {
  getDeleteCapability,
  getDeleteConfirmText,
  getProjectRowLabel,
  isRowDeleteOnly,
  ProjectRowProbe,
  sortProjectRows
} from "../model/projectRowState";
import { getProjectRowStatus } from "../model/projectRowState";

type ProjectLibraryDialogProps = {
  open: boolean;
  rows: ProjectLibraryRow[];
  probes: Map<string, ProjectRowProbe>;
  onClose: () => void;
  onAddProjects: () => void;
  onActivate: (row: ProjectLibraryRow) => void;
  onDelete: (rows: ProjectLibraryRow[]) => void;
  onRelink: (row: ProjectLibraryRow) => void;
  onMerge: (rows: ProjectLibraryRow[]) => void;
};

const PROJECT_COLUMNS =
  "44px minmax(160px, 1.2fr) minmax(160px, 1.2fr) minmax(180px, 1.4fr) 96px 124px 72px 72px 52px";
const PROJECT_MIN_WIDTH = 1020;

function formatSize(sizeBytes: number | null) {
  if (sizeBytes === null) {
    return "—";
  }
  const megabytes = sizeBytes / (1024 * 1024);

  return megabytes >= 1
    ? `${megabytes.toFixed(1)} MB`
    : `${String(Math.max(1, Math.round(sizeBytes / 1024)))} KB`;
}

function formatCount(value: number | null) {
  return value === null ? "—" : String(value);
}

export function ProjectLibraryDialog({
  open,
  rows,
  probes,
  onClose,
  onAddProjects,
  onActivate,
  onDelete,
  onRelink,
  onMerge
}: ProjectLibraryDialogProps) {
  const [pendingDeleteIds, setPendingDeleteIds] = useState<string[]>([]);
  const { selectedIds, toggle, setMany, clear } = useRowSelection();

  const { linked, unlinked } = useMemo(() => sortProjectRows(rows), [rows]);
  const allIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const selectAllState = getSelectAllState(selectedIds, allIds);
  const selectedRows = useMemo(
    () => rows.filter((row) => selectedIds.has(row.id)),
    [rows, selectedIds]
  );
  const pendingDeleteRows = useMemo(
    () => rows.filter((row) => pendingDeleteIds.includes(row.id)),
    [pendingDeleteIds, rows]
  );
  const deleteConfirmText = getDeleteConfirmText(
    pendingDeleteRows,
    getDeleteCapability(pendingDeleteRows)
  );

  const renderRow = (row: ProjectLibraryRow) => {
    const status: ProjectRowStatus = getProjectRowStatus(row, probes.get(row.id));
    const deleteOnly = isRowDeleteOnly(status);
    const selected = selectedIds.has(row.id);

    return (
      <Box
        role="row"
        key={row.id}
        data-project-row={row.id}
        data-project-status={status}
        aria-disabled={deleteOnly ? "true" : undefined}
        tabIndex={deleteOnly ? undefined : 0}
        onClick={(event) => {
          if (deleteOnly || isInteractiveRowTarget(event.target, event.currentTarget)) {
            return;
          }
          onActivate(row);
        }}
        onKeyDown={(event) => {
          if (deleteOnly || (event.key !== "Enter" && event.key !== " ")) {
            return;
          }
          if (isInteractiveRowTarget(event.target, event.currentTarget)) {
            return;
          }
          event.preventDefault();
          onActivate(row);
        }}
        sx={{
          display: "grid",
          gridTemplateColumns: PROJECT_COLUMNS,
          alignItems: "center",
          minHeight: 58,
          borderBottom: 1,
          borderColor: "rgba(169, 183, 207, 0.12)",
          cursor: deleteOnly ? "default" : "pointer",
          opacity: deleteOnly ? 0.5 : 1,
          backgroundColor: selected ? SELECTED_ROW_BACKGROUND : "transparent",
          transition: "background-color 160ms ease",
          "&:hover": {
            backgroundColor: selected
              ? SELECTED_ROW_BACKGROUND
              : deleteOnly
                ? "transparent"
                : SELECTED_ROW_HOVER_BACKGROUND
          }
        }}
      >
        <Box sx={{ display: "grid", placeItems: "center" }}>
          <RowSelectCheckbox
            label={`Выбрать проект ${getProjectRowLabel(row)}`}
            checked={selected}
            onChange={() => {
              toggle(row.id);
            }}
          />
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, minWidth: 0, px: 1 }}>
          {status === "missing" ? (
            <Tooltip title="Файл проекта не найден">
              <WarningAmberIcon fontSize="small" color="warning" aria-label="Файл проекта не найден" />
            </Tooltip>
          ) : null}
          <Typography
            title={row.projectName}
            sx={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {row.projectName || "—"}
          </Typography>
        </Box>
        <Typography
          title={row.fileName}
          sx={{ minWidth: 0, px: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {row.fileName}
        </Typography>
        <Typography
          title={row.description}
          sx={{ minWidth: 0, px: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {row.description || "—"}
        </Typography>
        <Typography sx={{ px: 1, whiteSpace: "nowrap" }}>{formatSize(row.sizeBytes)}</Typography>
        <Typography sx={{ px: 1, whiteSpace: "nowrap" }}>{formatCreatedAt(row.savedAt)}</Typography>
        <Typography sx={{ px: 1 }}>{formatCount(row.panelCount)}</Typography>
        <Typography sx={{ px: 1 }}>{formatCount(row.mediaCount)}</Typography>
        <Box sx={{ display: "grid", placeItems: "center" }}>
          <Tooltip title="Удалить проект">
            <IconButton
              size="small"
              aria-label={`Удалить проект ${getProjectRowLabel(row)}`}
              onClick={(event) => {
                event.stopPropagation();
                setPendingDeleteIds([row.id]);
              }}
            >
              <DeleteIcon />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>
    );
  };

  const renderStatusAction = (row: ProjectLibraryRow) => {
    const status = getProjectRowStatus(row, probes.get(row.id));
    if (status === "needsPermission") {
      return <Chip size="small" label="Требуется подтверждение" />;
    }
    if (status === "missing") {
      return (
        <Button
          size="small"
          onClick={() => {
            onRelink(row);
          }}
        >
          Указать другой файл
        </Button>
      );
    }

    return null;
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="lg"
      slotProps={{
        paper: {
          sx: {
            width: { xs: "calc(100vw - 24px)", sm: "calc(100vw - 64px)" },
            maxWidth: { xs: "calc(100vw - 24px)", sm: 1180 },
            maxHeight: { xs: "calc(100dvh - 24px)", sm: "calc(100dvh - 64px)" },
            m: { xs: 1.5, sm: 4 }
          }
        }
      }}
    >
      <DialogTitle>Проекты</DialogTitle>
      <DialogContent sx={{ overflowX: "auto", p: { xs: 1, sm: 3 } }}>
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1.5, alignItems: "center", mb: 2 }}>
          <Button variant="outlined" size="small" onClick={onAddProjects}>
            Добавить проекты в список
          </Button>
          <Typography variant="body2" color="text.secondary">
            Список хранит только ссылки на файлы .mumbox, а не их содержимое.
          </Typography>
        </Box>

        {selectedIds.size > 0 ? (
          <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap", mb: 1.5 }}>
            <Typography>Выбрано: {String(selectedIds.size)}</Typography>
            <Button size="small" onClick={clear}>
              Снять выделение
            </Button>
          </Box>
        ) : null}

        <Box role="table" aria-label="Проекты" sx={{ minWidth: PROJECT_MIN_WIDTH }}>
          <Box
            role="row"
            sx={{
              display: "grid",
              gridTemplateColumns: PROJECT_COLUMNS,
              alignItems: "center",
              minHeight: 42,
              borderBottom: 1,
              borderColor: "divider",
              backgroundColor: "rgba(5, 7, 13, 0.92)"
            }}
          >
            <Box role="columnheader" sx={{ display: "grid", placeItems: "center" }}>
              <SelectAllCheckbox
                label="Выбрать все проекты"
                state={selectAllState}
                onChange={(checked) => {
                  setMany(allIds, checked);
                }}
              />
            </Box>
            {["Имя проекта", "Имя файла", "Описание", "Размер", "Сохранён", "Панели", "Аудио", ""].map(
              (title, index) => (
                <Typography
                  key={title || `actions-${String(index)}`}
                  role="columnheader"
                  sx={{ px: 1, fontWeight: 700 }}
                >
                  {title}
                </Typography>
              )
            )}
          </Box>

          {linked.map((row) => {
            const statusAction = renderStatusAction(row);

            return (
              <Box key={row.id}>
                {renderRow(row)}
                {statusAction ? <Box sx={{ px: 2, pb: 1 }}>{statusAction}</Box> : null}
              </Box>
            );
          })}

          {linked.length === 0 && unlinked.length === 0 ? (
            <Box role="row" sx={{ minHeight: 58, display: "flex", alignItems: "center", px: 1 }}>
              <Typography color="text.secondary">Нет проектов</Typography>
            </Box>
          ) : null}

          {unlinked.length > 0 ? (
            <Box role="rowgroup" aria-label="Проекты без привязки к файлу">
              <Box sx={{ px: 1, pt: 2, pb: 1 }}>
                <Typography sx={{ fontWeight: 700 }}>Проекты без привязки к файлу</Typography>
                <Typography variant="body2" color="text.secondary">
                  Этот браузер не умеет запоминать ссылку на файл. Укажите файл заново, чтобы открыть
                  проект.
                </Typography>
              </Box>
              {unlinked.map((row) => (
                <Box key={row.id}>
                  {renderRow(row)}
                  <Box sx={{ px: 2, pb: 1 }}>
                    <Button
                      size="small"
                      onClick={() => {
                        onRelink(row);
                      }}
                    >
                      Указать файл
                    </Button>
                  </Box>
                </Box>
              ))}
            </Box>
          ) : null}
        </Box>
      </DialogContent>
      <DialogActions sx={{ flexWrap: "wrap" }}>
        <Button
          startIcon={<MergeTypeIcon />}
          disabled={selectedRows.length === 0}
          onClick={() => {
            onMerge(selectedRows);
          }}
        >
          Объединить ({String(selectedRows.length)})
        </Button>
        <Button
          color="error"
          startIcon={<DeleteIcon />}
          disabled={selectedRows.length === 0}
          onClick={() => {
            setPendingDeleteIds(selectedRows.map((row) => row.id));
          }}
        >
          Удалить ({String(selectedRows.length)})
        </Button>
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
        message={deleteConfirmText}
        action={
          <>
            <Button
              color="inherit"
              onClick={() => {
                onDelete(pendingDeleteRows);
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
  );
}

import CloseIcon from "@mui/icons-material/Close";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Typography
} from "@mui/material";
import { useEffect, useState } from "react";

import { GridCell } from "../../../entities/cell/model/types";
import { MediaAsset } from "../../../entities/media/model/types";
import { AppSettings, DEFAULT_SETTINGS, settingsEqual } from "../../../shared/lib/appSettings";
import { DiagnosticsSection } from "./DiagnosticsSection";
import { PerformanceSection } from "./PerformanceSection";
import { StorageSection } from "./StorageSection";
import { VisualsSection } from "./VisualsSection";

type SectionId = "performance" | "visuals" | "storage" | "diagnostics" | "reset";

const SECTIONS: readonly { id: SectionId; title: string }[] = [
  { id: "performance", title: "Производительность" },
  { id: "visuals", title: "Визуализация" },
  { id: "storage", title: "Хранилище" },
  { id: "diagnostics", title: "Диагностика" },
  { id: "reset", title: "Сброс" }
];

type AppSettingsDialogProps = {
  open: boolean;
  settings: AppSettings;
  media: MediaAsset[];
  cellsByPanel: Record<string, Record<string, GridCell>>;
  panelCount: number;
  persistenceFailed: boolean;
  /** False when a query flag on this load owns the value; the control says so and is disabled. */
  budgetEditable: boolean;
  partialEditable: boolean;
  listStoredMediaKeys: () => Promise<string[]>;
  mediaBlobPrefix: string;
  onClose: () => void;
  onApply: (settings: AppSettings) => void;
  onDeleteMedia: (mediaIds: string[]) => void;
  onClearDecodedCache: () => void;
  /** Opens the project-wide erase confirmation, which lives in `AppShell`. */
  onEraseAllData: () => void;
};

/**
 * Per-device settings, in five sections.
 *
 * Rendered only while open — `AppShell` guards it — and that is not a detail: a dialog left mounted
 * runs its whole body on every shell render, and this one computes a storage summary and scans the
 * project for unused media. The media library next door is mounted unconditionally and pays exactly
 * that, which is what this avoids.
 *
 * The settings are edited as a DRAFT and applied by the button. The storage actions are the
 * exception and say so: they are operations, not preferences, and waiting for "apply" would mean a
 * deletion that can be abandoned by closing the dialog.
 */
export function AppSettingsDialog({
  open,
  settings,
  media,
  cellsByPanel,
  panelCount,
  persistenceFailed,
  budgetEditable,
  partialEditable,
  listStoredMediaKeys,
  mediaBlobPrefix,
  onClose,
  onApply,
  onDeleteMedia,
  onClearDecodedCache,
  onEraseAllData
}: AppSettingsDialogProps) {
  const [section, setSection] = useState<SectionId>("performance");
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);

  // The draft follows the saved settings while the dialog is closed, so reopening never shows
  // edits that were abandoned.
  useEffect(() => {
    if (!open) {
      setDraft(settings);
      setConfirmingReset(false);
      setConfirmingClose(false);
    }
  }, [open, settings]);

  const dirty = !settingsEqual(draft, settings);

  const closeNow = () => {
    setDraft(settings);
    setConfirmingClose(false);
    onClose();
  };

  const requestClose = () => {
    if (dirty) {
      setConfirmingClose(true);
      return;
    }
    closeNow();
  };

  return (
    <Dialog
      open={open}
      onClose={requestClose}
      fullWidth
      maxWidth="lg"
      aria-labelledby="app-settings-title"
      slotProps={{
        paper: {
          sx: {
            width: { xs: "calc(100vw - 24px)", sm: "calc(100vw - 64px)" },
            maxWidth: { xs: "calc(100vw - 24px)", sm: 1100 },
            // `--app-height` rather than a vh unit: mobile landscape is a first-class layout here
            // and the on-screen keyboard makes vh lie about the space that is actually usable.
            maxHeight: "calc(var(--app-height, 100dvh) - 24px)",
            m: { xs: 1.5, sm: 4 }
          }
        }
      }}
    >
      <DialogTitle
        id="app-settings-title"
        sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", pr: 1 }}
      >
        Настройки приложения
        <IconButton aria-label="Закрыть настройки" onClick={requestClose}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "1fr", sm: "180px minmax(0, 1fr)", md: "240px minmax(0, 1fr)" },
            gridTemplateRows: { xs: "auto minmax(0, 1fr)", sm: "1fr" },
            minHeight: 0,
            height: { xs: "auto", sm: "min(560px, calc(var(--app-height, 100dvh) - 220px))" }
          }}
        >
          <Box
            component="nav"
            aria-label="Категории настроек"
            sx={{
              borderRight: 1,
              borderColor: "divider",
              backgroundColor: "rgba(5, 7, 13, 0.54)",
              overflowY: "auto",
              maxHeight: { xs: 128, sm: "none" }
            }}
          >
            <List dense disablePadding>
              {SECTIONS.map((item) => (
                <ListItemButton
                  key={item.id}
                  selected={section === item.id}
                  data-testid={`settings-nav-${item.id}`}
                  onClick={() => {
                    setSection(item.id);
                  }}
                >
                  <ListItemText primary={item.title} />
                </ListItemButton>
              ))}
            </List>
          </Box>

          <Box sx={{ overflowY: "auto", px: { xs: 2, md: 3 }, py: 2, minWidth: 0 }}>
            {section === "performance" ? (
              <PerformanceSection
                settings={draft}
                budgetEditable={budgetEditable}
                partialEditable={partialEditable}
                onChange={setDraft}
              />
            ) : null}
            {section === "visuals" ? (
              <VisualsSection settings={draft} onChange={setDraft} />
            ) : null}
            {section === "storage" ? (
              <StorageSection
                media={media}
                cellsByPanel={cellsByPanel}
                panelCount={panelCount}
                persistenceFailed={persistenceFailed}
                listStoredMediaKeys={listStoredMediaKeys}
                mediaBlobPrefix={mediaBlobPrefix}
                onDeleteMedia={onDeleteMedia}
                onClearDecodedCache={onClearDecodedCache}
              />
            ) : null}
            {section === "diagnostics" ? (
              <DiagnosticsSection
                settings={draft}
                media={media}
                onChange={setDraft}
                onApply={onApply}
              />
            ) : null}
            {section === "reset" ? (
              <Box data-testid="settings-section-reset" sx={{ display: "grid", gap: 3 }}>
                <Box sx={{ display: "grid", gap: 1 }}>
                  <Typography variant="h6">Сбросить настройки</Typography>
                  <Typography color="text.secondary">
                    Вернёт к умолчанию только настройки этого устройства. Проект, панели, ячейки и
                    медиатека останутся на месте.
                  </Typography>
                  {confirmingReset ? (
                    <Alert
                      severity="warning"
                      action={
                        <Box sx={{ display: "flex", gap: 1 }}>
                          <Button
                            color="inherit"
                            onClick={() => {
                              setDraft(DEFAULT_SETTINGS);
                              onApply(DEFAULT_SETTINGS);
                              setConfirmingReset(false);
                            }}
                          >
                            Сбросить настройки
                          </Button>
                          <Button
                            color="inherit"
                            onClick={() => {
                              setConfirmingReset(false);
                            }}
                          >
                            Отмена
                          </Button>
                        </Box>
                      }
                    >
                      Вернуть все настройки приложения к умолчанию?
                    </Alert>
                  ) : (
                    <Box sx={{ justifySelf: "start" }}>
                      <Button
                        variant="outlined"
                        color="warning"
                        onClick={() => {
                          setConfirmingReset(true);
                        }}
                      >
                        Вернуть настройки приложения к умолчанию
                      </Button>
                    </Box>
                  )}
                </Box>

                <Box sx={{ display: "grid", gap: 1 }}>
                  <Typography variant="h6">Стереть всё</Typography>
                  <Typography color="text.secondary">
                    Удалит проект, панели, ячейки, всю медиатеку и список проектов. Файлы проектов,
                    сохранённые на диск, не тронет. Отменить нельзя, поэтому сначала стоит сохранить
                    проект в файл.
                  </Typography>
                  <Box sx={{ justifySelf: "start" }}>
                    <Button variant="outlined" color="error" onClick={onEraseAllData}>
                      Стереть все данные
                    </Button>
                  </Box>
                </Box>
              </Box>
            ) : null}
          </Box>
        </Box>
      </DialogContent>
      <DialogActions sx={{ gap: 1, flexWrap: "wrap" }}>
        {confirmingClose ? (
          <Alert severity="warning" sx={{ flex: "1 1 auto" }}>
            Настройки изменены и не применены.
          </Alert>
        ) : null}
        {confirmingClose ? (
          <Button
            onClick={() => {
              setConfirmingClose(false);
            }}
          >
            Продолжить настройку
          </Button>
        ) : null}
        <Button onClick={confirmingClose ? closeNow : requestClose}>
          {confirmingClose ? "Закрыть без применения" : "Закрыть"}
        </Button>
        <Button
          variant="contained"
          disabled={!dirty}
          onClick={() => {
            onApply(draft);
            setConfirmingClose(false);
          }}
        >
          Применить
        </Button>
      </DialogActions>
    </Dialog>
  );
}

import FileOpenIcon from "@mui/icons-material/FileOpen";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import SaveAltIcon from "@mui/icons-material/SaveAlt";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import {
  Box,
  Button,
  Backdrop,
  CircularProgress,
  Divider,
  Menu,
  MenuItem,
  Snackbar,
  Stack,
  Typography
} from "@mui/material";
import useMediaQuery from "@mui/material/useMediaQuery";
import { ChangeEvent, MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { serializeState, useAppStore } from "../../../app/model/appState";
import { AudioImportDialog } from "../../../features/audio-import";
import { CellSettingsDrawer } from "../../../features/cell-settings";
import { readConfigFile, saveConfigFile } from "../../../features/file-config";
import { PanelTabs } from "../../../features/panel-tabs";
import { useAudioEngine } from "../../../features/playback/model/useAudioEngine";
import { ProjectFaqDialog } from "../../../features/project-faq";
import { RightToolbar } from "../../right-toolbar";
import { WorkspaceGrid } from "../../workspace-grid";

function isDefinedCell<T>(cell: T | undefined): cell is T {
  return Boolean(cell);
}

const audioExtensions = [".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".opus", ".webm"];
const audioAcceptTypes = [
  ...audioExtensions,
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/flac",
  "audio/ogg",
  "audio/opus",
  "audio/webm"
].join(",");

function isAudioFile(file: File) {
  const fileName = file.name.toLowerCase();
  return file.type.startsWith("audio/") || audioExtensions.some((extension) => fileName.endsWith(extension));
}

function hasConfiguredLayout(
  panelsCount: number,
  mediaCount: number,
  cellsByPanel: Record<string, Record<string, { mediaId: string | null }>>
) {
  return (
    panelsCount > 1 ||
    mediaCount > 0 ||
    Object.values(cellsByPanel).some((cells) =>
      Object.values(cells).some((cell) => Boolean(cell.mediaId))
    )
  );
}

function eventToHotkey(event: KeyboardEvent) {
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  const parts = [
    event.ctrlKey ? "Ctrl" : "",
    event.altKey ? "Alt" : "",
    event.shiftKey ? "Shift" : "",
    event.metaKey ? "Meta" : "",
    key
  ].filter(Boolean);

  return parts.join(" + ");
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return Boolean(target.closest("input, textarea, [contenteditable='true']"));
}

function isStandaloneDisplayMode() {
  const standaloneNavigator = navigator as Navigator & { standalone?: boolean };

  return window.matchMedia("(display-mode: standalone)").matches || standaloneNavigator.standalone === true;
}

export function AppShell() {
  const { state, activePanel, dispatch } = useAppStore();
  const [fileAnchor, setFileAnchor] = useState<HTMLElement | null>(null);
  const [selectedCellId, setSelectedCellId] = useState<string | null>(null);
  const [pendingAudioFiles, setPendingAudioFiles] = useState<File[]>([]);
  const [importLoading, setImportLoading] = useState(false);
  const [configImportWarningOpen, setConfigImportWarningOpen] = useState(false);
  const [faqOpen, setFaqOpen] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [installPromptDismissed, setInstallPromptDismissed] = useState(false);
  const [standaloneMode, setStandaloneMode] = useState(isStandaloneDisplayMode);
  const audioInputRef = useRef<HTMLInputElement | null>(null);
  const audioFolderInputRef = useRef<HTMLInputElement | null>(null);
  const configInputRef = useRef<HTMLInputElement | null>(null);
  const mobileBrowser = useMediaQuery("(hover: none) and (pointer: coarse)");
  const activeCells = useMemo(() => {
    if (!activePanel) {
      return [];
    }
    const cells = state.cellsByPanel[activePanel.id] ?? {};
    return activePanel.cellIds.map((cellId) => cells[cellId]).filter(isDefinedCell);
  }, [activePanel, state.cellsByPanel]);
  const { playingCells, playCell, toggleCell, stopCell, stopAll } = useAudioEngine(
    state.media,
    activeCells,
    state.masterVolume,
    state.masterMuted,
    state.stopOthers
  );

  const handleOpenFileMenu = (event: MouseEvent<HTMLButtonElement>) => {
    setFileAnchor(event.currentTarget);
  };

  const selectedCell = activeCells.find((cell) => cell.id === selectedCellId) ?? null;
  const cellSettingsOpen = state.editMode && Boolean(selectedCell);

  useEffect(() => {
    audioFolderInputRef.current?.setAttribute("webkitdirectory", "");
    audioFolderInputRef.current?.setAttribute("directory", "");
  }, []);

  useEffect(() => {
    const standaloneQuery = window.matchMedia("(display-mode: standalone)");
    const syncStandaloneMode = () => {
      setStandaloneMode(isStandaloneDisplayMode());
    };

    standaloneQuery.addEventListener("change", syncStandaloneMode);
    return () => {
      standaloneQuery.removeEventListener("change", syncStandaloneMode);
    };
  }, []);

  useEffect(() => {
    let animationFrameId = 0;
    const syncAppHeight = () => {
      window.cancelAnimationFrame(animationFrameId);
      animationFrameId = window.requestAnimationFrame(() => {
        const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
        document.documentElement.style.setProperty("--app-height", `${String(viewportHeight)}px`);
      });
    };
    const syncAppHeightAfterRotation = () => {
      syncAppHeight();
      window.setTimeout(syncAppHeight, 120);
      window.setTimeout(syncAppHeight, 360);
    };

    syncAppHeight();
    window.visualViewport?.addEventListener("resize", syncAppHeight);
    window.visualViewport?.addEventListener("scroll", syncAppHeight);
    window.addEventListener("resize", syncAppHeight);
    window.addEventListener("orientationchange", syncAppHeightAfterRotation);
    window.addEventListener("pageshow", syncAppHeight);
    return () => {
      window.cancelAnimationFrame(animationFrameId);
      window.visualViewport?.removeEventListener("resize", syncAppHeight);
      window.visualViewport?.removeEventListener("scroll", syncAppHeight);
      window.removeEventListener("resize", syncAppHeight);
      window.removeEventListener("orientationchange", syncAppHeightAfterRotation);
      window.removeEventListener("pageshow", syncAppHeight);
      document.documentElement.style.removeProperty("--app-height");
    };
  }, []);

  useEffect(() => {
    const preventZoomGesture = (event: Event) => {
      event.preventDefault();
    };
    const preventMultiTouchZoom = (event: TouchEvent) => {
      if (event.touches.length > 1) {
        event.preventDefault();
      }
    };
    const options = { passive: false };

    document.addEventListener("gesturestart", preventZoomGesture, options);
    document.addEventListener("gesturechange", preventZoomGesture, options);
    document.addEventListener("touchmove", preventMultiTouchZoom, options);
    return () => {
      document.removeEventListener("gesturestart", preventZoomGesture);
      document.removeEventListener("gesturechange", preventZoomGesture);
      document.removeEventListener("touchmove", preventMultiTouchZoom);
    };
  }, []);

  const closeFileMenu = () => {
    setFileAnchor(null);
  };

  const handleAudioFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []).filter(isAudioFile);
    if (files.length > 0) {
      setImportLoading(true);
      setPendingAudioFiles(files);
    }
    event.target.value = "";
  };

  const handleConfigFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    void readConfigFile(file).then((importedState) => {
      stopAll();
      dispatch({ type: "state/import", state: importedState });
      setSelectedCellId(null);
    });
  };

  const requestConfigImport = () => {
    if (hasConfiguredLayout(state.panels.length, state.media.length, state.cellsByPanel)) {
      setConfigImportWarningOpen(true);
      return;
    }

    configInputRef.current?.click();
  };

  const handleImportReady = useCallback(() => {
    setImportLoading(false);
  }, []);

  const handleImportLoadingChange = useCallback((loading: boolean) => {
    setImportLoading(loading);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (state.editMode || event.repeat || isEditableTarget(event.target)) {
        return;
      }
      const hotkey = eventToHotkey(event);
      const cell = activeCells.find((candidate) => candidate.hotkey === hotkey);
      if (!cell?.mediaId) {
        return;
      }
      event.preventDefault();
      if (cell.playbackMode === "gate") {
        void playCell(cell);
        return;
      }
      void toggleCell(cell);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (state.editMode || isEditableTarget(event.target)) {
        return;
      }
      const hotkey = eventToHotkey(event);
      const cell = activeCells.find((candidate) => candidate.hotkey === hotkey);
      if (cell?.playbackMode === "gate") {
        stopCell(cell.id);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [activeCells, playCell, state.editMode, stopCell, toggleCell]);

  if (!activePanel) {
    return null;
  }

  return (
    <Box
      data-noselect
      sx={{
        width: "100vw",
        height: "var(--app-height)",
        minHeight: 0,
        display: "grid",
        gridTemplateRows: {
          xs: "44px minmax(0, 1fr)",
          sm: "52px minmax(0, 1fr)"
        },
        color: "text.primary",
        overflow: "hidden",
        pt: "var(--app-safe-area-top)",
        pr: "var(--app-safe-area-right)",
        pb: "var(--app-safe-area-bottom)",
        pl: "var(--app-safe-area-left)",
        "@media (orientation: landscape) and (max-height: 430px)": {
          gridTemplateRows: "34px minmax(0, 1fr)",
          pt: 0,
          pb: 0
        }
      }}
    >
      <Box
        component="header"
        sx={{
          display: "grid",
          gridTemplateColumns: "auto minmax(0, 1fr) auto",
          alignItems: "center",
          gap: 1.5,
          px: 1.5,
          borderBottom: 1,
          borderColor: "divider",
          backgroundColor: "rgba(5, 7, 13, 0.78)",
          backdropFilter: "blur(18px)",
          "@media (orientation: landscape) and (max-height: 430px)": {
            gap: 0.75,
            px: 0.75,
            "& .MuiButton-root": {
              minWidth: 36,
              px: 0.75,
              py: 0.125
            },
            "& .MuiButton-startIcon": {
              mr: 0.5
            }
          }
        }}
      >
        <Button
          aria-controls={fileAnchor ? "file-menu" : undefined}
          aria-haspopup="true"
          aria-expanded={fileAnchor ? "true" : undefined}
          startIcon={<FileOpenIcon />}
          onClick={handleOpenFileMenu}
          variant="outlined"
          size="small"
        >
          Файл
        </Button>
        <Menu
          id="file-menu"
          anchorEl={fileAnchor}
          open={Boolean(fileAnchor)}
          onClose={closeFileMenu}
        >
          <MenuItem
            onClick={() => {
              void saveConfigFile(serializeState(state))
                .then((fileName) => {
                  setSaveMessage(`Конфиг сохранен: ${fileName}`);
                })
                .catch((error: unknown) => {
                  if (error instanceof DOMException && error.name === "AbortError") {
                    return;
                  }
                  setSaveMessage("Не удалось сохранить конфиг");
                });
              closeFileMenu();
            }}
          >
            <SaveAltIcon fontSize="small" />
            <Typography sx={{ ml: 1 }}>Сохранить в файл</Typography>
          </MenuItem>
          <MenuItem
            onClick={() => {
              requestConfigImport();
              closeFileMenu();
            }}
          >
            <UploadFileIcon fontSize="small" />
            <Typography sx={{ ml: 1 }}>Импортировать конфиг</Typography>
          </MenuItem>
          <MenuItem
            onClick={() => {
              audioInputRef.current?.click();
              closeFileMenu();
            }}
          >
            <UploadFileIcon fontSize="small" />
            <Typography sx={{ ml: 1 }}>Импорт аудио</Typography>
          </MenuItem>
          <MenuItem
            onClick={() => {
              audioFolderInputRef.current?.click();
              closeFileMenu();
            }}
          >
            <UploadFileIcon fontSize="small" />
            <Typography sx={{ ml: 1 }}>Импорт папки аудио</Typography>
          </MenuItem>
          <Divider />
          <MenuItem
            onClick={() => {
              setFaqOpen(true);
              closeFileMenu();
            }}
          >
            <HelpOutlineIcon fontSize="small" />
            <Typography sx={{ ml: 1 }}>ЧАВО</Typography>
          </MenuItem>
        </Menu>
        <input
          ref={configInputRef}
          type="file"
          accept="application/json"
          hidden
          onChange={handleConfigFile}
        />
        <input
          ref={audioInputRef}
          data-testid="audio-file-input"
          type="file"
          accept={audioAcceptTypes}
          multiple
          hidden
          onChange={handleAudioFiles}
        />
        <input
          ref={audioFolderInputRef}
          data-testid="audio-folder-input"
          type="file"
          accept={audioAcceptTypes}
          multiple
          hidden
          onChange={handleAudioFiles}
        />

        <Stack direction="row" alignItems="center" minWidth={0} sx={{ overflow: "hidden" }}>
          <PanelTabs
            panels={state.panels}
            activePanelId={state.activePanelId}
            dispatch={dispatch}
            onDeletePanel={(panelId) => {
              stopAll();
              if (selectedCellId && state.activePanelId === panelId) {
                setSelectedCellId(null);
              }
              dispatch({ type: "panel/delete", panelId });
            }}
          />
        </Stack>

        <Typography
          component="div"
          sx={{
            fontWeight: 700,
            fontSize: { xs: 18, sm: 22 },
            color: "primary.main",
            textShadow: "0 0 18px rgba(140, 248, 255, 0.5)",
            "@media (orientation: landscape) and (max-height: 430px)": {
              fontSize: 14
            }
          }}
        >
          MUMBOX
        </Typography>
      </Box>

      <Box
        component="main"
        sx={{
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: cellSettingsOpen
            ? { xs: "minmax(0, 1fr) 82px minmax(220px, 36vw)", sm: "minmax(0, 1fr) 64px minmax(280px, 40vw)", lg: "minmax(0, 1fr) 76px 460px" }
            : { xs: "minmax(0, 1fr) 82px", sm: "minmax(0, 1fr) 64px", lg: "minmax(0, 1fr) 76px" },
          gap: { xs: 0.75, sm: 1.5 },
          p: { xs: 0.75, sm: 1.5 },
          overflow: "hidden",
          "@media (max-height: 480px)": {
            gridTemplateColumns: cellSettingsOpen
              ? "minmax(0, 1fr) 46px minmax(190px, 34vw)"
              : "minmax(0, 1fr) 46px",
            gap: 0.5,
            p: 0.5
          },
          "@media (orientation: landscape) and (max-height: 430px)": {
            gap: 0.375,
            p: 0.375
          }
        }}
      >
        <WorkspaceGrid
          gridSize={activePanel.gridSize}
          cells={activeCells}
          media={state.media}
          editMode={state.editMode}
          selectedCellId={selectedCellId}
          playingCells={playingCells}
          onCellClick={(cell) => {
            if (state.editMode) {
              setSelectedCellId(cell.id);
              return;
            }
            if (cell.playbackMode !== "gate") {
              void toggleCell(cell);
            }
          }}
          onGateStart={(cell) => {
            void playCell(cell);
          }}
          onGateEnd={(cell) => {
            stopCell(cell.id);
          }}
          onCellMove={(fromCellId, toCellId) => {
            setSelectedCellId((current) => {
              if (!state.editMode) {
                return current;
              }
              if (current === fromCellId) {
                return toCellId;
              }
              if (current === toCellId) {
                return fromCellId;
              }
              return current;
            });
            dispatch({ type: "cell/move", panelId: activePanel.id, fromCellId, toCellId });
          }}
        />
        <RightToolbar
          masterVolume={state.masterVolume}
          masterMuted={state.masterMuted}
          editMode={state.editMode}
          stopOthers={state.stopOthers}
          gridSize={activePanel.gridSize}
          panelId={activePanel.id}
          dispatch={dispatch}
          onStopAll={stopAll}
        />
        <CellSettingsDrawer
          open={cellSettingsOpen}
          panelId={activePanel.id}
          cell={selectedCell}
          media={state.media}
          dispatch={dispatch}
          onClose={() => {
            setSelectedCellId(null);
          }}
          onClearCell={(cellId) => {
            stopCell(cellId);
            dispatch({ type: "cell/clear", panelId: activePanel.id, cellId });
          }}
          panelCells={activeCells}
          onDeleteMedia={(mediaId) => {
            stopAll();
            dispatch({ type: "media/deleteMany", mediaIds: [mediaId] });
          }}
        />
      </Box>
      <AudioImportDialog
        open={pendingAudioFiles.length > 0}
        files={pendingAudioFiles}
        onSave={(media) => {
          dispatch({ type: "media/addMany", media });
          setPendingAudioFiles([]);
          setImportLoading(false);
        }}
        onReady={handleImportReady}
        onLoadingChange={handleImportLoadingChange}
        onCancel={() => {
          setPendingAudioFiles([]);
          setImportLoading(false);
        }}
      />
      <ProjectFaqDialog
        open={faqOpen}
        onClose={() => {
          setFaqOpen(false);
        }}
      />
      <Backdrop
        open={importLoading}
        sx={{
          zIndex: (theme) => theme.zIndex.modal + 20,
          color: "primary.main",
          backgroundColor: "rgba(5, 7, 13, 0.72)",
          backdropFilter: "blur(10px)"
        }}
      >
        <CircularProgress color="inherit" />
      </Backdrop>
      <Snackbar
        open={mobileBrowser && !standaloneMode && !installPromptDismissed}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        message="Добавьте ярлык на главный экран, чтобы установить MUMBOX."
        action={
          <Button
            color="inherit"
            onClick={() => {
              setInstallPromptDismissed(true);
            }}
          >
            ОК
          </Button>
        }
        onClose={() => {
          setInstallPromptDismissed(true);
        }}
      />
      <Snackbar
        open={configImportWarningOpen}
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
        message="Импорт конфига перезапишет текущую рабочую раскладку"
        action={
          <>
            <Button
              color="inherit"
              onClick={() => {
                setConfigImportWarningOpen(false);
                configInputRef.current?.click();
              }}
            >
              Импортировать
            </Button>
            <Button
              color="inherit"
              onClick={() => {
                setConfigImportWarningOpen(false);
              }}
            >
              Отмена
            </Button>
          </>
        }
        onClose={() => {
          setConfigImportWarningOpen(false);
        }}
      />
      <Snackbar
        open={Boolean(saveMessage)}
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
        message={saveMessage}
        autoHideDuration={3200}
        onClose={() => {
          setSaveMessage("");
        }}
      />
    </Box>
  );
}

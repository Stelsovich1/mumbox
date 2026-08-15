import FileOpenIcon from "@mui/icons-material/FileOpen";
import DeleteIcon from "@mui/icons-material/Delete";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import LibraryMusicIcon from "@mui/icons-material/LibraryMusic";
import SaveAltIcon from "@mui/icons-material/SaveAlt";
import SystemUpdateAltIcon from "@mui/icons-material/SystemUpdateAlt";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import {
  Box,
  Button,
  Backdrop,
  CircularProgress,
  Divider,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Menu,
  MenuItem,
  Snackbar,
  Stack,
  Typography
} from "@mui/material";
import useMediaQuery from "@mui/material/useMediaQuery";
import {
  ChangeEvent,
  MouseEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useRegisterSW } from "virtual:pwa-register/react";

import {
  clearStoredAppData,
  deleteStoredMedia,
  MediaStorageProgress,
  serializeState,
  useAppStore,
  writeImportedProjectMedia
} from "../../../app/model/appState";
import { AudioImportDialog } from "../../../features/audio-import";
import { CellSettingsDrawer } from "../../../features/cell-settings";
import {
  LARGE_PROJECT_IMPORT_BYTES,
  makeProjectBlob,
  PROJECT_FILE_EXTENSION,
  ProjectFileProgress,
  readProjectFile,
  saveProjectBlob
} from "../../../features/file-config";
import { MediaLibraryDialog } from "../../../features/media-library";
import { PanelTabs } from "../../../features/panel-tabs";
import { useAudioEngine } from "../../../features/playback/model/useAudioEngine";
import { ProjectFaqDialog } from "../../../features/project-faq";
import { hasLikelyStorageForBytes } from "../../../shared/lib/storage";
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
const SETTINGS_PANEL_MIN_WIDTH = 460;
const SETTINGS_PANEL_MAX_WIDTH = SETTINGS_PANEL_MIN_WIDTH * 2;
const SETTINGS_PANEL_MOBILE_MIN_WIDTH = 170;
const SETTINGS_PANEL_LANDSCAPE_MIN_WIDTH = 190;
const SETTINGS_PANEL_RESIZER_WIDTH = 12;
const pleasantPink = "rgba(236, 90, 167, 0.78)";

type OperationProgress = {
  completed: number;
  total: number;
  label: string;
};

function isAudioFile(file: File) {
  const fileName = file.name.toLowerCase();
  return file.type.startsWith("audio/") || audioExtensions.some((extension) => fileName.endsWith(extension));
}

function getAudioMimeCandidates(fileName: string, mimeType: string) {
  if (mimeType) {
    return [mimeType];
  }
  const extension = fileName.toLowerCase().slice(fileName.lastIndexOf("."));
  const mimeByExtension: Record<string, string[]> = {
    ".mp3": ["audio/mpeg"],
    ".wav": ["audio/wav", "audio/x-wav"],
    ".ogg": ["audio/ogg"],
    ".m4a": ["audio/mp4", "audio/x-m4a"],
    ".aac": ["audio/aac"],
    ".flac": ["audio/flac"],
    ".opus": ["audio/opus", "audio/ogg"],
    ".webm": ["audio/webm"]
  };

  return mimeByExtension[extension] ?? [];
}

function isPlayableAudio(fileName: string, mimeType: string) {
  const audio = document.createElement("audio");
  const candidates = getAudioMimeCandidates(fileName, mimeType);

  return candidates.length === 0 || candidates.some((candidate) => audio.canPlayType(candidate) !== "");
}

function isDuplicateMediaFile(
  file: File,
  media: { fileName: string; size?: number; mimeType: string }[]
) {
  return media.some((item) => {
    if (item.fileName !== file.name) {
      return false;
    }
    if (typeof item.size === "number") {
      return item.size === file.size;
    }

    return item.mimeType === file.type || !file.type;
  });
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

function hasConfiguredCell(cell: {
  mediaId: string | null;
  aliasOverride: string;
  colorOverride: string | null;
  hotkey: string;
  playbackMode: string;
  volumeOffset: number;
  trimStartMs: number | null;
  trimEndMs: number | null;
  fadeInEnabled: boolean;
  fadeInMs: number;
  fadeOutEnabled: boolean;
  fadeOutMs: number;
}) {
  return (
    Boolean(cell.mediaId) ||
    cell.aliasOverride.length > 0 ||
    cell.colorOverride !== null ||
    cell.hotkey.length > 0 ||
    cell.playbackMode !== "once" ||
    cell.volumeOffset !== 0 ||
    cell.trimStartMs !== null ||
    cell.trimEndMs !== null ||
    cell.fadeInEnabled ||
    cell.fadeInMs !== 0 ||
    cell.fadeOutEnabled ||
    cell.fadeOutMs !== 0
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

function getStableAppHeight() {
  const viewport = window.visualViewport;
  const focusedElement = document.activeElement;
  const editableFocused = isEditableTarget(focusedElement);

  if (!viewport) {
    return window.innerHeight;
  }

  const keyboardLikeReduction = viewport.height < window.innerHeight - 80;
  if (keyboardLikeReduction && editableFocused) {
    return viewport.height;
  }

  return window.innerHeight;
}

export function AppShell() {
  const { state, activePanel, dispatch } = useAppStore();
  const [fileAnchor, setFileAnchor] = useState<HTMLElement | null>(null);
  const [selectedCellId, setSelectedCellId] = useState<string | null>(null);
  const [pendingAudioFiles, setPendingAudioFiles] = useState<File[]>([]);
  const [importLoading, setImportLoading] = useState(false);
  const [operationProgress, setOperationProgress] = useState<OperationProgress | null>(null);
  const [configImportWarningOpen, setConfigImportWarningOpen] = useState(false);
  const [largeProjectFile, setLargeProjectFile] = useState<File | null>(null);
  const [preparedProjectBlob, setPreparedProjectBlob] = useState<Blob | null>(null);
  const [mediaLibraryOpen, setMediaLibraryOpen] = useState(false);
  const [pendingDeletePanelId, setPendingDeletePanelId] = useState<string | null>(null);
  const [pendingClearCellId, setPendingClearCellId] = useState<string | null>(null);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [faqOpen, setFaqOpen] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [installPromptDismissed, setInstallPromptDismissed] = useState(false);
  const [standaloneMode, setStandaloneMode] = useState(isStandaloneDisplayMode);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [settingsPanelWidth, setSettingsPanelWidth] = useState(SETTINGS_PANEL_MIN_WIDTH);
  const swRegistrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const audioInputRef = useRef<HTMLInputElement | null>(null);
  const audioFolderInputRef = useRef<HTMLInputElement | null>(null);
  const projectInputRef = useRef<HTMLInputElement | null>(null);
  const mobileBrowser = useMediaQuery("(hover: none) and (pointer: coarse)");
  const {
    needRefresh: [updateAvailable],
    updateServiceWorker
  } = useRegisterSW({
    immediate: true,
    onNeedRefresh() {
      setUpdateDialogOpen(true);
    },
    onRegisteredSW(_, registration) {
      swRegistrationRef.current = registration ?? null;
    }
  });
  const activeCells = useMemo(() => {
    if (!activePanel) {
      return [];
    }
    const cells = state.cellsByPanel[activePanel.id] ?? {};
    return activePanel.cellIds.map((cellId) => cells[cellId]).filter(isDefinedCell);
  }, [activePanel, state.cellsByPanel]);
  const { playingCells, warmedMedia, playCell, toggleCell, stopCell, stopAll } = useAudioEngine(
    activePanel?.id ?? "",
    state.media,
    activeCells,
    state.masterVolume,
    state.masterMuted,
    state.stopOthers
  );

  const handleOpenFileMenu = (event: MouseEvent<HTMLButtonElement>) => {
    setFileAnchor(event.currentTarget);
  };

  function closeFileMenu() {
    setFileAnchor(null);
  }

  const selectedCell = activeCells.find((cell) => cell.id === selectedCellId) ?? null;
  const cellSettingsOpen = state.editMode && Boolean(selectedCell);
  const pendingDeletePanel =
    state.panels.find((panel) => panel.id === pendingDeletePanelId) ?? null;
  const pendingClearCell = pendingClearCellId
    ? state.cellsByPanel[activePanel?.id ?? ""]?.[pendingClearCellId] ?? null
    : null;

  const deletePanel = (panelId: string) => {
    stopAll();
    if (selectedCellId && state.activePanelId === panelId) {
      setSelectedCellId(null);
    }
    dispatch({ type: "panel/delete", panelId });
  };

  const requestDeletePanel = (panelId: string) => {
    const cells = state.cellsByPanel[panelId] ?? {};
    const hasFilledCells = Object.values(cells).some((cell) => Boolean(cell.mediaId));

    if (!hasFilledCells) {
      deletePanel(panelId);
      return;
    }

    setPendingDeletePanelId(panelId);
  };

  const clearCell = (cellId: string) => {
    if (!activePanel) {
      return;
    }
    stopCell(cellId);
    dispatch({ type: "cell/clear", panelId: activePanel.id, cellId });
    setSelectedCellId(null);
  };

  const requestClearCell = (cellId: string) => {
    if (!activePanel) {
      return;
    }
    const cell = state.cellsByPanel[activePanel.id]?.[cellId];
    if (!cell || !hasConfiguredCell(cell)) {
      clearCell(cellId);
      return;
    }

    setPendingClearCellId(cellId);
  };

  const clampSettingsPanelWidth = useCallback((nextWidth: number) => {
    const viewportWidth = window.innerWidth;
    let minimumWidth = SETTINGS_PANEL_MIN_WIDTH;
    if (window.matchMedia("(orientation: portrait) and (max-width: 700px)").matches) {
      minimumWidth = SETTINGS_PANEL_MOBILE_MIN_WIDTH;
    } else if (window.matchMedia("(max-height: 480px)").matches) {
      minimumWidth = SETTINGS_PANEL_LANDSCAPE_MIN_WIDTH;
    }
    const reservedWidth = viewportWidth < 700 ? 210 : 360;
    const maximumWidth = Math.min(SETTINGS_PANEL_MAX_WIDTH, Math.max(minimumWidth, viewportWidth - reservedWidth));

    return Math.min(maximumWidth, Math.max(minimumWidth, nextWidth));
  }, []);

  const startSettingsPanelResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startWidth = settingsPanelWidth;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        setSettingsPanelWidth(clampSettingsPanelWidth(startWidth - (moveEvent.clientX - startX)));
      };
      const handlePointerUp = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    },
    [clampSettingsPanelWidth, settingsPanelWidth]
  );

  useEffect(() => {
    setSettingsPanelWidth((current) => clampSettingsPanelWidth(current));
  }, [cellSettingsOpen, clampSettingsPanelWidth]);

  useEffect(() => {
    const handleResize = () => {
      setSettingsPanelWidth((current) => clampSettingsPanelWidth(current));
    };

    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", handleResize);
    };
  }, [clampSettingsPanelWidth]);

  useEffect(() => {
    if (state.editMode) {
      stopAll();
    }
  }, [state.editMode, stopAll]);

  const requestAppUpdate = useCallback(() => {
    closeFileMenu();
    stopAll();
    void updateServiceWorker(true);
  }, [stopAll, updateServiceWorker]);

  useEffect(() => {
    audioFolderInputRef.current?.setAttribute("webkitdirectory", "");
    audioFolderInputRef.current?.setAttribute("directory", "");
  }, []);

  useEffect(() => {
    if (updateAvailable) {
      setUpdateDialogOpen(true);
    }
  }, [updateAvailable]);

  useEffect(() => {
    const checkForServiceWorkerUpdate = () => {
      if (document.visibilityState === "visible") {
        void swRegistrationRef.current?.update();
      }
    };

    window.addEventListener("pageshow", checkForServiceWorkerUpdate);
    document.addEventListener("visibilitychange", checkForServiceWorkerUpdate);
    return () => {
      window.removeEventListener("pageshow", checkForServiceWorkerUpdate);
      document.removeEventListener("visibilitychange", checkForServiceWorkerUpdate);
    };
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
        const viewportHeight = getStableAppHeight();
        document.documentElement.style.setProperty("--app-height", `${String(viewportHeight)}px`);
      });
    };
    const syncAppHeightAfterRotation = () => {
      if (isEditableTarget(document.activeElement)) {
        (document.activeElement as HTMLElement).blur();
      }
      window.scrollTo(0, 0);
      syncAppHeight();
      window.setTimeout(syncAppHeight, 120);
      window.setTimeout(syncAppHeight, 360);
      window.setTimeout(syncAppHeight, 720);
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

  const updateOperationProgress = useCallback(
    (progress: MediaStorageProgress | ProjectFileProgress | null) => {
      setOperationProgress(
        progress
          ? {
              completed: progress.completed,
              total: progress.total,
              label: progress.label
            }
          : null
      );
    },
    []
  );

  const deleteMediaFromLibrary = useCallback(
    (mediaId: string) => {
      stopAll();
      dispatch({ type: "media/deleteMany", mediaIds: [mediaId] });
      void deleteStoredMedia([mediaId]).catch(() => {
        setSaveMessage("Не удалось удалить аудио из хранилища браузера");
      });
    },
    [dispatch, stopAll]
  );

  const handleAudioFiles = (event: ChangeEvent<HTMLInputElement>, source: "files" | "folder") => {
    const selectedFiles = Array.from(event.target.files ?? []).filter(isAudioFile);
    const unsupportedFiles = selectedFiles.filter((file) => !isPlayableAudio(file.name, file.type));
    const playableFiles = selectedFiles.filter((file) => isPlayableAudio(file.name, file.type));
    const files =
      source === "files"
        ? playableFiles.filter((file) => !isDuplicateMediaFile(file, state.media))
        : playableFiles;
    const duplicateCount = source === "files" ? playableFiles.length - files.length : 0;

    if (unsupportedFiles.length > 0) {
      setSaveMessage(
        `Формат не поддерживается на этом устройстве: ${unsupportedFiles
          .slice(0, 3)
          .map((file) => file.name)
          .join(", ")}`
      );
    } else if (duplicateCount > 0) {
      setSaveMessage(`Дубликаты уже есть в медиатеке и пропущены: ${String(duplicateCount)}`);
    }

    if (files.length > 0) {
      setImportLoading(true);
      void hasLikelyStorageForBytes(files.reduce((sum, file) => sum + file.size, 0)).then((result) => {
        if (!result.enough) {
          setImportLoading(false);
          setSaveMessage("В браузерном хранилище может не хватить места для выбранных аудио");
          return;
        }
        setPendingAudioFiles(files);
      });
    }
    event.target.value = "";
  };

  const importProjectFile = (file: File) => {
    setImportLoading(true);
    updateOperationProgress({ completed: 0, total: 1, label: "Проверка хранилища" });
    void hasLikelyStorageForBytes(file.size)
      .then(async (storage) => {
        if (!storage.enough) {
          setSaveMessage("В браузерном хранилище может не хватить места для проекта");
          return null;
        }
        return readProjectFile(file, updateOperationProgress);
      })
      .then(async (project) => {
        if (!project) {
          return;
        }
        const unsupportedMedia = project.mediaBlobs.filter(
          (item) => !isPlayableAudio(item.fileName, item.mimeType)
        );
        if (unsupportedMedia.length > 0) {
          setSaveMessage(
            `Проект содержит неподдерживаемый формат: ${unsupportedMedia
              .slice(0, 3)
              .map((item) => item.fileName)
              .join(", ")}`
          );
          return;
        }
        stopAll();
        const oldMediaIds = state.media.map((item) => item.id);
        const importedState = await writeImportedProjectMedia(
          project.state,
          project.mediaBlobs.map((item) => ({ id: item.id, blob: item.blob })),
          updateOperationProgress
        );
        dispatch({ type: "state/import", state: importedState });
        await deleteStoredMedia(oldMediaIds);
        setSelectedCellId(null);
        setSaveMessage(`Проект импортирован: ${file.name}`);
      })
      .catch(() => {
        setSaveMessage("Не удалось импортировать проект");
      })
      .finally(() => {
        setImportLoading(false);
        updateOperationProgress(null);
      });
  };

  const handleProjectFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    if (file.size >= LARGE_PROJECT_IMPORT_BYTES) {
      setLargeProjectFile(file);
      return;
    }
    importProjectFile(file);
  };

  const requestConfigImport = () => {
    if (hasConfiguredLayout(state.panels.length, state.media.length, state.cellsByPanel)) {
      setConfigImportWarningOpen(true);
      return;
    }

    projectInputRef.current?.click();
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
          Проект
        </Button>
        <Menu
          id="file-menu"
          anchorEl={fileAnchor}
          open={Boolean(fileAnchor)}
          onClose={closeFileMenu}
        >
          <MenuItem
            onClick={() => {
              setImportLoading(true);
              updateOperationProgress({ completed: 0, total: Math.max(1, state.media.length), label: "Сборка проекта" });
              void makeProjectBlob(serializeState(state), updateOperationProgress)
                .then((blob) => {
                  setPreparedProjectBlob(blob);
                })
                .catch(() => {
                  setSaveMessage("Не удалось экспортировать проект");
                })
                .finally(() => {
                  setImportLoading(false);
                  updateOperationProgress(null);
                });
              closeFileMenu();
            }}
          >
            <SaveAltIcon fontSize="small" />
            <Typography sx={{ ml: 1 }}>Экспорт проекта</Typography>
          </MenuItem>
          <MenuItem
            onClick={() => {
              setMediaLibraryOpen(true);
              closeFileMenu();
            }}
          >
            <LibraryMusicIcon fontSize="small" />
            <Typography sx={{ ml: 1 }}>Медиатека</Typography>
          </MenuItem>
          <MenuItem
            onClick={() => {
              requestConfigImport();
              closeFileMenu();
            }}
          >
            <UploadFileIcon fontSize="small" />
            <Typography sx={{ ml: 1 }}>Импорт проекта</Typography>
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
          <Divider />
          <MenuItem
            onClick={() => {
              setResetConfirmOpen(true);
              closeFileMenu();
            }}
            sx={{ color: "error.main" }}
          >
            <DeleteIcon fontSize="small" />
            <Typography sx={{ ml: 1 }}>Стереть все данные</Typography>
          </MenuItem>
          {updateAvailable ? (
            <>
              <Divider />
              <MenuItem onClick={requestAppUpdate}>
                <SystemUpdateAltIcon fontSize="small" />
                <Typography sx={{ ml: 1 }}>Обновить приложение</Typography>
              </MenuItem>
            </>
          ) : null}
        </Menu>
        <input
          ref={projectInputRef}
          data-testid="project-file-input"
          type="file"
          accept={`${PROJECT_FILE_EXTENSION},application/vnd.mumbox.project+json,application/json`}
          hidden
          onChange={handleProjectFile}
        />
        <input
          ref={audioInputRef}
          data-testid="audio-file-input"
          type="file"
          accept={audioAcceptTypes}
          multiple
          hidden
          onChange={(event) => {
            handleAudioFiles(event, "files");
          }}
        />
        <input
          ref={audioFolderInputRef}
          data-testid="audio-folder-input"
          type="file"
          accept={audioAcceptTypes}
          multiple
          hidden
          onChange={(event) => {
            handleAudioFiles(event, "folder");
          }}
        />

        <Stack direction="row" alignItems="center" minWidth={0} sx={{ overflow: "hidden" }}>
          <PanelTabs
            panels={state.panels}
            activePanelId={state.activePanelId}
            editMode={state.editMode}
            dispatch={dispatch}
            onDeletePanel={requestDeletePanel}
          />
        </Stack>

        <Typography
          component="div"
          sx={{
            fontWeight: 700,
            fontSize: { xs: 18, sm: 22 },
            color: "primary.main",
            textShadow: "0 0 18px rgba(236, 90, 167, 0.5)",
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
            ? {
                xs: `minmax(128px, 1fr) 82px ${String(SETTINGS_PANEL_RESIZER_WIDTH)}px minmax(${String(SETTINGS_PANEL_MOBILE_MIN_WIDTH)}px, ${String(settingsPanelWidth)}px)`,
                sm: `minmax(0, 1fr) 64px ${String(SETTINGS_PANEL_RESIZER_WIDTH)}px minmax(280px, ${String(settingsPanelWidth)}px)`,
                lg: `minmax(0, 1fr) 76px ${String(SETTINGS_PANEL_RESIZER_WIDTH)}px minmax(${String(SETTINGS_PANEL_MIN_WIDTH)}px, ${String(settingsPanelWidth)}px)`
              }
            : { xs: "minmax(0, 1fr) 82px", sm: "minmax(0, 1fr) 64px", lg: "minmax(0, 1fr) 76px" },
          gap: { xs: 0.375, sm: 0.75 },
          p: { xs: 0.75, sm: 1.5 },
          overflow: "hidden",
          "@media (max-height: 480px)": {
            gridTemplateColumns: cellSettingsOpen
              ? `minmax(0, 1fr) 46px ${String(SETTINGS_PANEL_RESIZER_WIDTH)}px minmax(${String(SETTINGS_PANEL_LANDSCAPE_MIN_WIDTH)}px, ${String(settingsPanelWidth)}px)`
              : "minmax(0, 1fr) 46px",
            gap: 0.25,
            p: 0.5
          },
          "@media (orientation: portrait) and (max-width: 700px)": {
            gridTemplateColumns: cellSettingsOpen
              ? `minmax(128px, 1fr) 57px ${String(SETTINGS_PANEL_RESIZER_WIDTH)}px minmax(${String(SETTINGS_PANEL_MOBILE_MIN_WIDTH)}px, ${String(settingsPanelWidth)}px)`
              : "minmax(0, 1fr) 57px",
            gap: 0.25,
            p: 0.5
          },
          "@media (orientation: landscape) and (max-height: 430px)": {
            gap: 0.1875,
            p: 0.375
          }
        }}
      >
        <WorkspaceGrid
          panelId={activePanel.id}
          gridSize={activePanel.gridSize}
          cells={activeCells}
          media={state.media}
          editMode={state.editMode}
          selectedCellId={selectedCellId}
          playingCells={playingCells}
          warmedMedia={warmedMedia}
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
        {cellSettingsOpen ? (
          <Box
            data-testid="settings-panel-resizer"
            aria-label="Изменить ширину панели настроек"
            role="separator"
            aria-orientation="vertical"
            tabIndex={0}
            onPointerDown={startSettingsPanelResize}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
                return;
              }
              event.preventDefault();
              setSettingsPanelWidth((current) =>
                clampSettingsPanelWidth(current + (event.key === "ArrowLeft" ? 24 : -24))
              );
            }}
            sx={{
              minWidth: SETTINGS_PANEL_RESIZER_WIDTH,
              height: "100%",
              cursor: "col-resize",
              touchAction: "none",
              display: "grid",
              placeItems: "center",
              "&::before": {
                content: '""',
                width: 3,
                height: 54,
                borderRadius: 999,
                backgroundColor: pleasantPink,
                boxShadow: "0 0 14px rgba(236, 90, 167, 0.4)"
              },
              "@media (hover: none)": {
                "&::before": {
                  opacity: 0
                }
              }
            }}
          />
        ) : null}
        <CellSettingsDrawer
          open={cellSettingsOpen}
          panelId={activePanel.id}
          cell={selectedCell}
          panels={state.panels}
          cellsByPanel={state.cellsByPanel}
          media={state.media}
          dispatch={dispatch}
          onClose={() => {
            setSelectedCellId(null);
          }}
          onClearCell={requestClearCell}
          panelCells={activeCells}
          onDeleteMedia={deleteMediaFromLibrary}
        />
      </Box>
      <AudioImportDialog
        open={pendingAudioFiles.length > 0}
        files={pendingAudioFiles}
        onSave={(media) => {
          dispatch({ type: "media/addMany", media });
          setPendingAudioFiles([]);
          setImportLoading(false);
          setOperationProgress(null);
        }}
        onReady={handleImportReady}
        onLoadingChange={handleImportLoadingChange}
        onProgress={updateOperationProgress}
        onCancel={() => {
          setPendingAudioFiles([]);
          setImportLoading(false);
          setOperationProgress(null);
        }}
      />
      <MediaLibraryDialog
        open={mediaLibraryOpen}
        media={state.media}
        dispatch={dispatch}
        onClose={() => {
          setMediaLibraryOpen(false);
        }}
        onDeleteMedia={deleteMediaFromLibrary}
      />
      <ProjectFaqDialog
        open={faqOpen}
        onClose={() => {
          setFaqOpen(false);
        }}
      />
      <Dialog
        open={updateAvailable && updateDialogOpen}
        onClose={() => {
          setUpdateDialogOpen(false);
        }}
        aria-labelledby="app-update-dialog-title"
      >
        <DialogTitle id="app-update-dialog-title">Доступна новая версия</DialogTitle>
        <DialogContent>
          <Typography>
            Можно обновить MUMBOX сейчас. Настройки ячеек, панели и импортированные аудио сохранятся.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setUpdateDialogOpen(false);
            }}
          >
            Позже
          </Button>
          <Button variant="contained" onClick={requestAppUpdate}>
            Обновить
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={Boolean(largeProjectFile)}
        onClose={() => {
          setLargeProjectFile(null);
        }}
        aria-labelledby="large-project-dialog-title"
      >
        <DialogTitle id="large-project-dialog-title">Большой файл проекта</DialogTitle>
        <DialogContent>
          <Typography>
            Проект весит больше 100 MB. Импорт может занять заметное время и потребовать много
            памяти, особенно на мобильном устройстве.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setLargeProjectFile(null);
            }}
          >
            Отмена
          </Button>
          <Button
            variant="contained"
            onClick={() => {
              const file = largeProjectFile;
              setLargeProjectFile(null);
              if (file) {
                importProjectFile(file);
              }
            }}
          >
            Импортировать
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={Boolean(preparedProjectBlob)}
        onClose={() => {
          setPreparedProjectBlob(null);
        }}
        aria-labelledby="prepared-project-dialog-title"
      >
        <DialogTitle id="prepared-project-dialog-title">Проект готов к сохранению</DialogTitle>
        <DialogContent>
          <Typography>
            Файл проекта собран. После выбора места сохранения браузер завершит сохранение .mumbox.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setPreparedProjectBlob(null);
            }}
          >
            Отмена
          </Button>
          <Button
            variant="contained"
            onClick={() => {
              const blob = preparedProjectBlob;
              if (!blob) {
                return;
              }
              setImportLoading(true);
              void saveProjectBlob(blob)
                .then((result) => {
                  setPreparedProjectBlob(null);
                  if (result.completed) {
                    setSaveMessage(`Проект экспортирован: ${result.fileName}`);
                  }
                })
                .catch((error: unknown) => {
                  if (error instanceof DOMException && error.name === "AbortError") {
                    return;
                  }
                  setSaveMessage("Не удалось сохранить проект");
                })
                .finally(() => {
                  setImportLoading(false);
                });
            }}
          >
            Выбрать место
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={Boolean(pendingClearCell)}
        onClose={() => {
          setPendingClearCellId(null);
        }}
        aria-labelledby="clear-cell-dialog-title"
        slotProps={{
          paper: {
            sx: {
              width: { xs: "calc(100vw - 24px)", sm: 420 },
              maxWidth: { xs: "calc(100vw - 24px)", sm: 420 },
              maxHeight: "calc(100dvh - 24px)",
              m: { xs: 1.5, sm: 4 }
            }
          }
        }}
      >
        <DialogTitle id="clear-cell-dialog-title">Очистить ячейку?</DialogTitle>
        <DialogActions>
          <Button
            onClick={() => {
              setPendingClearCellId(null);
            }}
          >
            Отмена
          </Button>
          <Button
            color="warning"
            variant="contained"
            onClick={() => {
              const cellId = pendingClearCell?.id;
              if (!cellId) {
                return;
              }
              clearCell(cellId);
              setPendingClearCellId(null);
            }}
          >
            Очистить
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={Boolean(pendingDeletePanel)}
        onClose={() => {
          setPendingDeletePanelId(null);
        }}
        aria-labelledby="delete-panel-dialog-title"
        slotProps={{
          paper: {
            sx: {
              width: { xs: "calc(100vw - 24px)", sm: 420 },
              maxWidth: { xs: "calc(100vw - 24px)", sm: 420 },
              maxHeight: "calc(100dvh - 24px)",
              m: { xs: 1.5, sm: 4 }
            }
          }
        }}
      >
        <DialogTitle id="delete-panel-dialog-title">Удалить панель?</DialogTitle>
        <DialogContent>
          <Typography>
            Вы действительно хотите удалить панель "{pendingDeletePanel?.name ?? ""}"? В ней есть
            заполненные ячейки.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setPendingDeletePanelId(null);
            }}
          >
            Отмена
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              const panelId = pendingDeletePanel?.id;
              if (!panelId) {
                return;
              }
              deletePanel(panelId);
              setPendingDeletePanelId(null);
            }}
          >
            Удалить
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={resetConfirmOpen}
        onClose={() => {
          setResetConfirmOpen(false);
        }}
        aria-labelledby="reset-project-dialog-title"
      >
        <DialogTitle id="reset-project-dialog-title">Стереть все данные?</DialogTitle>
        <DialogContent>
          <Typography>
            Будут удалены все панели, настройки ячеек и аудиофайлы из локального хранилища MUMBOX
            на этом устройстве.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setResetConfirmOpen(false);
            }}
          >
            Нет
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              setImportLoading(true);
              void clearStoredAppData()
                .then(() => {
                  stopAll();
                  setSelectedCellId(null);
                  dispatch({ type: "state/reset" });
                  setSaveMessage("Все данные MUMBOX стерты");
                })
                .finally(() => {
                  setResetConfirmOpen(false);
                  setImportLoading(false);
                });
            }}
          >
            Да, стереть
          </Button>
        </DialogActions>
      </Dialog>
      <Backdrop
        open={importLoading}
        sx={{
          zIndex: (theme) => theme.zIndex.modal + 20,
          color: "primary.main",
          backgroundColor: "rgba(5, 7, 13, 0.72)",
          backdropFilter: "blur(10px)"
        }}
      >
        <Box sx={{ display: "grid", gap: 1.5, placeItems: "center", textAlign: "center", px: 2 }}>
          <CircularProgress
            color="inherit"
            variant={operationProgress && operationProgress.total > 0 ? "determinate" : "indeterminate"}
            value={
              operationProgress && operationProgress.total > 0
                ? Math.min(100, Math.round((operationProgress.completed / operationProgress.total) * 100))
                : undefined
            }
          />
          {operationProgress ? (
            <Typography sx={{ maxWidth: 360, color: "text.primary" }}>{operationProgress.label}</Typography>
          ) : null}
        </Box>
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
        message="Импорт проекта перезапишет текущую рабочую раскладку и медиатеку"
        action={
          <>
            <Button
              color="inherit"
              onClick={() => {
                setConfigImportWarningOpen(false);
                projectInputRef.current?.click();
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

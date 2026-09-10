import FileOpenIcon from "@mui/icons-material/FileOpen";
import DeleteIcon from "@mui/icons-material/Delete";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import LibraryMusicIcon from "@mui/icons-material/LibraryMusic";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import MergeTypeIcon from "@mui/icons-material/MergeType";
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

import type { AppState } from "../../../app/model/appState";
import type { PersistenceHandle } from "../../../app/model/appStateStorage";
import {
  autoImportAudioFiles,
  clearStoredAppData,
  deleteStoredMedia,
  getMediaBlob,
  MediaStorageProgress,
  serializeState,
  useAppStore,
  writeImportedProjectMedia,
  writeMergedProjectMedia
} from "../../../app/model/appState";
import { AudioImportDialog } from "../../../features/audio-import";
import { CellSettingsDrawer } from "../../../features/cell-settings";
import {
  classifyProjectFileError,
  LARGE_PROJECT_IMPORT_BYTES,
  makeProjectBlob,
  PROJECT_FILE_ACCEPT_TYPES,
  PROJECT_FILE_ACCEPT_TYPES_MOBILE,
  ProjectFileProgress,
  readProjectFile,
  saveProjectBlob,
  toProjectFileName,
  verifyProjectMedia
} from "../../../features/file-config";
import { MediaLibraryDialog } from "../../../features/media-library";
import {
  countHiddenMediaCells,
  getMinGridSizeForMedia
} from "../../../entities/panel/model/hiddenCells";
import { ProjectLibraryRow } from "../../../entities/project/model/types";
import { PanelTabs } from "../../../features/panel-tabs";
import { useAudioEngine } from "../../../features/playback/model/useAudioEngine";
import { ProjectFaqDialog } from "../../../features/project-faq";
import { mergeProjectState, prepareMerge } from "../../../features/project-merge";
import {
  classifyFileError,
  clearProjectsIndex,
  getActivationPlan,
  getProjectRowLabel,
  ProjectActivationDialog,
  ProjectLibraryDialog,
  ProjectSaveDialog,
  useProjectLibrary
} from "../../../features/project-library";
import {
  recordPanelSwitchPaint,
  setActivePanelId,
  setDiagnosticsSinks,
  setServiceWorkerSource
} from "../../../shared/lib/diagnostics";
import { applyServiceWorkerUpdate, shouldCheckForUpdate } from "../../../shared/lib/appUpdate";
import { pickProjectFilesToOpen, pickProjectFileToSave } from "../../../shared/lib/fileSystemAccess";
import {
  FileHandleLike,
  requestHandlePermission
} from "../../../shared/lib/fileSystemAccess";
import { clearMediaCaches, purgeMediaCaches } from "../../../shared/lib/mediaCacheRegistry";
import {
  buildDistributionMessage,
  planMediaDistribution
} from "../../../shared/lib/mediaDistribution";
import { hasLikelyStorageForBytes } from "../../../shared/lib/storage";
import { filterValidAudioFiles } from "../../../shared/lib/audioFileUtils";
import { RightToolbar } from "../../right-toolbar";
import { WorkspaceGrid } from "../../workspace-grid";

function isDefinedCell<T>(cell: T | undefined): cell is T {
  return Boolean(cell);
}

const audioAcceptTypes = [
  ".mp3",
  ".wav",
  ".ogg",
  ".m4a",
  ".aac",
  ".flac",
  ".opus",
  ".webm",
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

export type AppShellProps = {
  initialState: AppState;
  /** Null when the initial read failed and writing has been suspended. */
  persistence: PersistenceHandle | null;
  /** True once a write has actually failed — see `BoardPage`. Sticky there, not here. */
  storageFailed?: boolean;
};

export function AppShell({ initialState, persistence, storageFailed = false }: AppShellProps) {
  const { state, activePanel, dispatch, persistenceFailed, flushPendingState } = useAppStore({
    initialState,
    persistence,
    storageFailed
  });
  const [fileAnchor, setFileAnchor] = useState<HTMLElement | null>(null);
  const [selectedCellId, setSelectedCellId] = useState<string | null>(null);
  const [pendingAudioFiles, setPendingAudioFiles] = useState<File[]>([]);
  const [importLoading, setImportLoading] = useState(false);
  const [operationProgress, setOperationProgress] = useState<OperationProgress | null>(null);
  const [configImportWarningOpen, setConfigImportWarningOpen] = useState(false);
  const [largeProjectFile, setLargeProjectFile] = useState<File | null>(null);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [projectLibraryOpen, setProjectLibraryOpen] = useState(false);
  const [activationRow, setActivationRow] = useState<ProjectLibraryRow | null>(null);
  const [relinkRowId, setRelinkRowId] = useState<string | null>(null);
  /** Set when the next picked project file must be merged instead of replacing the layout. */
  const [mergeRowPending, setMergeRowPending] = useState(false);
  /** Set when the user chose «Сохранить и открыть»: the row to open once the save finishes. */
  const [pendingActivationRow, setPendingActivationRow] = useState<ProjectLibraryRow | null>(null);
  const [mediaLibraryOpen, setMediaLibraryOpen] = useState(false);
  const [pendingDeletePanelId, setPendingDeletePanelId] = useState<string | null>(null);
  const [pendingClearCellId, setPendingClearCellId] = useState<string | null>(null);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [faqOpen, setFaqOpen] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [installPromptDismissed, setInstallPromptDismissed] = useState(false);
  const [standaloneMode, setStandaloneMode] = useState(isStandaloneDisplayMode);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [updateInProgress, setUpdateInProgress] = useState(false);
  const lastUpdateCheckAtRef = useRef<number | null>(null);
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
  // The whole cell record, not `activeCells`: shrinking the grid keeps cells it stops rendering,
  // and those are exactly the ones worth reporting.
  const activePanelCellRecord = activePanel ? state.cellsByPanel[activePanel.id] : undefined;
  const hiddenMediaCount = useMemo(
    () =>
      activePanel ? countHiddenMediaCells(activePanelCellRecord, activePanel.gridSize) : 0,
    [activePanel, activePanelCellRecord]
  );
  const minGridSize = useMemo(
    () => getMinGridSizeForMedia(activePanelCellRecord),
    [activePanelCellRecord]
  );
  const { playingCells, warmedCells, playCell, toggleCell, stopCell, stopAll } = useAudioEngine(
    activePanel?.id ?? "",
    state.media,
    activeCells,
    state.masterVolume,
    state.masterMuted,
    state.stopOthers,
    state.monoPlayback
  );

  useEffect(() => {
    // Mono is deliberately not in the toolbar yet: it is off by default and unproven until the
    // on-device numbers land, so it is reachable only through the diagnostics API.
    setDiagnosticsSinks({
      setMono: (mono) => {
        dispatch({ type: "mono/set", value: mono });
      },
      clearCaches: () => {
        clearMediaCaches();
      }
    });
  }, [dispatch]);

  /**
   * The write is latched, not repeated, so this fires once. Silence here used to mean a blank page
   * on the next dispatch; now it means the layout is live but nothing is being written down, which
   * the user can only act on if they are told.
   */
  useEffect(() => {
    if (persistenceFailed) {
      setSaveMessage("Состояние не сохраняется. Сохраните проект в файл");
    }
  }, [persistenceFailed]);

  const activePanelId = activePanel?.id ?? null;
  useEffect(() => {
    setActivePanelId(activePanelId);
    // Double rAF measures what the user feels — the engine-side switch cost is recorded
    // separately inside the audio engine, and the two answer different questions.
    const startedAt = performance.now();
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        recordPanelSwitchPaint(performance.now() - startedAt);
      });
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [activePanelId]);

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

  const deletePanel = useCallback(
    (panelId: string) => {
      stopAll();
      if (selectedCellId && state.activePanelId === panelId) {
        setSelectedCellId(null);
      }
      dispatch({ type: "panel/delete", panelId });
    },
    [dispatch, selectedCellId, state.activePanelId, stopAll]
  );

  /**
   * Memoised because `PanelTabs` is memoised, and a fresh closure here would defeat that outright:
   * `AppShell` re-renders on every progress push while anything plays.
   */
  const requestDeletePanel = useCallback(
    (panelId: string) => {
      const cells = state.cellsByPanel[panelId] ?? {};
      const hasFilledCells = Object.values(cells).some((cell) => Boolean(cell.mediaId));

      if (!hasFilledCells) {
        deletePanel(panelId);
        return;
      }

      setPendingDeletePanelId(panelId);
    },
    [deletePanel, state.cellsByPanel]
  );

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
    // The reload is ours, not the plugin's — see `applyServiceWorkerUpdate`. The button also has
    // to say something immediately: the silent version of this flow is what made users tap it
    // over and over.
    setUpdateInProgress(true);
    void applyServiceWorkerUpdate({
      registration: swRegistrationRef.current,
      container: "serviceWorker" in navigator ? navigator.serviceWorker : null,
      sendSkipWaiting: () => updateServiceWorker(true),
      reload: () => {
        window.location.reload();
      },
      setTimer: (callback, ms) => {
        window.setTimeout(callback, ms);
      }
    });
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
    setServiceWorkerSource(() => swRegistrationRef.current);
  }, []);

  useEffect(() => {
    const checkForServiceWorkerUpdate = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      // Throttled: on a phone this fires on every app switch and lock, and a worker kept
      // perpetually in `installing` has no `waiting` for «Обновить» to message.
      const now = Date.now();
      if (!shouldCheckForUpdate(lastUpdateCheckAtRef.current, now)) {
        return;
      }
      lastUpdateCheckAtRef.current = now;
      void swRegistrationRef.current?.update().catch(() => undefined);
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
    (mediaIds: string[]) => {
      if (mediaIds.length === 0) {
        return;
      }
      // One pass for the whole batch: one stop, one dispatch, one purge, one storage delete.
      stopAll();
      dispatch({ type: "media/deleteMany", mediaIds });
      // The IndexedDB blob and the decoded PCM are two separate stores; deleting one without the
      // other left the decoded copy resident for the rest of the session.
      purgeMediaCaches(mediaIds);
      void (async () => {
        // The same barrier the import path needs, and for the same reason: the state that stops
        // naming this media is written asynchronously, so deleting the blobs first leaves a
        // window where a reload shows library rows and filled pads with nothing behind them.
        if (!(await flushPendingState())) {
          setSaveMessage("Состояние не сохранено, аудио оставлено в хранилище");
          return;
        }
        await deleteStoredMedia(mediaIds).catch(() => {
          setSaveMessage("Не удалось удалить аудио из хранилища браузера");
        });
      })();
    },
    [dispatch, flushPendingState, stopAll]
  );

  const handleAudioFiles = (event: ChangeEvent<HTMLInputElement>, source: "files" | "folder") => {
    const { unsupportedFiles, duplicateFiles, validFiles } = filterValidAudioFiles(
      Array.from(event.target.files ?? []),
      state.media
    );
    const files = source === "files" ? validFiles : [...validFiles, ...duplicateFiles];
    const duplicateCount = source === "files" ? duplicateFiles.length : 0;

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

  /**
   * Replaces the current layout with a project file.
   *
   * The old blobs go **before** the new ones are written: the previous order left both projects
   * resident at once, which is what a mobile tab gets killed for. `readProjectFile` already
   * materialised and validated the whole zip by then, so nothing is destroyed on a bad file.
   */
  const importProjectFile = (file: File, sessionRow?: ProjectLibraryRow) => {
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
        const { unsupportedFiles: unsupportedMedia } = filterValidAudioFiles(
          project.mediaBlobs.map((blob) => new File([blob.blob], blob.fileName, { type: blob.mimeType })),
          []
        );
        if (unsupportedMedia.length > 0) {
          setSaveMessage(
            `Проект содержит неподдерживаемый формат: ${unsupportedMedia
              .slice(0, 3)
              .map((item) => item.name)
              .join(", ")}`
          );
          return;
        }
        stopAll();
        // Through the ref, not the render closure: reading and verifying a large file can take
        // minutes, and anything imported into the library meanwhile would otherwise be missing
        // from this list and orphaned. The merge path already does exactly this.
        const oldMediaIds = stateRef.current.media.map((item) => item.id);
        // Neither of these destroys anything recoverable, and running them here preserves the
        // memory head-room the original order was written for.
        clearMediaCaches();
        // Every media range is read and checked against its recorded CRC BEFORE storage is touched.
        // `readProjectFile` validated the archive's structure, but its media blobs are lazy
        // `file.slice` views — not a single audio byte had been read at this point, so a file that
        // was corrupt in the middle, or that had become unreadable since it was picked, was only
        // discovered while writing.
        await verifyProjectMedia(project, updateOperationProgress);
        const importedState = await writeImportedProjectMedia(
          project.state,
          project.mediaBlobs.map((item) => ({ id: item.id, blob: item.blob })),
          updateOperationProgress
        );
        dispatch({
          type: "state/import",
          state: importedState,
          session: {
            projectId: sessionRow?.id ?? null,
            name: sessionRow?.projectName ?? project.meta.name ?? "",
            description: sessionRow?.description ?? project.meta.description ?? "",
            fileName: file.name,
            saved: true,
            dirty: false
          }
        });
        // The persist barrier: wait for the imported state to actually reach storage, and refuse
        // to delete anything if it did not. Between the dispatch above and that write the new
        // state lives only in React memory while the PERSISTED state still names exactly the
        // blobs below — so a tab killed there, or a quota error, would reproduce the very failure
        // the reordering exists to prevent. Keeping the old blobs costs quota; deleting them
        // costs the project.
        const persisted = await flushPendingState();
        setSelectedCellId(null);
        if (!persisted) {
          setSaveMessage("Проект импортирован, но не сохранён. Прежнее аудио оставлено");
          return;
        }
        // ONLY NOW. This line used to run before the write, on the strength of a comment claiming
        // the zip had been "materialised and validated" — it had not: the media blobs are lazy
        // slices and their bytes are first read while writing. So a source file that vanished, or a
        // storage quota reached mid-write, left the old audio deleted, the new audio half written,
        // and the persisted state still naming the old ids. Every pad silent, nothing to recover.
        //
        // Its own catch: at this point the import has fully succeeded and is on screen. A failure
        // to tidy up the previous project's blobs leaks quota; reporting it as a failed import
        // would be a lie.
        await deleteStoredMedia(oldMediaIds).catch(() => undefined);
        setSaveMessage(`Проект импортирован: ${file.name}`);
      })
      .catch((error: unknown) => {
        const kind = classifyProjectFileError(error);
        setSaveMessage(
          kind === "corrupt"
            ? `Файл проекта повреждён: ${file.name}`
            : kind === "not-a-project"
              ? `Это не файл проекта: ${file.name}`
              : kind === "too-large"
                ? "Проект слишком большой для файла .mumbox: предел 4 ГБ"
                : kind === "no-space"
                  ? "В браузерном хранилище не хватило места для проекта"
                  : kind === "unreadable"
                    ? "Не удалось прочитать файл проекта"
                    : "Не удалось импортировать проект"
        );
      })
      .finally(() => {
        setImportLoading(false);
        updateOperationProgress(null);
      });
  };

  const handleProjectFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    const rowId = relinkRowId;
    const merging = mergeRowPending;
    setRelinkRowId(null);
    setMergeRowPending(false);
    if (!file) {
      return;
    }
    if (merging) {
      void mergeProjectFile(file);
      return;
    }
    if (file.size >= LARGE_PROJECT_IMPORT_BYTES) {
      setLargeProjectFile(file);
      return;
    }
    // Re-linking a row: the file the user just pointed at replaces the row's stale reference.
    const row = rowId ? projectLibrary.rows.find((candidate) => candidate.id === rowId) : undefined;
    if (row) {
      setProjectLibraryOpen(false);
      void projectLibrary
        .upsertRow(
          {
            fileName: file.name,
            projectName: row.projectName,
            description: row.description,
            sizeBytes: file.size,
            savedAt: row.savedAt,
            lastOpenedAt: row.lastOpenedAt,
            panelCount: row.panelCount,
            mediaCount: row.mediaCount,
            handle: undefined
          },
          row.id
        )
        .then(() => {
          importProjectFile(file, row);
        })
        .catch(() => {
          setSaveMessage("Не удалось обновить проект в списке");
        });
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

  const projectLibrary = useProjectLibrary(projectLibraryOpen);
  // Merging several projects dispatches between awaits; a render closure would still hold the
  // pre-merge state, and every merge but the last would be silently discarded.
  const stateRef = useRef(state);
  stateRef.current = state;

  const rememberSavedProject = async (
    values: { name: string; description: string; fileName: string },
    handle?: FileHandleLike,
    sizeBytes?: number
  ) => {
    return projectLibrary.upsertRow(
      {
        fileName: values.fileName,
        projectName: values.name,
        description: values.description,
        sizeBytes: sizeBytes ?? null,
        panelCount: state.panels.length,
        mediaCount: state.media.length,
        handle
      },
      state.projectSession.projectId ?? undefined
    );
  };

  /**
   * Points an existing row at a different file. Uses the picker where the browser has one, so a
   * Chromium row keeps its handle instead of being demoted to the unlinked section forever.
   */
  const relinkProjectRow = async (row: ProjectLibraryRow) => {
    const picked = await pickProjectFilesToOpen(false);
    if (picked.kind === "cancelled") {
      return;
    }
    if (picked.kind === "unsupported") {
      setRelinkRowId(row.id);
      projectInputRef.current?.click();
      return;
    }
    const handle = picked.value[0];
    if (!handle) {
      return;
    }

    try {
      const file = await handle.getFile();
      await projectLibrary.upsertRow(
        {
          fileName: file.name,
          projectName: row.projectName,
          description: row.description,
          sizeBytes: file.size,
          savedAt: row.savedAt,
          lastOpenedAt: row.lastOpenedAt,
          panelCount: row.panelCount,
          mediaCount: row.mediaCount,
          handle
        },
        row.id
      );
    } catch {
      setSaveMessage("Не удалось прочитать файл проекта");
    }
  };

  const addProjectsToLibrary = async () => {
    const picked = await pickProjectFilesToOpen(true);
    // A dismissed picker means the user changed their mind — it must not open a second dialog.
    if (picked.kind === "cancelled") {
      return;
    }
    if (picked.kind === "unsupported") {
      // No pickers here: the file input is the only way in, and a plain import is what it does.
      projectInputRef.current?.click();
      return;
    }

    for (const handle of picked.value) {
      try {
        const file = await handle.getFile();
        const project = await readProjectFile(file);
        await projectLibrary.upsertRow({
          fileName: file.name,
          projectName: project.meta.name ?? "",
          description: project.meta.description ?? "",
          sizeBytes: file.size,
          panelCount: project.state.panels.length,
          mediaCount: project.state.media.length,
          handle
        });
      } catch {
        setSaveMessage(`Не удалось прочитать проект: ${handle.name}`);
      }
    }
  };

  const deleteProjectRowsFromLibrary = async (rows: ProjectLibraryRow[]) => {
    const { removedFromDisk, failedOnDisk } = await projectLibrary.removeRows(rows);
    if (failedOnDisk > 0) {
      setSaveMessage(`Не удалось удалить файлов с диска: ${String(failedOnDisk)}`);
      return;
    }
    setSaveMessage(
      removedFromDisk > 0
        ? `Удалено проектов: ${String(rows.length)}, файлов с диска: ${String(removedFromDisk)}`
        : `Удалено проектов из списка: ${String(rows.length)}`
    );
  };

  /** Adds a project's panels to the current one instead of replacing it. */
  const mergeProjectFile = async (file: File) => {
    setImportLoading(true);
    updateOperationProgress({ completed: 0, total: 1, label: "Чтение проекта" });

    try {
      const project = await readProjectFile(file, updateOperationProgress);
      const { unsupportedFiles: unsupportedMedia } = filterValidAudioFiles(
        project.mediaBlobs.map(
          (blob) => new File([blob.blob], blob.fileName, { type: blob.mimeType })
        ),
        []
      );
      if (unsupportedMedia.length > 0) {
        setSaveMessage(
          `Проект содержит неподдерживаемый формат: ${unsupportedMedia
            .slice(0, 3)
            .map((item) => item.name)
            .join(", ")}`
        );
        return;
      }

      // Same hazard as an import, minus the deletion: a partial write orphans blobs forever.
      await verifyProjectMedia(project, updateOperationProgress);
      const currentState = serializeState(stateRef.current);
      // `loadBlob` is what lets the CURRENT project be hashed too. Without it a project that has
      // never been saved carries no hashes, and the whole merge falls back to matching on file name
      // and byte length — which is not evidence that two files are the same audio.
      const preparation = await prepareMerge(currentState, project, {
        loadBlob: getMediaBlob,
        onProgress: updateOperationProgress
      });
      // Kept BEFORE the storage check, not only on the success path. Hashing both libraries reads
      // every candidate byte and can take minutes on a large project; returning at the check below
      // threw all of it away, so a user who freed some space and retried paid for the whole pass a
      // second time. The current side is a live part of the state, so recording its hashes here is
      // correct whether or not the merge goes ahead.
      const currentHashes = preparation.computedHashes.filter((entry) =>
        stateRef.current.media.some((asset) => asset.id === entry.mediaId)
      );
      if (currentHashes.length > 0) {
        dispatch({ type: "media/setContentHash", hashes: currentHashes });
      }

      // Nothing is deleted by a merge, so the storage cost is purely additive — but only for what
      // survives deduplication.
      const storage = await hasLikelyStorageForBytes(preparation.survivorBytes);
      if (!storage.enough) {
        setSaveMessage("В браузерном хранилище может не хватить места для объединения");
        return;
      }

      const { state: remappedIncoming, addedMedia, idByImportedId } = await writeMergedProjectMedia(
        preparation.incoming,
        project.mediaBlobs.map((item) => ({ id: item.id, blob: item.blob })),
        preparation.mediaIdMap,
        preparation.keptIncomingIds,
        updateOperationProgress
      );

      // `writeMergedProjectMedia` has already rewritten every id in `remappedIncoming` to its final
      // value. Remapping again through the incoming-keyed map would find no key and empty every
      // merged cell — visible only when the incoming audio is new, which a self-merge never is.
      const finalMediaIds = new Map([...idByImportedId.values()].map((id) => [id, id]));
      const merged = mergeProjectState({
        // The hash-backfilled state, so the work rides into the merged project and is persisted by
        // `state/merge`. Dispatching `media/setContentHash` first would be pointless: the merge is
        // built from a snapshot and `state/merge` replaces everything.
        current: preparation.current,
        incoming: remappedIncoming,
        mediaIdMap: finalMediaIds,
        addedMedia,
        createPanelId: () => `panel-${crypto.randomUUID()}`
      });

      dispatch({ type: "state/merge", state: merged.state });
      setSelectedCellId(null);
      setSaveMessage(
        // The undecided count is reported ALONGSIDE the reused one, never instead of it. Reporting
        // it only when nothing was deduplicated meant the common mixed case — one pair matched by
        // hash, another impossible to compare — showed a bare number that implies every pair was
        // checked, which is the claim `undecidedCount` exists to stop the app from making.
        [
          `Добавлено панелей: ${String(merged.addedPanelIds.length)}`,
          preparation.reusedCount > 0
            ? `дубликатов аудио пропущено: ${String(preparation.reusedCount)}`
            : null,
          preparation.undecidedCount > 0 ? "часть аудио не сравнивалась" : null
        ]
          .filter((part): part is string => part !== null)
          .join(", ")
      );
    } catch (error: unknown) {
      const kind = classifyProjectFileError(error);
      setSaveMessage(
        kind === "corrupt"
          ? `Файл проекта повреждён: ${file.name}`
          : kind === "unreadable"
            ? "Не удалось прочитать файл проекта"
            : kind === "no-space"
              ? "В браузерном хранилище не хватило места для проекта"
              : "Не удалось объединить проекты"
      );
    } finally {
      setImportLoading(false);
      updateOperationProgress(null);
    }
  };

  const mergeProjectRows = async (rows: ProjectLibraryRow[]) => {
    setProjectLibraryOpen(false);
    const linked = rows.filter((row) => row.handle);
    const unlinked = rows.length - linked.length;

    if (linked.length === 0) {
      // Nothing to read from: the user points at one file through the normal input instead.
      setMergeRowPending(true);
      projectInputRef.current?.click();
      return;
    }

    for (const row of linked) {
      const handle = row.handle;
      if (!handle) {
        continue;
      }
      const permission = await requestHandlePermission(handle, "read");
      if (permission === "denied") {
        setSaveMessage(`Нет доступа к файлу проекта: ${row.fileName}`);
        continue;
      }
      try {
        await mergeProjectFile(await handle.getFile());
      } catch {
        setSaveMessage(`Не удалось открыть проект: ${row.fileName}`);
      }
    }

    if (unlinked > 0) {
      setSaveMessage(`Пропущено проектов без привязки к файлу: ${String(unlinked)}`);
    }
  };

  const openProjectFromRow = async (row: ProjectLibraryRow) => {
    setActivationRow(null);
    const handle = row.handle;
    if (!handle) {
      // No handle to open with: the user points at the file again through the normal input.
      setRelinkRowId(row.id);
      projectInputRef.current?.click();
      return;
    }

    const permission = await requestHandlePermission(handle, "read");
    if (permission === "denied") {
      setSaveMessage("Нет доступа к файлу проекта");
      return;
    }

    try {
      const file = await handle.getFile();
      setProjectLibraryOpen(false);
      importProjectFile(file, row);
      await projectLibrary.markOpened(row);
    } catch (error: unknown) {
      setSaveMessage(
        classifyFileError(error) === "missing"
          ? "Файл проекта не найден"
          : "Не удалось открыть проект"
      );
      await projectLibrary.refresh();
    }
  };

  const handleSaveProject = async (values: {
    name: string;
    description: string;
    fileName: string;
  }) => {
    setSaveDialogOpen(false);
    // The picker must be opened while the click's user activation is still live, so it comes before
    // the (asynchronous) blob assembly, not after.
    const picked = await pickProjectFileToSave(toProjectFileName(values.fileName));
    if (picked.kind === "cancelled") {
      setPendingActivationRow(null);
      return;
    }
    const handle = picked.kind === "picked" ? picked.value : undefined;

    setImportLoading(true);
    updateOperationProgress({
      completed: 0,
      total: Math.max(1, state.media.length),
      label: "Сборка проекта"
    });

    try {
      const blob = await makeProjectBlob(serializeState(state), {
        meta: {
          name: values.name || undefined,
          description: values.description || undefined,
          savedAt: new Date().toISOString()
        },
        onProgress: updateOperationProgress,
        onHash: (hashes) => {
          dispatch({ type: "media/setContentHash", hashes });
        }
      });
      const result = await saveProjectBlob(blob, values.fileName, handle);
      const row = await rememberSavedProject(
        { ...values, fileName: result.fileName },
        handle,
        blob.size
      );
      // Without the row id every later save mints another row, and the "already open" check can
      // never match the project the user is looking at.
      dispatch({
        type: "project/saved",
        projectId: row.id,
        fileName: result.fileName,
        name: values.name,
        description: values.description
      });
      const nextRow = pendingActivationRow;
      setPendingActivationRow(null);
      if (nextRow) {
        await openProjectFromRow(nextRow);
      }
      setSaveMessage(
        result.completed
          ? `Проект сохранён: ${result.fileName}`
          : `Файл проекта передан браузеру: ${result.fileName}`
      );
    } catch (error: unknown) {
      setPendingActivationRow(null);
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      setSaveMessage("Не удалось сохранить проект");
    } finally {
      setImportLoading(false);
      updateOperationProgress(null);
    }
  };

  const assignDroppedMedia = useCallback(
    (mediaIds: string[], targetCellId: string) => {
      if (!activePanel || !state.editMode) {
        return;
      }
      const cells = state.cellsByPanel[activePanel.id] ?? {};
      const plan = planMediaDistribution({
        cellIds: activePanel.cellIds,
        occupiedCellIds: new Set(activePanel.cellIds.filter((id) => cells[id]?.mediaId)),
        targetCellId,
        mediaIds
      });

      if (plan.assignments.length > 0) {
        dispatch({
          type: "cell/assignMany",
          panelId: activePanel.id,
          assignments: plan.assignments
        });
      }
      // Deliberately no setSelectedCellId: leaving the selection alone is what keeps the picker
      // open for the next drop.
      const message = buildDistributionMessage(plan);
      if (message) {
        setSaveMessage(message);
      }
    },
    [activePanel, dispatch, state.cellsByPanel, state.editMode]
  );

  const handleAudioDrop = useCallback(
    async (files: File[]) => {
      const { unsupportedFiles, duplicateFiles, validFiles } = filterValidAudioFiles(files, state.media);

      if (unsupportedFiles.length > 0) {
        setSaveMessage(
          `Формат не поддерживается на этом устройстве: ${unsupportedFiles
            .slice(0, 3)
            .map((file) => file.name)
            .join(", ")}`
        );
      }

      if (duplicateFiles.length > 0) {
        setSaveMessage(`Дубликаты уже есть в медиатеке и пропущены: ${String(duplicateFiles.length)}`);
      }

      if (validFiles.length === 0) {
        return;
      }

      setImportLoading(true);
      updateOperationProgress({ completed: 0, total: validFiles.length, label: "Проверка хранилища" });

      const storageCheck = await hasLikelyStorageForBytes(
        validFiles.reduce((sum, file) => sum + file.size, 0)
      );

      if (!storageCheck.enough) {
        setImportLoading(false);
        updateOperationProgress(null);
        setSaveMessage("В браузерном хранилище может не хватить места для выбранных аудио");
        return;
      }

      try {
        const importedMedia = await autoImportAudioFiles(validFiles, updateOperationProgress);
        dispatch({ type: "media/addMany", media: importedMedia });

        const cells = activePanel ? state.cellsByPanel[activePanel.id] ?? {} : {};
        const freeCellIds = activePanel ? activePanel.cellIds.filter((id) => !cells[id]?.mediaId) : [];
        const assignments = freeCellIds
          .slice(0, importedMedia.length)
          .map((cellId, index) => ({ cellId, mediaId: importedMedia[index]?.id ?? "" }))
          .filter((assignment) => assignment.mediaId !== "");
        const cellsToAssign = assignments.length;

        if (activePanel && cellsToAssign > 0) {
          dispatch({ type: "cell/assignMany", panelId: activePanel.id, assignments });
        }

        const message =
          cellsToAssign > 0
            ? `Импортировано ${String(importedMedia.length)} аудио, назначено ${String(cellsToAssign)} ячеек`
            : `Импортировано ${String(importedMedia.length)} аудио в медиатеку`;

        setSaveMessage(message);
      } catch {
        setSaveMessage("Не удалось импортировать аудио");
      } finally {
        setImportLoading(false);
        updateOperationProgress(null);
      }
    },
    [state.media, state.cellsByPanel, activePanel, dispatch, updateOperationProgress]
  );

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
              setSaveDialogOpen(true);
              closeFileMenu();
            }}
          >
            <SaveAltIcon fontSize="small" />
            <Typography sx={{ ml: 1 }}>Сохранить проект</Typography>
          </MenuItem>
          {/* Desktop only. The list is a list of file handles, and a phone browser keeps none:
              every row lands in the handle-less section, where reopening means picking the file
              again anyway. Offering it there promised a library the platform cannot deliver. */}
          {mobileBrowser ? null : (
            <MenuItem
              onClick={() => {
                setProjectLibraryOpen(true);
                closeFileMenu();
              }}
            >
              <FolderOpenIcon fontSize="small" />
              <Typography sx={{ ml: 1 }}>Проекты</Typography>
            </MenuItem>
          )}
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
              setMergeRowPending(true);
              projectInputRef.current?.click();
              closeFileMenu();
            }}
          >
            <MergeTypeIcon fontSize="small" />
            <Typography sx={{ ml: 1 }}>Объединить с проектом</Typography>
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
              <MenuItem onClick={requestAppUpdate} disabled={updateInProgress}>
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
          accept={mobileBrowser ? PROJECT_FILE_ACCEPT_TYPES_MOBILE : PROJECT_FILE_ACCEPT_TYPES}
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
          playingCellKeys={playingCells}
          warmedCells={warmedCells}
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
          onAudioDrop={(files) => {
            void handleAudioDrop(files);
          }}
          onMediaDrop={assignDroppedMedia}
        />
        <RightToolbar
          masterVolume={state.masterVolume}
          masterMuted={state.masterMuted}
          editMode={state.editMode}
          stopOthers={state.stopOthers}
          gridSize={activePanel.gridSize}
          panelId={activePanel.id}
          hiddenMediaCount={hiddenMediaCount}
          minGridSize={minGridSize}
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
        onError={setSaveMessage}
        onCancel={() => {
          setPendingAudioFiles([]);
          setImportLoading(false);
          setOperationProgress(null);
        }}
      />
      <MediaLibraryDialog
        open={mediaLibraryOpen}
        media={state.media}
        cellsByPanel={state.cellsByPanel}
        dispatch={dispatch}
        onClose={() => {
          setMediaLibraryOpen(false);
        }}
        onDeleteMedia={deleteMediaFromLibrary}
      />
      <ProjectLibraryDialog
        open={projectLibraryOpen}
        rows={projectLibrary.rows}
        probes={projectLibrary.probes}
        onClose={() => {
          setProjectLibraryOpen(false);
        }}
        onAddProjects={() => {
          void addProjectsToLibrary();
        }}
        onActivate={(row) => {
          const plan = getActivationPlan(state.projectSession, row);
          if (plan.kind === "alreadyOpen") {
            setSaveMessage("Этот проект уже открыт");
            return;
          }
          setActivationRow(row);
        }}
        onDelete={(rows) => {
          void deleteProjectRowsFromLibrary(rows);
        }}
        onRelink={(row) => {
          void relinkProjectRow(row);
        }}
        onMerge={(rows) => {
          void mergeProjectRows(rows);
        }}
      />
      <ProjectActivationDialog
        open={activationRow !== null}
        plan={activationRow ? getActivationPlan(state.projectSession, activationRow) : null}
        projectLabel={activationRow ? getProjectRowLabel(activationRow) : ""}
        onCancel={() => {
          setActivationRow(null);
        }}
        onOpenProject={() => {
          if (activationRow) {
            void openProjectFromRow(activationRow);
          }
        }}
        onSaveAndOpen={() => {
          setPendingActivationRow(activationRow);
          setActivationRow(null);
          setSaveDialogOpen(true);
        }}
        onDiscardAndOpen={() => {
          if (activationRow) {
            void openProjectFromRow(activationRow);
          }
        }}
      />
      <ProjectSaveDialog
        open={saveDialogOpen}
        defaultName={state.projectSession.name}
        defaultDescription={state.projectSession.description}
        // Without the extension: it is appended on save, so there is nothing to type.
        defaultFileName={(state.projectSession.fileName ?? "").replace(/\.mumbox$/i, "")}
        takenProjectNames={projectLibrary.rows.map((row) => row.projectName).filter(Boolean)}
        onCancel={() => {
          setSaveDialogOpen(false);
        }}
        onSave={(values) => {
          void handleSaveProject(values);
        }}
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
          if (!updateInProgress) {
            setUpdateDialogOpen(false);
          }
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
            disabled={updateInProgress}
            onClick={() => {
              setUpdateDialogOpen(false);
            }}
          >
            Позже
          </Button>
          <Button
            variant="contained"
            onClick={requestAppUpdate}
            disabled={updateInProgress}
            startIcon={updateInProgress ? <CircularProgress size={16} color="inherit" /> : null}
          >
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
            на этом устройстве. Список проектов также будет очищен — файлы .mumbox на диске
            останутся.
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
                // A separate IndexedDB store, so idb-keyval's `clear()` does not reach it. Clearing
                // it here is deliberate: "erase everything" must mean everything.
                .then(clearProjectsIndex)
                .then(() => {
                  stopAll();
                  setSelectedCellId(null);
                  dispatch({ type: "state/reset" });
                  clearMediaCaches();
                  setSaveMessage("Все данные MUMBOX стерты");
                })
                .catch(() => {
                  // Without this the whole `then` block was skipped on a failed erase: no reset,
                  // no cache purge, no message — and React still held the full project, so the
                  // next action re-persisted it, naming blobs that had already been deleted. A
                  // complete-looking layout with missing audio, and nothing said.
                  stopAll();
                  setSelectedCellId(null);
                  dispatch({ type: "state/reset" });
                  clearMediaCaches();
                  setSaveMessage("Данные стерты не полностью. Повторите или очистите данные сайта");
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

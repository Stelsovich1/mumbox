import AddIcon from "@mui/icons-material/Add";
import CheckBoxIcon from "@mui/icons-material/CheckBox";
import CheckBoxOutlineBlankIcon from "@mui/icons-material/CheckBoxOutlineBlank";
import CloseIcon from "@mui/icons-material/Close";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography
} from "@mui/material";
import {
  KeyboardEvent,
  memo,
  PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState
} from "react";

import { AppAction } from "../../../app/model/appState";
import { Panel } from "../../../entities/panel/model/types";
import { MobileLandscapeTextField } from "../../../shared/ui/MobileLandscapeTextField";

type PanelTabsProps = {
  panels: Panel[];
  activePanelId: string;
  editMode: boolean;
  selectionMode: boolean;
  selectedPanelIds: ReadonlySet<string>;
  dispatch: React.Dispatch<AppAction>;
  onDeletePanel: (panelId: string) => void;
  onTogglePanelSelected: (panelId: string) => void;
};

/**
 * Memoised. Its props change only when the panel layout or a mode does, but `AppShell`
 * re-renders on every progress push while anything plays — 20 times a second — and each of those
 * renders re-serialized every `sx` object in here for nothing.
 */
export const PanelTabs = memo(function PanelTabs({
  panels,
  activePanelId,
  editMode,
  selectionMode,
  selectedPanelIds,
  dispatch,
  onDeletePanel,
  onTogglePanelSelected
}: PanelTabsProps) {
  const [renamingPanelId, setRenamingPanelId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [copyDialogOpen, setCopyDialogOpen] = useState(false);
  const [copySourcePanelId, setCopySourcePanelId] = useState("");
  const [copyNameDraft, setCopyNameDraft] = useState("");
  const lastTouchTapRef = useRef<{ panelId: string; time: number } | null>(null);
  const selectedCopyPanel =
    panels.find((panel) => panel.id === copySourcePanelId) ??
    panels.find((panel) => panel.id === activePanelId) ??
    panels[0] ??
    null;
  const copyNamePlaceholder = selectedCopyPanel ? `${selectedCopyPanel.name}_copy` : "";

  useEffect(() => {
    if (!editMode) {
      setRenamingPanelId(null);
      setCopyDialogOpen(false);
    }
  }, [editMode]);

  const commitRename = () => {
    if (!renamingPanelId || !editMode) {
      return;
    }
    dispatch({ type: "panel/rename", panelId: renamingPanelId, name: draftName });
    setRenamingPanelId(null);
  };

  const startRename = (panel: Panel) => {
    if (!editMode) {
      return;
    }
    setRenamingPanelId(panel.id);
    setDraftName(panel.name);
  };

  const handlePanelPointerUp = (event: ReactPointerEvent<HTMLElement>, panel: Panel) => {
    if (!editMode || event.pointerType === "mouse") {
      return;
    }

    const now = window.performance.now();
    const previousTap = lastTouchTapRef.current;
    if (previousTap?.panelId === panel.id && now - previousTap.time < 420) {
      event.preventDefault();
      event.stopPropagation();
      lastTouchTapRef.current = null;
      startRename(panel);
      return;
    }

    lastTouchTapRef.current = { panelId: panel.id, time: now };
  };

  const handleRenameKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter") {
      commitRename();
    }
    if (event.key === "Escape") {
      setRenamingPanelId(null);
    }
  };

  const openCopyDialog = () => {
    const panel = panels.find((candidate) => candidate.id === activePanelId) ?? panels[0];
    if (!panel) {
      return;
    }
    setCopySourcePanelId(panel.id);
    setCopyNameDraft("");
    setCopyDialogOpen(true);
  };

  const closeCopyDialog = () => {
    setCopyDialogOpen(false);
    setCopyNameDraft("");
  };

  const copyPanel = () => {
    if (!selectedCopyPanel || !editMode) {
      return;
    }

    dispatch({
      type: "panel/copy",
      sourcePanelId: selectedCopyPanel.id,
      name: copyNameDraft.trim() || copyNamePlaceholder
    });
    closeCopyDialog();
  };

  return (
    <>
      <Tabs
        value={activePanelId}
        aria-label="Панели MUMBOX"
        variant="scrollable"
        scrollButtons="auto"
        allowScrollButtonsMobile
        onChange={(_, panelId: string) => {
          dispatch({ type: "panel/select", panelId });
        }}
        onWheel={(event) => {
          const scroller = event.currentTarget.querySelector(".MuiTabs-scroller");
          if (!scroller) {
            return;
          }
          scroller.scrollLeft += event.deltaY + event.deltaX;
        }}
        sx={{
          minHeight: 42,
          minWidth: 0,
          maxWidth: "100%",
          "& .MuiTabs-scroller": {
            overflowX: "auto !important"
          },
          "@media (orientation: landscape) and (max-height: 430px)": {
            // 36 rather than 32: four extra pixels of tap target, which is what a thumb needs to
            // switch panels reliably in a 430 px tall viewport.
            minHeight: 36,
            "& .MuiTab-root": {
              minHeight: 36,
              px: 0.75,
              fontSize: 11
            },
            "& .MuiTabs-scrollButtons": {
              width: 24
            }
          }
        }}
      >
        {panels.map((panel) => (
          <Tab
            key={panel.id}
            value={panel.id}
            label={
              renamingPanelId === panel.id ? (
                <MobileLandscapeTextField
                  value={draftName}
                  autoFocus
                  size="small"
                  variant="standard"
                  slotProps={{
                    htmlInput: {
                      "aria-label": "Название панели"
                    }
                  }}
                  onValueChange={(value) => {
                    setDraftName(value);
                  }}
                  onMobileCommit={(value) => {
                    if (renamingPanelId) {
                      dispatch({ type: "panel/rename", panelId: renamingPanelId, name: value });
                      setRenamingPanelId(null);
                    }
                  }}
                  onBlur={commitRename}
                  onKeyDown={handleRenameKeyDown}
                  sx={{ width: 120 }}
                />
              ) : (
                <Box
                  sx={{
                    position: "relative",
                    display: "inline-flex",
                    alignItems: "center",
                    minWidth: 0,
                    maxWidth: 150,
                    pr: editMode && !selectionMode && panel !== panels[0] ? 2.5 : 0,
                    "&:hover .panel-delete-button, &:focus-within .panel-delete-button": {
                      opacity: 1,
                      pointerEvents: "auto"
                    },
                    "@media (orientation: landscape) and (max-height: 430px)": {
                      pr: editMode && !selectionMode && panel !== panels[0] ? 4 : 0
                    }
                  }}
                >
                  {selectionMode && panel !== panels[0] ? (
                    /* Its own control, not the tab body: switching panels must keep working in
                       selection mode, or a user could never select a panel they are not on. The
                       first panel gets none — it is not deletable, so offering it would be a lie. */
                    <IconButton
                      component="span"
                      aria-label={`Выбрать панель ${panel.name}`}
                      aria-pressed={selectedPanelIds.has(panel.id)}
                      size="small"
                      onClick={(event) => {
                        event.stopPropagation();
                        onTogglePanelSelected(panel.id);
                      }}
                      onMouseDown={(event) => {
                        event.stopPropagation();
                      }}
                      sx={{
                        mr: 0.25,
                        width: 26,
                        height: 26,
                        p: 0.25,
                        color: selectedPanelIds.has(panel.id) ? "secondary.main" : "text.secondary",
                        "@media (orientation: landscape) and (max-height: 430px)": {
                          width: 24,
                          height: 24,
                          mr: 0
                        }
                      }}
                    >
                      {selectedPanelIds.has(panel.id) ? (
                        <CheckBoxIcon sx={{ fontSize: 18 }} />
                      ) : (
                        <CheckBoxOutlineBlankIcon sx={{ fontSize: 18 }} />
                      )}
                    </IconButton>
                  ) : null}
                  <Box
                    component="span"
                    sx={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap"
                    }}
                  >
                    {panel.name}
                  </Box>
                  {/* Hidden while selecting: the cross sits absolutely over the tab's corner and
                      the checkbox widens the label, so on a phone the two overlapped as soon as a
                      few tabs stood side by side. Bulk deletion is what selection mode is for. */}
                  {editMode && !selectionMode && panel !== panels[0] ? (
                    <Tooltip title="Удалить панель">
                      <IconButton
                        className="panel-delete-button"
                        component="span"
                        aria-label={`Удалить панель ${panel.name}`}
                        size="small"
                        onClick={(event) => {
                          event.stopPropagation();
                          onDeletePanel(panel.id);
                        }}
                        onMouseDown={(event) => {
                          event.stopPropagation();
                        }}
                        sx={{
                          position: "absolute",
                          top: -12,
                          right: -10,
                          width: 20,
                          height: 20,
                          opacity: 1,
                          pointerEvents: "auto",
                          color: "error.main",
                          backgroundColor: "rgba(5, 7, 13, 0.92)",
                          border: 1,
                          borderColor: "rgba(255, 107, 138, 0.42)",
                          transition: "opacity 140ms ease, transform 140ms ease",
                          "&:hover": {
                            backgroundColor: "rgba(255, 107, 138, 0.18)",
                            transform: "scale(1.08)"
                          },
                          "&:focus-visible": {
                            opacity: 1,
                            pointerEvents: "auto"
                          },
                          "@media (hover: none)": {
                            opacity: 1,
                            pointerEvents: "auto"
                          },
                          "@media (orientation: landscape) and (max-height: 430px)": {
                            // Centred on the label rather than pinned near its top: the header row
                            // grew to 38 px and a top-anchored cross drifted below the tab text.
                            // A negative margin does the centring instead of `translateY`, which
                            // the hover `scale` would overwrite.
                            top: "50%",
                            mt: "-13px",
                            right: -8,
                            width: 26,
                            height: 26,
                            p: 0.25
                          }
                        }}
                      >
                        <CloseIcon
                          sx={{
                            fontSize: 14,
                            "@media (orientation: landscape) and (max-height: 430px)": {
                              fontSize: 18
                            }
                          }}
                        />
                      </IconButton>
                    </Tooltip>
                  ) : null}
                </Box>
              )
            }
            onDoubleClick={() => {
              startRename(panel);
            }}
            onPointerUp={(event) => {
              handlePanelPointerUp(event, panel);
            }}
            sx={{
              minHeight: 42,
              maxWidth: 180,
              color: editMode ? "secondary.main" : undefined,
              "&.Mui-selected": {
                color: editMode ? "secondary.main" : undefined
              },
              "@media (orientation: landscape) and (max-height: 430px)": {
                minHeight: 36,
                maxWidth: 120
              }
            }}
          />
        ))}
      </Tabs>
      {editMode ? (
        <Box
          sx={{
            display: "inline-flex",
            alignItems: "center",
            gap: 0.75,
            ml: 1,
            flexShrink: 0,
            "@media (orientation: landscape) and (max-height: 430px)": {
              gap: 0.75,
              ml: 0.75
            }
          }}
        >
          <Tooltip title="Добавить панель">
            <IconButton
              aria-label="Добавить панель"
              size="small"
              onClick={() => {
                dispatch({ type: "panel/add" });
              }}
              sx={{
                width: 34,
                height: 34,
                "@media (orientation: landscape) and (max-height: 430px)": {
                  width: 32,
                  height: 32,
                  p: 0.25
                }
              }}
            >
              <AddIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title="Скопировать панель">
            <IconButton
              aria-label="Скопировать панель"
              size="small"
              onClick={openCopyDialog}
              sx={{
                width: 34,
                height: 34,
                "@media (orientation: landscape) and (max-height: 430px)": {
                  width: 32,
                  height: 32,
                  p: 0.25
                }
              }}
            >
              <ContentCopyIcon />
            </IconButton>
          </Tooltip>
        </Box>
      ) : null}
      <Dialog
        open={copyDialogOpen}
        onClose={closeCopyDialog}
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
        <DialogTitle>Скопировать панель</DialogTitle>
        <DialogContent>
          <Box sx={{ display: "grid", gap: 1.5, pt: 1 }}>
            <TextField
              select
              label="Панель"
              value={selectedCopyPanel?.id ?? ""}
              onChange={(event) => {
                setCopySourcePanelId(event.target.value);
                setCopyNameDraft("");
              }}
              fullWidth
            >
              {panels.map((panel) => (
                <MenuItem key={panel.id} value={panel.id}>
                  {panel.name}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label="Имя копии"
              value={copyNameDraft}
              placeholder={copyNamePlaceholder}
              onChange={(event) => {
                setCopyNameDraft(event.target.value);
              }}
              fullWidth
              slotProps={{
                htmlInput: {
                  "aria-label": "Имя копии панели"
                }
              }}
            />
            <Typography color="text.secondary">
              Если поле оставить пустым, будет использовано имя {copyNamePlaceholder || "панели_copy"}.
            </Typography>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeCopyDialog}>Отмена</Button>
          <Button variant="contained" disabled={!selectedCopyPanel} onClick={copyPanel}>
            Скопировать
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
});

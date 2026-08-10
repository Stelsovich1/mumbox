import AddIcon from "@mui/icons-material/Add";
import CloseIcon from "@mui/icons-material/Close";
import { Box, IconButton, Tab, Tabs, Tooltip } from "@mui/material";
import { KeyboardEvent, PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";

import { AppAction } from "../../../app/model/appState";
import { Panel } from "../../../entities/panel/model/types";
import { MobileLandscapeTextField } from "../../../shared/ui/MobileLandscapeTextField";

type PanelTabsProps = {
  panels: Panel[];
  activePanelId: string;
  editMode: boolean;
  dispatch: React.Dispatch<AppAction>;
  onDeletePanel: (panelId: string) => void;
};

export function PanelTabs({ panels, activePanelId, editMode, dispatch, onDeletePanel }: PanelTabsProps) {
  const [renamingPanelId, setRenamingPanelId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const lastTouchTapRef = useRef<{ panelId: string; time: number } | null>(null);

  useEffect(() => {
    if (!editMode) {
      setRenamingPanelId(null);
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
            minHeight: 32,
            "& .MuiTab-root": {
              minHeight: 32,
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
                    pr: editMode && panel !== panels[0] ? 2.5 : 0,
                    "&:hover .panel-delete-button, &:focus-within .panel-delete-button": {
                      opacity: 1,
                      pointerEvents: "auto"
                    }
                  }}
                >
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
                  {editMode && panel !== panels[0] ? (
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
                          opacity: 0,
                          pointerEvents: "none",
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
                            top: -4,
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
              "@media (orientation: landscape) and (max-height: 430px)": {
                minHeight: 32,
                maxWidth: 120
              }
            }}
          />
        ))}
      </Tabs>
      {editMode ? (
        <Tooltip title="Добавить панель">
          <IconButton
            aria-label="Добавить панель"
            size="small"
            onClick={() => {
              dispatch({ type: "panel/add" });
            }}
            sx={{
              "@media (orientation: landscape) and (max-height: 430px)": {
                width: 28,
                height: 28,
                p: 0.25
              }
            }}
          >
            <AddIcon />
          </IconButton>
        </Tooltip>
      ) : null}
    </>
  );
}

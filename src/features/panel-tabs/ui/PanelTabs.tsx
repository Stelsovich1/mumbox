import AddIcon from "@mui/icons-material/Add";
import CloseIcon from "@mui/icons-material/Close";
import { Box, IconButton, Tab, Tabs, TextField, Tooltip } from "@mui/material";
import { KeyboardEvent, useState } from "react";

import { AppAction } from "../../../app/model/appState";
import { Panel } from "../../../entities/panel/model/types";

type PanelTabsProps = {
  panels: Panel[];
  activePanelId: string;
  dispatch: React.Dispatch<AppAction>;
  onDeletePanel: (panelId: string) => void;
};

export function PanelTabs({ panels, activePanelId, dispatch, onDeletePanel }: PanelTabsProps) {
  const [renamingPanelId, setRenamingPanelId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  const commitRename = () => {
    if (!renamingPanelId) {
      return;
    }
    dispatch({ type: "panel/rename", panelId: renamingPanelId, name: draftName });
    setRenamingPanelId(null);
  };

  const handleRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
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
                <TextField
                  value={draftName}
                  autoFocus
                  size="small"
                  variant="standard"
                  slotProps={{
                    htmlInput: {
                      "aria-label": "Название панели"
                    }
                  }}
                  onChange={(event) => {
                    setDraftName(event.target.value);
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
                    pr: panel === panels[0] ? 0 : 2.5,
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
                  {panel !== panels[0] ? (
                    <Tooltip title="Удалить панель">
                      <IconButton
                        className="panel-delete-button"
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
                          }
                        }}
                      >
                        <CloseIcon sx={{ fontSize: 14 }} />
                      </IconButton>
                    </Tooltip>
                  ) : null}
                </Box>
              )
            }
            onDoubleClick={() => {
              setRenamingPanelId(panel.id);
              setDraftName(panel.name);
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
    </>
  );
}

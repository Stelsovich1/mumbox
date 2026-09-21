import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { Box, IconButton, Tooltip, Typography } from "@mui/material";
import type { ReactNode } from "react";

type SettingRowProps = {
  title: string;
  /** What the setting does and what it costs. Shown on hover and on tap. */
  hint: string;
  /** Rendered under the title, for the things a tooltip must not hide — such as "needs a reload". */
  note?: string | null;
  children: ReactNode;
};

/**
 * One setting: title, an `i` that explains it, and the control.
 *
 * The explanation hangs off an `IconButton` rather than a bare icon so a coarse pointer can reach
 * it at all — MUI opens a tooltip on touch through the child's own handlers, and a focusable child
 * is also what gives the hint a keyboard route. `enterTouchDelay` is dropped to zero because the
 * long-press this would otherwise need is already taken by the cell drag elsewhere in the app, and
 * a hint that needs a gesture the app teaches nowhere is a hint nobody reads.
 */
export function SettingRow({ title, hint, note, children }: SettingRowProps) {
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: { xs: "1fr", sm: "minmax(0, 1fr) minmax(0, 260px)" },
        alignItems: "center",
        gap: { xs: 1, sm: 2 },
        py: 1.5,
        borderBottom: 1,
        borderColor: "rgba(169, 183, 207, 0.12)"
      }}
    >
      <Box sx={{ display: "grid", gap: 0.25, minWidth: 0 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          <Typography>{title}</Typography>
          <Tooltip title={hint} enterTouchDelay={0} leaveTouchDelay={6000}>
            <IconButton
              size="small"
              aria-label={`Что делает: ${title}`}
              sx={{ color: "text.secondary" }}
            >
              <InfoOutlinedIcon fontSize="inherit" />
            </IconButton>
          </Tooltip>
        </Box>
        {note ? (
          <Typography variant="caption" color="warning.main">
            {note}
          </Typography>
        ) : null}
      </Box>
      <Box sx={{ justifySelf: { xs: "start", sm: "end" }, minWidth: 0, width: "100%" }}>
        {children}
      </Box>
    </Box>
  );
}

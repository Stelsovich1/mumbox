import { Box, Tooltip } from "@mui/material";

import { CELL_COLORS } from "../config/colorPalette";

type ColorSwatchesProps = {
  value: string;
  onChange: (color: string) => void;
  label: string;
};

export function ColorSwatches({ value, onChange, label }: ColorSwatchesProps) {
  return (
    <Box
      role="radiogroup"
      aria-label={label}
      sx={{ display: "grid", gridTemplateColumns: "repeat(6, 24px)", gap: 0.75 }}
    >
      {CELL_COLORS.map((color) => (
        <Tooltip title={color} key={color}>
          <Box
            component="button"
            type="button"
            role="radio"
            aria-checked={value === color}
            aria-label={`${label} ${color}`}
            onClick={() => {
              onChange(color);
            }}
            sx={{
              width: 24,
              height: 24,
              borderRadius: "50%",
              border: value === color ? "2px solid #000000" : "1px solid rgba(247, 251, 255, 0.28)",
              backgroundColor: color,
              boxShadow: value === color ? `0 0 0 2px ${color}, 0 0 14px ${color}` : "none",
              cursor: "pointer",
              transition: "transform 140ms ease, border-color 140ms ease",
              "&:hover": {
                transform: "scale(1.08)"
              },
              "&:focus-visible": {
                outline: "2px solid #8cf8ff",
                outlineOffset: 2
              }
            }}
          />
        </Tooltip>
      ))}
    </Box>
  );
}

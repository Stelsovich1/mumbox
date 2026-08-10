import { Box, Tooltip } from "@mui/material";

import { CELL_COLORS } from "../config/colorPalette";

type ColorSwatchesProps = {
  value: string;
  onChange: (color: string) => void;
  label: string;
  compact?: boolean;
};

export function ColorSwatches({ value, onChange, label, compact = false }: ColorSwatchesProps) {
  const swatchSize = compact ? 18 : 24;

  return (
    <Box
      role="radiogroup"
      aria-label={label}
      sx={{
        display: "grid",
        gridTemplateColumns: `repeat(6, ${String(swatchSize)}px)`,
        gap: compact ? 0.45 : 0.75,
        "@media (orientation: portrait) and (max-width: 700px)": {
          gridTemplateColumns: "repeat(6, minmax(14px, 1fr))",
          gap: 0.35,
          maxWidth: "100%"
        }
      }}
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
              width: swatchSize,
              height: swatchSize,
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
                outline: "2px solid #ec5aa7",
                outlineOffset: 2
              },
              "@media (orientation: portrait) and (max-width: 700px)": {
                width: "100%",
                aspectRatio: "1 / 1",
                height: "auto",
                minWidth: 14,
                minHeight: 14
              }
            }}
          />
        </Tooltip>
      ))}
    </Box>
  );
}

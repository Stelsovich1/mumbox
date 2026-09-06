import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";

import { formatCreatedAtParts, MISSING_DATE_LABEL } from "../lib/formatDate";

/**
 * Date over time, on two lines. One line needs a column wider than its own header, and every table
 * here lives in a width-constrained surface; a taller row is the cheaper trade.
 */
export function CreatedAtCell({ value }: { value: string | undefined | null }) {
  const parts = formatCreatedAtParts(value);

  if (!parts) {
    return <Typography sx={{ px: 0.75 }}>{MISSING_DATE_LABEL}</Typography>;
  }

  return (
    <Box sx={{ px: 0.75, minWidth: 0, display: "grid", lineHeight: 1.2 }}>
      <Typography sx={{ whiteSpace: "nowrap", lineHeight: 1.2 }}>{parts.date}</Typography>
      <Typography
        component="span"
        color="text.secondary"
        sx={{ whiteSpace: "nowrap", lineHeight: 1.2, fontSize: "0.85em" }}
      >
        {parts.time}
      </Typography>
    </Box>
  );
}

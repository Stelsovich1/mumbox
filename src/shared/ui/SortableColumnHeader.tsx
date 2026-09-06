import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import UnfoldMoreIcon from "@mui/icons-material/UnfoldMore";
import Box from "@mui/material/Box";

import { getAriaSort, SortState } from "../lib/tableSort";

type SortableColumnHeaderProps<TKey extends string> = {
  columnKey: TKey;
  title: string;
  sort: SortState<TKey>;
  onSort: (key: TKey) => void;
};

/**
 * A sortable header for the hand-rolled `role="table"` grids. `aria-sort` sits on the columnheader
 * per the WAI-ARIA table pattern, and the button carries no `aria-label` so its accessible name
 * stays its visible text — one string for the user and the tests to share.
 */
export function SortableColumnHeader<TKey extends string>({
  columnKey,
  title,
  sort,
  onSort
}: SortableColumnHeaderProps<TKey>) {
  const ariaSort = getAriaSort(sort, columnKey);

  return (
    <Box role="columnheader" aria-sort={ariaSort} sx={{ minWidth: 0 }}>
      <Box
        component="button"
        type="button"
        onClick={() => {
          onSort(columnKey);
        }}
        sx={{
          display: "flex",
          // The sort icon sits to the right of the label, on the same line and vertically centred.
          // Columns carry a minimum width that fits label plus icon, so neither has to give way.
          alignItems: "center",
          gap: 0.5,
          width: "100%",
          minWidth: 0,
          px: 0.75,
          py: 1,
          border: 0,
          background: "none",
          color: "inherit",
          font: "inherit",
          fontWeight: 700,
          lineHeight: 1.2,
          textAlign: "left",
          cursor: "pointer",
          borderRadius: 1,
          "&:hover": { backgroundColor: "rgba(247, 251, 255, 0.06)" },
          "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main" }
        }}
      >
        {/* Wraps onto a second line rather than truncating: an ellipsis in a narrow column costs
            the whole word, and the header row has no fixed height. `hyphens: none` keeps it from
            breaking mid-word; `overflow: hidden` keeps it out of the next column either way. */}
        <Box
          component="span"
          title={title}
          sx={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            lineHeight: 1.15
          }}
        >
          {title}
        </Box>
        <Box component="span" sx={{ display: "grid", placeItems: "center", flexShrink: 0 }}>
          {ariaSort === "ascending" ? (
            <ArrowUpwardIcon sx={{ fontSize: 16 }} />
          ) : ariaSort === "descending" ? (
            <ArrowDownwardIcon sx={{ fontSize: 16 }} />
          ) : (
            <UnfoldMoreIcon sx={{ fontSize: 16, opacity: 0.35 }} />
          )}
        </Box>
      </Box>
    </Box>
  );
}

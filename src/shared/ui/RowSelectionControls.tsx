import Checkbox from "@mui/material/Checkbox";

import { SelectAllState } from "../lib/rowSelection";

type SelectAllCheckboxProps = {
  label: string;
  state: SelectAllState;
  size?: "small" | "medium";
  onChange: (checked: boolean) => void;
};

type RowSelectCheckboxProps = {
  label: string;
  checked: boolean;
  size?: "small" | "medium";
  onChange: () => void;
};

export function SelectAllCheckbox({ label, state, size, onChange }: SelectAllCheckboxProps) {
  return (
    <Checkbox
      size={size}
      // The label belongs on the input, not on the MUI root span: that is what carries the
      // `checkbox` role, so `getByRole("checkbox", { name })` only resolves when it is placed here.
      slotProps={{ input: { "aria-label": label } }}
      checked={state === "all"}
      indeterminate={state === "some"}
      onChange={(event) => {
        onChange(event.target.checked);
      }}
    />
  );
}

/**
 * `stopPropagation` is baked in rather than left to the call site: both tables put this inside a
 * row whose own click does something else entirely — assign media to a cell, or open a project.
 */
export function RowSelectCheckbox({ label, checked, size, onChange }: RowSelectCheckboxProps) {
  return (
    <Checkbox
      size={size}
      slotProps={{ input: { "aria-label": label } }}
      checked={checked}
      onClick={(event) => {
        event.stopPropagation();
      }}
      onChange={onChange}
    />
  );
}

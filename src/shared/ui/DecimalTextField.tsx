import type { TextFieldProps } from "@mui/material/TextField";
import { useState } from "react";

import { formatDecimalRu, parseDecimalInput } from "../lib/decimalInput";
import { MobileLandscapeTextField } from "./MobileLandscapeTextField";

type DecimalTextFieldProps = Omit<
  TextFieldProps,
  "value" | "onChange" | "type" | "inputMode" | "defaultValue"
> & {
  value: number;
  /** Fires for every keystroke that parses; a keystroke that does not (`34,`) leaves state alone. */
  onValueChange: (value: number) => void;
};

/**
 * A number shown as `34,0` and typed with either separator.
 *
 * Two sources of truth, switched by focus: while the field is focused, the text is whatever the
 * user typed — reformatting under the cursor would turn `34,` into `34,0` mid-keystroke; once it
 * blurs, the text is `formatDecimalRu(value)` again, so `34,` settles to `34,0` and whatever the
 * parent clamped shows as clamped. Derived rather than synced in an effect, so a slider moving the
 * same value never fights the field.
 */
export function DecimalTextField({
  value,
  onValueChange,
  onFocus,
  onBlur,
  slotProps,
  ...props
}: DecimalTextFieldProps) {
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState("");
  const shown = focused ? draft : formatDecimalRu(value);

  const applyText = (text: string) => {
    setDraft(text);
    const parsed = parseDecimalInput(text);
    if (parsed !== null && parsed !== value) {
      onValueChange(parsed);
    }
  };

  return (
    <MobileLandscapeTextField
      {...props}
      type="text"
      value={shown}
      onValueChange={applyText}
      onMobileCommit={() => {
        // The overlay editor blurs the inline field silently, so this is the only blur it gets.
        setFocused(false);
      }}
      onFocus={(event) => {
        setDraft(formatDecimalRu(value));
        setFocused(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        onBlur?.(event);
      }}
      slotProps={{
        ...slotProps,
        htmlInput: {
          inputMode: "decimal",
          autoComplete: "off",
          ...(typeof slotProps?.htmlInput === "object" ? slotProps.htmlInput : {})
        }
      }}
    />
  );
}

import { Box, Button, Portal, TextField } from "@mui/material";
import useMediaQuery from "@mui/material/useMediaQuery";
import type { TextFieldProps } from "@mui/material/TextField";
import { FocusEvent, KeyboardEvent, useEffect, useRef, useState } from "react";

type MobileLandscapeTextFieldProps = Omit<TextFieldProps, "value" | "onChange"> & {
  value: string | number;
  onValueChange: (value: string) => void;
  onMobileCommit?: (value: string) => void;
};

type ViewportRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

function getViewportRect(): ViewportRect {
  const viewport = window.visualViewport;

  return {
    top: viewport?.offsetTop ?? 0,
    left: viewport?.offsetLeft ?? 0,
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight
  };
}

export function MobileLandscapeTextField({
  value,
  onValueChange,
  onMobileCommit,
  label,
  onFocus,
  onBlur,
  onKeyDown,
  slotProps,
  ...props
}: MobileLandscapeTextFieldProps) {
  const automatedBrowser = typeof navigator !== "undefined" && navigator.webdriver;
  const mobileLandscape = useMediaQuery(
    "(hover: none) and (pointer: coarse) and (orientation: landscape) and (max-height: 430px)"
  );
  const [editorOpen, setEditorOpen] = useState(false);
  const [draftValue, setDraftValue] = useState(String(value));
  const [viewportRect, setViewportRect] = useState<ViewportRect>(() =>
    typeof window === "undefined"
      ? { top: 0, left: 0, width: 0, height: 0 }
      : getViewportRect()
  );
  const editorInputRef = useRef<HTMLInputElement | null>(null);
  const focusedFieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const keyboardWaitTimerRef = useRef<number | null>(null);
  const awaitingKeyboardRef = useRef(false);
  const suppressNextBlurRef = useRef(false);

  useEffect(() => {
    if (!editorOpen) {
      setDraftValue(String(value));
    }
  }, [editorOpen, value]);

  useEffect(() => {
    if (!editorOpen) {
      return;
    }

    const syncViewport = () => {
      setViewportRect(getViewportRect());
    };

    syncViewport();
    window.visualViewport?.addEventListener("resize", syncViewport);
    window.visualViewport?.addEventListener("scroll", syncViewport);
    window.addEventListener("resize", syncViewport);
    return () => {
      window.visualViewport?.removeEventListener("resize", syncViewport);
      window.visualViewport?.removeEventListener("scroll", syncViewport);
      window.removeEventListener("resize", syncViewport);
    };
  }, [editorOpen]);

  useEffect(() => {
    if (!mobileLandscape) {
      return;
    }

    const clearKeyboardWait = () => {
      awaitingKeyboardRef.current = false;
      if (keyboardWaitTimerRef.current !== null) {
        window.clearTimeout(keyboardWaitTimerRef.current);
        keyboardWaitTimerRef.current = null;
      }
    };

    const openEditorForKeyboard = () => {
      const rect = getViewportRect();
      const keyboardLikelyOpen = rect.height < window.innerHeight - 80;
      if (!awaitingKeyboardRef.current || !keyboardLikelyOpen) {
        return;
      }

      clearKeyboardWait();
      suppressNextBlurRef.current = true;
      focusedFieldRef.current?.blur();
      setDraftValue(String(value));
      setViewportRect(rect);
      setEditorOpen(true);
    };

    window.visualViewport?.addEventListener("resize", openEditorForKeyboard);
    window.visualViewport?.addEventListener("scroll", openEditorForKeyboard);
    return () => {
      clearKeyboardWait();
      window.visualViewport?.removeEventListener("resize", openEditorForKeyboard);
      window.visualViewport?.removeEventListener("scroll", openEditorForKeyboard);
    };
  }, [mobileLandscape, value]);

  useEffect(() => {
    if (!editorOpen) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      editorInputRef.current?.focus();
      editorInputRef.current?.select();
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [editorOpen]);

  const commitAndClose = () => {
    onValueChange(draftValue);
    onMobileCommit?.(draftValue);
    setEditorOpen(false);
  };

  const handleFieldFocus = (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    onFocus?.(event);
    if (event.defaultPrevented || !mobileLandscape || automatedBrowser) {
      return;
    }
    focusedFieldRef.current = event.currentTarget;
    awaitingKeyboardRef.current = true;
    if (keyboardWaitTimerRef.current !== null) {
      window.clearTimeout(keyboardWaitTimerRef.current);
    }
    keyboardWaitTimerRef.current = window.setTimeout(() => {
      awaitingKeyboardRef.current = false;
      keyboardWaitTimerRef.current = null;
    }, 900);
  };

  const handleFieldBlur = (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (suppressNextBlurRef.current) {
      suppressNextBlurRef.current = false;
      return;
    }
    onBlur?.(event);
  };

  const handleFieldKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
  };

  return (
    <>
      <TextField
        {...props}
        label={label}
        value={value}
        onFocus={handleFieldFocus}
        onBlur={handleFieldBlur}
        onKeyDown={handleFieldKeyDown}
        onChange={(event) => {
          onValueChange(event.target.value);
        }}
        slotProps={slotProps}
      />
      {editorOpen ? (
        <Portal>
          <Box
            role="presentation"
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) {
                commitAndClose();
              }
            }}
            sx={{
              position: "fixed",
              zIndex: 1600,
              top: viewportRect.top,
              left: viewportRect.left,
              width: viewportRect.width,
              height: viewportRect.height,
              backgroundColor: "rgba(5, 7, 13, 0.92)",
              backdropFilter: "blur(10px)",
              display: "grid",
              alignItems: "start",
              p: 0.75,
              pt: "max(6px, var(--app-safe-area-top))"
            }}
          >
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) auto auto",
                gap: 0.5,
                alignItems: "center",
                minWidth: 0
              }}
            >
              <TextField
                {...props}
                inputRef={editorInputRef}
                label={label}
                value={draftValue}
                size="small"
                autoFocus
                fullWidth
                slotProps={slotProps}
                onChange={(event) => {
                  setDraftValue(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitAndClose();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setEditorOpen(false);
                  }
                }}
                sx={{
                  "& .MuiInputBase-input": {
                    fontSize: 16,
                    py: 0.75
                  },
                  "& .MuiInputLabel-root": {
                    fontSize: 13
                  }
                }}
              />
              <Button variant="contained" size="small" onClick={commitAndClose}>
                Готово
              </Button>
              <Button
                variant="outlined"
                size="small"
                onClick={() => {
                  setEditorOpen(false);
                }}
              >
                Отмена
              </Button>
            </Box>
          </Box>
        </Portal>
      ) : null}
    </>
  );
}

import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  InputAdornment,
  Typography
} from "@mui/material";
import { useEffect, useRef, useState } from "react";

import { makeUniqueName } from "../../../shared/lib/uniqueName";
import { MobileLandscapeTextField } from "../../../shared/ui/MobileLandscapeTextField";
import { PROJECT_FILE_EXTENSION } from "../../file-config";

type ProjectSaveDialogProps = {
  open: boolean;
  defaultName: string;
  defaultDescription: string;
  defaultFileName: string;
  /** Names already in the projects list, so a fresh project does not open on a taken one. */
  takenProjectNames: readonly string[];
  onCancel: () => void;
  onSave: (values: { name: string; description: string; fileName: string }) => void;
};

const DEFAULT_PROJECT_NAME = "Новый проект";

/**
 * Name and description are optional and go **into the file**, so re-picking it on a browser that
 * cannot keep a file handle restores the project's identity from the file itself.
 */
export function ProjectSaveDialog({
  open,
  defaultName,
  defaultDescription,
  defaultFileName,
  takenProjectNames,
  onCancel,
  onSave
}: ProjectSaveDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState(defaultDescription);
  const [fileName, setFileName] = useState(defaultFileName);
  /**
   * The project name feeds the file name until the user edits the file name themselves. The link is
   * one-way and one-time: editing the file name never writes back, and never gets overwritten.
   */
  const fileNameEditedRef = useRef(false);
  /**
   * Seeded once per OPENING, never again while the dialog is up.
   *
   * `takenProjectNames` is read from IndexedDB, so it arrives after the dialog is already on
   * screen. With it in the dependency list the effect re-ran on arrival and reset all three fields
   * — silently discarding whatever the user had typed in the meantime, and doing it more often the
   * slower the machine. It showed up as a saved project called "Новый проект" that the user had
   * named something else moments earlier.
   */
  const seededForOpenRef = useRef(false);

  useEffect(() => {
    if (!open) {
      seededForOpenRef.current = false;
      return;
    }
    if (seededForOpenRef.current) {
      return;
    }
    seededForOpenRef.current = true;
    // A project saved before keeps its own name; a fresh one gets a default that is not taken yet.
    const initialName =
      defaultName || makeUniqueName(takenProjectNames, DEFAULT_PROJECT_NAME, DEFAULT_PROJECT_NAME);
    fileNameEditedRef.current = Boolean(defaultFileName);
    setName(initialName);
    setDescription(defaultDescription);
    setFileName(defaultFileName || initialName);
  }, [defaultDescription, defaultFileName, defaultName, open, takenProjectNames]);

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      fullWidth
      slotProps={{
        paper: {
          sx: {
            width: { xs: "calc(100vw - 24px)", sm: "calc(100vw - 64px)" },
            maxWidth: { xs: "calc(100vw - 24px)", sm: 520 },
            maxHeight: "calc(100dvh - 24px)",
            m: { xs: 1.5, sm: 4 }
          }
        }
      }}
    >
      <DialogTitle>Сохранить проект</DialogTitle>
      <DialogContent sx={{ display: "grid", gap: 2, pt: 1 }}>
        <MobileLandscapeTextField
          label="Имя проекта"
          value={name}
          size="small"
          slotProps={{ htmlInput: { "aria-label": "Имя проекта" } }}
          onValueChange={(value) => {
            setName(value);
            if (!fileNameEditedRef.current) {
              setFileName(value);
            }
          }}
        />
        <MobileLandscapeTextField
          label="Описание"
          value={description}
          size="small"
          multiline
          minRows={2}
          slotProps={{ htmlInput: { "aria-label": "Описание проекта" } }}
          onValueChange={setDescription}
        />
        <MobileLandscapeTextField
          label="Имя файла"
          value={fileName}
          size="small"
          slotProps={{
            htmlInput: { "aria-label": "Имя файла проекта" },
            // The extension is appended on save, so there is nothing to type and nothing to get
            // wrong; showing it as a suffix keeps the result obvious.
            input: {
              endAdornment: <InputAdornment position="end">{PROJECT_FILE_EXTENSION}</InputAdornment>
            }
          }}
          onValueChange={(value) => {
            fileNameEditedRef.current = true;
            setFileName(value);
          }}
        />
        <Typography variant="body2" color="text.secondary">
          Имя проекта и описание сохраняются внутри файла .mumbox.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Отмена</Button>
        <Button
          variant="contained"
          onClick={() => {
            onSave({ name: name.trim(), description: description.trim(), fileName });
          }}
        >
          Сохранить
        </Button>
      </DialogActions>
    </Dialog>
  );
}

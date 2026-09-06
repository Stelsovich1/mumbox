import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography
} from "@mui/material";
import { useEffect, useState } from "react";

import { MobileLandscapeTextField } from "../../../shared/ui/MobileLandscapeTextField";

type ProjectSaveDialogProps = {
  open: boolean;
  defaultName: string;
  defaultDescription: string;
  defaultFileName: string;
  onCancel: () => void;
  onSave: (values: { name: string; description: string; fileName: string }) => void;
};

/**
 * Name and description are optional and go **into the file**, so re-picking it on a browser that
 * cannot keep a file handle restores the project's identity from the file itself.
 */
export function ProjectSaveDialog({
  open,
  defaultName,
  defaultDescription,
  defaultFileName,
  onCancel,
  onSave
}: ProjectSaveDialogProps) {
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState(defaultDescription);
  const [fileName, setFileName] = useState(defaultFileName);

  useEffect(() => {
    if (open) {
      setName(defaultName);
      setDescription(defaultDescription);
      setFileName(defaultFileName);
    }
  }, [defaultDescription, defaultFileName, defaultName, open]);

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
          onValueChange={setName}
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
          slotProps={{ htmlInput: { "aria-label": "Имя файла проекта" } }}
          onValueChange={setFileName}
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

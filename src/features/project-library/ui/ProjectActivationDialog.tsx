import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from "@mui/material";

import { ActivationPlan } from "../model/projectRowState";

type ProjectActivationDialogProps = {
  open: boolean;
  plan: ActivationPlan | null;
  projectLabel: string;
  onCancel: () => void;
  onOpenProject: () => void;
  onSaveAndOpen: () => void;
  onDiscardAndOpen: () => void;
};

export function ProjectActivationDialog({
  open,
  plan,
  projectLabel,
  onCancel,
  onOpenProject,
  onSaveAndOpen,
  onDiscardAndOpen
}: ProjectActivationDialogProps) {
  const unsaved = plan?.kind === "unsavedProject";

  return (
    <Dialog
      open={open && plan !== null && plan.kind !== "alreadyOpen"}
      onClose={onCancel}
      aria-labelledby="project-activation-title"
      slotProps={{
        paper: {
          sx: {
            width: { xs: "calc(100vw - 24px)", sm: 460 },
            maxWidth: { xs: "calc(100vw - 24px)", sm: 460 },
            maxHeight: "calc(100dvh - 24px)",
            m: { xs: 1.5, sm: 4 }
          }
        }
      }}
    >
      <DialogTitle id="project-activation-title">Активировать проект?</DialogTitle>
      <DialogContent>
        <Typography>
          {unsaved
            ? `Текущий проект не сохранён. Открыть "${projectLabel}"?`
            : `Переключиться на проект "${projectLabel}"?`}
        </Typography>
      </DialogContent>
      <DialogActions sx={{ flexWrap: "wrap" }}>
        <Button onClick={onCancel}>Отмена</Button>
        {unsaved ? (
          <>
            <Button color="error" onClick={onDiscardAndOpen}>
              Без сохранения
            </Button>
            <Button variant="contained" onClick={onSaveAndOpen}>
              Сохранить и открыть
            </Button>
          </>
        ) : (
          <Button variant="contained" onClick={onOpenProject}>
            Открыть
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

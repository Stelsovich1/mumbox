/**
 * A file dragged from the desktop onto a page nobody handles is opened by the browser: it
 * navigates the tab to the file, or opens one tab per file. The grid only accepts file drops in
 * edit mode, so every drop outside that case used to leave the app entirely — the most destructive
 * thing a stray gesture can do here, because an unsaved layout goes with the navigation.
 *
 * So the window swallows native file drags unconditionally. Handlers that DO want a drop (the grid
 * in edit mode) run first, during bubbling, and this guard only calls `preventDefault` afterwards;
 * it never inspects or consumes the payload.
 */

type DropGuardTarget = Pick<Window, "addEventListener" | "removeEventListener">;

function carriesFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  if (!types) {
    return false;
  }
  return Array.from(types).includes("Files");
}

export function installNativeFileDropGuard(target: DropGuardTarget = window): () => void {
  const handleDragOver = (event: DragEvent) => {
    if (!carriesFiles(event)) {
      return;
    }
    // A handler below that already claimed the drag has called `preventDefault` and set its own
    // `dropEffect`; leave that cursor alone and only swallow the unclaimed rest.
    const claimed = event.defaultPrevented;
    event.preventDefault();
    if (!claimed && event.dataTransfer) {
      event.dataTransfer.dropEffect = "none";
    }
  };

  const handleDrop = (event: DragEvent) => {
    if (!carriesFiles(event)) {
      return;
    }
    event.preventDefault();
  };

  target.addEventListener("dragover", handleDragOver);
  target.addEventListener("drop", handleDrop);

  return () => {
    target.removeEventListener("dragover", handleDragOver);
    target.removeEventListener("drop", handleDrop);
  };
}

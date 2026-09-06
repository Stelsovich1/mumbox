/**
 * The drag session shared by the media picker (the source) and the workspace grid (the target).
 *
 * It lives in `shared` because both a feature and a widget need it and features must not import
 * each other. It publishes coordinates only and never hit-tests: only the grid knows which cells
 * exist and which are occupied.
 */

export type MediaDragEvent =
  | { kind: "start" | "move" | "drop"; mediaIds: string[]; clientX: number; clientY: number }
  | { kind: "cancel" };

type PointerDragInput = {
  mediaIds: string[];
  pointerId: number;
  clientX: number;
  clientY: number;
  sourceElement: HTMLElement;
};

const listeners = new Set<(event: MediaDragEvent) => void>();

let pointerSession: { mediaIds: string[]; pointerId: number; sourceElement: HTMLElement } | null =
  null;
/**
 * The in-flight native drag, kept module-side as well as in `dataTransfer`.
 *
 * `dragover` must decide "is this a media drag?" synchronously, and some browsers mask
 * `dataTransfer.types` while a drag is in protected mode. Without a readable type nothing calls
 * `preventDefault`, and then no `drop` ever fires. The drag never leaves this document, so a
 * module-level record is a reliable second channel; the MIME payload stays the documented contract.
 */
let nativeDragMediaIds: string[] | null = null;

export function subscribeMediaDrag(listener: (event: MediaDragEvent) => void) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

function publish(event: MediaDragEvent) {
  for (const listener of listeners) {
    listener(event);
  }
}

function handleWindowDragEnd() {
  endNativeMediaDrag();
}

export function beginNativeMediaDrag(mediaIds: readonly string[]) {
  nativeDragMediaIds = [...mediaIds];
  // The source row can unmount mid-drag: the picker is virtualised above 80 rows, and a row that
  // scrolls out of the window may never fire its own `dragend`. A window-level listener guarantees
  // the registry is cleared, otherwise every later `dragover` on a cell reads as a media drag.
  window.addEventListener("dragend", handleWindowDragEnd);
  window.addEventListener("drop", handleWindowDragEnd);
}

export function endNativeMediaDrag() {
  window.removeEventListener("dragend", handleWindowDragEnd);
  window.removeEventListener("drop", handleWindowDragEnd);
  if (!nativeDragMediaIds) {
    return;
  }
  nativeDragMediaIds = null;
  publish({ kind: "cancel" });
}

export function getNativeMediaDragIds() {
  return nativeDragMediaIds;
}

function teardownPointerSession() {
  if (!pointerSession) {
    return;
  }
  const { sourceElement, pointerId } = pointerSession;
  pointerSession = null;
  window.removeEventListener("pointermove", handlePointerMove);
  window.removeEventListener("pointerup", handlePointerUp);
  window.removeEventListener("pointercancel", handlePointerCancel);
  window.removeEventListener("keydown", handleKeyDown);
  try {
    sourceElement.releasePointerCapture(pointerId);
  } catch {
    // The capture may never have been granted; synthetic pointers cannot be captured at all.
  }
}

function handlePointerMove(event: PointerEvent) {
  if (pointerSession?.pointerId !== event.pointerId) {
    return;
  }
  event.preventDefault();
  publish({
    kind: "move",
    mediaIds: pointerSession.mediaIds,
    clientX: event.clientX,
    clientY: event.clientY
  });
}

function handlePointerUp(event: PointerEvent) {
  if (pointerSession?.pointerId !== event.pointerId) {
    return;
  }
  const { mediaIds } = pointerSession;
  teardownPointerSession();
  publish({ kind: "drop", mediaIds, clientX: event.clientX, clientY: event.clientY });
}

function handlePointerCancel(event: PointerEvent) {
  if (pointerSession?.pointerId !== event.pointerId) {
    return;
  }
  teardownPointerSession();
  publish({ kind: "cancel" });
}

function handleKeyDown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    cancelMediaDrag();
  }
}

export function beginPointerMediaDrag({
  mediaIds,
  pointerId,
  clientX,
  clientY,
  sourceElement
}: PointerDragInput) {
  teardownPointerSession();
  pointerSession = { mediaIds, pointerId, sourceElement };

  try {
    sourceElement.setPointerCapture(pointerId);
  } catch {
    // Synthetic pointers have no live capture target; the window listeners still see the events.
  }

  window.addEventListener("pointermove", handlePointerMove, { passive: false });
  window.addEventListener("pointerup", handlePointerUp);
  window.addEventListener("pointercancel", handlePointerCancel);
  window.addEventListener("keydown", handleKeyDown);

  publish({ kind: "start", mediaIds, clientX, clientY });
}

export function cancelMediaDrag() {
  const hadPointerSession = pointerSession !== null;
  teardownPointerSession();
  nativeDragMediaIds = null;
  if (hadPointerSession) {
    publish({ kind: "cancel" });
  }
}

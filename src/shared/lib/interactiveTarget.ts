/**
 * True when the event originated on a control inside a clickable row, so the row's own click
 * handler must stand down. Covers keyboard activation too: Space on a checkbox fires a click whose
 * target is the `input`.
 */
export function isInteractiveRowTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest("button, input, textarea, [role='button'], [role='checkbox'], [role='radio']"))
  );
}

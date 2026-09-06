const INTERACTIVE_SELECTOR =
  "button, input, textarea, [role='button'], [role='checkbox'], [role='radio']";

/**
 * True when the event originated on a control *inside* a clickable row, so the row's own click
 * handler must stand down. Covers keyboard activation too: Space on a checkbox fires a click whose
 * target is the `input`.
 *
 * `rowElement` matters when the row itself carries an interactive role — the media picker's rows are
 * `role="button"`. Without it the row matches its own selector and every click is discarded.
 */
export function isInteractiveRowTarget(target: EventTarget | null, rowElement?: Element | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const control = target.closest(INTERACTIVE_SELECTOR);

  return control !== null && control !== rowElement;
}

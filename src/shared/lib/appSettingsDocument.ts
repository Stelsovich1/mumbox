import { AppSettings, resolveLabelScaleFactor } from "./appSettings";

/**
 * The visual settings reach the DOM as attributes on the root element, never as props on a cell.
 *
 * A root attribute changes nothing in React: no prop crosses the memo boundary of the 144 cells and
 * no component re-renders. That matters less than it would for a warm-state change — this value
 * changes once per «Применить», not continuously — but it also keeps the switch out of the render
 * path entirely, which a prop could not.
 *
 * They are attributes on `:root` rather than a class on the grid so the rules can also reach things
 * outside the grid. `:root[data-visuals="flat"] [data-cell-id]` is (0,3,0) against Emotion's single
 * class (0,1,0); `global.css` still writes `!important` on the four properties Emotion may set from
 * more than one rule.
 */
export function applySettingsToDocument(settings: AppSettings): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  if (settings.visuals.flatGraphics) {
    root.setAttribute("data-visuals", "flat");
  } else {
    root.removeAttribute("data-visuals");
  }
  if (settings.visuals.reduceMotion) {
    root.setAttribute("data-motion", "reduced");
  } else {
    root.removeAttribute("data-motion");
  }
  root.style.setProperty("--mumbox-label-scale", String(resolveLabelScaleFactor(settings)));
}

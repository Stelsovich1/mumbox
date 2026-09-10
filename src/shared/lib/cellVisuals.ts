/**
 * Per-cell visuals that change faster than React should be asked to render.
 *
 * Playback progress used to be React state: the rAF loop pushed an array of playing cells into
 * `useState` twenty times a second, and because `useAudioEngine` is called from `AppShell` that
 * re-rendered the entire shell — toolbar, tabs, the 144-element grid map — at that rate, for the
 * whole time anything was playing. Measured on a 32-core Xeon, `grid100-medium-1panel` already ran
 * at 54 fps with a p95 frame interval of 33 ms; a phone is five to eight times slower.
 *
 * The app already knew this trick and used it in one place: `setPressed` writes `data-pressed`
 * straight to the node because routing press feedback through React put a reconciliation between
 * the finger and the first visible pixel. This is the same idea for the same reason, applied to the
 * thing that actually runs at frame rate.
 *
 * WHAT STAYS IN REACT: which cells are playing. That changes on a press, which is rare, and it
 * drives `data-playing` plus the colour derivation. Only the continuous quantity moves out.
 *
 * A module-level registry rather than a ref passed down, because the writer is the audio engine and
 * it holds no reference to the grid — the same reason `playbackBufferCache` is a singleton.
 *
 * Typed structurally so the unit tier can drive it with plain objects.
 */

export type CellVisualTarget = {
  setAttribute: (name: string, value: string) => void;
  style: { setProperty: (name: string, value: string) => void };
};

const targets = new Map<string, CellVisualTarget>();
/**
 * Last value written per cell, kept so a REGISTRATION can replay it.
 *
 * Without that, a cell remounting mid-playback — a grid resize, a panel switch back — would show a
 * marker frozen at zero until the next write. It also makes the write dedupe exact rather than
 * approximate: the comparison is on the formatted string that would reach the DOM.
 */
const lastProgress = new Map<string, string>();

/** Four decimals, which is what the DOM attribute has always carried. */
function format(progress: number): string {
  const clamped = Math.min(1, Math.max(0, progress));
  return clamped.toFixed(4);
}

function apply(target: CellVisualTarget, value: string): void {
  target.setAttribute("data-progress", value);
  target.style.setProperty("--cell-progress", value);
}

/**
 * Attaches a cell's element, or detaches it when `target` is null.
 *
 * Replays the last known value immediately: a test that reads `data-progress` in the same tick it
 * saw `data-playing` must not see a stale zero, and neither must a user.
 */
export function registerCell(cellKey: string, target: CellVisualTarget | null): void {
  if (!target) {
    targets.delete(cellKey);
    return;
  }
  targets.set(cellKey, target);
  apply(target, lastProgress.get(cellKey) ?? "0.0000");
}

export function writeProgress(cellKey: string, progress: number): void {
  const value = format(progress);
  if (lastProgress.get(cellKey) === value) {
    return;
  }
  lastProgress.set(cellKey, value);
  const target = targets.get(cellKey);
  if (target) {
    apply(target, value);
  }
}

/**
 * Returns a cell to rest. Called when a cue ends, so a stopped pad does not keep a stale marker.
 *
 * The retained value is DELETED rather than written back as zero. Rest is the default that
 * `registerCell` already replays for an absent key, so keeping an entry bought nothing and cost
 * one permanent string per cell key ever used — and keys carry the panel id, which `panel/add`,
 * `panel/copy`, an import and a merge all mint fresh. An edit session that builds and discards
 * panels grew this map for as long as it ran.
 */
export function clearProgress(cellKey: string): void {
  writeProgress(cellKey, 0);
  lastProgress.delete(cellKey);
}

/** Test seam. The registry outlives any single component, so a test has to be able to empty it. */
export function resetCellVisuals(): void {
  targets.clear();
  lastProgress.clear();
}

/** Test seam: what the registry believes a cell's progress is. */
export function readProgress(cellKey: string): string | null {
  return lastProgress.get(cellKey) ?? null;
}

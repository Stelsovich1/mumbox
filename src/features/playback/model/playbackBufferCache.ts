import {
  readBudgetOverride,
  setDiagnosticsSinks,
  setPcmAccountingSource
} from "../../../shared/lib/diagnostics";
import { registerMediaCache } from "../../../shared/lib/mediaCacheRegistry";
import { createAudioBufferCache } from "./audioBufferCache";

/**
 * The playback buffer cache singleton, its device-derived budget, and the wiring that lets
 * `AppShell` purge it and the diagnostics overlay report it.
 *
 * Kept apart from `audioBufferCache.ts` so that module stays free of DOM globals and can be unit
 * tested in Node.
 *
 * The cache is module-level rather than a hook ref because purging must work without a reference
 * to the engine. It is deliberately NOT cleared on unmount: `AppShell` never unmounts in
 * production, React 19 StrictMode double-mounts in development, and clearing there would throw
 * away a warm cache on every dev mount. Invalidation is explicit instead.
 */

/**
 * There is no default budget on a desktop, and there IS one on a coarse-pointer device.
 *
 * The desktop half is unchanged and for the original reason: a cap smaller than the project turns
 * every trigger into a cold decode, and this app is a soundboard, so a pad that is not instant is
 * not a pad. The bound there comes from housekeeping — deleted media releases its PCM, only the
 * panel on screen is kept warm, a streamed route releases its finished segments.
 *
 * The mobile half exists because housekeeping bounds the footprint to ONE PANEL'S WORTH, and on a
 * phone one panel's worth can still be more than the device has. Measured on a real 18-cell panel
 * of whole MP3s with byte-range decoding off: 1 539 MiB resident, and `__mumboxDiag.termination()`
 * reporting the previous session killed. A panel with the path working was measured at 110-180 MiB
 * — on other hardware and another project, so the two are separate observations rather than a
 * before/after of one thing; what they establish together is only the ORDER of magnitude between a
 * declining path and a working one. So the budget is not the mechanism that makes this app fit, it
 * is the backstop for when that mechanism declines. Declining is legitimate and permanent for some cells: a loop is excluded from
 * streaming by design, and a file whose alignment cannot be measured is off the path for good. A
 * handful of those must not be able to kill the tab.
 *
 * 1 GiB, and the number is deliberately generous rather than protective. A working panel of long
 * tracks needs about 110-180 MiB once byte-range decoding is doing its job, so this ceiling is not
 * reached at all in the healthy case — which is the point: the predictive skip in the warm-up
 * consults the budget, and a tighter number leaves pads dim on a panel that would have fitted.
 *
 * The trade, stated plainly because it is a real one. The failure this exists for — the byte-range
 * path declining across the board, measured at 1 539 MiB resident with the tab then killed — is one
 * a few hundred MiB of ceiling would have survived and this one probably will not. It is set here anyway
 * because that failure now has its own guard (a browser verdict that cannot latch on one file) and
 * its own regression tests, while a dim pad has no guard at all and is felt at every show. Revisit
 * with `__mumboxDiag.termination()`: `ungraceful` after a long session is this number being wrong.
 *
 * The two-tier eviction is what makes it safe to be wrong — a pinned buffer is never evicted, so a
 * playing cue cannot be cut, and the active panel is evicted last.
 *
 * Both halves stay overridable, and the override still wins in BOTH directions: `?pcmBudgetMb=N`
 * at load or `__mumboxDiag.setBudgetMb(n)` at runtime sets it, `?pcmBudgetMb=0` clears it even
 * where a default would apply. That is the knob for measuring where a device gives up.
 */
export const COARSE_POINTER_BUDGET_BYTES = 1024 * 1024 * 1024;

export function getDefaultBudgetBytes(): number | null {
  const override = readBudgetOverride();
  if (override.present) {
    return override.bytes;
  }
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  return window.matchMedia("(hover: none) and (pointer: coarse)").matches
    ? COARSE_POINTER_BUDGET_BYTES
    : null;
}

export const playbackBufferCache = createAudioBufferCache(getDefaultBudgetBytes());

let activePanelKeys: readonly string[] = [];

export function setActivePanelKeys(keys: readonly string[]): void {
  activePanelKeys = keys;
}

registerMediaCache({
  name: "playback-buffers",
  deleteByMediaId: (mediaId) => playbackBufferCache.deleteByMediaId(mediaId),
  clear: () => {
    playbackBufferCache.clear();
  },
  bytes: () => playbackBufferCache.bytes()
});

setPcmAccountingSource(
  () => {
    const stats = playbackBufferCache.stats();
    return {
      totalBytes: stats.bytes,
      activePanelBytes: playbackBufferCache.bytesFor(activePanelKeys),
      pinnedBytes: stats.pinnedBytes,
      budgetBytes: stats.budgetBytes,
      entries: stats.entries,
      hits: stats.hits,
      misses: stats.misses,
      evictions: stats.evictions,
      overBudget: stats.overBudget
    };
  },
  () => playbackBufferCache.keys()
);

setDiagnosticsSinks({
  setBudgetBytes: (bytes) => {
    playbackBufferCache.setBudgetBytes(bytes);
  }
});

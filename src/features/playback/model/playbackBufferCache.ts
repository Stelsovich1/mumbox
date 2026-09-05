import {
  getBudgetOverrideFromQuery,
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
 * There is no default budget, on any device.
 *
 * A cap smaller than the project turns every trigger into a cold decode, and this app is a
 * soundboard: a pad that is not instant is not a pad. Capping was a regression for people whose
 * libraries already worked. What made memory grow without bound before was not the absence of a
 * cap but the absence of housekeeping — deleted media kept its PCM, revisited panels accumulated,
 * a looping fallback leaked a context per iteration, and an untrimmed decode was kept even for a
 * cell that plays twelve seconds of it. Those are fixed, so the footprint is now what the project
 * actually needs rather than everything it ever touched.
 *
 * The limit still exists so it can be set deliberately: `?pcmBudgetMb=N` at load, or
 * `__mumboxDiag.setBudgetMb(n)` at runtime, with a non-positive value clearing it again. That is
 * the knob for measuring where a device gives up — pair it with `__mumboxDiag.termination()`,
 * which reports whether the previous session ended without running its `pagehide` handler.
 */
export function getDefaultBudgetBytes(): number | null {
  return getBudgetOverrideFromQuery();
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

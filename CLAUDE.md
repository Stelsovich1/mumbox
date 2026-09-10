# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Vite dev server on 127.0.0.1
npm run build        # tsc -b (typecheck) + vite build
npm run lint         # eslint, type-aware
npm run test:unit    # Playwright runner, no browser and no server
npm run test:e2e     # Playwright; auto-runs `build` + `preview --port 4173` first
npm run test         # unit + e2e
npm run test:perf    # separate config, own build + preview on port 4174
npm run deploy       # gh-pages -d dist (requires a prior build)
```

Run a single test or project:

```bash
npx playwright test tests/e2e/app-shell.spec.ts -g "manages panels and grid size" --project=desktop-chromium
```

Playwright projects are `desktop-chromium` (1440x900) and `mobile-landscape` (932x430, touch). `reuseExistingServer` is on outside CI, so a running `npm run preview -- --port 4173` is reused; a stale one serves stale `dist`.

### Three test tiers, three configs

`webServer` is a top-level Playwright field and cannot be scoped per project, so the tiers are
separate config files rather than separate projects.

| Tier | Config | Contents |
| --- | --- | --- |
| unit | `playwright.unit.config.ts` | `tests/unit/` — pure modules imported from `src/`, no `page` fixture, so no browser and no server start. Modules reachable from here must stay free of `import.meta.env`, CSS and JSX: the Playwright loader transpiles TypeScript but runs no Vite plugins. |
| e2e | `playwright.config.ts` | `tests/e2e/` |
| perf | `playwright.perf.config.ts` | `tests/perf/` — port 4174, `workers: 1`, `reuseExistingServer: false`, service workers blocked. Never part of `test:e2e`. |

`tests/support/` holds the shared helpers: `audioFixtures.ts` (pure-JS WAV writer),
`seedProject.ts` (seeds the IndexedDB media blobs plus the IndexedDB layout record in one
navigation — never the legacy localStorage key, or every seeded test would be exercising the
migration path instead of the steady state),
`audioMock.ts` (the opt-in Web Audio mock that exercises the buffer route), `diag.ts` (typed access
to `window.__mumboxDiag`).

Two mocks exist on purpose. `installAudioMock` in `app-shell.spec.ts` defines no
`createBufferSource`, so everything using it drives `startMediaElementFallback`.
`installBufferAudioMock` in `tests/support/audioMock.ts` drives `startBufferRoute` — the path every
real browser takes — and gives the audio clock to the test (`advanceAudioClock`), because a loop
restart on a wall-clock timer either makes tests ten seconds slow or recurses synchronously inside
`onended`.

`tests/perf/baseline.json` is committed so a performance regression shows up as a reviewable diff.
Record a new one with `PERF_UPDATE_BASELINE=1 npm run test:perf`. There are four gate kinds
(`tests/perf/support/baseline.ts`): `hard` is an absolute ceiling that needs no baseline — time to
first sound is one, because the constraint is perceptual and against a sub-millisecond baseline a
ratio gate cries wolf; `exact` asserts equality and is used for decoded byte counts and decode
COUNTS, which are facts about the code rather than about the machine; `soft` fails only when a 30 %
ratio **and** an absolute floor are both exceeded; `record` is stored and never asserted, for
numbers whose spread is not known yet. The `exact` gates only hold because `perfGoto` pins
`?rate=44100` — every fixture is a 44.1 kHz WAV, and at another rate they leave the byte-range path
entirely.

`tests/MUTATION-PROTOCOL.md` describes the manual mutation-testing round used to find holes in these
tests. There is no mutation framework and none may be added.

## Architecture

Feature-Sliced Design: `app` → `pages` → `widgets` → `features` → `entities` → `shared`. Imports go downward only; each slice exposes a barrel `index.ts`.

`AppShell` (`src/widgets/app-shell/ui/AppShell.tsx`) is the single orchestrator — it owns the store, the audio engine, all dialogs, file inputs, global hotkey listeners, and the PWA update prompt. Everything below it is presentational or self-contained.

### State and persistence — two separate stores

`src/app/model/appState.ts` holds a `useReducer` store (`useAppStore`) that is the single source of
truth for panels, cells, media metadata, and volume.

The layout lives in **IndexedDB**, in its own database `mumbox-app`/`state` under the key `state:v1`
(`src/app/model/appStateStorage.ts`) — deliberately not idb-keyval's default store, which
`clearStoredAppData` empties wholesale. `ProjectSession` sits beside it under `session:v1`, a
separate key so the `.mumbox` payload stays byte-identical for an untouched project. Reading is
therefore asynchronous and `BoardPage` is the boot gate; a FAILED read is not an empty one and
suspends writing entirely, because writing over a project that is still there is the most
destructive thing this layer can do.

Writes are debounced (`createPersistence`): 400 ms trailing with a 2 s max wait for the six
`DEFERRABLE_ACTIONS`, immediate for everything else, plus a flush on `visibilitychange`. `flush()`
returns whether the write SUCCEEDED, and `useAppStore`'s `flushPendingState()` waits for the current
state to reach persistence before flushing — a barrier that only awaited the flush wrote nothing at
all, because React schedules the persistence effect on a macrotask while `await` resolves in a
microtask. Any path that deletes blobs the old state names must go through it and must not delete
when it returns false.

`serializeState` (`src/app/model/serializeState.ts`) drops `editMode` **and every cell equal to
`makeCell(id)`**. That is what keeps a 20-panel 12x12 project from materialising 2880 cells; every
load path runs `ensurePanelCells`, which rebuilds them, so the omission is compatible in both
directions and `version` stays 2.

`mumbox:state:v1` and `mumbox:project-session:v1` survive in localStorage as a **rollback mirror
only**, written for one release while the serialized layout is under 1.5 M characters and removed
above it. IndexedDB always wins; edits made on an older build are lost on the way back. Two keys
stay in localStorage on purpose: `mumbox:partial-decode:v1` (read synchronously on a hot path) and
`mumbox:diag:session:v1` (written from `pagehide`, where an async write would never land).

Audio blobs never enter that JSON. They live in **IndexedDB** via `idb-keyval` under `mumbox:media:<mediaId>` (`saveImportedMedia` / `getMediaBlob` / `deleteStoredMedia`). `MediaAsset` in state only carries metadata. Any code that adds or removes media must keep both stores in sync.

### Cell identity and grid resizing

Cell IDs are position-stable: `cell-${row * 12 + column}` (`getPanelCellIds`), so a cell keeps its coordinates when the grid grows or shrinks between 6/8/10/12. Older saves used flat `cell-${index}`; `normalizePanelCellIds` and `remapLegacyCells` migrate those on load and on project import. Do not change this scheme without keeping both migration paths working — e2e tests cover resize round-trips.

Shrinking a grid **hides** cells, it never clears them: `panel/gridSize` regenerates `cellIds` and
merges the cell record, so a cue placed at 12x12 still exists while a 6x6 grid is on screen. It
does **not** fire from its hotkey there, and that is a defect rather than a design: `AppShell`
builds the hotkey list from `activePanel.cellIds`, which is the visible lattice only. Recorded here
because the claim used to read the other way round and a reader would rebuild the wrong invariant
from it. Nothing on the grid can show that, because the cell is not rendered,
so `entities/panel/model/hiddenCells.ts` derives it from the id lattice and the size control paints
itself with a gradient (`data-hidden-media`) plus the smallest size that would show everything.

`ensurePanelCells` builds a panel's record from `cellIds` alone, so every path that runs it —
loading the stored layout, importing a `.mumbox`, merging one — would delete those hidden cues.
`preserveHiddenCells` re-attaches them, and legacy flat-id panels are deliberately excluded: their
ids are flat for the panel's own size, so an out-of-grid id names a lattice position only when that
size was 12, and guessing would move a cue somewhere it never was.

Several reducer actions (`panel/add`, `panel/copy`, `panel/rename`, `panel/delete`,
`panel/deleteMany`) intentionally no-op unless `state.editMode` is true.

### Selection mode and the bulk actions

«Режим выбора» (`RightToolbar`, edit mode only) turns a tap into a tick: `cell/clearMany`,
`cell/copyMany` and `panel/deleteMany` are the bulk counterparts of `cell/clear`, `cell/copy` and
`panel/delete`. The planning is pure and unit-tested — `entities/cell/model/clearCells.ts`,
`copyCells.ts`, `entities/panel/model/deletePanels.ts` — and the singular reducer cases share
`copyCellInto` and `isConfiguredCell` with them so the two cannot drift.

**One action, never a loop of the singular one.** N dispatches mean N renders of the grid, N
persistence writes and N warm-up signature changes; worse, `panel/delete` re-picks `activePanelId`
on every step, so a mid-loop fallback can land on a panel the next step deletes.

**Selection lives in `AppShell` state, not in `appState`.** It is ephemeral UI: in the store it
would be serialized into the `.mumbox` payload and would flip `ProjectSession` to dirty for a tap
that changed nothing. Four invariants hold it together, and each exists because its absence is a
data bug rather than a cosmetic one:

- cell selection is dropped outright on `panel/select`, because cell ids repeat across panels and
  pruning would silently retarget the set at the new panel's cells;
- it is pruned against `activePanel.cellIds`, so a cue hidden by a grid shrink leaves the count
  rather than becoming a ghost `clearPanelCells` refuses anyway;
- leaving edit mode leaves selection mode, so destructive buttons are never armed over a live set;
- `clearSelectedCells` stops every selected cell BEFORE dispatching, and `deleteSelectedPanels`
  calls `stopAll` — `stopOthers` is off by default, so routes of a panel about to stop existing are
  normally still playing.

Two rules the pure planners carry: the FIRST panel is never deletable (so it has no checkbox, and
`planPanelDeletion` refuses it again), and a copy onto a panel with fewer free cells than sources
copies as many as fit and REPORTS the rest instead of refusing the batch — a partly filled target
is the common case, not an error.

An empty cell is not selectable at all (`isConfiguredCell`): it has nothing to clear and nothing to
copy, and ticking one would put a number in the confirmation that the bulk action then skips.

The per-tab delete cross is hidden while selection mode is on. It is absolutely positioned over the
tab corner and the checkbox widens the label, so on a phone the two overlapped once a few tabs stood
side by side.

### Audio engine

`WorkspaceGrid` renders each cell through a memoised `WorkspaceGridCell` that receives a
ref-backed `controller` — its identity must never change, or the memoisation buys nothing. This is
not a micro-optimisation: every warm-up state change used to re-render the whole grid, measured at
89 long tasks and 5.6 s of blocked main thread on a 12x12 panel against 287 ms for the same work on
a 6x6 one. That is what made the hover highlight stutter during warm-up. Derived visuals (label and
colours) are computed inside the cell, not in the parent's map, for the same reason.

`src/features/playback/model/useAudioEngine.ts` runs one `AudioRoute` per playing cell, keyed `${panelId}:${cellId}`:

- Primary path decodes to an `AudioBuffer` (cached per media id in a ref) and plays through `AudioBufferSourceNode`; the `startMediaElementFallback` path (`HTMLAudioElement` + `createMediaElementSource`) exists for browsers without `createBufferSource`.
- Each route has two gain nodes: `envelopeGain` (fade curves) and `volumeGain` (the per-cell offset
  alone), so volume changes never disturb a scheduled envelope. Master volume and mute live on ONE
  shared `masterGain` per context (`volume.ts` factors the product exactly, proven over the whole
  reachable lattice by `tests/unit/volume.spec.ts`), so a master change is one `setValueAtTime` on
  one node instead of a rewrite of every playing route on every frame. The media-element fallback
  keeps the combined form: it builds its own context and its own destination, which nothing on this
  context can reach.
- Async starts are guarded by a per-cell monotonic play token (`bumpCellToken`); check the token again after every `await` before touching a route.
- A single `requestAnimationFrame` loop drives progress, loop restarts for the media-element path, and volume sync; it stops itself when no routes remain.
- iOS: `getPlayableContext` closes and recreates a stuck `AudioContext`, and `pageshow`/`focus`/`visibilitychange` resume it.
- On mount and on panel change, buffers for the active panel's cells are pre-decoded by a debounced, serialized bounded pool (`warmedCells` drives the per-cell warm indicator), and the previous panel's buffers are dropped — see **Decoded-buffer memory**. A cell holding media that is not decoded yet is a third visual state — the cell colour dimmed 30 % — because otherwise there is no way to see which pads start instantly.

`audioEnvelope.ts` is shared fade/trim math. Reuse it rather than reimplementing curves — preview,
playback, and the planned export must sound identical.

**Envelope time base — the invariant that matters.** Every time value handed to `audioEnvelope.ts`
is a position within the ORIGINAL media file (source time), never a position inside a playback
buffer. `getEnvelopeValue` anchors the fade-in to `trimStartMs`, so passing buffer-relative time
silently pins the gain to 0 and the cue plays inaudibly with no error anywhere. Sliced buffers
compensate at `source.start(0, startSeconds - entry.sliceStartSeconds, ...)`, never by shifting what
the envelope is told.

`scheduleEnvelope` schedules no `setValueAtTime` at the curve's own start time: per spec the
`[startTime, startTime + duration]` interval is start-inclusive, so an event there makes
`setValueCurveAtTime` throw `InvalidStateError`. The curve point count scales with the shortest
enabled fade, because a uniform 256-point grid stretches a short fade over a long cue into a slow
ramp that starts early.

### Decoded-buffer memory

Decoded PCM is Float32: one second of 44.1 kHz stereo is 0.34 MiB, so a 15 MB MP3 becomes 220–330
MiB resident.

**There is no default budget, on any device, and that is deliberate.** A cap smaller than the
project turns every trigger into a cold decode, and this app is a soundboard: a pad that is not
instant is not a pad. The bound comes from housekeeping instead: deleted media releases its PCM, a
full track is not cached for a cell that plays twelve seconds of it, a looping fallback no longer
leaks a context per iteration — and, above all, **only the panel on screen is kept warm**.

`src/features/playback/model/audioBufferCache.ts` is a byte-budget LRU (not entry count);
`playbackBufferCache.ts` owns the singleton. A `null` budget means unlimited. The limit is opt-in,
for measuring a device: `?pcmBudgetMb=N` at load or `__mumboxDiag.setBudgetMb(n)` at runtime, with
a non-positive value clearing it. When a budget IS set, eviction is two-tier: never a pinned buffer
(one a live route is using), then non-priority by LRU, then the active panel by LRU. Plain LRU
would evict cell 1 first — the most likely next tap — because the warm-up fills in cell order.

**One panel warm at a time.** The panel effect drops every key outside the active panel, keeping
only what a live route still uses (playback survives a switch, and `stopOthers` is off by default).
Resident PCM is therefore one panel's worth however long the session wanders, which is what a phone
needs; the price, paid knowingly, is that returning to a panel is a cold warm-up. Keeping every
visited panel resident was better on a desktop with headroom and is what killed the tab on a phone,
where the library never fits.

Three things that rule forces, and none of them are optional:

- **The warm-up is debounced** (`WARMUP_DEBOUNCE_MS`, 150 ms). Without it, flicking through panels
  decodes a whole panel per click and throws it away on the next one — more transient memory than
  the accumulation the eviction replaces.
- **Warm-up runs are serialized** through a promise chain. `decodeAudioData` cannot be cancelled,
  so a superseded run keeps decoding; letting the next run start anyway stacks pools and multiplies
  exactly the transient allocation that gets a tab killed. The pool width is the ceiling on decodes
  in flight, and `playback-memory.spec.ts` sweeps the mock's timestamps to pin it.
- **A late decode does not repopulate the cache.** `warmMedia` re-checks its run id after the
  await and deletes the entry unless the panel now on screen wants that key or a live route holds
  it. The warm state is dropped with it — a cell left `ready` without a buffer promises an instant
  start the engine cannot deliver and suppresses its own re-warm.

The warm-up measures its budget against `stats().protectedBytes` — the active panel plus live
routes — never against everything cached; measuring against the total made the panel the user is
looking at refuse to warm in order to protect one they had left.

Cache keys are `${mediaId}|${trimStartMs ?? 0}|${trimEndMs ?? "e"}|${loop ? "l" : "o"}|${mono ? "m" : "s"}`, so the same
media with two different trims is two entries and one decode. Sharing that decode is reference
counted, not time based: the warm-up counts how many targets want each media up front, stages only
those wanted more than once, and releases the full buffer when the last one has been sliced.

The warm-up runs a bounded pool rather than one decode at a time — measured 3-6x faster wall clock.
Two things that pool forces: concurrency is deliberately small (two on a coarse-pointer device,
`cores - 2` capped at four elsewhere) because simultaneous decodes multiply the transient memory
that gets a tab killed; and when a budget is set, the estimated bytes must be RESERVED when a
worker takes a target, or every worker checks the budget before any has finished, all see it empty,
and the pool overshoots by its own width.

Anything that deletes or replaces media must go through `src/shared/lib/mediaCacheRegistry.ts`
(`purgeMediaCaches` / `clearMediaCaches`) — the decoded PCM, the waveform peaks, the decoded
durations and the media probes live in four different caches, and the IndexedDB blob is a fifth
store.

### Byte-range decoding (MP3 and WAV)

`decodeAudioData` has no partial-decode API, but a file does: `blob.slice(a, b)` on an
IndexedDB-backed blob reads only that range. Measured — 64 reads of 256 KiB out of a 60 MiB blob
took 98 ms against 59 ms for one full read, i.e. 39x less work than materialising the file per read.
So MP3 and WAV take a **fast path** that decodes only what a cell plays; every other container
(m4a, ogg, flac, opus, webm) keeps the full decode, byte for byte.

Everything decoded for playback now agrees on ONE sample rate — the live `AudioContext`'s
(`playback/model/playbackRate.ts`), commonly 48 000 on Android rather than the 44 100 three separate
call sites used to force. A buffer at another rate is resampled by the source node on the audio
thread for the whole cue, so a 48 kHz file was resampled down at decode and back up at playback.
**WAV is the exception, and deliberately so**: `decodeWavFrames` builds its buffer at the FILE's
rate because it invokes no decoder at all, which is exactly why that path is exempt from the
per-browser partial-decode verdict. Rather than resample there, a WAV whose rate differs from the
engine's falls through to the full decode, where the browser owns the quality
(`shouldUseNativeRateForWav`). `?rate=N` pins the rate: the perf tier uses it through `perfGoto` so
the committed `exact` byte gates stay machine-independent, and it is the on-device A/B and the
escape hatch, the same family of switch as `?partial=` and `?pcmBudgetMb=`.

TWO ORTHOGONAL GATES, and conflating them was the first draft's bug. `shouldReadRange` asks whether
the window is small enough relative to the file that reading only its bytes pays — the trimmed-cue
case, which a whole untrimmed track fails because its window IS the file. `shouldSegmentWindow`
asks whether the window's PCM is large enough that it must arrive in pieces — the whole-long-track
case, which a 2-second one-shot fails because 0.34 MiB is not worth a seam. A single gate on window
LENGTH excluded a 5-second window out of a 180-second file, the most profitable case there is.

**The time base is the invariant that matters.** Every position handed out is a position in the
original media *as the app understands it*, and the app's timeline is the FULL DECODE's, because
that is what the editor measured the trim against. A standalone mid-file MP3 slice is not on that
timeline: the full decode strips the encoder delay a LAME header declares, an isolated slice does
not. Measured at **2257 samples** on a real 192 kbps file — 1152 (one preamble frame) plus 1105
(LAME delay). Both terms are file-dependent, so the offset is MEASURED per media
(`partialVerify.ts`, during warm-up, two anchored decodes) and a mid-file MP3 window is REFUSED
until it is. Two comparison windows must agree, because a sustained tone matches at every multiple
of its period and one window cannot tell a period from a delay.

A frame range must start on a frame boundary and carry preamble for the bit reservoir
(`main_data_begin` reaches up to 511 bytes back). With that, a mid-file slice decoded
**bit-identically** to the same range of a full decode — peak correlation 1.000000, residual RMS 0.

Streaming shape: a head (0.5 s, cached, so a warm cell still starts instantly) plus segments on a
**progressively growing ladder** (4, 8, then 16 s). Progressive purely to cut seams — a fixed 4 s
chunk gives a 3-minute track about 45 of them, the ladder gives 13, at the same memory ceiling.
Every seam is a chance to click.

Things that ladder and that head force, none of them optional:

- **The head of a streamed route is scheduled with an EXPLICIT time**, not `start(0)`. Measured: a
  requested time in the future is honoured to the sample, while `start(0)` never reports which
  frame it landed on — and every handoff time is derived from that number, so guessing it skips
  audio at each seam. `SCHEDULE_LEAD_SECONDS` is one render quantum and only streamed routes pay
  it; a single-segment route keeps `start(0)` and its 0.5 ms baseline.
- **`scheduleEnvelope` therefore takes a `startTime`** (defaulting to `context.currentTime`), or the
  fades would run a quantum ahead of the sound. ONE curve covers the whole window on the shared
  gain, and no segment ever reschedules it: a second `setValueCurveAtTime` overlapping the first
  throws, its `setValueAtTime` fallback throws too inside a running curve, and the gain would be
  left pinned at full scale for the rest of the cue.
- **The handoff is `prev.stop(T)` and `next.start(T)` at the same absolute time**, which is
  sample-accurate on both sides. Each buffer carries a 60 ms margin of real audio past its nominal
  end so the outgoing segment always has samples up to T.
- **`stopRoute` clamps with `Math.min`.** Measured: a later `stop` EXTENDS an earlier one
  (`stop(0.3)` then `stop(0.6)` plays to 0.6), so a blind `stop(now + RELEASE)` on a segment already
  stopping at its handoff would overlap it with the next one.
- **`isLast` is explicit on the segment**, never inferred. An `onended` from the head means "the
  next segment's turn"; code treating any `onended` as "cue finished" restarts a loop at the seam.
- **Two levels of teardown.** `promoteToLast` ends a cue whose chain gave up, the whole chain runs
  inside one `try`, and the rAF watchdog is the second line of defence. The watchdog INCREMENTS
  `partial.segments.watchdog`, because a cue ending there rather than from its last segment sounds
  identical — without the counter a broken `isLast` would be silently covered up by its own safety
  net, which is exactly what survived a mutation round until the counter existed.
- **A cue that has been started is never dropped, and that is the pair of the rule above it.**
  `planMediaSegments` refuses to START a stream it cannot continue; `recoverRouteFromFullDecode`
  refuses to END one it has started. A segment whose range read fails is replaced by the tail of
  the FULL decode, scheduled at the handoff the outgoing segment is already stopping at, and the
  cue plays to its end with a dropout as long as the failure. It costs the whole file's PCM — the
  price every cue paid before byte-range decoding — and is paid only where the alternative is
  silence. `partial.segments.recovered` counts it, for the same reason `watchdog` is counted: a
  recovered cue sounds nearly right, so a range path that had stopped working would otherwise show
  up only as memory.
- **Lateness is measured against the SEGMENT'S OWN LENGTH, not a fixed 0.25 s.** A segment late by
  less than its length still has audio to play and is scheduled at its correct source position, so
  the hole equals the delay; one whose audio is entirely in the past is skipped, and only when it
  was the LAST segment does the cue end. The fixed limit meant the whole budget from the press was
  the head's 0.5 s plus a quarter second — routinely missed on a panel that is still warming, where
  the answer was a three-minute track audible for half a second.
- **One shared decode gate** (`decodeSemaphore.ts`), used by the warm-up pool AND every live chain
  — in TWO LANES. `stopOthers` is off by default, so six live pads would otherwise mean six
  unsynchronised decodes on top of the warm-up, and both lanes are bounded for that reason. They
  are separate because one FIFO queue starves the only work with a deadline: a warm-up decode is
  speculative and may be thrown away by the next panel switch, while a segment decode is due before
  the 0.5 s head runs out, and a decode can be neither cancelled nor preempted, so priority
  ordering alone would not have helped. The live lane is deliberately narrow (2) and carries only
  the press path and the segment chain; everything else must say nothing and get the background
  bound. The memory argument survives the split: a live decode is one rung of the ladder, at most
  16 s of stereo (5.6 MB), against the 105 MB whole-file decode that happens in the background
  lane.
- **`mono` and the window are captured into the chain at press time**, never re-read from a ref: a
  live route is immune to a mid-cue mono toggle because its cache key is pinned, and a chain
  re-reading the ref would feed a one-channel buffer to the same gain the two-channel head feeds.
- **The staging exclusion.** The warm-up stages a shared full decode for media several targets need;
  range-bound targets are excluded from that count, or the 220-330 MiB transient is paid anyway and
  then discarded.
- **Loops are excluded from streaming in v1.** A looping cue is heard over and over, so one full
  decode is the right price — and it avoids re-streaming the track every iteration. A loop still
  gets a plain range read of its window.

Segments are NEVER cached. The cached entry is the head, so `has(key)` still means "starts
instantly"; caching a reassembled window would put the whole track's PCM back in memory and do it
silently, because `protectedBytes` would then include it and the warm-up would start skipping the
panel on screen in order to protect it.

Not being cached is not the same as being released, and for a long time only the first was true.
A finished segment's `onended` disconnected its node but left the entry on the route, and an
`AudioBufferSourceNode` keeps its `buffer` reachable — so a cue held every segment it had ever
scheduled. `routeSegments.ts` is what enforces the release now: `dropSegment` on each non-last
`onended`, plus `pruneFinishedSegments` before every push, because `onended` is not delivered
reliably across an iOS audio interruption and that is exactly the session where a cue runs long
enough to matter. Measured on a 60 s window: **21 273 848 bytes held before, 5 468 400 after**.

The cache accounting could not have caught this and still cannot: `pcm.totalBytes` reports
`playbackBufferCache`, and a route's segments are not cache entries. `__mumboxDiag` therefore
reports `pcm.routeBytes` and `pcm.residentBytes` beside it, and `partial.segments.peakLive` as the
discrete high-water mark — sampled where segments are pushed and dropped, never where diagnostics
are read, because a counter sampled on read records when someone looked rather than what was held.

Four switches, because iOS Safari cannot be reached from CI at all (CoreAudio, not ffmpeg):
`?partial=0` / `?partial=1` per load; a verdict persisted per browser in `mumbox:partial-decode:v1`
(a sidecar, like `mumbox:project-session:v1` — outside `SerializableAppState` and outside the
`.mumbox` payload); a per-media flag in the probe cache; and structurally, `loadPlaybackEntry` calls
the partial path inside a `try` where any throw falls through to the full decode. **WAV is exempt
from the verdict entirely** — its path never invokes the browser's decoder, so there is nothing
about a device that could make `value / 32768` behave differently. Do not add device self-checks to
the WAV path.

Measured effect, panel of 12 whole 180 s stereo tracks: resident PCM **762 048 000 → 2 370 912
bytes** (321x), full decodes 12 → 0. `partial-off-12x180s` in `tests/perf/baseline.json` holds the
pre-change figures so the claim is auditable from one file.

### Diagnostics

`window.__mumboxDiag` is installed unconditionally; the overlay is gated behind `?diag=1` and lazy
loaded. Both ship to production on purpose — a deployed build is the only way to read these numbers
on a real iOS device. `?pcmBudgetMb=NNN` overrides the cache budget, and
`__mumboxDiag.termination()` reports whether the previous session ended without running its
`pagehide` handler, which is the only available signal for an OS kill. Memory accounting is analytic
(`length * numberOfChannels * 4`): `performance.memory` and `measureUserAgentSpecificMemory()` do
not see AudioBuffer PCM, and the latter needs cross-origin isolation that GitHub Pages cannot set.

### Project file format (`.mumbox`)

`src/features/file-config/index.ts` implements a **hand-rolled ZIP writer and reader** (stored entries only, no deflate, own CRC32) — there is deliberately no zip dependency. A project is `project.json` (manifest `{kind: "mumbox-project", version: 2, meta?, state, mediaBlobs}`) plus `media/<mediaId>` binaries. Import regenerates all media ids (`writeImportedProjectMedia`) and replaces the current layout and library. iOS Safari matches only MIME types for file inputs, hence the separate `PROJECT_FILE_ACCEPT_TYPES_MOBILE`.

**`version` stays 2 and must not be bumped.** `isProjectFile` compares it exactly, and the app is a
PWA with `registerType: "prompt"`, so a user can stay on an old build for weeks — a bump makes that
build refuse files the current one writes. New manifest fields go in as optional, which is what
`meta` (`{name?, description?, savedAt?}`) is. `normalizeProjectMeta` tolerates a missing or
malformed `meta` rather than failing the import.

Project name and description live **inside the file**, not only in the projects list. That is what
lets a re-picked file restore its own identity on Safari and iOS, where a file handle cannot be
stored at all.

### Projects list and project identity

`src/features/project-library` is a list of **bookmarks**, never a store: a row holds metadata plus,
where the browser can keep one, a `FileSystemFileHandle`. Project audio is never duplicated into
browser storage — that was the whole reason not to keep project snapshots.

- **The menu entry is desktop-only.** On a coarse pointer `AppShell` hides «Проекты» entirely: a
  phone browser keeps no file handles, so every row lands in the handle-less section where
  reopening means picking the file again. `projects.spec.ts` therefore runs on `desktop-chromium`
  only, and `app-shell.spec.ts` pins the absence of the entry on mobile.
- The list lives in its **own** IndexedDB database, `mumbox-projects`/`projects`. idb-keyval's
  `clear()` in `clearStoredAppData` only reaches the default store, so «Стереть все данные» clears
  the list through an explicit second call. `storage-contract.spec.ts` pins both.
- **A path cannot be shown.** No browser exposes one, File System Access included. Size, date, panel
  count and media count are what distinguish two same-named files.
- Row status is four-valued (`projectRowState.ts`): `ready`, `needsPermission` (the grant lapsed —
  the row stays usable and is *not* an error), `missing` (delete or re-link only) and `noHandle`
  (Safari/iOS/Firefox — its own section, no warning icon). `classifyFileError` must keep
  `NotFoundError` apart from `NotAllowedError`; conflating them marks a healthy project broken
  forever.
- Deleting a file from disk is Chromium 110+ only, detected per handle via `typeof handle.remove`.
  `getDeleteConfirmText` therefore has one wording per capability, and a unit test asserts the
  list-only text never claims a disk deletion. `readwrite` is requested lazily, at the click.
- `ProjectSession` (`src/app/model/projectSession.ts`) is project identity: name, description, file
  name, saved and dirty. It is deliberately **not** in `SerializableAppState` — the `.mumbox`
  payload and the stored layout stay byte-identical for an untouched project — and persists under
  its own key `session:v1` in the same `mumbox-app`/`state` database, never merged into the layout
  record. Dirty tracking wraps the reducer
  (`withDirtyTracking`) instead of touching any `case`; volume, mute, `stopOthers` and mono all
  count as edits because they are serialized into the file.
- Import deletes the outgoing blobs **after** the incoming ones are written and the state has been
  applied, and it verifies every media CRC before touching storage at all. It used to do the
  opposite, justified by a claim that `readProjectFile` had "already validated the whole zip" — it
  had not: the media blobs it returns are lazy `file.slice` views, so not one audio byte had been
  read. A source file that vanished, or a quota reached mid-write, therefore left the old audio
  deleted, the new audio half written, and the persisted state still naming the old ids: a full
  layout where nothing plays, with nothing to recover. The storage peak is `old + new` now, which is
  what `hasLikelyStorageForBytes` already required anyway — it compares against `quota - usage` with
  the old project still resident.
- `readProjectFile` validates STRUCTURE only, and that is a deliberate split: it is also called once
  per file by `addProjectsToLibrary` just to read a name and two counts for a bookmark row, so
  verifying content there would read every byte of every project the user adds. Content is checked
  by `verifyProjectMedia`, explicitly, on the paths that are about to overwrite something.
- The reader's acceptance rules live in `file-config/model/zipDirectory.ts` and
  `file-config/model/projectManifest.ts` rather than in `index.ts`, because that file imports
  `getMediaBlob` and therefore cannot be loaded by the unit tier at all. `checkZipWriteLimits`
  refuses an archive past 4 GiB instead of writing one whose uint32 offsets have silently wrapped;
  ZIP64 is deliberately not implemented, because a 4 GiB `.mumbox` is unusable on the paths that
  matter even when written correctly.

### Merging projects

`src/features/project-merge` appends one project's panels to another. Two rules carry the feature:
audio is deduplicated by SHA-256 of the bytes (`contentHash`, an optional `MediaAsset` field), and
**every incoming panel id is regenerated** — `sanitizeImportedState` keeps incoming ids, and a
collision would silently overwrite a panel's cells. Names are resolved with the same
`makeUniquePanelName` panel copy uses, against the accumulating list. Global settings always come
from the current project.

`isDuplicateMediaFile`'s name-and-size rule is still consulted, but only as a cheap NEGATIVE: it can
say "different", never "same". Allowing it to assert identity was a silent data-substitution bug and
the default path at that — the current project's assets only gain a hash as a side effect of saving,
so a project that had never been saved deduplicated entirely on file name and byte length, and two
different `bell.mp3` of equal length collapsed into one. `prepareMerge` now hashes BOTH sides
(through an injected `loadBlob`, so the module stays unit-testable), bucketed by size so only assets
that could possibly collide are hashed at all. A pair that cannot be decided is KEPT and counted in
`undecidedCount`, and the user is told that duplicates were not checked rather than shown a number
implying they were.

## Conventions that bite

- **UI language is Russian** and e2e tests select by Russian accessible names (`getByRole("button", { name: "Режим редактирования" })`). Renaming a label or `aria-label` breaks tests; grep `tests/e2e` before changing user-facing strings.
- ESLint runs `strictTypeChecked` + `stylisticTypeChecked`. Consequences seen throughout the code: `type` instead of `interface` (enforced), `String(n)` inside template literals, and `noUncheckedIndexedAccess` making every array/record index `| undefined`.
- The master volume slider carries its dragged value in local state (`dragVolume`) and also
  dispatches on `onChangeCommitted`. Rendering `masterVolume` directly made every frame of a touch
  drag depend on a dispatch-render round trip landing before the next `touchmove`, and anything
  that drops one leaves the thumb showing the old value — the gesture then ends with the slider
  back where it started. MUI also restates the vertical slider's 20 px side padding inside
  `@media (pointer: coarse)`, so `p: 0` must be repeated there or the hit area is clipped by the
  sidebar column on exactly the devices that need it.
- Mobile landscape (`@media (orientation: landscape) and (max-height: 430px)`) is a first-class layout, not an afterthought. `MobileLandscapeTextField` renders a portal overlay positioned from `visualViewport` because the on-screen keyboard covers inline inputs there. Height comes from the `--app-height` CSS variable (`100dvh` where supported), never `100vh`.
- Vite `base` is `/mumbox/` for GitHub Pages; PWA `registerType: "prompt"`, so the update banner is
  wired through `useRegisterSW` in `AppShell`.
- **The update reload is ours, not the plugin's** (`src/shared/lib/appUpdate.ts`).
  `updateServiceWorker(true)` ignores its argument: it only posts SKIP_WAITING, and the reload sits
  in a `controlling` listener that fires only when `event.isUpdate` is true — a flag workbox-window
  latches once, from `Boolean(navigator.serviceWorker.controller)` at registration time. A
  standalone iOS launch routinely starts uncontrolled, so the flag is false for the whole session
  and the tap did nothing visible until the user relaunched the app. `wb.messageSkipWaiting()` is
  the second silent failure: it no-ops when `registration.waiting` is null, which is what a
  `registration.update()` still installing leaves behind. So `applyServiceWorkerUpdate` messages the
  waiting worker directly and reloads on `controllerchange` **or** on a 2 s timer, whichever lands
  first — the timer is armed before the first `await`, because `update()` can hang on a dead
  network. The generated SW sets no `clientsClaim`, so an uncontrolled page is never claimed and the
  timer is the only thing that ends that case. The `visibilitychange` update check is throttled to a
  minute for the same reason: unthrottled it keeps a worker in `installing`, where there is no
  `waiting` to message. `__mumboxDiag.serviceWorker()` reports `controlled` / `waiting` /
  `updatePending`, which is the only way to see this on a real device.
- The diagnostics overlay is the one deliberate exception to the Russian-UI rule about accessible names: it carries Russian text but no `role` and no `aria-label`, so it cannot collide with the suite's `getByRole` queries. Select it by `data-testid`.
- `__debt/` holds design documents for features that are not implemented yet (currently MP3 export from the audio editor). Read the relevant file before starting such a feature.
- Dragging a media row from the cell picker onto a grid cell uses the custom MIME
  `application/x-mumbox-media` (`mediaDragTransfer.ts`), never `text/plain` — the cell drop handler
  reads `text/plain` as a source cell id. `dragover` decides "is this a media drag?" from the
  module-level registry in `mediaDragSession.ts`, because some browsers mask `dataTransfer.types`
  mid-drag and without a readable type nothing calls `preventDefault` and no `drop` ever fires.
- The picker stays open across drops **because the drop does not move `selectedCellId`**. The effect
  at `CellSettingsDrawer.tsx` closes the picker when the *selected* cell gains media, so dropping on
  another cell cannot close it and dropping on the selected cell opens that cell's settings. Do not
  "fix" this by adding state.
- On a coarse pointer the picker row is not `draggable`; the drag starts from a dedicated handle
  carrying `touch-action: none`. On the row it would kill both the vertical list scroll and the
  horizontal table scroll. `global.css` writes that rule at the same specificity as
  `[data-noselect] button:not([draggable="true"])` — otherwise that rule wins and the touch drag
  breaks silently, on real hardware only.
- New cells assigned in one gesture go through `cell/assignMany`, not a loop of `cell/assign`: one
  action, one validated state change, no half-applied layout.
- Commit messages follow Conventional Commits with a Russian subject: `feat(panel): добавить копирование панелей`.

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

### Test tiers

Three tiers, three Playwright configs — unit (`playwright.unit.config.ts`), e2e
(`playwright.config.ts`), perf (`playwright.perf.config.ts`). The constraints each one puts on
the code it can import, the shared helpers in `tests/support/`, the two audio mocks and the perf
baseline gate kinds are in `tests/CLAUDE.md`.

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

**The hot fields have their own record**, `ui:v1`: `activePanelId`, `masterVolume`, `masterMuted`,
`stopOthers`, `monoPlayback` — `DEFERRABLE_ACTIONS` minus `editMode`, which is not persisted at all.
A panel switch changes one string, and persisting it used to rewrite the whole serialized layout, so
cycling tabs pushed `navigator.storage.estimate()` up by roughly the project size per switch:
IndexedDB is LevelDB-backed, an overwrite appends, and the old value survives until compaction. The
number recovers on its own; the ~0.78 MiB of serialization and disk traffic per six changed bytes did
not. `createPersistence` decides which write to do by comparing `panels`, `cellsByPanel` and `media`
**by reference** against the last successful write — the reducer returns the same objects for every
action that does not touch them, so three pointer comparisons replace the `serializeState` walk they
exist to avoid — and skips the write entirely when the hot fields' JSON is unchanged too. A failed
write clears that memo, so the retry is always a full one. `BoardPage` seeds it with the state it
just READ (`PersistenceBaseline`), or null on a fresh project, where `state:v1` does not exist yet
and the first write has to create it.

Every FULL write still puts those five fields into `state:v1`, so the layout record stays complete
on its own; `readAppState` folds `ui:v1` over it. Anything that writes `state:v1` from outside this
module must DELETE `ui:v1` — both e2e seeders do, and so does the legacy migration — or a sidecar
from the project it replaces overrides the seeded active panel and volume.

`serializeState` (`src/app/model/serializeState.ts`) drops `editMode` **and every cell equal to
`makeCell(id)`**. That is what keeps a 20-panel 12x12 project from materialising 2880 cells; every
load path runs `ensurePanelCells`, which rebuilds them, so the omission is compatible in both
directions and `version` stays 2.

`mumbox:state:v1` and `mumbox:project-session:v1` are still **read** in localStorage, so a layout
written before the IndexedDB move is migrated on first boot and the old keys are left in place. They
are no longer written: the mirror was a one-release rollback net and cost a full `JSON.stringify`
plus a synchronous localStorage write on every persisted change — the same amplification `ui:v1`
exists to remove. Going back to a pre-IndexedDB build now finds whatever that build last wrote. Two
keys stay in localStorage on purpose: `mumbox:partial-decode:v1` (read synchronously on a hot path)
and `mumbox:diag:session:v1` (written from `pagehide`, where an async write would never land).

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

### Audio engine, decoded-buffer memory, byte-range decoding

One `AudioRoute` per playing cell, a byte-budget LRU over decoded PCM with only the active panel
kept warm, and a partial-decode fast path for MP3 and WAV. The invariants that carry all three —
the envelope time base, the warm-up serialization, the segment ladder and its handoff — are in
`src/features/playback/CLAUDE.md`. Read it before touching playback.

### Diagnostics

`window.__mumboxDiag` is installed unconditionally; the overlay is gated behind `?diag=1` and lazy
loaded. Both ship to production on purpose — a deployed build is the only way to read these numbers
on a real iOS device. `?pcmBudgetMb=NNN` overrides the cache budget in both directions — there is a default budget on a
coarse pointer now, and `?pcmBudgetMb=0` clears it — and
`__mumboxDiag.termination()` reports whether the previous session ended without running its
`pagehide` handler, which is the only available signal for an OS kill. Memory accounting is analytic
(`length * numberOfChannels * 4`): `performance.memory` and `measureUserAgentSpecificMemory()` do
not see AudioBuffer PCM, and the latter needs cross-origin isolation that GitHub Pages cannot set.

### Project files, the projects list, and merging

The `.mumbox` format (hand-rolled ZIP, manifest `version` pinned at 2) is documented in
`src/features/file-config/CLAUDE.md`; the bookmark-only projects list and `ProjectSession`
identity in `src/features/project-library/CLAUDE.md`; content-hash deduplication and panel-id
regeneration on merge in `src/features/project-merge/CLAUDE.md`.

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

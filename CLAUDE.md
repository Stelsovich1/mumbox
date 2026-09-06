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
`seedProject.ts` (seeds IndexedDB blobs plus the localStorage layout in one navigation),
`audioMock.ts` (the opt-in Web Audio mock that exercises the buffer route), `diag.ts` (typed access
to `window.__mumboxDiag`).

Two mocks exist on purpose. `installAudioMock` in `app-shell.spec.ts` defines no
`createBufferSource`, so everything using it drives `startMediaElementFallback`.
`installBufferAudioMock` in `tests/support/audioMock.ts` drives `startBufferRoute` — the path every
real browser takes — and gives the audio clock to the test (`advanceAudioClock`), because a loop
restart on a wall-clock timer either makes tests ten seconds slow or recurses synchronously inside
`onended`.

`tests/perf/baseline.json` is committed so a performance regression shows up as a reviewable diff.
Record a new one with `PERF_UPDATE_BASELINE=1 npm run test:perf`. Time to first sound is gated on an
**absolute** ceiling, not a ratio: the constraint is perceptual, and against a sub-millisecond
baseline a ratio gate cries wolf. Everything else is a soft gate that fails only when a 30 % ratio
**and** an absolute floor are both exceeded.

`tests/MUTATION-PROTOCOL.md` describes the manual mutation-testing round used to find holes in these
tests. There is no mutation framework and none may be added.

## Architecture

Feature-Sliced Design: `app` → `pages` → `widgets` → `features` → `entities` → `shared`. Imports go downward only; each slice exposes a barrel `index.ts`.

`AppShell` (`src/widgets/app-shell/ui/AppShell.tsx`) is the single orchestrator — it owns the store, the audio engine, all dialogs, file inputs, global hotkey listeners, and the PWA update prompt. Everything below it is presentational or self-contained.

### State and persistence — two separate stores

`src/app/model/appState.ts` holds a `useReducer` store (`useAppStore`) that is the single source of truth for panels, cells, media metadata, and volume. It is serialized to **localStorage** under `mumbox:state:v1` on every state change (`serializeState` drops `editMode`).

Audio blobs never enter that JSON. They live in **IndexedDB** via `idb-keyval` under `mumbox:media:<mediaId>` (`saveImportedMedia` / `getMediaBlob` / `deleteStoredMedia`). `MediaAsset` in state only carries metadata. Any code that adds or removes media must keep both stores in sync.

### Cell identity and grid resizing

Cell IDs are position-stable: `cell-${row * 12 + column}` (`getPanelCellIds`), so a cell keeps its coordinates when the grid grows or shrinks between 6/8/10/12. Older saves used flat `cell-${index}`; `normalizePanelCellIds` and `remapLegacyCells` migrate those on load and on project import. Do not change this scheme without keeping both migration paths working — e2e tests cover resize round-trips.

Several reducer actions (`panel/add`, `panel/copy`, `panel/rename`, `panel/delete`) intentionally no-op unless `state.editMode` is true.

### Audio engine

`WorkspaceGrid` renders each cell through a memoised `WorkspaceGridCell` that receives a
ref-backed `controller` — its identity must never change, or the memoisation buys nothing. This is
not a micro-optimisation: every warm-up state change used to re-render the whole grid, measured at
89 long tasks and 5.6 s of blocked main thread on a 12x12 panel against 287 ms for the same work on
a 6x6 one. That is what made the hover highlight stutter during warm-up. Derived visuals (label and
colours) are computed inside the cell, not in the parent's map, for the same reason.

`src/features/playback/model/useAudioEngine.ts` runs one `AudioRoute` per playing cell, keyed `${panelId}:${cellId}`:

- Primary path decodes to an `AudioBuffer` (cached per media id in a ref) and plays through `AudioBufferSourceNode`; the `startMediaElementFallback` path (`HTMLAudioElement` + `createMediaElementSource`) exists for browsers without `createBufferSource`.
- Each route has two gain nodes: `envelopeGain` (fade curves) and `volumeGain` (master × per-cell offset), so volume changes never disturb a scheduled envelope.
- Async starts are guarded by a per-cell monotonic play token (`bumpCellToken`); check the token again after every `await` before touching a route.
- A single `requestAnimationFrame` loop drives progress, loop restarts for the media-element path, and volume sync; it stops itself when no routes remain.
- iOS: `getPlayableContext` closes and recreates a stuck `AudioContext`, and `pageshow`/`focus`/`visibilitychange` resume it.
- On mount and on panel change, buffers for the active panel's cells are pre-decoded by a bounded pool (`warmedCells` drives the per-cell warm indicator). A cell holding media that is not decoded yet is a third visual state — the cell colour dimmed 30 % — because otherwise there is no way to see which pads start instantly.

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
instant is not a pad. What made memory grow without bound was never the absence of a cap but the
absence of housekeeping — deleted media kept its PCM, revisited panels accumulated, a looping
fallback leaked a context per iteration, and a full track was cached for a cell that plays twelve
seconds of it. With those fixed the footprint is what the project needs, not everything it ever
touched.

`src/features/playback/model/audioBufferCache.ts` is a byte-budget LRU (not entry count);
`playbackBufferCache.ts` owns the singleton. A `null` budget means unlimited. The limit is opt-in,
for measuring a device: `?pcmBudgetMb=N` at load or `__mumboxDiag.setBudgetMb(n)` at runtime, with
a non-positive value clearing it. When a budget IS set, eviction is two-tier: never a pinned buffer
(one a live route is using), then non-priority by LRU, then the active panel by LRU. Plain LRU
would evict cell 1 first — the most likely next tap — because the warm-up fills in cell order.

Two rules that took a wrong turn to find. Panels are never evicted on a switch, only under real
pressure: dropping a panel while the library still fits buys nothing and costs a decode on return.
And the warm-up measures its budget against `stats().protectedBytes` — the active panel plus live
routes — never against everything cached, because other panels are evictable; measuring against the
total made the panel the user is looking at refuse to warm in order to protect one they had left.
What the panel effect does collect is genuine garbage: a key no visited panel references any more,
which is what a trim or channel-mode change leaves behind.

Cache keys are `${mediaId}|${trimStartMs ?? 0}|${trimEndMs ?? "e"}|${mono ? "m" : "s"}`, so the same
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
(`purgeMediaCaches` / `clearMediaCaches`) — the decoded PCM, the waveform peaks and the decoded
durations live in three different caches, and the IndexedDB blob is a fourth store.

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
  payload and `mumbox:state:v1` stay byte-identical for an untouched project — and persists in the
  sidecar key `mumbox:project-session:v1`. Dirty tracking wraps the reducer
  (`withDirtyTracking`) instead of touching any `case`; volume, mute, `stopOthers` and mono all
  count as edits because they are serialized into the file.
- Import deletes the outgoing blobs **before** writing the incoming ones, so the storage peak is
  `max(old, new)` rather than their sum. `readProjectFile` has already validated the whole zip by
  then, so a corrupt file destroys nothing.

### Merging projects

`src/features/project-merge` appends one project's panels to another. Two rules carry the feature:
audio is deduplicated by SHA-256 of the bytes (`contentHash`, an optional `MediaAsset` field, with
`isDuplicateMediaFile`'s name+size rule as the fallback for projects saved before it existed), and
**every incoming panel id is regenerated** — `sanitizeImportedState` keeps incoming ids, and a
collision would silently overwrite a panel's cells. Names are resolved with the same
`makeUniquePanelName` panel copy uses, against the accumulating list. Global settings always come
from the current project.

## Conventions that bite

- **UI language is Russian** and e2e tests select by Russian accessible names (`getByRole("button", { name: "Режим редактирования" })`). Renaming a label or `aria-label` breaks tests; grep `tests/e2e` before changing user-facing strings.
- ESLint runs `strictTypeChecked` + `stylisticTypeChecked`. Consequences seen throughout the code: `type` instead of `interface` (enforced), `String(n)` inside template literals, and `noUncheckedIndexedAccess` making every array/record index `| undefined`.
- Mobile landscape (`@media (orientation: landscape) and (max-height: 430px)`) is a first-class layout, not an afterthought. `MobileLandscapeTextField` renders a portal overlay positioned from `visualViewport` because the on-screen keyboard covers inline inputs there. Height comes from the `--app-height` CSS variable (`100dvh` where supported), never `100vh`.
- Vite `base` is `/mumbox/` for GitHub Pages; PWA `registerType: "prompt"`, so the update banner is wired through `useRegisterSW` in `AppShell`.
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

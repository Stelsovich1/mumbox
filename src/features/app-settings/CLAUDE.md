# App settings

Per-DEVICE settings: the knobs that used to exist only as query flags or `__mumboxDiag` calls.
Five sections — производительность, визуализация, хранилище, диагностика, сброс.

## What is deliberately NOT here

`stopOthers`, master volume, edit mode and grid size are one tap away on the workspace and live in
`appState`, where they belong: they are properties of the PROJECT and travel with it. Duplicating
them here would create a second source of truth for values the user changes mid-show.

`monoPlayback` is the one that looks like a device setting and is not: `setMono` dispatches
`mono/set` into the project state, the flag is serialized into the `.mumbox` payload, and it is part
of every playback cache key. Moving it here would split that.

## Where the record lives

`settings:v1` in `mumbox-app`/`state`, beside `state:v1`, `ui:v1` and `session:v1`
(`app/model/appStateStorage.ts`). NOT localStorage: the root `CLAUDE.md` keeps that storage for the
two records that genuinely cannot be asynchronous, and nothing reads settings before the boot gate.

The draft version of this plan put them in localStorage on the argument that
`playbackBufferCache` reads its budget at module import and therefore needs a synchronous read. That
argument is void: the budget is applied through the existing `setBudgetBytes` sink after boot, so
the import-time value only has to be the device default.

`clearAppStateStorage` deletes it too. Someone reaching for «Стереть все данные» is usually escaping
a state they cannot explain, and the setting that produced it must not survive. That button lives in
the «Сброс» section, beside the settings reset and clearly separated from it: the two are one click
apart, so the difference between "forget my preferences" and "delete my project" is spelled out
rather than implied.

The e2e/perf seeders delete it for the same reason they delete `ui:v1`. A leaked `on-press` warm-up
mode is invisible and fatal to the suites: every wait for `[data-warm-state="ready"]` across a panel
would time out and the perf tier's `exact` decode-count gates would fail with no hint why.

## Reading order at boot

**The settings must not be read before the layout.** Both records share a database, and idb-keyval
memoises the open only once it SUCCEEDS — a failed one leaves nothing cached, so whichever read goes
first is the one that meets a broken handle. The layout read has to be that one: it is the read
whose failure suspends writing, and a settings read taking the failure for it would leave
`readAppState` succeeding and that rule unarmed. `storage-contract.spec.ts` ("a failed read really
does leave the stored project on disk") fails exactly that way if the order is swapped, because its
fault injection breaks the FIRST open only.

The settings read is also bounded by a timer (`SETTINGS_READ_BUDGET_MS`). The boot gate renders
nothing while it waits, so a database that opens but never answers would otherwise leave a blank
page in front of a real project — a preference is not allowed to be able to do that. On timeout the
defaults are applied and the app starts.

Settings are applied before `AppShell` mounts, so the engine does not start a warm-up in the default
mode and get restarted by the saved one a frame later.

## Query flags still win

`?pcmBudgetMb=`, `?partial=` and `?rate=` are the instruments every memory measurement in this repo
is taken with, so a saved setting must not beat them — and the plumbing runs the other way by
default: `setPartialDecodeMode` is consulted BEFORE the query flag by `getPartialDecodeMode`, and
`setBudgetBytes` writes to the cache with nothing left of `readBudgetOverride` to consult.
`applyPlaybackSettings` therefore checks `readBudgetOverride().present` and `hasPartialQueryFlag()`
and stands down, and the dialog disables the control with «переопределено флагом» rather than
letting it look broken.

`partialDecode` offers only `auto` and `off`. The engine's third mode, `force`, returns "allowed"
before the per-browser verdict is consulted — as `?partial=1` that is a one-load debugging switch,
as a saved setting it would permanently disable the only guard against a browser that cannot decode
byte ranges at all.

There is no "reset the browser verdict" button: `resetPartialDecodePolicy()` clears the whole record
including `hardBlocked`, which is a statement about what the browser CAN do and liftable by nothing.
The verdict itself is derived from the tally on every write and never latches, so there is nothing
stuck to unstick. The counters are shown in the diagnostics section instead.

## Warm-up settings need an effect dependency, not just a read

Everything the warm-up does is inside an effect keyed on `warmupSignature` — the cache keys the
panel wants. A mode switch does not change those keys, so reading the mode at run time would mean
the new mode takes effect at the next panel change and, on a single-panel project, never. The
settings object is therefore in the effect's dependency array, and `setAppSettings` keeps identity
stable for an unchanged value so a save that changes nothing does not restart a warm-up.

Clearing the decoded caches deliberately does NOT restart the warm-up. That button is a request to
give memory back, and re-decoding on the spot would return an unchanged number and a busy machine.
The purge drops the warm state with the buffers, so the cells go honestly cold and warm again on the
next panel switch or press. The neighbouring rule — a decode already in flight when the purge
happens must not repopulate the cache — is pinned by `playback-memory.spec.ts`; the "does not
restart" half has no test of its own, and the first draft of this change broke that spec by adding
the restart.

The button spares the media PROBE cache (`clearMediaCaches({ except: ["media-probes"] })`). That
cache is tens of kilobytes, so it is not the memory being reclaimed, and it holds the measured
decoder offset and the per-media "off the byte-range path" flag: dropping it makes every file verify
again, and repeated failures feed the ratio behind the per-browser verdict. Pressing the button a
few times on a project with one bad file could take byte-range decoding off the whole profile — and
cost far more memory than the button gave back.

## The storage section reports orphans, it does not delete them

A `mumbox:media:*` key with no matching entry in `state.media` is NORMAL in at least six windows:
audio import writes blobs before `media/addMany`, project import writes the whole archive before
`state/import`, a failed persist barrier leaves the OUTGOING blobs in place on purpose,
`deleteMediaFromLibrary` dispatches before it deletes and keeps the blobs when the barrier fails,
and both the single-file and merge write paths roll back partially. In the failed-barrier case the
state ON DISK still names those blobs while the state in memory does not — so deleting "orphans"
there destroys exactly what the barrier exists to protect. The count is worth showing; the button is
not worth having.

`navigator.storage.estimate()` is called directly rather than through `shared/lib/storage`'s
`estimateStorage`, which also calls `persist()` and can raise a permission prompt. Asking for
persistent storage has its own button.

## Unused media is scanned over `cellsByPanel`, not over `panel.cellIds`

Shrinking a grid hides cells rather than clearing them, so a cue placed at 12x12 still exists while
a 6x6 grid is on screen. A scan driven by the visible lattice would report its media as unused and
offer to delete it — the one place in this feature where a wrong answer destroys data instead of
looking wrong. `entities/media/model/unusedMedia.ts` walks the whole record; `app-settings.spec.ts`
shrinks a grid and checks the count.

Deletion goes through `AppShell`'s existing `deleteMediaFromLibrary`, which already stops playback,
dispatches, purges the caches, waits on the persist barrier and only then removes the blobs.

## Names, because the suite selects by them

The e2e suite matches accessible names as SUBSTRINGS unless a test passes `exact`, and the collision
runs in both directions: a new name can break an existing bare locator, and an existing name can
answer a new one.

- The two footer buttons are «Применить» and «Закрыть», and both are short enough to be substrings
  of names elsewhere — so every locator for them passes `exact: true`. «Сохранить» was avoided
  outright: it is used bare in `app-shell.spec.ts`, and «Сохранить настройки» would also have
  matched the existing «Сохранить настройки ячейки».
- The title bar's cross is «Закрыть настройки», which `exact: true` on «Закрыть» does not match —
  and which is itself a substring of `CellSettingsDrawer`'s «Закрыть настройки ячейки», so it is
  never selected without `exact` either.
- «Сбросить» is used bare in `app-shell.spec.ts` — hence «Сбросить настройки» and «Вернуть настройки
  приложения к умолчанию».
- «Стереть все данные» moved here from the «Проект» menu. Six specs opened it through that menu;
  they go through `tests/support/eraseAllData.ts` now, so the next move costs one edit.

Sections are reached by `data-testid`, never by their title.

The dialog is rendered only while open. `MediaLibraryDialog` next door is mounted unconditionally
and runs its whole body on every shell render; this one computes a storage summary and scans the
project for unused media, so it must not repeat that.

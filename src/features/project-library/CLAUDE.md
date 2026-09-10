# Projects list and project identity

## Projects list and project identity

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
  applied, and it verifies every media CRC on the SAME read that produces the bytes to store — one
  entry at a time, so a checksum failure still throws before that entry reaches storage. See
  `file-config/CLAUDE.md`: a separate verification pass read the whole source file a second time,
  the second read landing inside `set()`. It used to do the
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


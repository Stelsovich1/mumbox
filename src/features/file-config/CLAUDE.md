# Project file format (`.mumbox`)

## Project file format (`.mumbox`)

`src/features/file-config/index.ts` implements a **hand-rolled ZIP writer and reader** (stored entries only, no deflate, own CRC32) — there is deliberately no zip dependency. A project is `project.json` (manifest `{kind: "mumbox-project", version: 2, meta?, state, mediaBlobs}`) plus `media/<mediaId>` binaries. Import regenerates all media ids (`writeImportedProjectMedia`) and replaces the current layout and library. iOS Safari matches only MIME types for file inputs, hence the separate `PROJECT_FILE_ACCEPT_TYPES_MOBILE`.

**`version` stays 2 and must not be bumped.** `isProjectFile` compares it exactly, and the app is a
PWA with `registerType: "prompt"`, so a user can stay on an old build for weeks — a bump makes that
build refuse files the current one writes. New manifest fields go in as optional, which is what
`meta` (`{name?, description?, savedAt?}`) is. `normalizeProjectMeta` tolerates a missing or
malformed `meta` rather than failing the import.

Project name and description live **inside the file**, not only in the projects list. That is what
lets a re-picked file restore its own identity on Safari and iOS, where a file handle cannot be
stored at all.


## Verifying media on the write's own read

The reader's media entries are lazy `File.slice` views: `readZipProjectFile` reads only the
directory, the local headers and `project.json`, so after it returns not one audio byte has been
read. That is what keeps the peak at a slice instead of the 2 GB a whole-project `arrayBuffer()`
plus a copy per entry used to cost — and it is also why "verify everything, then write everything"
read the source file TWICE. The second read is the expensive one and the invisible one: it happens
inside `set()`, where IndexedDB pulls the bytes out of the picked file itself, and on Android that
file is routinely behind a content provider.

So the import and merge paths interleave. `readVerifiedMediaBlob` reads ONE entry in 4 MiB chunks,
folds its CRC and returns a memory-backed `Blob` of those same bytes; the writers take it through
the injected `MediaWritePrepare` seam, because `file-config` already imports `app/model/appState`
and the dependency may only run one way. Peak memory is one media file, the write is a copy from
RAM, and a checksum failure still throws before anything is stored — the writer's rollback removes
what it had written, and the outgoing audio is untouched because that deletion waits for the persist
barrier.

The CRC itself folds in a worker (`crc32Folder.ts`, `crc32.worker.ts`). `updateCrc32` is a
byte-at-a-time table loop at about 240 MB/s on a warm desktop JIT and a fraction of that on a
phone, so on a large project it is tens of seconds during which the progress label cannot even
repaint. Chunks are CLONED into the worker rather than transferred: transferring detaches the
caller's view, and if the worker then dies the bytes are gone and the fold cannot fall back to this
thread. A 4 MiB copy is about a millisecond against tens for the fold it replaces. The export folds
over every byte it writes too, so `makeProjectBlob` uses the same worker.

`verifyProjectMedia` remains for a caller that wants an archive checked without storing it. Neither
the import nor the merge uses it — they would read every byte twice again.

A merge verifies only the media it actually STORES. A discarded duplicate contributes no bytes to
storage, and deduplication has already compared it by SHA-256, which a corrupt copy would fail.

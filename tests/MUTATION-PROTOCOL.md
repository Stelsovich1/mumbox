# Mutation testing protocol

No mutation framework is installed and none may be added. This is a manual protocol: introduce one
small behaviour-changing edit at a time, run the suites, and record whether they noticed. A
mutation the suites do not notice is a **surviving mutant** — a hole in the tests, not a bug in the
code.

## Scope

In scope (logic that is unit- or probe-testable):

| File | Functions |
| --- | --- |
| `src/features/playback/model/audioEnvelope.ts` | all |
| `src/features/playback/model/audioBufferCache.ts` | all |
| `src/features/playback/model/decodeAudio.ts` | `shouldSliceBuffer`, `sliceAudioBuffer` |
| `src/features/playback/model/mp3FrameIndex.ts` | all |
| `src/features/playback/model/wavPartial.ts` | all |
| `src/features/playback/model/mediaFormat.ts` | all |
| `src/features/playback/model/partialPlan.ts` | all |
| `src/features/playback/model/pcmAlign.ts` | all |
| `src/features/playback/model/mediaProbeCache.ts` | all |
| `src/features/playback/model/decodeSemaphore.ts` | `createSemaphore` |
| `src/features/playback/model/partialSource.ts` | `planMediaSegments`, `decodeWavRange`, `decodeMp3Range`, `verifyConstantFrameBytes`, `ensureScannedTo`, `ensureMp3Alignment` |
| `src/features/playback/model/partialVerify.ts` | `verifyMp3Alignment` |
| `src/shared/lib/partialDecodePolicy.ts` | all |
| `src/features/audio-editor/model/waveformCache.ts` | all |
| `src/shared/lib/mediaCacheRegistry.ts` | all |
| `src/shared/lib/diagnostics.ts` | `recordDecode`, `recordTimeToFirstSound`, `getBudgetOverrideFromQuery` |
| `src/features/playback/model/useAudioEngine.ts` | `getHtmlAudioVolume`, `needsAlignmentMeasurement`, `getClampedPlaybackRange`, `getTrimmedDurationMs`, `getEnvelopeSignature`, `arePlayingCellsEqual`, `setRouteVolume`, `stopRoute`, `startBufferRoute` including its `entry.partial` branch, the `playCell` token guards, the rAF `tick` including the streamed-route watchdog, the warm-up and panel-eviction effects, `isPartialPathLikely`, `tryDecodeRange`, `runSegmentChain`, `promoteToLast` |
| `src/app/model/appState.ts` | the `media/deleteMany` case, the `cell/assignMany` case, `remapImportedState`, `writeMergedProjectMedia` |
| `src/entities/panel/model/panelCells.ts` | `getPanelCellIds`, `normalizePanelCellIds`, `remapLegacyCells`, `ensurePanelCells` |
| `src/entities/panel/model/panelName.ts` | all |
| `src/entities/media/model/normalizeMedia.ts` | all |
| `src/entities/media/model/mediaSort.ts` | all |
| `src/entities/media/model/mediaDeletion.ts` | all |
| `src/entities/cell/model/cellUsage.ts` | all |
| `src/shared/lib/rowSelection.ts` | all |
| `src/shared/lib/tableSort.ts` | all |
| `src/shared/lib/formatDate.ts` | all |
| `src/shared/lib/pluralizeRu.ts` | all |
| `src/shared/lib/mediaDistribution.ts` | all |
| `src/shared/lib/mediaDragTransfer.ts` | all |
| `src/shared/lib/contentHash.ts` | `toHex` |
| `src/app/model/projectSession.ts` | all |
| `src/features/file-config/model/projectMeta.ts` | all |
| `src/features/project-library/model/projectRowState.ts` | all |
| `src/features/project-merge/model/mediaDedup.ts` | all |
| `src/features/project-merge/model/mergeProjects.ts` | all |
| `src/features/project-merge/model/runMerge.ts` | `prepareMerge`, `selectMediaToHash` |
| `src/features/file-config/model/zipDirectory.ts` | all |
| `src/features/file-config/model/projectManifest.ts` | all |
| `src/features/file-config/model/projectFileError.ts` | `classifyProjectFileError` |
| `src/features/playback/model/routeSegments.ts` | all |
| `src/features/playback/model/volume.ts` | all |
| `src/features/playback/model/playbackRate.ts` | all |
| `src/features/playback/model/mediaProbeCache.ts` | `createMediaProbeCache`, `indexBytesOf` |
| `src/features/playback/model/mp3FrameIndex.ts` | `getIndexedDurationSeconds` (plus the existing entries) |
| `src/features/playback/model/pcmAlign.ts` | `findAlignmentOffset`, `residualWithinTolerance` (plus the existing entries) |
| `src/app/model/serializeState.ts` | all |
| `src/shared/lib/cellVisuals.ts` | all |

Out of scope: every `.tsx`, the hand-rolled ZIP writer and reader in
`src/features/file-config/index.ts` (its pure `model/` modules ARE in scope), anything reachable
only through a Russian UI string, and the whole `tests/perf` tier (too slow and too noisy for a
binary verdict).

The `index.ts` exclusion is a consequence of the I/O boundary, not a preference: that file imports
`getMediaBlob`, which reaches `react` and `idb-keyval`, so the unit tier cannot load it at all and a
mutant there could only die by accident. Draw the line at "no I/O, no DOM, no runtime import of app
state" — anything on the pure side of it belongs in the table above.

## Mutation classes

1. **Boundary flip** — `remainingSeconds <= ENVELOPE_MIN_CURVE_SECONDS` → `<`;
   `playDurationSeconds <= 0.001` → `<`; `Math.abs(...) < 0.001` in `setRouteVolume` → `<=`;
   `entries.size > entryLimit` → `>=`; `settings.fadeInMs > 0` → `>= 0`;
   `sliceBytes < fullBytes * MIN_SLICE_RATIO` → `<=`.
2. **Guard removal** — delete a play-token guard in `startBufferRoute` / `playCell`; delete the
   route-identity guard in the `onended` handlers; delete `if (!state.editMode) return state;` from
   a panel action.
3. **Constant change** — `ENVELOPE_CURVE_POINTS` 256 → 128; `RELEASE_SECONDS` → 0;
   `PROGRESS_EPSILON` → 0.1; the 70 ms warm-up gap → 0; `MIN_SLICE_SAVING_BYTES` → 0;
   `WARMUP_BUDGET_RATIO` → 10; `DECODE_HISTORY_LIMIT` → 4096.
4. **Early-return insertion** — `return;` right after `setValueAtTime` in `scheduleEnvelope`; at the
   top of `setRouteVolume`; at the top of the deferred body inside `stopRoute`.
5. **Off-by-one** — `index / Math.max(1, pointCount - 1)` → `/ pointCount`;
   `Math.floor(index / gridSize)` → `Math.round`.
6. **Dropped invalidation or sync** — remove `routeByCellRef.current.delete(cellKey)` from
   `stopCellKey`; remove `playbackBufferCache.set(...)`; remove the LRU touch (`entries.delete` then
   `entries.set`) inside the cache's `get`; remove `bumpCellToken` from `playCell`; remove
   `purgeMediaCaches([mediaId])` from `deleteMediaFromLibrary`; remove `setPinned` from the
   route-pinning effect.
7. **Operator or argument swap** — `Math.min` ↔ `Math.max` in `getEnvelopeValue` and
   `getClampedPlaybackRange`; swap `startSeconds`/`endSeconds` at a `scheduleEnvelope` call site;
   `masterVolume / 100` → `/ 1000`.
8. **Negation** — `if (!blob)` → `if (blob)`; swap the operands of
   `masterMuted ? 0 : getEffectiveVolume(...)`.

## Verification — all four commands, for every mutant

```
npx tsc -p tsconfig.app.json --noEmit
npx tsc -p tsconfig.node.json --noEmit
npm run test:unit
npx playwright test --project=desktop-chromium --reporter=line
```

Only `desktop-chromium` is run: `mobile-landscape` doubles the cost and covers layout, not this
logic. A mutation that fails typecheck is `INVALID`, not a mutant — discard it, do not report it as
survived.

## Revert protocol — non-negotiable, and every step leaves evidence

The working tree is **not** clean and **nothing in this change is committed**, so `git restore`
would revert the entire feature, not the mutation. Use file copies and checksums instead.

1. Before starting, record `git rev-parse HEAD` and `git status --porcelain`. Both must match at the
   end.
2. For each mutant, before editing:
   `cp <path> <path>.mutation-backup` and record `sha256sum <path>`.
3. Apply exactly **one** mutation to exactly **one** file.
4. Record `diff -u <path>.mutation-backup <path>` — this is the proof of what was actually mutated.
   A mutant reported without this diff is discarded.
5. Run all four commands. Keep the final summary line of each.
6. Revert: `cp <path>.mutation-backup <path>` then `rm <path>.mutation-backup`.
7. Prove the revert: `sha256sum <path>` must equal the value from step 2. Record both.
8. Never use `git restore`, `git checkout`, `git stash`, or `git commit` at any point.
9. Hard stop after 16 mutants, or immediately if a command fails for a reason other than a test
   assertion (a compile error in unmutated code, a port conflict, a browser launch failure).

## Report format

One line per mutant:

```
MUTANT | <repo-relative path>:<line> | <class> | ORIG: <original line, trimmed> | MUT: <mutated line, trimmed> | <VERDICT> | <evidence>
```

`VERDICT` is exactly one of:

- `KILLED:<tier>:<first failing test title>` — evidence must quote the literal failing assertion line.
- `SURVIVED` — evidence must quote the literal final summary line of **all four** commands, each
  showing zero failures.
- `INVALID:<tsc error code>` — evidence must quote the tsc error.
- `EQUIVALENT` — a semantic no-op, with a one-sentence argument.
- `UNVERIFIED` — a command was not run. Never report `SURVIVED` in this case.

Then exactly one final line:

```
SUMMARY | total=<n> killed=<n> survived=<n> invalid=<n> equivalent=<n> | startSha=<sha> endSha=<sha> | statusMatches=<yes|no>
```

## Anti-fabrication rules

- `SURVIVED` is valid **only** with the literal tail of all four commands quoted, each with its own
  pass/fail count. Paraphrase ("all green", "suite passed") is grounds for discarding the line.
- `KILLED` must quote the exact failing test title **and** the assertion line.
- Every mutant must carry its `diff -u` output and its before/after checksums.
- Never edit a test, a config, or a fixture to change a mutant's outcome. If a mutant appears to
  require a test change, report it and move on.
- Never report a mutant that was not actually applied and run. If the budget runs out, report the
  remainder as `UNVERIFIED` or omit them.
- Do not aggregate or interpret beyond the single `SUMMARY` line. Deduplication and fact-checking
  happen upstream.

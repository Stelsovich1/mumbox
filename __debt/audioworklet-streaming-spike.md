# AudioWorklet streaming — feasibility spike

Status: **feasibility confirmed, decision deferred.** Nothing disqualifying was found; the criteria
that would justify adopting it cannot be completed without a real iOS device, and the strongest
argument for it was removed by another change.

## What it would replace, and what it would not

It replaces the **scheduling half** of `useAudioEngine`: `SCHEDULE_LEAD_SECONDS`, the
`prev.stop(T)` / `next.start(T)` handoff, `isLast`, `promoteToLast`, `resolveLateSegment` and the
rAF watchdog — roughly 250 lines. A ring buffer inside the worklet has no seams, so the whole
`isSeamContinuous` class of risk disappears, and back-pressure becomes observable (`queuedFrames`)
rather than inferred from timing.

It does **not** replace `planSegments`, `partialSource`, `mp3FrameIndex`, `partialVerify` or
`pcmAlign`. `OfflineAudioContext` is unavailable in both Worker and AudioWorklet scopes, so decoding
stays on the main thread by constraint, and something still has to decide which byte range to fetch.
The ladder survives — its justification changes from "fewer seams" to "fetch granularity".

It **adds**: a Vite worker-emission dependency, a service-worker precache entry and a new SW
revision, a feature detect plus a fallback to the current path, a second kill switch in the
`?partial=` family, and a main-thread copy per chunk — `AudioBuffer.getChannelData()` returns a live
view onto the buffer's memory, so it cannot be transferred and every chunk must be `.slice()`d
before `postMessage`.

## Checkpoint 1 — does Vite emit a loadable worklet? YES

This was the plan's first checkpoint precisely because it could have ended the spike. Measured on
this repo:

- `new URL("./streamProcessor.ts?worker&url", import.meta.url)` emits **nothing** — no separate
  chunk appears in `dist/assets/`. That form does not work here.
- `import url from "./streamProcessor.ts?worker&url"` emits `assets/streamProcessor-<hash>.js`,
  240 bytes, and rewrites the import to a `base`-aware URL.
- The emitted format is an IIFE, as `worker.format: "iife"` implies — but the feared failure does
  not occur. The body references no worker globals, so it never touches `self`, which
  `AudioWorkletGlobalScope` does not expose:

  ```js
  (function(){"use strict";class s{/* ... */}registerProcessor("mumbox-stream",s)})();
  ```

- It **is** precached: `workbox.globPatterns` is `**/*.{js,css,html,svg,woff2}`, and the emitted
  chunk appears in `dist/sw.js`. Offline is unaffected.

So the `public/` fallback the plan held in reserve is not needed, and the spike's cheapest possible
disqualifier is ruled out.

## Why the decision is deferred rather than taken

The ADOPT rule was pre-committed and requires all of: sample-exactness against a full decode
(residual RMS ≤ 1e-6 on WAV *and* a real MP3), zero underruns over 3 min × 6 pads at 6× CPU
throttle, `timeToFirstSoundWarmMax` ≤ 20 ms, resident plus queued PCM no worse than today, frame
health no worse than baseline, offline reload from a real `gh-pages`-shaped build, and the
scheduling machinery actually removed rather than sitting beside it.

Two of those cannot be settled here:

- **iOS.** `addModule` from a deployed GitHub Pages build is the one platform that matters most and
  the one CI cannot reach — the same reason `mumbox:partial-decode:v1` exists at all. The plan named
  this an explicit manual step with an owner.
- **The motivation shrank.** The headline memory argument was that a streamed route accumulated
  every segment it scheduled. That is fixed: `routeSegments.ts` brought a 60 s window from
  21 273 848 bytes down to 5 468 400, and the bound is now enforced and tested. A worklet would make
  the accumulation impossible by construction, which is better in kind — but it is no longer solving
  an outstanding defect.

`addModule` is also asynchronous, which is a hard design constraint rather than a detail: the
synchronous fast path in `playCell` is what produces the 0.5 ms warm baseline, so the worklet may
only be used when a module-loaded flag is ALREADY true, with today's path as the fallback.

## What to do when it is picked up

1. Re-run checkpoint 1 (the import form, the emitted format, the precache entry) — it is three
   minutes and the build tooling moves.
2. Build the worklet behind `?worklet=1` with a per-browser persisted verdict, structurally
   identical to `partialDecodePolicy.ts`.
3. Measure against the numbers already in `tests/perf/baseline.json`, and report two columns —
   better and worse — rather than a recommendation.

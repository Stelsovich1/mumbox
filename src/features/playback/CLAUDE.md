# Playback

## Audio engine

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

## Decoded-buffer memory

Decoded PCM is Float32: one second of 44.1 kHz stereo is 0.34 MiB, so a 15 MB MP3 becomes 220–330
MiB resident.

**No default budget on a fine pointer, 384 MiB on a coarse one.** A cap smaller than the project
turns every trigger into a cold decode, and this app is a soundboard: a pad that is not instant is
not a pad. So on a desktop the bound comes from housekeeping alone: deleted media releases its PCM,
a full track is not cached for a cell that plays twelve seconds of it, a looping fallback no longer
leaks a context per iteration — and, above all, **only the panel on screen is kept warm**.

On a phone that housekeeping is necessary and not sufficient, because one panel's worth can be more
than the device has. Measured on a real 18-cell panel of whole MP3s with the byte-range path off:
1 539 MiB resident, `__mumboxDiag.termination()` reporting the previous session killed; the same
panel with the path on held 182 MiB. So the budget is not what makes this app fit — the byte-range
path is — it is the backstop for when that path DECLINES, which is legitimate and sometimes
permanent: a loop is excluded from streaming by design, and a file whose alignment cannot be
measured is off the path for good. A handful of those must not be able to end the session. The
number is a floor-of-evidence, not a measurement: above the 182 MiB a working panel of long tracks
needs, far below the 1 539 MiB that got a tab killed. Two-tier eviction is what makes being wrong
survivable — a pinned buffer is never evicted, so a playing cue cannot be cut.

`src/features/playback/model/audioBufferCache.ts` is a byte-budget LRU (not entry count);
`playbackBufferCache.ts` owns the singleton and derives the default from
`(hover: none) and (pointer: coarse)`. A `null` budget means unlimited. The override wins in BOTH
directions: `?pcmBudgetMb=N` at load or `__mumboxDiag.setBudgetMb(n)` at runtime sets it, and a
non-positive value clears it even where a default would apply — which is why the query flag is read
through `readBudgetOverride` (present/absent) rather than as a bare `number | null`, a shape that
cannot tell "no flag" from "flag asking for no cap".

When a budget IS set, eviction is two-tier: never a pinned buffer (one a live route is using), then
non-priority by LRU, then the active panel by LRU. Plain LRU would evict cell 1 first — the most
likely next tap — because the warm-up fills in cell order.

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

## Byte-range decoding (MP3 and WAV)

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
- **One shared decode gate** (`decodeSemaphore.ts`), used by the RANGE path and every live chain —
  in TWO LANES. `stopOthers` is off by default, so six live pads would otherwise mean six
  unsynchronised decodes on top of the warm-up, and both lanes are bounded for that reason. They
  are separate because one FIFO queue starves the only work with a deadline: a warm-up decode is
  speculative and may be thrown away by the next panel switch, while a segment decode is due before
  the 0.5 s head runs out, and a decode can be neither cancelled nor preempted, so priority
  ordering alone would not have helped. The live lane is deliberately narrow (2) and carries only
  the press path and the segment chain; everything else must say nothing and get the background
  bound. The memory argument survives the split: a live decode is one rung of the ladder, at most
  16 s of stereo (5.6 MB), against the 105 MB whole-file decode that happens in the background
  lane.
- **The gate does NOT cover full decodes**, and that is a known gap rather than a design.
  `decodeFullBuffer` calls `decodeAudioBlob` directly, so the only bound on concurrent full decodes
  is the warm-up pool's own width — and since the range path started engaging, the two range lanes
  run alongside that pool rather than sharing a limit with it. The fix is not a one-liner: a full
  decode is 105 MB against a segment's 5.6 MB, so it cannot join the narrow live lane without
  voiding that lane's memory argument, and it cannot join the background lane on the press path
  without re-creating the starvation the two lanes exist to prevent. Written down so the next reader
  does not rebuild the wrong invariant from a claim the code does not keep.
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
the partial path inside a `try` where any throw falls through to the full decode.

**The verdict is DERIVED from the tally on every write, never latched, and it is a RATIO.** The
first rule blocked on any failure past three verifications and guarded its own recovery branch with
`verdict !== "blocked"`, so one file was enough to take byte-range decoding off a browser profile
forever. Measured in the field: 14 passes, 1 `windows-disagree`, blocked; the fallback cost
1 539 MiB against 182 MiB. The two failure kinds are what make a ratio safe. `decode-rejected` — a
slice the browser refuses while the full decode accepts it — is a CAPABILITY, recorded as
`hardBlocked` and liftable by nothing. `windows-disagree` and `no-alignment` are properties of the
FILE, and that file is already off the path through its own probe flag, so they may only speak for
the browser once they OUTNUMBER the passes. The record carries `policy`, and a mismatch resets it
exactly as a `uaKey` mismatch does — without that, shipping the new rule would have fixed nothing
for anyone already carrying the old rule's verdict.

**The reference window grows on a ladder when every comparison window is silent.** Both windows sit
inside the first `REFERENCE_FRAMES` — roughly the first two seconds — so a fade-in silences both,
and `skipped: silent` took the file off the range path for good: measured one track in sixteen,
about 38 MiB of resident PCM for a quiet intro. The reference must START at frame 0, because only a
decode from the first frame shares the full decode's gapless decision, so the retry can only
LENGTHEN the window (80 frames, then 240 — about 6.3 s). That needs more of the frame table than
the caller pre-scanned, and the scanner is INJECTED rather than the deep scan paid up front: the
fifteen files in sixteen that pass on the first rung would otherwise each pay a header read they
never use. A deeper rung that also comes back quiet reports `silent-deep`, so the two cases stay
distinguishable on a device with no debugger.

`partial.declineReasons`, `partial.verificationReasons` and `partial.failedMediaIds` exist because
`served.declined` and a fail count cannot be acted on. A decline is a full decode, so the
difference between "these cues are loops, excluded on purpose" and "the path is off and the tab is
about to die" is the whole question, and on iOS there is no debugger to answer it with.

**WAV is exempt from the verdict entirely** — its path never invokes the browser's decoder, so
there is nothing about a device that could make `value / 32768` behave differently. Do not add
device self-checks to the WAV path.

Measured effect, panel of 12 whole 180 s stereo tracks: resident PCM **762 048 000 → 2 370 912
bytes** (321x), full decodes 12 → 0. `partial-off-12x180s` in `tests/perf/baseline.json` holds the
pre-change figures so the claim is auditable from one file.


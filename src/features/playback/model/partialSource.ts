/**
 * Reads and decodes a byte range of a media file into a playback buffer.
 *
 * This is where the step-0 measurements land as code:
 *
 * - `blob.slice(a, b).arrayBuffer()` on an IndexedDB-backed blob really reads only that range
 *   (64 reads of 256 KiB from a 60 MiB blob took 98 ms, against 59 ms for one full read — 39x less
 *   work than materialising the file per read).
 * - `decodeAudioData` accepts a raw MP3 frame range and returns samples **bit-identical** to the
 *   same range of a full decode (peak correlation 1.000000, residual RMS 0), provided the range
 *   starts on a frame boundary and carries enough preamble for the bit reservoir.
 *
 * THE TIME BASE, which is the thing to get right: every position handed out is a position in the
 * ORIGINAL media as the app understands it — and the app's timeline is the FULL DECODE's timeline,
 * because that is what the editor measured its trim against. A standalone mid-file slice does not
 * share that timeline: the full decode strips the encoder delay declared in a LAME header and an
 * isolated slice does not, which measured as a 2257-sample offset (1152 preamble + 1105 delay).
 * So a mid-file MP3 range needs that offset measured before it can be trusted, and until it is,
 * such a window is refused and falls back to the full decode. WAV has no such problem: there is no
 * decoder involved at all.
 */
import { getMediaBlob } from "../../../app/model/appState";
import { recordProbe, recordRangeRead } from "../../../shared/lib/diagnostics";
import { isPartialDecodeAllowed } from "../../../shared/lib/partialDecodePolicy";
import { PlaybackBufferEntry } from "./audioBufferCache";
import { DECODE_SAMPLE_RATE } from "./decodeAudio";
import { getEngineSampleRate, shouldUseNativeRateForWav } from "./playbackRate";
import { DecodeLane, getDecodeSemaphore } from "./decodeSemaphore";
import { PlannedSegment, planSegments, shouldSegmentWindow } from "./partialPlan";
import { FORMAT_PROBE_BYTES, PartialMediaFormat, sniffMediaFormat } from "./mediaFormat";
import { MediaProbe, mediaProbeCache } from "./mediaProbeCache";
import {
  appendFrames,
  byteRangeForFrames,
  createMp3FrameIndex,
  fillConstantBitrateIndex,
  findTrailerOffset,
  getIndexedDurationSeconds,
  Mp3FrameIndex,
  parseId3v2Size,
  parseMp3StreamInfo,
  preambleFrameCount,
  readFrameHeader
} from "./mp3FrameIndex";
import { REQUIRED_INDEX_FRAMES, verifyMp3Alignment } from "./partialVerify";
import { decodeWavFrames, parseWavStreamInfo, wavByteRangeForFrames } from "./wavPartial";

/** Enough of the tail to hold an ID3v1 (128 B), APE or Lyrics3 trailer. */
const TRAILER_PROBE_BYTES = 8192;
/** Window size for the incremental VBR frame scan. */
const SCAN_WINDOW_BYTES = 256 * 1024;
/** How many predicted offsets to verify before trusting a constant frame size. */
const CBR_PROBE_POINTS = [0.25, 0.5, 0.75] as const;

async function readRange(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  const from = Math.max(0, Math.min(blob.size, start));
  const to = Math.max(from, Math.min(blob.size, end));
  const bytes = new Uint8Array(await blob.slice(from, to).arrayBuffer());
  // Counted so the laziness assumption stays measurable on a device this repo's CI cannot reach:
  // total bytes far above the sum of the windows requested would mean slices are materialising the
  // whole file, and the whole design would need revisiting.
  recordRangeRead(bytes.byteLength);
  return bytes;
}

/**
 * Verifies a proposed constant frame size by probing deeper in the file.
 *
 * `parseMp3StreamInfo` can only see that the OPENING frames are uniform. A VBR file whose first
 * frames happen to share a bitrate would otherwise produce an index that is arithmetically neat and
 * completely wrong, which is the worst kind of wrong here: every seek would land mid-frame.
 */
async function verifyConstantFrameBytes(
  blob: Blob,
  firstFrameOffset: number,
  audioEndOffset: number,
  frameBytes: number
): Promise<boolean> {
  const totalFrames = Math.floor((audioEndOffset - firstFrameOffset) / frameBytes);
  if (totalFrames < 4) {
    return false;
  }
  for (const fraction of CBR_PROBE_POINTS) {
    const frame = Math.floor(totalFrames * fraction);
    const offset = firstFrameOffset + frame * frameBytes;
    const window = await readRange(blob, offset, offset + 4);
    if (readFrameHeader(window, 0)?.frameBytes !== frameBytes) {
      return false;
    }
  }
  return true;
}

async function buildMp3Probe(mediaId: string, blob: Blob): Promise<MediaProbe | null> {
  const head = await readRange(blob, 0, FORMAT_PROBE_BYTES);
  const tagBytes = parseId3v2Size(head);
  // Two staged reads rather than one big one: an ID3v2 tag with cover art can be hundreds of
  // kilobytes, and reading past it blindly would pull all of that for nothing.
  const frameHead =
    tagBytes > 0
      ? await readRange(blob, tagBytes, tagBytes + FORMAT_PROBE_BYTES)
      : head;
  const headForInfo = tagBytes > 0 ? frameHead : head;

  const tail = await readRange(blob, Math.max(0, blob.size - TRAILER_PROBE_BYTES), blob.size);
  const audioEndOffset = findTrailerOffset(tail, blob.size);

  const info = parseMp3StreamInfo({
    // When a tag was skipped the window starts at the tag's end, so offsets inside it are relative;
    // shifting them back is what keeps `firstFrameOffset` absolute.
    head: headForInfo,
    fileSize: blob.size,
    audioEndOffset
  });
  if (!info) {
    return null;
  }
  const absoluteInfo = {
    ...info,
    firstFrameOffset: info.firstFrameOffset + (tagBytes > 0 ? tagBytes : 0)
  };

  let constantFrameBytes = absoluteInfo.constantFrameBytes;
  if (
    constantFrameBytes !== null &&
    !(await verifyConstantFrameBytes(
      blob,
      absoluteInfo.firstFrameOffset,
      audioEndOffset,
      constantFrameBytes
    ))
  ) {
    constantFrameBytes = null;
  }

  const index = createMp3FrameIndex({ ...absoluteInfo, constantFrameBytes });
  if (constantFrameBytes !== null) {
    fillConstantBitrateIndex(index);
  }

  return {
    mediaId,
    format: "mp3",
    mp3: index,
    containerDurationSeconds: getIndexedDurationSeconds(index),
    sampleRate: index.info.sampleRate,
    channels: index.info.channels,
    alignDeltaSamples: null,
    verified: "unknown",
    partialDisabled: false,
    failures: 0
  };
}

/**
 * Extends a VBR index forward until it covers `throughByte`, reading in windows.
 *
 * Only ever scans as far as playback needs. A full-file header scan is possible (and cheap: it
 * reads the compressed bytes and decodes nothing) but pointless before the range is known.
 */
async function ensureScannedTo(
  blob: Blob,
  index: Mp3FrameIndex,
  throughByte: number
): Promise<void> {
  while (!index.complete && index.scannedToByte < throughByte) {
    const from = index.scannedToByte;
    const to = Math.min(index.info.audioEndOffset, from + SCAN_WINDOW_BYTES);
    if (to <= from) {
      index.complete = true;
      return;
    }
    const window = await readRange(blob, from, to);
    const appended = appendFrames(index, window, from);
    if (appended === 0) {
      // No progress: either the window ended mid-frame at the very end, or the stream is corrupt.
      return;
    }
  }
}

async function buildWavProbe(mediaId: string, blob: Blob): Promise<MediaProbe | null> {
  // A DAW file can carry LIST/bext/JUNK chunks before `data`, so the header window has to be
  // generous enough to walk past them.
  const head = await readRange(blob, 0, Math.min(blob.size, 64 * 1024));
  const info = parseWavStreamInfo(head, blob.size);
  if (!info) {
    return null;
  }
  return {
    mediaId,
    format: "wav",
    wav: info,
    containerDurationSeconds: info.frameCount / info.sampleRate,
    sampleRate: info.sampleRate,
    channels: info.channels,
    // No decoder is involved, so there is nothing to be offset from.
    alignDeltaSamples: 0,
    verified: "pass",
    partialDisabled: false,
    failures: 0
  };
}

/** Builds (or returns) the per-media probe. Null means this media has no partial path. */
/**
 * Re-derives an evicted frame table, keeping everything expensive that was measured around it.
 *
 * Rebuilding costs a handful of range reads and no decode. The facts it hangs off — above all
 * `alignDeltaSamples`, which costs two decodes and a cross-correlation — are never evicted, so a
 * table coming back does NOT drag a re-verification with it. That was the whole point of splitting
 * the cache: under one shared budget, two long tracks could not both keep a table, and each eviction
 * re-triggered the measurement on the next panel switch.
 */
async function ensureMp3Index(probe: MediaProbe, blob: Blob): Promise<Mp3FrameIndex | null> {
  if (probe.mp3) {
    return probe.mp3;
  }
  if (probe.format !== "mp3") {
    return null;
  }
  const rebuilt = await buildMp3Probe(probe.mediaId, blob);
  if (!rebuilt?.mp3) {
    return null;
  }
  // `setIndex` attaches it to the STORED facts record, which is the object `probe` already points
  // at whenever it came from `getMediaProbe` — so the caller's `probe.mp3` is populated too.
  mediaProbeCache.setIndex(probe.mediaId, rebuilt.mp3);
  return rebuilt.mp3;
}

export async function getMediaProbe(mediaId: string): Promise<MediaProbe | null> {
  const cached = mediaProbeCache.get(mediaId);
  if (cached) {
    return cached.format === "unsupported" ? null : cached;
  }

  const blob = await getMediaBlob(mediaId);
  if (!blob) {
    return null;
  }

  const head = await readRange(blob, 0, FORMAT_PROBE_BYTES);
  const format: PartialMediaFormat = sniffMediaFormat(head);
  recordProbe(format);
  if (format === "unsupported") {
    mediaProbeCache.set({
      mediaId,
      format: "unsupported",
      containerDurationSeconds: null,
      sampleRate: null,
      channels: null,
      alignDeltaSamples: null,
      verified: "unknown",
      partialDisabled: true,
      failures: 0
    });
    return null;
  }

  const probe = format === "wav" ? await buildWavProbe(mediaId, blob) : await buildMp3Probe(mediaId, blob);
  if (!probe) {
    mediaProbeCache.set({
      mediaId,
      format: "unsupported",
      containerDurationSeconds: null,
      sampleRate: null,
      channels: null,
      alignDeltaSamples: null,
      verified: "unknown",
      partialDisabled: true,
      failures: 0
    });
    return null;
  }
  mediaProbeCache.set(probe);
  return probe;
}

function createOfflineBuffer(channels: number, length: number, sampleRate: number) {
  // Built lazily on an offline context, exactly as `sliceToAudioBuffer` does: iOS caps concurrent
  // contexts, and a buffer created offline plays fine on a live context.
  const context = new OfflineAudioContext(1, 1, sampleRate);
  return context.createBuffer(channels, length, sampleRate);
}

export type RangeDecodeRequest = {
  mediaId: string;
  /** Source-time window, in the app's timeline. */
  startSeconds: number;
  endSeconds: number;
  mono: boolean;
};

export type RangeDecodeResult = {
  entry: PlaybackBufferEntry;
  /** Bytes actually read from the file, for diagnostics. */
  readBytes: number;
};

async function decodeWavRange(
  blob: Blob,
  probe: MediaProbe,
  request: RangeDecodeRequest
): Promise<RangeDecodeResult | null> {
  const info = probe.wav;
  if (!info) {
    return null;
  }
  // A WAV whose rate is not the engine's falls through to the full decode, which resamples inside
  // `decodeAudioData`. Resampling here instead would mean writing a resampler onto the one path
  // that never invokes the browser's decoder — the very property that exempts WAV from the
  // per-browser partial-decode verdict. Two lines beat a resampler to get wrong.
  if (!shouldUseNativeRateForWav(info.sampleRate)) {
    return null;
  }
  const startFrame = Math.floor(request.startSeconds * info.sampleRate);
  const endFrame = Math.ceil(request.endSeconds * info.sampleRate);
  const range = wavByteRangeForFrames(info, startFrame, endFrame);
  if (range.frames <= 0) {
    return null;
  }

  const bytes = await readRange(blob, range.start, range.end);
  const buffer = decodeWavFrames({
    info,
    bytes,
    frames: range.frames,
    mono: request.mono,
    createBuffer: createOfflineBuffer
  }) as AudioBuffer;

  const actualStartFrame = Math.max(0, Math.min(info.frameCount, startFrame));
  return {
    readBytes: bytes.byteLength,
    entry: {
      buffer,
      bytes: buffer.length * buffer.numberOfChannels * 4,
      // Exact: the range began on this frame, so the buffer's sample 0 is that position in source
      // time. No decoder, so no offset to correct for.
      sliceStartSeconds: actualStartFrame / info.sampleRate,
      sourceDurationSeconds: info.frameCount / info.sampleRate
    }
  };
}

async function decodeMp3Range(
  blob: Blob,
  probe: MediaProbe,
  request: RangeDecodeRequest
): Promise<RangeDecodeResult | null> {
  const index = await ensureMp3Index(probe, blob);
  if (!index) {
    return null;
  }
  const { samplesPerFrame, sampleRate } = index.info;

  const startSample = Math.max(0, Math.floor(request.startSeconds * sampleRate));
  const endSample = Math.ceil(request.endSeconds * sampleRate);
  const wantedFirstFrame = Math.floor(startSample / samplesPerFrame);
  const wantedLastFrame = Math.ceil(endSample / samplesPerFrame) + 1;

  // A mid-file window needs the measured decoder offset; a window starting at the head does not,
  // because a decode from byte 0 IS the app's timeline. Refusing rather than guessing: a wrong
  // offset here is inaudible-but-wrong audio, which is worse than a slower cold start.
  if (wantedFirstFrame > 0 && probe.alignDeltaSamples === null) {
    return null;
  }

  await ensureScannedTo(
    blob,
    index,
    // Scan a little past the window so `byteRangeForFrames` has the frame after the last one.
    Math.min(index.info.audioEndOffset, index.info.firstFrameOffset + (wantedLastFrame + 8) * 2048)
  );
  if (index.frameCount === 0) {
    return null;
  }

  const preamble = wantedFirstFrame === 0 ? 0 : preambleFrameCount(index, wantedFirstFrame);
  if (preamble === null) {
    return null;
  }
  const firstFrame = Math.max(0, wantedFirstFrame - preamble);
  const lastFrame = Math.min(index.frameCount, Math.max(firstFrame + 1, wantedLastFrame));
  const range = byteRangeForFrames(index, firstFrame, lastFrame);
  if (!range) {
    return null;
  }

  const bytes = await readRange(blob, range.start, range.end);
  // Feeds the playback graph, so it decodes at the ENGINE rate. The verification decode in
  // `partialVerify.ts` deliberately does not — see the comment there.
  const context = new OfflineAudioContext(1, 1, getEngineSampleRate());
  const decoded = await context.decodeAudioData(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  );

  const sourceDurationSeconds =
    probe.containerDurationSeconds ?? decoded.duration + firstFrame * samplesPerFrame / sampleRate;

  // Where this buffer's sample 0 sits in the app's timeline: the frame the range began on, minus
  // the measured offset between an isolated decode and the full one.
  const sliceStartSeconds =
    (firstFrame * samplesPerFrame - (probe.alignDeltaSamples ?? 0)) / sampleRate;

  return {
    readBytes: bytes.byteLength,
    entry: {
      buffer: decoded,
      bytes: decoded.length * decoded.numberOfChannels * 4,
      sliceStartSeconds,
      sourceDurationSeconds
    }
  };
}

/**
 * Decodes one source-time window straight out of the file.
 *
 * Returns null whenever the partial path does not apply — an unsupported container, a disabled
 * media, a mid-file MP3 window with no measured offset yet, a range the index cannot resolve. The
 * caller treats null as "use the existing full decode", so this function can never fail a cue.
 *
 * Every decode goes through the shared gate, including a segment fetched mid-playback: the whole
 * point of bounding concurrency is that simultaneous decodes multiply the transient, and a chain
 * that bypassed the bound would reintroduce exactly that.
 *
 * `lane` picks WHICH bound. A cue that is already audible has a deadline measured in hundreds of
 * milliseconds and must not queue behind speculative warm-up work — see `decodeSemaphore.ts`. It
 * defaults to the background lane so that only the two call sites that really are on a deadline,
 * the press path and the live segment chain, have to say so.
 */
export async function decodeMediaRange(
  request: RangeDecodeRequest,
  lane: DecodeLane = "background"
): Promise<RangeDecodeResult | null> {
  const probe = await getMediaProbe(request.mediaId);
  if (!probe || probe.partialDisabled || !isPartialDecodeAllowed(probe.format)) {
    return null;
  }
  const blob = await getMediaBlob(request.mediaId);
  if (!blob) {
    return null;
  }

  return getDecodeSemaphore().run(
    async () =>
      probe.format === "wav"
        ? decodeWavRange(blob, probe, request)
        : decodeMp3Range(blob, probe, request),
    lane
  );
}

/**
 * Measures the decoder offset for an MP3, if it has not been measured yet.
 *
 * Called from the warm-up and only for media that actually needs it — a cue whose window starts
 * mid-file. A window starting at the head does not need it, because a decode from byte 0 already
 * IS the app's timeline, and paying two extra decodes per media to learn a number nothing will use
 * would make warming slower for no benefit.
 *
 * Returns whether a mid-file window is now usable. Never throws: a failure disables the partial
 * path for that media and, if the decoder rejected a slice outright, blocks the browser.
 */
export async function ensureMp3Alignment(mediaId: string): Promise<boolean> {
  const probe = await getMediaProbe(mediaId);
  if (probe?.format !== "mp3" || probe.partialDisabled) {
    return false;
  }
  if (probe.alignDeltaSamples !== null) {
    return true;
  }
  if (probe.verified === "fail") {
    return false;
  }
  const blob = await getMediaBlob(mediaId);
  if (!blob) {
    return false;
  }
  // The verification reads the frame table; make sure one is attached before handing the probe over.
  const index = await ensureMp3Index(probe, blob);
  if (!index) {
    return false;
  }
  // Attached is not the same as scanned, and that gap is what made this whole feature inert.
  // `createMp3FrameIndex` returns `frameCount === 0` and fills lazily; `fillConstantBitrateIndex`
  // would fill it up front but never runs on real material, because a 192 kbps 44.1 kHz frame is
  // 626.94 bytes and the alternating padding bit leaves `constantFrameBytes` null. So the
  // verification saw an empty table, answered "too-short", and returned `skipped` — which is not
  // `fail`, so no counter moved and no verdict was blocked. `alignDeltaSamples` simply stayed null,
  // and with it every mid-file window was refused for the life of the session.
  //
  // The byte bound is the same shape `decodeMp3Range` uses: 2048 is an upper bound on an MPEG-1
  // Layer III frame, so this covers the frames the measurement needs plus a margin for the range
  // that ends it.
  await ensureScannedTo(
    blob,
    index,
    Math.min(
      index.info.audioEndOffset,
      index.info.firstFrameOffset + (REQUIRED_INDEX_FRAMES + 8) * 2048
    )
  );
  const outcome = await getDecodeSemaphore().run(() => verifyMp3Alignment(blob, probe));
  return outcome.status === "pass";
}

/**
 * Whether a window can be streamed as segments, and how it splits.
 *
 * Answered from the probe, so it needs the container — which is why the caller treats a null here
 * as "not streamable" rather than as an error. A mid-file MP3 window without a measured offset is
 * refused for the same reason a mid-file range decode is: the head would be misplaced in time.
 */
export async function planMediaSegments(request: {
  mediaId: string;
  startSeconds: number;
  endSeconds: number;
  /**
   * Duration the caller already knows, used when the container will not say.
   *
   * Nine of sixteen files in a real corpus carry no Xing, Info or VBRI frame at all, so even with
   * the branch order in `getIndexedDurationSeconds` fixed their `declaredFrameCount` is null and
   * the only exact answer would be a full header scan of the file. That is the wrong price for a
   * number the app already measured at import (`readAudioDurationMs` → `MediaAsset.durationMs`),
   * and it is the SAME number the window was computed against one frame up the stack, so using it
   * here cannot disagree with the trim.
   *
   * It only ever bounds the margin of the last segment: `planSegments` clamps `bufferEndSeconds` to
   * it, and the engine already takes `Math.max` of this and the decoder's own duration for exactly
   * the "container short by one frame" case.
   */
  fallbackDurationSeconds?: number;
}): Promise<{ segments: PlannedSegment[]; sourceDurationSeconds: number } | null> {
  const probe = await getMediaProbe(request.mediaId);
  if (!probe || probe.partialDisabled || !isPartialDecodeAllowed(probe.format)) {
    return null;
  }
  // An MP3 with no measured offset cannot be streamed AT ALL, whatever the window's start.
  //
  // Gating this on `startSeconds > 0` was right for a plain range read and wrong here: a plan is
  // only ever returned with more than one segment, and every segment after the head starts
  // mid-file by construction. So an untrimmed track was allowed onto the streaming path, played
  // its 0.5 s head, had each following segment refused by `decodeMp3Range` for the missing offset,
  // and was ended by `promoteToLast` — a three-minute cue audible for half a second. Refusing the
  // plan sends the media to the full decode instead: more memory, but the audio the user asked
  // for. A cue that cannot be continued must never be started.
  if (probe.format === "mp3" && probe.alignDeltaSamples === null) {
    return null;
  }
  const fallback = request.fallbackDurationSeconds;
  const sourceDurationSeconds =
    probe.containerDurationSeconds ??
    (fallback !== undefined && Number.isFinite(fallback) ? fallback : null);
  if (sourceDurationSeconds === null || sourceDurationSeconds <= 0) {
    return null;
  }

  // The size gate, which `planSegments` itself does not apply: it will happily split a 5-second
  // window into a head plus one segment, and that is exactly the case where a seam buys nothing —
  // 1.7 MB decodes in one piece. Without this check every trimmed window would be streamed and the
  // range path would never run.
  // From the facts, which survive eviction. Reading them off `probe.mp3` meant that once the frame
  // table was evicted these silently became the defaults and mis-gated `shouldSegmentWindow`.
  const channels = probe.channels ?? 2;
  const sampleRate = probe.sampleRate ?? DECODE_SAMPLE_RATE;
  if (
    !shouldSegmentWindow({
      windowSeconds: request.endSeconds - request.startSeconds,
      sampleRate,
      channels
    })
  ) {
    return null;
  }

  const segments = planSegments({
    startSeconds: request.startSeconds,
    endSeconds: request.endSeconds,
    sourceDurationSeconds
  });
  return segments.length > 1 ? { segments, sourceDurationSeconds } : null;
}

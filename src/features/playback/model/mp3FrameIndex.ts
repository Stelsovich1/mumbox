/**
 * MP3 frame table: the map from a position in time to a byte range in the file.
 *
 * This is what makes a byte-range decode possible at all. `decodeAudioData` has no partial-decode
 * API, so the only way to decode part of a file is to hand it part of the file — and for MP3 that
 * means handing it whole frames, because a frame is the unit the decoder can start on.
 *
 * Measured on a real 192 kbps CBR file: a mid-stream slice of 121 frames (75 860 bytes) decoded
 * successfully and its samples were **bit-identical** to the same range of a full decode — peak
 * correlation 1.000000, residual RMS 0. So the approach is exact, not approximate, as long as the
 * frame boundaries are exact. That is this module's whole job.
 *
 * Dependency-free and DOM-free on purpose: it parses `Uint8Array` windows and nothing else, which
 * is what lets the unit tier build streams out of hand-written 4-byte headers plus filler. The
 * indexer only ever reads headers, so testing it needs no encoder and no binary fixture.
 */

export type Mp3Version = "mpeg1" | "mpeg2" | "mpeg2.5";

export type Mp3FrameHeader = {
  version: Mp3Version;
  bitrateKbps: number;
  sampleRate: number;
  channels: 1 | 2;
  /** 1152 for MPEG-1 Layer III, 576 for MPEG-2/2.5. A hardcoded 1152 is a bug on a 24 kHz file. */
  samplesPerFrame: number;
  /** Includes the padding byte when the padding bit is set. */
  frameBytes: number;
};

export type Mp3StreamInfo = {
  version: Mp3Version;
  sampleRate: number;
  channels: 1 | 2;
  samplesPerFrame: number;
  firstFrameOffset: number;
  /** Where the audio stops, i.e. before any ID3v1/APE/Lyrics3 trailer. */
  audioEndOffset: number;
  /**
   * Non-null only when every sampled header agreed, which allows O(1) seeking with no scan at all.
   * A caller may still verify it by probing predicted offsets before trusting it.
   */
  constantFrameBytes: number | null;
  hasXingHeader: boolean;
  /**
   * Frame count declared by a Xing/VBRI header. Used for a DURATION cross-check only, never for
   * seeking: the accompanying TOC is about 1 % accurate, which is 1.8 s of error on a 3-minute
   * track — three orders of magnitude past what a sample-accurate splice can tolerate.
   */
  declaredFrameCount: number | null;
};

export type Mp3FrameIndex = {
  info: Mp3StreamInfo;
  /** `byteOffsets[i]` is the byte offset of frame `i`. Grown by doubling. */
  byteOffsets: Uint32Array;
  frameCount: number;
  /** Bytes consumed so far, so an incremental scan knows where to resume. */
  scannedToByte: number;
  complete: boolean;
};

/** A frame's main_data may reference up to this many bytes of the preceding stream. */
export const MP3_BIT_RESERVOIR_BYTES = 511;
/**
 * Ceiling on preamble frames. Reaching it means the bitrate is so low that a single frame carries
 * under ~32 bytes, which no real encoder produces; such a file is disqualified from the partial
 * path rather than guessed at.
 */
export const MP3_MAX_PREAMBLE_FRAMES = 16;

const BITRATES_MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES: Record<Mp3Version, readonly number[]> = {
  mpeg1: [44100, 48000, 32000, 0],
  mpeg2: [22050, 24000, 16000, 0],
  "mpeg2.5": [11025, 12000, 8000, 0]
};

const LAYER_III_BITS = 0x01;

function byteAt(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset >= bytes.length) {
    return null;
  }
  // `noUncheckedIndexedAccess` makes this `number | undefined`; the bounds check above is what
  // makes the assertion-free read safe, and `?? 0` is deliberately avoided everywhere in this
  // module because a silent 0 turns an out-of-range read into a plausible byte value.
  return bytes[offset] ?? null;
}

/**
 * Size of an ID3v2 tag at the start of `head`, or 0 when there is none.
 *
 * The syncsafe integer uses 7 bits per byte; a set footer flag adds another 10 bytes.
 */
export function parseId3v2Size(head: Uint8Array): number {
  if (
    byteAt(head, 0) !== 0x49 ||
    byteAt(head, 1) !== 0x44 ||
    byteAt(head, 2) !== 0x33
  ) {
    return 0;
  }
  const flags = byteAt(head, 5);
  const s0 = byteAt(head, 6);
  const s1 = byteAt(head, 7);
  const s2 = byteAt(head, 8);
  const s3 = byteAt(head, 9);
  if (flags === null || s0 === null || s1 === null || s2 === null || s3 === null) {
    return 0;
  }
  // Any high bit set means this is not a valid syncsafe integer.
  if ((s0 | s1 | s2 | s3) & 0x80) {
    return 0;
  }
  const size = (s0 << 21) | (s1 << 14) | (s2 << 7) | s3;
  const footerBytes = (flags & 0x10) === 0x10 ? 10 : 0;
  return 10 + size + footerBytes;
}

/** Parses a Layer III frame header, or returns null when `offset` is not one. */
export function readFrameHeader(bytes: Uint8Array, offset: number): Mp3FrameHeader | null {
  const b0 = byteAt(bytes, offset);
  const b1 = byteAt(bytes, offset + 1);
  const b2 = byteAt(bytes, offset + 2);
  const b3 = byteAt(bytes, offset + 3);
  if (b0 === null || b1 === null || b2 === null || b3 === null) {
    return null;
  }
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) {
    return null;
  }

  // Layer III only. This check is what keeps ADTS AAC out: it shares the 11-bit sync pattern, and
  // omitting the layer test is the most likely way to misdetect an .aac file as MP3.
  if (((b1 >> 1) & 0x03) !== LAYER_III_BITS) {
    return null;
  }

  const versionBits = (b1 >> 3) & 0x03;
  let version: Mp3Version;
  if (versionBits === 0x03) {
    version = "mpeg1";
  } else if (versionBits === 0x02) {
    version = "mpeg2";
  } else if (versionBits === 0x00) {
    version = "mpeg2.5";
  } else {
    return null;
  }

  const bitrateTable = version === "mpeg1" ? BITRATES_MPEG1_L3 : BITRATES_MPEG2_L3;
  const bitrateKbps = bitrateTable[(b2 >> 4) & 0x0f];
  const sampleRate = SAMPLE_RATES[version][(b2 >> 2) & 0x03];
  if (!bitrateKbps || !sampleRate) {
    return null;
  }

  const samplesPerFrame = version === "mpeg1" ? 1152 : 576;
  const padding = (b2 >> 1) & 0x01;
  const frameBytes = Math.floor((samplesPerFrame / 8) * bitrateKbps * 1000 / sampleRate) + padding;
  if (frameBytes < 24) {
    return null;
  }

  return {
    version,
    bitrateKbps,
    sampleRate,
    channels: ((b3 >> 6) & 0x03) === 0x03 ? 1 : 2,
    samplesPerFrame,
    frameBytes
  };
}

/**
 * Two headers describe the same stream when everything but the bitrate matches. The bitrate is
 * excluded on purpose: it varies per frame in a VBR file, which is legal.
 */
function headersAgree(a: Mp3FrameHeader, b: Mp3FrameHeader): boolean {
  return (
    a.version === b.version &&
    a.sampleRate === b.sampleRate &&
    a.channels === b.channels &&
    a.samplesPerFrame === b.samplesPerFrame
  );
}

/**
 * First frame at or after `from`, requiring TWO consecutive agreeing headers before accepting.
 *
 * One match is not evidence: an 11-bit sync pattern occurs by chance roughly every 2 KB, so a
 * single hit inside cover art or a lyrics tag would derail the whole index.
 */
export function findFirstFrame(bytes: Uint8Array, from: number, limit: number): number | null {
  const end = Math.min(bytes.length, limit);
  for (let offset = Math.max(0, from); offset < end; offset += 1) {
    const first = readFrameHeader(bytes, offset);
    if (!first) {
      continue;
    }
    const second = readFrameHeader(bytes, offset + first.frameBytes);
    if (second && headersAgree(first, second)) {
      return offset;
    }
  }
  return null;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let result = "";
  for (let index = 0; index < length; index += 1) {
    const value = byteAt(bytes, offset + index);
    if (value === null) {
      return result;
    }
    result += String.fromCharCode(value);
  }
  return result;
}

function readUint32BE(bytes: Uint8Array, offset: number): number | null {
  const b0 = byteAt(bytes, offset);
  const b1 = byteAt(bytes, offset + 1);
  const b2 = byteAt(bytes, offset + 2);
  const b3 = byteAt(bytes, offset + 3);
  if (b0 === null || b1 === null || b2 === null || b3 === null) {
    return null;
  }
  return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
}

/** Side info size, which is where a Xing header sits inside the first frame. */
function getSideInfoBytes(version: Mp3Version, channels: 1 | 2): number {
  if (version === "mpeg1") {
    return channels === 1 ? 17 : 32;
  }
  return channels === 1 ? 9 : 17;
}

function readXing(bytes: Uint8Array, firstFrameOffset: number, header: Mp3FrameHeader) {
  const xingOffset = firstFrameOffset + 4 + getSideInfoBytes(header.version, header.channels);
  const tag = readAscii(bytes, xingOffset, 4);
  if (tag === "Xing" || tag === "Info") {
    const flags = readUint32BE(bytes, xingOffset + 4);
    if (flags !== null && (flags & 0x0001) === 0x0001) {
      const frames = readUint32BE(bytes, xingOffset + 8);
      return { hasXingHeader: true, declaredFrameCount: frames };
    }
    return { hasXingHeader: true, declaredFrameCount: null };
  }
  // VBRI sits at a fixed offset instead of after the side info.
  if (readAscii(bytes, firstFrameOffset + 4 + 32, 4) === "VBRI") {
    const frames = readUint32BE(bytes, firstFrameOffset + 4 + 32 + 14);
    return { hasXingHeader: true, declaredFrameCount: frames };
  }
  return { hasXingHeader: false, declaredFrameCount: null };
}

/**
 * Where the audio ends, given the tail of the file. Trailers are metadata and must not be fed to
 * the decoder as if they were frames.
 *
 * A missed trailer costs at most a short final segment, because the frame index bounds the last
 * range as well — so this stays a best-effort scan rather than a hard requirement.
 */
export function findTrailerOffset(tail: Uint8Array, fileSize: number): number {
  const tailStart = fileSize - tail.length;
  let end = fileSize;

  if (tail.length >= 128 && readAscii(tail, tail.length - 128, 3) === "TAG") {
    end = Math.min(end, tailStart + tail.length - 128);
  }
  for (let offset = tail.length - 32; offset >= 0; offset -= 1) {
    if (readAscii(tail, offset, 8) === "APETAGEX") {
      end = Math.min(end, tailStart + offset);
      break;
    }
  }
  for (let offset = tail.length - 15; offset >= 0; offset -= 1) {
    if (readAscii(tail, offset, 9) === "LYRICS200") {
      end = Math.min(end, tailStart + offset);
      break;
    }
  }

  return Math.max(0, end);
}

export type ParseStreamInfoOptions = {
  /** Bytes from the start of the file. Must reach past any ID3v2 tag to the first frame. */
  head: Uint8Array;
  fileSize: number;
  /** Where the audio ends; defaults to `fileSize` when no trailer scan was done. */
  audioEndOffset?: number;
  /** How many consecutive headers must agree before `constantFrameBytes` is proposed. */
  constantSampleFrames?: number;
};

/**
 * Reads the stream's shape from the head of the file.
 *
 * `constantFrameBytes` is only a PROPOSAL here — it says the first few frames are all the same
 * size. The caller verifies it by probing predicted offsets deeper in the file before relying on
 * O(1) seeking, because a VBR file whose opening frames happen to share a bitrate would otherwise
 * produce a silently wrong index.
 */
export function parseMp3StreamInfo(options: ParseStreamInfoOptions): Mp3StreamInfo | null {
  const { head, fileSize } = options;
  const tagBytes = parseId3v2Size(head);
  const firstFrameOffset = findFirstFrame(head, tagBytes, head.length);
  if (firstFrameOffset === null) {
    return null;
  }
  const header = readFrameHeader(head, firstFrameOffset);
  if (!header) {
    return null;
  }

  const sampleCount = options.constantSampleFrames ?? 8;
  let constantFrameBytes: number | null = header.frameBytes;
  let cursor = firstFrameOffset;
  for (let index = 0; index < sampleCount; index += 1) {
    const current = readFrameHeader(head, cursor);
    if (!current || !headersAgree(current, header)) {
      break;
    }
    if (current.frameBytes !== header.frameBytes) {
      constantFrameBytes = null;
      break;
    }
    cursor += current.frameBytes;
  }

  const xing = readXing(head, firstFrameOffset, header);

  return {
    version: header.version,
    sampleRate: header.sampleRate,
    channels: header.channels,
    samplesPerFrame: header.samplesPerFrame,
    firstFrameOffset,
    audioEndOffset: Math.min(fileSize, options.audioEndOffset ?? fileSize),
    // A Xing header means the encoder wrote a VBR table, which is a strong hint the stream is not
    // CBR even when its opening frames look uniform.
    constantFrameBytes: xing.hasXingHeader ? null : constantFrameBytes,
    hasXingHeader: xing.hasXingHeader,
    declaredFrameCount: xing.declaredFrameCount
  };
}

export function createMp3FrameIndex(info: Mp3StreamInfo): Mp3FrameIndex {
  return {
    info,
    byteOffsets: new Uint32Array(1024),
    frameCount: 0,
    scannedToByte: info.firstFrameOffset,
    complete: false
  };
}

function pushOffset(index: Mp3FrameIndex, offset: number) {
  if (index.frameCount === index.byteOffsets.length) {
    const grown = new Uint32Array(index.byteOffsets.length * 2);
    grown.set(index.byteOffsets);
    index.byteOffsets = grown;
  }
  index.byteOffsets[index.frameCount] = offset;
  index.frameCount += 1;
}

/**
 * Appends every complete frame found in `window`, which starts at absolute byte `windowStartByte`.
 *
 * Returns how many frames were appended. `scannedToByte` advances only past frames that were fully
 * contained in the window, so the next window can start there and no frame is split or skipped.
 *
 * A header that disagrees with `info` — a mid-stream sample-rate or version change — stops the
 * scan and marks the index complete rather than producing entries whose sample positions would be
 * wrong. Such a file falls back to the full-decode path.
 */
export function appendFrames(
  index: Mp3FrameIndex,
  window: Uint8Array,
  windowStartByte: number
): number {
  const audioEnd = index.info.audioEndOffset;
  let cursor = Math.max(0, index.scannedToByte - windowStartByte);
  let appended = 0;

  for (;;) {
    const absolute = windowStartByte + cursor;
    if (absolute + 4 > audioEnd) {
      index.complete = true;
      break;
    }
    const header = readFrameHeader(window, cursor);
    if (!header) {
      // Either the window ran out or the stream is corrupt here; only the caller knows which,
      // from whether the window reached `audioEndOffset`.
      if (windowStartByte + window.length >= audioEnd) {
        index.complete = true;
      }
      break;
    }
    if (
      header.version !== index.info.version ||
      header.sampleRate !== index.info.sampleRate ||
      header.channels !== index.info.channels
    ) {
      index.complete = true;
      break;
    }
    if (cursor + header.frameBytes > window.length || absolute + header.frameBytes > audioEnd) {
      // The frame is not fully inside this window. Do not index a partial frame.
      if (absolute + header.frameBytes > audioEnd) {
        index.complete = true;
      }
      break;
    }

    pushOffset(index, absolute);
    appended += 1;
    cursor += header.frameBytes;
    index.scannedToByte = windowStartByte + cursor;
  }

  return appended;
}

/** Populates the whole index from a CBR stream arithmetically, with no scan at all. */
export function fillConstantBitrateIndex(index: Mp3FrameIndex): number {
  const frameBytes = index.info.constantFrameBytes;
  if (frameBytes === null || frameBytes <= 0) {
    return 0;
  }
  const total = Math.floor((index.info.audioEndOffset - index.info.firstFrameOffset) / frameBytes);
  for (let frame = 0; frame < total; frame += 1) {
    pushOffset(index, index.info.firstFrameOffset + frame * frameBytes);
  }
  index.scannedToByte = index.info.firstFrameOffset + total * frameBytes;
  index.complete = true;
  return total;
}

function offsetOf(index: Mp3FrameIndex, frame: number): number | null {
  if (frame < 0 || frame >= index.frameCount) {
    return null;
  }
  return index.byteOffsets[frame] ?? null;
}

/**
 * Sample position of a frame.
 *
 * Derived rather than stored: Layer III frames carry a fixed sample count per version, and
 * `appendFrames` refuses a stream that changes version or rate mid-file, so the multiplication is
 * exact. Storing a second array would double the index's memory for no information.
 */
export function sampleForFrame(index: Mp3FrameIndex, frame: number): number {
  return frame * index.info.samplesPerFrame;
}

export function frameForSample(index: Mp3FrameIndex, sample: number): number | null {
  if (sample < 0 || index.frameCount === 0) {
    return null;
  }
  const frame = Math.floor(sample / index.info.samplesPerFrame);
  return frame >= index.frameCount ? null : frame;
}

export function byteRangeForFrames(
  index: Mp3FrameIndex,
  firstFrame: number,
  lastFrameExclusive: number
): { start: number; end: number } | null {
  const start = offsetOf(index, firstFrame);
  if (start === null || lastFrameExclusive <= firstFrame) {
    return null;
  }
  // One past the last frame is the end of the audio, not a frame offset, so it is not required to
  // exist in the table.
  const end =
    lastFrameExclusive >= index.frameCount
      ? index.info.audioEndOffset
      : offsetOf(index, lastFrameExclusive);
  if (end === null || end <= start) {
    return null;
  }
  return { start, end };
}

/**
 * How many frames before `frame` must be decoded and discarded so `frame` itself is correct.
 *
 * A frame's `main_data_begin` can point up to 511 bytes back into the stream, so the decoder needs
 * that much history. The answer is the smallest `k` whose preceding frames cover the reservoir —
 * one frame at 192 kbps (626 bytes), more at low bitrates.
 *
 * Returns null when the file cannot supply enough history, which happens near the very start and
 * on pathologically low bitrates; such a range is not eligible for a partial decode.
 */
export function preambleFrameCount(index: Mp3FrameIndex, frame: number): number | null {
  const target = offsetOf(index, frame);
  if (target === null) {
    return null;
  }
  for (let k = 1; k <= MP3_MAX_PREAMBLE_FRAMES; k += 1) {
    const candidate = offsetOf(index, frame - k);
    if (candidate === null) {
      // Ran off the start of the stream: there is no earlier data, so there is nothing to carry
      // over and the frame is self-contained by construction.
      return frame - k < 0 ? Math.max(0, frame) : null;
    }
    if (target - candidate >= MP3_BIT_RESERVOIR_BYTES) {
      return k;
    }
  }
  return null;
}

/** Resident cost of the table, for the byte-budgeted cache that owns it. */
export function indexBytes(index: Mp3FrameIndex): number {
  return index.byteOffsets.byteLength;
}

/**
 * Duration the frame table can vouch for, or null when it cannot.
 *
 * ORDER IS LOAD-BEARING, and getting it wrong disabled streaming for every MP3 in a real library.
 * A freshly built index has `frameCount === 0` — the table is scanned lazily, and
 * `fillConstantBitrateIndex` only runs for a stream whose opening frames share a size. At the most
 * common encoder setting they do not: 192 kbps / 44.1 kHz gives a frame of 626.94 bytes, so the
 * padding bit alternates 626/627 and `constantFrameBytes` resolves to null. A `frameCount === 0`
 * check placed first therefore returned null for EVERY such file, shadowing the declared count
 * below it — which is the only reason `declaredFrameCount` is parsed at all.
 *
 * Downstream, no duration means `planMediaSegments` bails, no head is built, and an untrimmed track
 * — which `shouldReadRange` correctly declines, because its window IS the file — falls through to a
 * full decode. 300 s of stereo is 105.8 MB resident and a panel of twelve is 1.27 GB, which is
 * precisely the jetsam the byte-range work exists to prevent.
 *
 * Nothing failed, because the WAV probe reports `frameCount / sampleRate` from the container
 * directly and every fixture in the suite is WAV.
 */
export function getIndexedDurationSeconds(index: Mp3FrameIndex): number | null {
  const { samplesPerFrame, sampleRate, declaredFrameCount } = index.info;
  if (sampleRate <= 0) {
    return null;
  }
  // A completed scan is the only exact source; prefer it whenever it exists.
  if (index.complete && index.frameCount > 0) {
    return (index.frameCount * samplesPerFrame) / sampleRate;
  }
  // The encoder's own tally from a Xing/VBRI frame. Trusted for DURATION only, never for seeking —
  // the accompanying TOC is about 1 % accurate, three orders of magnitude past a sample-accurate
  // splice.
  if (declaredFrameCount !== null && declaredFrameCount > 0) {
    return (declaredFrameCount * samplesPerFrame) / sampleRate;
  }
  return null;
}

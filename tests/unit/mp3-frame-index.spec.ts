import { expect, test } from "@playwright/test";

import {
  appendFrames,
  byteRangeForFrames,
  createMp3FrameIndex,
  fillConstantBitrateIndex,
  findFirstFrame,
  findTrailerOffset,
  frameForSample,
  getIndexedDurationSeconds,
  indexBytes,
  MP3_BIT_RESERVOIR_BYTES,
  parseId3v2Size,
  parseMp3StreamInfo,
  preambleFrameCount,
  readFrameHeader,
  sampleForFrame
} from "../../src/features/playback/model/mp3FrameIndex";

/**
 * The indexer only ever parses headers, so a synthetic stream of real headers plus filler is a
 * complete test input — no encoder and no committed binary needed. Frame payloads are filler on
 * purpose: nothing here decodes audio.
 */

const VERSION_BITS = { mpeg1: 0x03, mpeg2: 0x02, "mpeg2.5": 0x00 } as const;
const BITRATES_MPEG1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_MPEG2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const RATES = {
  mpeg1: [44100, 48000, 32000],
  mpeg2: [22050, 24000, 16000],
  "mpeg2.5": [11025, 12000, 8000]
} as const;

type Version = keyof typeof VERSION_BITS;

type FrameSpec = {
  version?: Version;
  bitrateKbps: number;
  sampleRate?: number;
  padding?: boolean;
  channels?: 1 | 2;
};

function frameByteLength(spec: FrameSpec) {
  const version = spec.version ?? "mpeg1";
  const sampleRate = spec.sampleRate ?? RATES[version][0];
  const samplesPerFrame = version === "mpeg1" ? 1152 : 576;
  return (
    Math.floor(((samplesPerFrame / 8) * spec.bitrateKbps * 1000) / sampleRate) +
    (spec.padding ? 1 : 0)
  );
}

function makeFrame(spec: FrameSpec): Uint8Array {
  const version = spec.version ?? "mpeg1";
  const sampleRate = spec.sampleRate ?? RATES[version][0];
  const rateIndex = (RATES[version] as readonly number[]).indexOf(sampleRate);
  const table = version === "mpeg1" ? BITRATES_MPEG1 : BITRATES_MPEG2;
  const bitrateIndex = table.indexOf(spec.bitrateKbps);
  expect(rateIndex, `unknown sample rate ${String(sampleRate)}`).toBeGreaterThanOrEqual(0);
  expect(bitrateIndex, `unknown bitrate ${String(spec.bitrateKbps)}`).toBeGreaterThan(0);

  const length = frameByteLength(spec);
  const bytes = new Uint8Array(length);
  bytes[0] = 0xff;
  // sync high bits | version | Layer III (0b01) | protection bit set (no CRC)
  bytes[1] = 0xe0 | (VERSION_BITS[version] << 3) | (0x01 << 1) | 0x01;
  bytes[2] = (bitrateIndex << 4) | (rateIndex << 2) | (spec.padding ? 0x02 : 0x00);
  bytes[3] = (spec.channels ?? 2) === 1 ? 0xc0 : 0x00;
  // Filler that is deliberately not 0xFF, so it cannot be mistaken for a sync word.
  bytes.fill(0x5a, 4);
  return bytes;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function makeId3v2(payloadBytes: number, withFooter = false): Uint8Array {
  const header = new Uint8Array(10 + payloadBytes + (withFooter ? 10 : 0));
  header[0] = 0x49;
  header[1] = 0x44;
  header[2] = 0x33;
  header[3] = 0x04;
  header[5] = withFooter ? 0x10 : 0x00;
  header[6] = (payloadBytes >>> 21) & 0x7f;
  header[7] = (payloadBytes >>> 14) & 0x7f;
  header[8] = (payloadBytes >>> 7) & 0x7f;
  header[9] = payloadBytes & 0x7f;
  // Cover-art-like payload containing a byte pair that looks like a sync word, so the scan is
  // forced to honour the declared tag size rather than hunting for 0xFF.
  header.fill(0x00, 10);
  if (payloadBytes > 4) {
    header[10] = 0xff;
    header[11] = 0xfb;
  }
  return header;
}

function ascii(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index);
  }
  return bytes;
}

function buildIndex(stream: Uint8Array, audioEndOffset?: number) {
  const info = parseMp3StreamInfo({
    head: stream,
    fileSize: stream.length,
    audioEndOffset
  });
  expect(info).not.toBeNull();
  if (!info) {
    throw new Error("unreachable");
  }
  const index = createMp3FrameIndex(info);
  appendFrames(index, stream, 0);
  return { info, index };
}

test.describe("readFrameHeader", () => {
  test("parses an MPEG-1 Layer III 192 kbps frame as 626 bytes", () => {
    // 626 is the frame size measured on a real 192 kbps CBR file during the step-0 probe, so this
    // pins the arithmetic against reality rather than against itself.
    const header = readFrameHeader(makeFrame({ bitrateKbps: 192 }), 0);
    expect(header).toEqual({
      version: "mpeg1",
      bitrateKbps: 192,
      sampleRate: 44100,
      channels: 2,
      samplesPerFrame: 1152,
      frameBytes: 626
    });
  });

  test("MPEG-2 Layer III carries 576 samples per frame, not 1152", () => {
    const header = readFrameHeader(
      makeFrame({ version: "mpeg2", bitrateKbps: 64, sampleRate: 24000, channels: 1 }),
      0
    );
    expect(header?.samplesPerFrame).toBe(576);
    expect(header?.version).toBe("mpeg2");
    expect(header?.channels).toBe(1);
    // 72000 * 64 / 24000, not 144000 * 64 / 24000.
    expect(header?.frameBytes).toBe(192);
  });

  test("MPEG-2.5 is recognised and also uses 576 samples", () => {
    const header = readFrameHeader(
      makeFrame({ version: "mpeg2.5", bitrateKbps: 32, sampleRate: 8000, channels: 1 }),
      0
    );
    expect(header?.version).toBe("mpeg2.5");
    expect(header?.samplesPerFrame).toBe(576);
  });

  test("the padding bit adds exactly one byte", () => {
    const plain = readFrameHeader(makeFrame({ bitrateKbps: 128 }), 0);
    const padded = readFrameHeader(makeFrame({ bitrateKbps: 128, padding: true }), 0);
    expect(padded?.frameBytes).toBe((plain?.frameBytes ?? 0) + 1);
  });

  test("rejects an ADTS AAC header, which shares the sync pattern", () => {
    // 0xFF 0xF1 is ADTS: sync matches, but the layer bits are 00, not Layer III. Dropping the
    // layer check is the most likely way to misdetect an .aac file as MP3.
    const adts = new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc]);
    expect(readFrameHeader(adts, 0)).toBeNull();
  });

  test("rejects reserved version and free/bad bitrate indices", () => {
    const reservedVersion = makeFrame({ bitrateKbps: 128 });
    reservedVersion[1] = 0xe0 | (0x01 << 3) | (0x01 << 1) | 0x01;
    expect(readFrameHeader(reservedVersion, 0)).toBeNull();

    const freeBitrate = makeFrame({ bitrateKbps: 128 });
    freeBitrate[2] = 0x00;
    expect(readFrameHeader(freeBitrate, 0)).toBeNull();

    const badBitrate = makeFrame({ bitrateKbps: 128 });
    badBitrate[2] = 0xf0;
    expect(readFrameHeader(badBitrate, 0)).toBeNull();
  });

  test("returns null rather than reading past the end of the buffer", () => {
    expect(readFrameHeader(new Uint8Array([0xff, 0xfb, 0xb0]), 0)).toBeNull();
    expect(readFrameHeader(makeFrame({ bitrateKbps: 128 }), 10_000)).toBeNull();
  });
});

test.describe("parseId3v2Size", () => {
  test("reports header plus syncsafe payload", () => {
    expect(parseId3v2Size(makeId3v2(300_000))).toBe(10 + 300_000);
  });

  test("adds the footer when its flag is set", () => {
    expect(parseId3v2Size(makeId3v2(1000, true))).toBe(10 + 1000 + 10);
  });

  test("is zero when there is no tag", () => {
    expect(parseId3v2Size(makeFrame({ bitrateKbps: 128 }))).toBe(0);
  });

  test("refuses a size field whose high bits are set, instead of decoding it wrong", () => {
    const tag = makeId3v2(1000);
    tag[7] = 0x80;
    expect(parseId3v2Size(tag)).toBe(0);
  });
});

test.describe("findFirstFrame", () => {
  test("requires two consecutive agreeing headers, so a planted sync word loses", () => {
    // A lone 0xFF 0xFB pair that parses as a header but is followed by junk must be skipped: an
    // 11-bit sync pattern occurs by chance roughly every 2 KB.
    const decoy = new Uint8Array(200);
    decoy.fill(0x5a);
    decoy[100] = 0xff;
    decoy[101] = 0xfb;
    decoy[102] = 0xb0;
    decoy[103] = 0x00;

    const stream = concat([decoy, makeFrame({ bitrateKbps: 192 }), makeFrame({ bitrateKbps: 192 })]);
    expect(findFirstFrame(stream, 0, stream.length)).toBe(200);
  });

  test("skips an ID3v2 tag whose payload contains a sync-looking byte pair", () => {
    const tag = makeId3v2(2048);
    const stream = concat([tag, makeFrame({ bitrateKbps: 128 }), makeFrame({ bitrateKbps: 128 })]);
    expect(findFirstFrame(stream, parseId3v2Size(tag), stream.length)).toBe(tag.length);
  });

  test("returns null when there is no frame at all", () => {
    const junk = new Uint8Array(500);
    junk.fill(0x5a);
    expect(findFirstFrame(junk, 0, junk.length)).toBeNull();
  });
});

test.describe("parseMp3StreamInfo", () => {
  test("proposes constantFrameBytes for a CBR stream", () => {
    const stream = concat(
      Array.from({ length: 10 }, () => makeFrame({ bitrateKbps: 192 }))
    );
    const info = parseMp3StreamInfo({ head: stream, fileSize: stream.length });
    expect(info?.constantFrameBytes).toBe(626);
    expect(info?.firstFrameOffset).toBe(0);
    expect(info?.samplesPerFrame).toBe(1152);
    expect(info?.hasXingHeader).toBe(false);
  });

  test("withholds constantFrameBytes as soon as a frame size differs", () => {
    const stream = concat([
      makeFrame({ bitrateKbps: 192 }),
      makeFrame({ bitrateKbps: 192 }),
      makeFrame({ bitrateKbps: 128 }),
      makeFrame({ bitrateKbps: 192 })
    ]);
    expect(parseMp3StreamInfo({ head: stream, fileSize: stream.length })?.constantFrameBytes).toBeNull();
  });

  test("a padded frame among unpadded ones is not constant bitrate", () => {
    // A CBR stream still alternates padding to hold the exact rate, so treating "same bitrate" as
    // "same frame size" would produce an index that drifts by one byte per padded frame.
    const stream = concat([
      makeFrame({ bitrateKbps: 128 }),
      makeFrame({ bitrateKbps: 128, padding: true }),
      makeFrame({ bitrateKbps: 128 })
    ]);
    expect(parseMp3StreamInfo({ head: stream, fileSize: stream.length })?.constantFrameBytes).toBeNull();
  });

  test("a Xing header withholds constantFrameBytes even when the opening frames look uniform", () => {
    const first = makeFrame({ bitrateKbps: 128 });
    // Xing sits after the side info: 32 bytes for MPEG-1 stereo.
    first.set(ascii("Xing"), 4 + 32);
    first[4 + 32 + 7] = 0x01;
    first[4 + 32 + 8] = 0x00;
    first[4 + 32 + 9] = 0x00;
    first[4 + 32 + 10] = 0x02;
    first[4 + 32 + 11] = 0x9a;
    const stream = concat([first, makeFrame({ bitrateKbps: 128 }), makeFrame({ bitrateKbps: 128 })]);

    const info = parseMp3StreamInfo({ head: stream, fileSize: stream.length });
    expect(info?.hasXingHeader).toBe(true);
    expect(info?.declaredFrameCount).toBe(666);
    expect(info?.constantFrameBytes).toBeNull();
  });

  test("returns null for a stream with no frames", () => {
    const junk = new Uint8Array(500);
    junk.fill(0x5a);
    expect(parseMp3StreamInfo({ head: junk, fileSize: junk.length })).toBeNull();
  });
});

test.describe("findTrailerOffset", () => {
  test("excludes an ID3v1 trailer from the audio", () => {
    const trailer = new Uint8Array(128);
    trailer.set(ascii("TAG"), 0);
    const stream = concat([makeFrame({ bitrateKbps: 128 }), trailer]);
    expect(findTrailerOffset(stream, stream.length)).toBe(stream.length - 128);
  });

  test("excludes an APE trailer", () => {
    const trailer = new Uint8Array(64);
    trailer.set(ascii("APETAGEX"), 0);
    const stream = concat([makeFrame({ bitrateKbps: 128 }), trailer]);
    expect(findTrailerOffset(stream, stream.length)).toBe(stream.length - 64);
  });

  test("leaves the end alone when there is no trailer", () => {
    const stream = makeFrame({ bitrateKbps: 128 });
    expect(findTrailerOffset(stream, stream.length)).toBe(stream.length);
  });
});

test.describe("appendFrames", () => {
  test("indexes every frame of a VBR stream, where division cannot work", () => {
    const specs: FrameSpec[] = [
      { bitrateKbps: 128 },
      { bitrateKbps: 192 },
      { bitrateKbps: 96 },
      { bitrateKbps: 320 },
      { bitrateKbps: 128, padding: true }
    ];
    const stream = concat(specs.map(makeFrame));
    const { index } = buildIndex(stream);

    expect(index.frameCount).toBe(5);
    let expectedOffset = 0;
    for (const [position, spec] of specs.entries()) {
      expect(index.byteOffsets[position]).toBe(expectedOffset);
      expectedOffset += frameByteLength(spec);
    }
    expect(index.complete).toBe(true);
  });

  test("resumes across windows without splitting or skipping a frame", () => {
    const stream = concat(Array.from({ length: 12 }, () => makeFrame({ bitrateKbps: 192 })));
    const info = parseMp3StreamInfo({ head: stream, fileSize: stream.length });
    if (!info) {
      throw new Error("unreachable");
    }
    const index = createMp3FrameIndex(info);

    // A window boundary deliberately falling mid-frame: 1000 is not a multiple of 626.
    const firstWindow = stream.subarray(0, 1000);
    appendFrames(index, firstWindow, 0);
    expect(index.frameCount).toBe(1);
    expect(index.scannedToByte).toBe(626);

    appendFrames(index, stream.subarray(index.scannedToByte), index.scannedToByte);
    expect(index.frameCount).toBe(12);
    expect(index.byteOffsets[11]).toBe(626 * 11);
  });

  test("refuses a stream that changes sample rate mid-file", () => {
    // Such a file would break `frame * samplesPerFrame`, so the index stops rather than producing
    // entries whose sample positions are wrong.
    const stream = concat([
      makeFrame({ bitrateKbps: 128 }),
      makeFrame({ bitrateKbps: 128 }),
      makeFrame({ bitrateKbps: 128, sampleRate: 48000 }),
      makeFrame({ bitrateKbps: 128, sampleRate: 48000 })
    ]);
    const { index } = buildIndex(stream);
    expect(index.frameCount).toBe(2);
    expect(index.complete).toBe(true);
  });

  test("stops at audioEndOffset so a trailer is never indexed as a frame", () => {
    const frames = concat(Array.from({ length: 4 }, () => makeFrame({ bitrateKbps: 192 })));
    const trailer = new Uint8Array(128);
    trailer.set(ascii("TAG"), 0);
    const stream = concat([frames, trailer]);
    const { index } = buildIndex(stream, frames.length);
    expect(index.frameCount).toBe(4);
  });
});

test.describe("fillConstantBitrateIndex", () => {
  test("fills arithmetically and agrees with a scan of the same stream", () => {
    const stream = concat(Array.from({ length: 40 }, () => makeFrame({ bitrateKbps: 192 })));
    const scanned = buildIndex(stream).index;

    const info = parseMp3StreamInfo({ head: stream, fileSize: stream.length });
    if (!info) {
      throw new Error("unreachable");
    }
    const arithmetic = createMp3FrameIndex(info);
    expect(fillConstantBitrateIndex(arithmetic)).toBe(40);
    expect(arithmetic.frameCount).toBe(scanned.frameCount);
    expect([...arithmetic.byteOffsets.subarray(0, 40)]).toEqual([
      ...scanned.byteOffsets.subarray(0, 40)
    ]);
  });

  test("does nothing when the stream is not constant bitrate", () => {
    const stream = concat([makeFrame({ bitrateKbps: 128 }), makeFrame({ bitrateKbps: 192 })]);
    const info = parseMp3StreamInfo({ head: stream, fileSize: stream.length });
    if (!info) {
      throw new Error("unreachable");
    }
    expect(fillConstantBitrateIndex(createMp3FrameIndex(info))).toBe(0);
  });
});

test.describe("sample and byte mapping", () => {
  test("sample positions are multiples of the version's frame size", () => {
    const stream = concat(Array.from({ length: 6 }, () => makeFrame({ bitrateKbps: 192 })));
    const { index } = buildIndex(stream);
    expect(sampleForFrame(index, 0)).toBe(0);
    expect(sampleForFrame(index, 3)).toBe(3 * 1152);
    expect(frameForSample(index, 3 * 1152)).toBe(3);
    // Anywhere inside a frame maps to that frame.
    expect(frameForSample(index, 3 * 1152 + 1151)).toBe(3);
  });

  test("a sample past the end maps to null, never to frame 0", () => {
    const stream = concat(Array.from({ length: 3 }, () => makeFrame({ bitrateKbps: 192 })));
    const { index } = buildIndex(stream);
    expect(frameForSample(index, 99 * 1152)).toBeNull();
    expect(frameForSample(index, -1)).toBeNull();
  });

  test("byteRangeForFrames round-trips to the frames' own offsets", () => {
    const stream = concat(Array.from({ length: 10 }, () => makeFrame({ bitrateKbps: 192 })));
    const { index } = buildIndex(stream);
    expect(byteRangeForFrames(index, 2, 5)).toEqual({ start: 2 * 626, end: 5 * 626 });
  });

  test("a range ending past the last frame ends at audioEndOffset", () => {
    const stream = concat(Array.from({ length: 4 }, () => makeFrame({ bitrateKbps: 192 })));
    const { index, info } = buildIndex(stream);
    expect(byteRangeForFrames(index, 2, 99)).toEqual({ start: 2 * 626, end: info.audioEndOffset });
  });

  test("an out-of-range or empty request returns null rather than offset 0", () => {
    // Returning 0 would mean "decode from the start of the file", which is the worst possible
    // failure mode: it plays confidently wrong audio instead of failing.
    const stream = concat(Array.from({ length: 4 }, () => makeFrame({ bitrateKbps: 192 })));
    const { index } = buildIndex(stream);
    expect(byteRangeForFrames(index, 99, 120)).toBeNull();
    expect(byteRangeForFrames(index, 2, 2)).toBeNull();
    expect(byteRangeForFrames(index, 3, 1)).toBeNull();
  });
});

test.describe("preambleFrameCount", () => {
  test("one frame is enough at 192 kbps, matching the measured file", () => {
    // 626 bytes per frame already exceeds the 511-byte reservoir, and the step-0 probe confirmed a
    // single preamble frame produced a bit-identical decode on a real 192 kbps file.
    const stream = concat(Array.from({ length: 20 }, () => makeFrame({ bitrateKbps: 192 })));
    const { index } = buildIndex(stream);
    expect(preambleFrameCount(index, 10)).toBe(1);
  });

  test("needs more frames as the bitrate falls", () => {
    const at128 = buildIndex(
      concat(Array.from({ length: 20 }, () => makeFrame({ bitrateKbps: 128 })))
    ).index;
    // 417 bytes per frame: one frame is not enough, two are.
    expect(preambleFrameCount(at128, 10)).toBe(2);

    const at32 = buildIndex(
      concat(Array.from({ length: 20 }, () => makeFrame({ bitrateKbps: 32, channels: 1 })))
    ).index;
    // 104 bytes per frame, so it takes five to cover 511.
    expect(preambleFrameCount(at32, 10)).toBe(5);
  });

  test("the reservoir limit is the threshold that decides the count", () => {
    const stream = concat(Array.from({ length: 20 }, () => makeFrame({ bitrateKbps: 128 })));
    const { index } = buildIndex(stream);
    const count = preambleFrameCount(index, 10);
    if (count === null) {
      throw new Error("expected a preamble count");
    }
    const target = index.byteOffsets[10] ?? 0;
    const covered = target - (index.byteOffsets[10 - count] ?? 0);
    const oneFewer = target - (index.byteOffsets[10 - (count - 1)] ?? 0);
    expect(covered).toBeGreaterThanOrEqual(MP3_BIT_RESERVOIR_BYTES);
    expect(oneFewer).toBeLessThan(MP3_BIT_RESERVOIR_BYTES);
  });

  test("the reservoir threshold includes a span of exactly 511 bytes", () => {
    // Built from offsets directly rather than from a synthesised stream, and deliberately so.
    // Layer III frame sizes are a discrete set (104, 130, 156, 182, 208, 261, 313, 365, 417, 522,
    // 626, 730, 835, 1044 at 44.1 kHz), and no sum of them appears to land on exactly 511 — so the
    // boundary may be unreachable from any real file. The function's contract at the boundary still
    // has to be pinned, otherwise flipping `>=` to `>` changes nothing any test can see. Found by a
    // mutation round, where exactly that flip survived.
    const index = createMp3FrameIndex({
      version: "mpeg1",
      sampleRate: 44100,
      channels: 2,
      samplesPerFrame: 1152,
      firstFrameOffset: 0,
      audioEndOffset: 2000,
      constantFrameBytes: null,
      hasXingHeader: false,
      declaredFrameCount: null
    });
    for (const offset of [0, 300, 700, 1211]) {
      index.byteOffsets[index.frameCount] = offset;
      index.frameCount += 1;
    }

    // Frame 3 sits exactly MP3_BIT_RESERVOIR_BYTES after frame 2, so one preamble frame covers the
    // reservoir and the answer must be 1, not 2.
    expect((index.byteOffsets[3] ?? 0) - (index.byteOffsets[2] ?? 0)).toBe(MP3_BIT_RESERVOIR_BYTES);
    expect(preambleFrameCount(index, 3)).toBe(1);
  });

  test("a frame near the very start needs only the frames that exist before it", () => {
    const stream = concat(Array.from({ length: 20 }, () => makeFrame({ bitrateKbps: 32, channels: 1 })));
    const { index } = buildIndex(stream);
    // Frame 1 has no five frames of history; there is nothing earlier to carry over, so the frame
    // is self-contained and the answer is "everything before it".
    expect(preambleFrameCount(index, 1)).toBe(1);
    expect(preambleFrameCount(index, 0)).toBe(0);
  });

  test("returns null for a frame that is not in the index", () => {
    const stream = concat(Array.from({ length: 4 }, () => makeFrame({ bitrateKbps: 192 })));
    const { index } = buildIndex(stream);
    expect(preambleFrameCount(index, 99)).toBeNull();
  });
});

test("indexBytes reports the table's real cost", () => {
  const stream = concat(Array.from({ length: 5 }, () => makeFrame({ bitrateKbps: 192 })));
  const { index } = buildIndex(stream);
  // 1024 slots of Uint32 until the table doubles: the point is that the cost is bytes, not entries,
  // because an hour-long set is 137 800 frames and 32 of those would be 17 MB, not 1 MB.
  expect(indexBytes(index)).toBe(index.byteOffsets.byteLength);
  expect(indexBytes(index)).toBe(4096);
});

/**
 * `getIndexedDurationSeconds` decides whether a media can be streamed at all: `planMediaSegments`
 * bails on a null duration, and an untrimmed track that cannot be streamed pays a full decode.
 *
 * The branch ORDER is the whole subject here. A freshly built index always has `frameCount === 0`,
 * so a guard on that placed before the declared-count fallback returns null for every file whose
 * opening frames are not uniform — which is every 192 kbps / 44.1 kHz file, because the frame is
 * 626.94 bytes and the padding bit alternates 626/627. Measured on a real 16-file corpus:
 * `constantFrameBytes` was null for all sixteen.
 */
test.describe("indexed duration", () => {
  function makeIndex(overrides: {
    declaredFrameCount?: number | null;
    sampleRate?: number;
    samplesPerFrame?: number;
  }) {
    return createMp3FrameIndex({
      version: "mpeg1",
      sampleRate: overrides.sampleRate ?? 44100,
      channels: 2,
      samplesPerFrame: overrides.samplesPerFrame ?? 1152,
      firstFrameOffset: 0,
      audioEndOffset: 100_000,
      constantFrameBytes: null,
      hasXingHeader: overrides.declaredFrameCount != null,
      declaredFrameCount: overrides.declaredFrameCount ?? null
    });
  }

  test("uses the declared frame count while the table is still empty", () => {
    // The case that was broken: nothing has been scanned yet, but the encoder already told us.
    const index = makeIndex({ declaredFrameCount: 11_628 });
    expect(index.frameCount).toBe(0);
    expect(getIndexedDurationSeconds(index)).toBeCloseTo((11_628 * 1152) / 44100, 6);
  });

  test("prefers a completed scan over the declared count", () => {
    // A scan is exact; a Xing tally can disagree with the stream by a frame or two.
    const index = makeIndex({ declaredFrameCount: 11_628 });
    index.byteOffsets[0] = 0;
    index.frameCount = 10;
    index.complete = true;
    expect(getIndexedDurationSeconds(index)).toBeCloseTo((10 * 1152) / 44100, 6);
  });

  test("ignores a partial scan in favour of the declared count", () => {
    // Mid-scan the table covers only what playback has needed so far, so its count is not a
    // duration. Reading it as one would shorten every cue whose trim end is "to the end".
    const index = makeIndex({ declaredFrameCount: 11_628 });
    index.byteOffsets[0] = 0;
    index.frameCount = 10;
    index.complete = false;
    expect(getIndexedDurationSeconds(index)).toBeCloseTo((11_628 * 1152) / 44100, 6);
  });

  test("a completed scan with no frames defers to the declared count", () => {
    // The boundary between the scan being authoritative and the scan saying nothing. Relaxing it
    // survived a mutation round: an empty completed index would report 0 s, planMediaSegments
    // would bail on a zero duration, and that media would pay a full decode.
    const index = makeIndex({ declaredFrameCount: 11_628 });
    index.complete = true;
    expect(index.frameCount).toBe(0);
    expect(getIndexedDurationSeconds(index)).toBeCloseTo((11_628 * 1152) / 44100, 6);
  });

  test("returns null when neither a completed scan nor a declared count exists", () => {
    // Nine of sixteen files in the real corpus land here — no Xing, no Info, no VBRI. They are
    // streamable only because the caller passes the duration it measured at import.
    expect(getIndexedDurationSeconds(makeIndex({ declaredFrameCount: null }))).toBeNull();
  });

  test("treats a zero or negative declared count as no answer", () => {
    expect(getIndexedDurationSeconds(makeIndex({ declaredFrameCount: 0 }))).toBeNull();
  });

  test("reports null rather than dividing by a zero sample rate", () => {
    expect(getIndexedDurationSeconds(makeIndex({ declaredFrameCount: 100, sampleRate: 0 }))).toBeNull();
  });

  test("scales with samplesPerFrame, which is 576 on MPEG-2", () => {
    // A hardcoded 1152 would double the reported duration of a 24 kHz file.
    const index = makeIndex({ declaredFrameCount: 1000, samplesPerFrame: 576, sampleRate: 24000 });
    expect(getIndexedDurationSeconds(index)).toBeCloseTo((1000 * 576) / 24000, 6);
  });
});

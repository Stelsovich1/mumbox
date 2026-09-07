import { expect, test } from "@playwright/test";

import { AudioBufferFactory, ReadableAudioBuffer } from "../../src/features/playback/model/decodeAudio";
import {
  decodeWavFrames,
  parseWavStreamInfo,
  wavByteRangeForFrames
} from "../../src/features/playback/model/wavPartial";

/**
 * The WAV path never calls the browser's decoder, so its correctness is entirely arithmetic and
 * entirely checkable here, with exact sample values. That is why WAV ships before MP3: nothing
 * about a device can change what `value / 32768` produces.
 *
 * The fixture encodes both position and channel into every sample — the idiom `audio-slice.spec.ts`
 * already uses — so a wrong byte offset, a wrong length and a channel swap are each visible as a
 * specific number rather than as "some audio".
 */

const CHANNEL_STRIDE = 10_000;

function makeBufferFactory(): AudioBufferFactory {
  return (channels, length, sampleRate) => {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    const buffer: ReadableAudioBuffer = {
      length,
      duration: length / sampleRate,
      sampleRate,
      numberOfChannels: channels,
      getChannelData: (channel) => {
        const target = data[channel];
        if (!target) {
          throw new Error(`no channel ${String(channel)}`);
        }
        return target;
      }
    };
    return buffer;
  };
}

function ascii(text: string): number[] {
  return Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));
}

type WavOptions = {
  frames: number;
  channels?: 1 | 2;
  sampleRate?: number;
  /** Extra chunks written between `fmt ` and `data`, as real files do. */
  extraChunks?: { id: string; payload: number[] }[];
  /** Written into the `data` chunk's size field instead of the real size. */
  declaredDataSize?: number;
  audioFormat?: number;
  bitsPerSample?: number;
  /** Emits a 40-byte extensible `fmt ` chunk carrying a SubFormat GUID. */
  extensibleSubFormat?: number;
};

function makeWav(options: WavOptions): Uint8Array {
  const channels = options.channels ?? 2;
  const sampleRate = options.sampleRate ?? 44100;
  const bitsPerSample = options.bitsPerSample ?? 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const dataBytes = options.frames * blockAlign;

  const fmtPayload: number[] = [];
  const pushU16 = (target: number[], value: number) => {
    target.push(value & 0xff, (value >> 8) & 0xff);
  };
  const pushU32 = (target: number[], value: number) => {
    target.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff);
  };

  pushU16(fmtPayload, options.extensibleSubFormat === undefined ? (options.audioFormat ?? 1) : 0xfffe);
  pushU16(fmtPayload, channels);
  pushU32(fmtPayload, sampleRate);
  pushU32(fmtPayload, sampleRate * blockAlign);
  pushU16(fmtPayload, blockAlign);
  pushU16(fmtPayload, bitsPerSample);
  if (options.extensibleSubFormat !== undefined) {
    pushU16(fmtPayload, 22);
    pushU16(fmtPayload, bitsPerSample);
    pushU32(fmtPayload, channels === 1 ? 0x4 : 0x3);
    pushU16(fmtPayload, options.extensibleSubFormat);
    // The rest of the SubFormat GUID is a fixed suffix and carries no information here.
    for (let index = 0; index < 14; index += 1) {
      fmtPayload.push(0);
    }
  }

  const chunks: number[] = [];
  const pushChunk = (id: string, payload: number[]) => {
    chunks.push(...ascii(id));
    pushU32(chunks, payload.length);
    chunks.push(...payload);
    if (payload.length % 2 === 1) {
      chunks.push(0);
    }
  };

  pushChunk("fmt ", fmtPayload);
  for (const extra of options.extraChunks ?? []) {
    pushChunk(extra.id, extra.payload);
  }

  chunks.push(...ascii("data"));
  pushU32(chunks, options.declaredDataSize ?? dataBytes);

  const header = [...ascii("RIFF")];
  pushU32(header, 4 + chunks.length + dataBytes);
  header.push(...ascii("WAVE"));

  const bytes = new Uint8Array(header.length + chunks.length + dataBytes);
  bytes.set(header, 0);
  bytes.set(chunks, header.length);

  const dataOffset = header.length + chunks.length;
  const view = new DataView(bytes.buffer);
  for (let frame = 0; frame < options.frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const offset = dataOffset + frame * blockAlign + channel * bytesPerSample;
      const value = frame + channel * CHANNEL_STRIDE;
      if (bitsPerSample === 8) {
        view.setUint8(offset, value & 0xff);
      } else if (bitsPerSample === 16) {
        view.setInt16(offset, value, true);
      } else if (bitsPerSample === 32) {
        view.setFloat32(offset, value / 32768, true);
      } else {
        view.setUint8(offset, value & 0xff);
        view.setUint8(offset + 1, (value >> 8) & 0xff);
        view.setInt8(offset + 2, value >> 16);
      }
    }
  }

  return bytes;
}

/** Exact float a 16-bit container sample becomes. */
function pcm16Value(frame: number, channel: number) {
  return (frame + channel * CHANNEL_STRIDE) / 32768;
}

/** Reads a sample, failing loudly instead of coercing an out-of-range index to 0. */
function sampleAt(buffer: ReadableAudioBuffer, channel: number, index: number): number {
  const value = buffer.getChannelData(channel)[index];
  if (value === undefined) {
    throw new Error(`no sample at channel ${String(channel)} index ${String(index)}`);
  }
  return value;
}

test.describe("parseWavStreamInfo", () => {
  test("reads a canonical 44-byte header", () => {
    const info = parseWavStreamInfo(makeWav({ frames: 1000 }), 44 + 4000);
    expect(info).toEqual({
      sampleRate: 44100,
      channels: 2,
      format: "pcm16",
      bytesPerFrame: 4,
      dataOffset: 44,
      dataBytes: 4000,
      frameCount: 1000
    });
  });

  test("finds data after LIST, fact and JUNK chunks instead of assuming offset 36", () => {
    // Every fixture in this repo is canonical, but a real DAW file is not. Assuming offset 36 would
    // read metadata as audio, which is the "pressed a pad and heard garbage" failure.
    const bytes = makeWav({
      frames: 100,
      extraChunks: [
        { id: "LIST", payload: [...ascii("INFO"), ...ascii("ISFT"), 0, 0, 0, 0] },
        { id: "fact", payload: [100, 0, 0, 0] },
        { id: "JUNK", payload: Array.from({ length: 17 }, () => 0) }
      ]
    });
    const info = parseWavStreamInfo(bytes, bytes.length);
    expect(info?.dataOffset).toBeGreaterThan(44);
    expect(info?.frameCount).toBe(100);
    if (!info) {
      throw new Error("unreachable");
    }

    // And the audio actually starts there: frame 0 channel 0 must be 0, frame 1 must be 1.
    const range = wavByteRangeForFrames(info, 0, 2);
    const decoded = decodeWavFrames({
      info,
      bytes: bytes.subarray(range.start, range.end),
      frames: range.frames,
      mono: false,
      createBuffer: makeBufferFactory()
    });
    expect(decoded.getChannelData(0)[0]).toBeCloseTo(pcm16Value(0, 0), 10);
    expect(decoded.getChannelData(0)[1]).toBeCloseTo(pcm16Value(1, 0), 10);
  });

  test("an odd-sized chunk is padded to even, so the next chunk is still found", () => {
    const bytes = makeWav({
      frames: 50,
      extraChunks: [{ id: "id3 ", payload: Array.from({ length: 7 }, () => 1) }]
    });
    expect(parseWavStreamInfo(bytes, bytes.length)?.frameCount).toBe(50);
  });

  test("an extensible header carrying a PCM SubFormat is treated as PCM", () => {
    const bytes = makeWav({ frames: 10, extensibleSubFormat: 1 });
    expect(parseWavStreamInfo(bytes, bytes.length)?.format).toBe("pcm16");
  });

  test("a streamed data size of 0 or 0xFFFFFFFF is clamped to the file", () => {
    const zero = makeWav({ frames: 100, declaredDataSize: 0 });
    expect(parseWavStreamInfo(zero, zero.length)?.frameCount).toBe(100);

    const sentinel = makeWav({ frames: 100, declaredDataSize: 0xffffffff });
    expect(parseWavStreamInfo(sentinel, sentinel.length)?.frameCount).toBe(100);
  });

  test("a data size larger than the file is clamped rather than trusted", () => {
    const bytes = makeWav({ frames: 100, declaredDataSize: 4_000_000 });
    expect(parseWavStreamInfo(bytes, bytes.length)?.frameCount).toBe(100);
  });

  test("recognises 24-bit and 32-bit float", () => {
    const wav24 = makeWav({ frames: 10, bitsPerSample: 24 });
    expect(parseWavStreamInfo(wav24, wav24.length)?.format).toBe("pcm24");

    const wav32 = makeWav({ frames: 10, bitsPerSample: 32, audioFormat: 3 });
    expect(parseWavStreamInfo(wav32, wav32.length)?.format).toBe("float32");
  });

  test.describe("refuses what it cannot read exactly", () => {
    test("8-bit PCM", () => {
      const bytes = makeWav({ frames: 10, bitsPerSample: 8 });
      expect(parseWavStreamInfo(bytes, bytes.length)).toBeNull();
    });

    test("a non-PCM codec such as A-law", () => {
      const bytes = makeWav({ frames: 10, audioFormat: 6 });
      expect(parseWavStreamInfo(bytes, bytes.length)).toBeNull();
    });

    test("more than two channels", () => {
      const bytes = makeWav({ frames: 10, channels: 2 });
      // Patch the channel count in the fmt payload to 6 without fixing blockAlign.
      new DataView(bytes.buffer).setUint16(22, 6, true);
      expect(parseWavStreamInfo(bytes, bytes.length)).toBeNull();
    });

    test("a blockAlign that disagrees with the channel count and bit depth", () => {
      const bytes = makeWav({ frames: 10 });
      new DataView(bytes.buffer).setUint16(32, 6, true);
      expect(parseWavStreamInfo(bytes, bytes.length)).toBeNull();
    });

    test("an RF64 file, which is not WAV", () => {
      const bytes = makeWav({ frames: 10 });
      bytes.set(ascii("RF64"), 0);
      expect(parseWavStreamInfo(bytes, bytes.length)).toBeNull();
    });

    test("a file with no data chunk at all", () => {
      const bytes = makeWav({ frames: 0 });
      bytes.set(ascii("junk"), 36);
      expect(parseWavStreamInfo(bytes, bytes.length)).toBeNull();
    });
  });
});

test.describe("wavByteRangeForFrames", () => {
  test("maps a frame window to its exact byte range", () => {
    const bytes = makeWav({ frames: 1000 });
    const info = parseWavStreamInfo(bytes, bytes.length);
    if (!info) {
      throw new Error("unreachable");
    }
    // Stereo 16-bit: 4 bytes per frame. A non-round window is the case that catches a mapping that
    // multiplies by the channel count instead of the frame size.
    expect(wavByteRangeForFrames(info, 137, 401)).toEqual({
      start: 44 + 137 * 4,
      end: 44 + 401 * 4,
      frames: 264
    });
  });

  test("clamps past the end and never returns a negative or inverted range", () => {
    const bytes = makeWav({ frames: 100 });
    const info = parseWavStreamInfo(bytes, bytes.length);
    if (!info) {
      throw new Error("unreachable");
    }
    expect(wavByteRangeForFrames(info, 90, 500)).toEqual({
      start: 44 + 90 * 4,
      end: 44 + 100 * 4,
      frames: 10
    });
    expect(wavByteRangeForFrames(info, -20, 5)).toEqual({ start: 44, end: 44 + 5 * 4, frames: 5 });
    expect(wavByteRangeForFrames(info, 60, 40).frames).toBe(0);
  });
});

test.describe("decodeWavFrames", () => {
  test("copies exactly the requested window from every channel", () => {
    const bytes = makeWav({ frames: 2000 });
    const info = parseWavStreamInfo(bytes, bytes.length);
    if (!info) {
      throw new Error("unreachable");
    }
    const range = wavByteRangeForFrames(info, 500, 900);
    const decoded = decodeWavFrames({
      info,
      bytes: bytes.subarray(range.start, range.end),
      frames: range.frames,
      mono: false,
      createBuffer: makeBufferFactory()
    });

    expect(decoded.length).toBe(400);
    expect(decoded.numberOfChannels).toBe(2);
    expect(decoded.getChannelData(0)[0]).toBeCloseTo(pcm16Value(500, 0), 10);
    expect(decoded.getChannelData(1)[0]).toBeCloseTo(pcm16Value(500, 1), 10);
    expect(decoded.getChannelData(0)[399]).toBeCloseTo(pcm16Value(899, 0), 10);
    expect(decoded.getChannelData(1)[399]).toBeCloseTo(pcm16Value(899, 1), 10);
  });

  test("a channel swap is visible, because channels carry different values", () => {
    const bytes = makeWav({ frames: 100 });
    const info = parseWavStreamInfo(bytes, bytes.length);
    if (!info) {
      throw new Error("unreachable");
    }
    const range = wavByteRangeForFrames(info, 10, 20);
    const decoded = decodeWavFrames({
      info,
      bytes: bytes.subarray(range.start, range.end),
      frames: range.frames,
      mono: false,
      createBuffer: makeBufferFactory()
    });
    const left = sampleAt(decoded, 0, 0);
    const right = sampleAt(decoded, 1, 0);
    expect(right).toBeGreaterThan(left);
    expect(right - left).toBeCloseTo(CHANNEL_STRIDE / 32768, 10);
  });

  test("mono is the channel mean, not channel 0", () => {
    const bytes = makeWav({ frames: 100 });
    const info = parseWavStreamInfo(bytes, bytes.length);
    if (!info) {
      throw new Error("unreachable");
    }
    const range = wavByteRangeForFrames(info, 7, 12);
    const decoded = decodeWavFrames({
      info,
      bytes: bytes.subarray(range.start, range.end),
      frames: range.frames,
      mono: true,
      createBuffer: makeBufferFactory()
    });
    expect(decoded.numberOfChannels).toBe(1);
    // Matches `sliceAudioBuffer`'s downmix so the two paths sound identical.
    expect(decoded.getChannelData(0)[0]).toBeCloseTo((pcm16Value(7, 0) + pcm16Value(7, 1)) / 2, 10);
  });

  test("a mono source is unaffected by the mono flag", () => {
    const bytes = makeWav({ frames: 100, channels: 1 });
    const info = parseWavStreamInfo(bytes, bytes.length);
    if (!info) {
      throw new Error("unreachable");
    }
    const range = wavByteRangeForFrames(info, 3, 8);
    const decoded = decodeWavFrames({
      info,
      bytes: bytes.subarray(range.start, range.end),
      frames: range.frames,
      mono: true,
      createBuffer: makeBufferFactory()
    });
    expect(decoded.numberOfChannels).toBe(1);
    expect(decoded.getChannelData(0)[0]).toBeCloseTo(pcm16Value(3, 0), 10);
  });

  test("decodes 32-bit float without rescaling it", () => {
    const bytes = makeWav({ frames: 100, bitsPerSample: 32, audioFormat: 3 });
    const info = parseWavStreamInfo(bytes, bytes.length);
    if (!info) {
      throw new Error("unreachable");
    }
    const range = wavByteRangeForFrames(info, 20, 25);
    const decoded = decodeWavFrames({
      info,
      bytes: bytes.subarray(range.start, range.end),
      frames: range.frames,
      mono: false,
      createBuffer: makeBufferFactory()
    });
    expect(decoded.getChannelData(0)[0]).toBeCloseTo(pcm16Value(20, 0), 6);
  });

  test("decodes 24-bit and sign-extends correctly", () => {
    const bytes = makeWav({ frames: 100, bitsPerSample: 24 });
    const info = parseWavStreamInfo(bytes, bytes.length);
    if (!info) {
      throw new Error("unreachable");
    }
    const range = wavByteRangeForFrames(info, 30, 35);
    const decoded = decodeWavFrames({
      info,
      bytes: bytes.subarray(range.start, range.end),
      frames: range.frames,
      mono: false,
      createBuffer: makeBufferFactory()
    });
    // Written as the same integer, so the value is that integer over the 24-bit full scale.
    expect(decoded.getChannelData(0)[0]).toBeCloseTo(30 / 8388608, 12);
    expect(decoded.getChannelData(1)[0]).toBeCloseTo((30 + CHANNEL_STRIDE) / 8388608, 12);
  });

  test("a negative 24-bit sample stays negative", () => {
    const bytes = makeWav({ frames: 4, channels: 1, bitsPerSample: 24 });
    const info = parseWavStreamInfo(bytes, bytes.length);
    if (!info) {
      throw new Error("unreachable");
    }
    const view = new DataView(bytes.buffer);
    // -1000 in 24-bit two's complement.
    view.setUint8(info.dataOffset, 0x18);
    view.setUint8(info.dataOffset + 1, 0xfc);
    view.setInt8(info.dataOffset + 2, -1);
    const range = wavByteRangeForFrames(info, 0, 1);
    const decoded = decodeWavFrames({
      info,
      bytes: bytes.subarray(range.start, range.end),
      frames: range.frames,
      mono: false,
      createBuffer: makeBufferFactory()
    });
    expect(decoded.getChannelData(0)[0]).toBeCloseTo(-1000 / 8388608, 12);
  });

  test("never returns an empty buffer, and produces silence for an empty range", () => {
    const bytes = makeWav({ frames: 100 });
    const info = parseWavStreamInfo(bytes, bytes.length);
    if (!info) {
      throw new Error("unreachable");
    }
    const decoded = decodeWavFrames({
      info,
      bytes: new Uint8Array(0),
      frames: 0,
      mono: false,
      createBuffer: makeBufferFactory()
    });
    // Mirrors `sliceAudioBuffer`, which also never produces a zero-length buffer.
    expect(decoded.length).toBe(1);
    expect(decoded.getChannelData(0)[0]).toBe(0);
  });

  test("a byte range shorter than the promised frame count decodes what is there", () => {
    const bytes = makeWav({ frames: 100 });
    const info = parseWavStreamInfo(bytes, bytes.length);
    if (!info) {
      throw new Error("unreachable");
    }
    const range = wavByteRangeForFrames(info, 0, 10);
    const decoded = decodeWavFrames({
      info,
      // Half the bytes, but still claiming 10 frames.
      bytes: bytes.subarray(range.start, range.start + 5 * info.bytesPerFrame),
      frames: 10,
      mono: false,
      createBuffer: makeBufferFactory()
    });
    expect(decoded.getChannelData(0)[4]).toBeCloseTo(pcm16Value(4, 0), 10);
  });
});

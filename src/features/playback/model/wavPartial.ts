/**
 * Byte-range reading of WAV, without the browser's decoder.
 *
 * WAV is already PCM, so a range of frames is a range of bytes and turning it into an `AudioBuffer`
 * is arithmetic: read Int16, divide, de-interleave. There is no `decodeAudioData` call anywhere on
 * this path.
 *
 * That is why the WAV path needs no runtime verification and ships first. Nothing about a device or
 * a browser can make `value / 32768` behave differently, so correctness here is entirely our own
 * and entirely covered by exact sample assertions in the Node unit tier. Do not add device
 * self-checks to this path; they would be measuring us, not the platform.
 *
 * Written against the structural types from `decodeAudio.ts` for the same reason that module is:
 * so the conversion can be unit tested in Node, where Web Audio does not exist.
 */
import { AudioBufferFactory, ReadableAudioBuffer } from "./decodeAudio";

export type WavSampleFormat = "pcm16" | "pcm24" | "float32";

export type WavStreamInfo = {
  sampleRate: number;
  channels: number;
  format: WavSampleFormat;
  /** Bytes per frame across all channels, i.e. the container's `blockAlign`. */
  bytesPerFrame: number;
  dataOffset: number;
  dataBytes: number;
  frameCount: number;
};

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_FLOAT = 0x0003;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

function matchesAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

/**
 * Parses the container by walking the chunk list.
 *
 * `data` is NOT assumed to be at offset 36. Every fixture in this repo is a canonical 44-byte
 * header, but a real file from a DAW carries `LIST`/`INFO`, `bext`, `fact`, `JUNK` or `id3 ` before
 * it, and assuming the canonical layout would read metadata as audio — which is exactly the
 * "pressed a pad and heard garbage" failure this feature must not introduce.
 *
 * Returns null for anything this module refuses, which sends the media back to the full-decode
 * path with no user-visible difference.
 */
export function parseWavStreamInfo(head: Uint8Array, fileSize: number): WavStreamInfo | null {
  if (!matchesAscii(head, 0, "RIFF") || !matchesAscii(head, 8, "WAVE")) {
    return null;
  }
  if (head.length < 12) {
    return null;
  }

  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let cursor = 12;
  let audioFormat: number | null = null;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let blockAlign = 0;
  let dataOffset: number | null = null;
  let dataBytes = 0;

  while (cursor + 8 <= head.length) {
    const chunkSize = view.getUint32(cursor + 4, true);
    const payloadOffset = cursor + 8;

    if (matchesAscii(head, cursor, "fmt ") && payloadOffset + 16 <= head.length) {
      audioFormat = view.getUint16(payloadOffset, true);
      channels = view.getUint16(payloadOffset + 2, true);
      sampleRate = view.getUint32(payloadOffset + 4, true);
      blockAlign = view.getUint16(payloadOffset + 12, true);
      bitsPerSample = view.getUint16(payloadOffset + 14, true);
      // An extensible header carries the real format in a SubFormat GUID whose first two bytes are
      // the format tag; the rest of the GUID is a fixed suffix that adds nothing here.
      if (
        audioFormat === WAVE_FORMAT_EXTENSIBLE &&
        chunkSize >= 40 &&
        payloadOffset + 26 <= head.length
      ) {
        audioFormat = view.getUint16(payloadOffset + 24, true);
      }
    } else if (matchesAscii(head, cursor, "data")) {
      dataOffset = payloadOffset;
      // A streamed WAV writes 0 or 0xFFFFFFFF because the length was unknown at write time.
      dataBytes =
        chunkSize === 0 || chunkSize === 0xffffffff
          ? Math.max(0, fileSize - payloadOffset)
          : chunkSize;
      break;
    }

    // Chunks are padded to an even length, and the pad byte is not counted in the size.
    cursor = payloadOffset + chunkSize + (chunkSize % 2);
  }

  if (dataOffset === null || audioFormat === null || channels < 1 || channels > 2) {
    return null;
  }
  if (sampleRate <= 0 || blockAlign <= 0) {
    return null;
  }

  let format: WavSampleFormat;
  if (audioFormat === WAVE_FORMAT_PCM && bitsPerSample === 16) {
    format = "pcm16";
  } else if (audioFormat === WAVE_FORMAT_PCM && bitsPerSample === 24) {
    format = "pcm24";
  } else if (audioFormat === WAVE_FORMAT_FLOAT && bitsPerSample === 32) {
    format = "float32";
  } else {
    // 8-bit unsigned PCM, A-law, µ-law and ADPCM all live here. Refusing them costs nothing: they
    // keep the path they have today.
    return null;
  }

  const expectedBlockAlign = channels * (bitsPerSample / 8);
  if (blockAlign !== expectedBlockAlign) {
    // A header that disagrees with itself is not worth guessing about.
    return null;
  }

  const available = Math.max(0, Math.min(dataBytes, fileSize - dataOffset));

  return {
    sampleRate,
    channels,
    format,
    bytesPerFrame: blockAlign,
    dataOffset,
    dataBytes: available,
    frameCount: Math.floor(available / blockAlign)
  };
}

/**
 * Byte range holding frames `[startFrame, endFrameExclusive)`.
 *
 * Both ends are clamped to the data chunk, and `frames` reports what the range actually covers, so
 * a caller never has to re-derive it from the byte length.
 */
export function wavByteRangeForFrames(
  info: WavStreamInfo,
  startFrame: number,
  endFrameExclusive: number
): { start: number; end: number; frames: number } {
  const first = Math.max(0, Math.min(info.frameCount, Math.floor(startFrame)));
  const last = Math.max(first, Math.min(info.frameCount, Math.floor(endFrameExclusive)));
  return {
    start: info.dataOffset + first * info.bytesPerFrame,
    end: info.dataOffset + last * info.bytesPerFrame,
    frames: last - first
  };
}

export type DecodeWavFramesOptions = {
  info: WavStreamInfo;
  /** Exactly the range `wavByteRangeForFrames` returned. */
  bytes: Uint8Array;
  frames: number;
  mono: boolean;
  createBuffer: AudioBufferFactory;
};

/**
 * Converts interleaved container samples into a buffer, with the optional mono downmix folded into
 * the same pass — mirroring the "no intermediate buffer" rule `sliceAudioBuffer` already follows.
 *
 * Reads through a `DataView` rather than indexing a typed array. Under
 * `noUncheckedIndexedAccess` every `bytes[i]` is `number | undefined`, and the idiomatic `?? 0`
 * would turn an off-by-one range into plausible silence instead of a visible failure. `DataView`
 * getters return `number` and throw when out of range, which is the behaviour worth having here.
 */
export function decodeWavFrames(options: DecodeWavFramesOptions): ReadableAudioBuffer {
  const { info, bytes, frames, mono, createBuffer } = options;
  const sourceChannels = info.channels;
  const outputChannels = mono && sourceChannels > 1 ? 1 : sourceChannels;
  const usableFrames = Math.max(
    0,
    Math.min(frames, Math.floor(bytes.byteLength / info.bytesPerFrame))
  );
  const target = createBuffer(outputChannels, Math.max(1, usableFrames), info.sampleRate);
  if (usableFrames === 0) {
    return target;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bytesPerSample = info.bytesPerFrame / sourceChannels;
  const readSample = (frame: number, channel: number) => {
    const offset = frame * info.bytesPerFrame + channel * bytesPerSample;
    if (info.format === "pcm16") {
      return view.getInt16(offset, true) / 32768;
    }
    if (info.format === "float32") {
      return view.getFloat32(offset, true);
    }
    // 24-bit little-endian signed: assemble the three bytes, then sign-extend.
    const low = view.getUint8(offset);
    const mid = view.getUint8(offset + 1);
    const high = view.getInt8(offset + 2);
    return ((high << 16) | (mid << 8) | low) / 8388608;
  };

  if (outputChannels === 1 && sourceChannels > 1) {
    const output = target.getChannelData(0);
    for (let frame = 0; frame < usableFrames; frame += 1) {
      let sum = 0;
      for (let channel = 0; channel < sourceChannels; channel += 1) {
        sum += readSample(frame, channel);
      }
      // The mean, matching `sliceAudioBuffer`'s downmix so the two paths sound identical.
      output[frame] = sum / sourceChannels;
    }
    return target;
  }

  for (let channel = 0; channel < outputChannels; channel += 1) {
    const output = target.getChannelData(channel);
    for (let frame = 0; frame < usableFrames; frame += 1) {
      output[frame] = readSample(frame, channel);
    }
  }
  return target;
}

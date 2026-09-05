/**
 * Real, decodable WAV fixtures generated in pure JS — no ffmpeg, no npm dependency.
 *
 * Everything is written at 44 100 Hz on purpose. `decodeAudioBlob` in the audio engine decodes
 * through `new OfflineAudioContext(1, 1, 44_100)`, and `decodeAudioData` resamples to the
 * context rate while preserving the channel count. Matching 44 100 means zero resampling, so
 * the decoded PCM size is exactly `seconds * 44100 * channels * 4` with no rounding — which
 * turns "cached PCM bytes" from a fuzzy perf number into an equality assertion.
 */

export type WavSpec = {
  seconds: number;
  /** Must stay 44 100 for the exact-byte guarantee above. */
  sampleRate?: number;
  channels?: 1 | 2;
  /** 0 produces silence. */
  freqHz?: number;
};

export const WAV_HEADER_BYTES = 44;
export const DECODE_SAMPLE_RATE = 44_100;

/**
 * IMPORTANT — this function is serialized with `Function.prototype.toString()` and rebuilt
 * inside the page by `seedProject`, so it must stay self-contained: no imports, no references
 * to module scope, no class fields, nothing that makes TypeScript emit a downlevel helper.
 * A violation fails at runtime inside the page with a confusing "X is not defined".
 */
export function makeWavBytes(spec: {
  seconds: number;
  sampleRate?: number;
  channels?: 1 | 2;
  freqHz?: number;
}): Uint8Array {
  const sampleRate = spec.sampleRate ?? 44100;
  const channels = spec.channels ?? 1;
  const freqHz = spec.freqHz ?? 220;
  const frames = Math.round(spec.seconds * sampleRate);
  const dataBytes = frames * channels * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      bytes[offset + index] = text.charCodeAt(index);
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);

  const step = (2 * Math.PI * freqHz) / sampleRate;
  for (let frame = 0; frame < frames; frame += 1) {
    const value = freqHz === 0 ? 0 : Math.round(Math.sin(frame * step) * 32000);
    for (let channel = 0; channel < channels; channel += 1) {
      view.setInt16(44 + (frame * channels + channel) * 2, value, true);
    }
  }

  return bytes;
}

export function makeWavBuffer(spec: WavSpec): Buffer {
  const bytes = makeWavBytes(spec);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Bytes the .wav file occupies on disk and in IndexedDB. */
export function wavByteLength(spec: WavSpec): number {
  const sampleRate = spec.sampleRate ?? DECODE_SAMPLE_RATE;
  const channels = spec.channels ?? 1;
  return WAV_HEADER_BYTES + Math.round(spec.seconds * sampleRate) * channels * 2;
}

/** Bytes the decoded AudioBuffer occupies in RAM (Float32 per sample per channel). */
export function decodedByteLength(spec: WavSpec, mono = false): number {
  const channels = mono ? 1 : (spec.channels ?? 1);
  return Math.round(spec.seconds * DECODE_SAMPLE_RATE) * channels * 4;
}

export const SIZES = {
  /** 258 KB file / 517 KB decoded. */
  small: { seconds: 3, channels: 1, freqHz: 220 } satisfies WavSpec,
  /** 5.05 MB file / 10.1 MB decoded. */
  medium: { seconds: 30, channels: 2, freqHz: 330 } satisfies WavSpec,
  /** 30.3 MB file / 60.6 MB decoded. */
  large: { seconds: 180, channels: 2, freqHz: 440 } satisfies WavSpec
} as const;

export type SizeName = keyof typeof SIZES;

import { expect, test } from "@playwright/test";

import {
  shouldSliceBuffer,
  sliceAudioBuffer
} from "../../src/features/playback/model/decodeAudio";
import type {
  AudioBufferFactory,
  ReadableAudioBuffer,
  SliceOptions
} from "../../src/features/playback/model/decodeAudio";
import { getEnvelopeValue } from "../../src/features/playback/model/audioEnvelope";

const SAMPLE_RATE = 44_100;

function makeSource(seconds: number, channels: number): ReadableAudioBuffer {
  const length = Math.round(seconds * SAMPLE_RATE);
  const data = Array.from({ length: channels }, (_, channel) => {
    const buffer = new Float32Array(length);
    for (let index = 0; index < length; index += 1) {
      // Encodes both position and channel, so a wrong offset or a swapped channel is visible.
      buffer[index] = index + channel * 1_000_000;
    }
    return buffer;
  });

  return {
    length,
    duration: length / SAMPLE_RATE,
    sampleRate: SAMPLE_RATE,
    numberOfChannels: channels,
    getChannelData: (channel) => data[channel] ?? new Float32Array(0)
  };
}

const createBuffer: AudioBufferFactory = (channels, length, sampleRate) => {
  const data = Array.from({ length: channels }, () => new Float32Array(length));
  return {
    length,
    duration: length / sampleRate,
    sampleRate,
    numberOfChannels: channels,
    getChannelData: (channel) => data[channel] ?? new Float32Array(0)
  };
};

function options(overrides: Partial<SliceOptions> = {}): SliceOptions {
  return { startSeconds: 0, endSeconds: 1, mono: false, createBuffer, ...overrides };
}

test.describe("sliceAudioBuffer", () => {
  test("copies exactly the requested window from every channel", () => {
    const source = makeSource(10, 2);
    const slice = sliceAudioBuffer(source, options({ startSeconds: 3, endSeconds: 4 }));

    expect(slice.length).toBe(SAMPLE_RATE);
    expect(slice.numberOfChannels).toBe(2);
    expect(slice.getChannelData(0)[0]).toBe(3 * SAMPLE_RATE);
    expect(slice.getChannelData(1)[0]).toBe(3 * SAMPLE_RATE + 1_000_000);
    expect(slice.getChannelData(0)[SAMPLE_RATE - 1]).toBe(4 * SAMPLE_RATE - 1);
  });

  test("clamps a window that runs past the end of the source", () => {
    const source = makeSource(2, 1);
    const slice = sliceAudioBuffer(source, options({ startSeconds: 1.5, endSeconds: 99 }));
    expect(slice.length).toBe(Math.round(0.5 * SAMPLE_RATE));
    expect(slice.getChannelData(0)[0]).toBe(Math.round(1.5 * SAMPLE_RATE));
  });

  test("never produces an empty buffer for a collapsed window", () => {
    const source = makeSource(2, 1);
    const slice = sliceAudioBuffer(source, options({ startSeconds: 1, endSeconds: 1 }));
    expect(slice.length).toBe(1);
  });

  test("downmixes to the channel mean, not to the first channel", () => {
    const source = makeSource(1, 2);
    const slice = sliceAudioBuffer(source, options({ endSeconds: 1, mono: true }));

    expect(slice.numberOfChannels).toBe(1);
    // Channel 0 holds `index`, channel 1 holds `index + 1_000_000`.
    expect(slice.getChannelData(0)[0]).toBe(500_000);
    expect(slice.getChannelData(0)[10]).toBe(500_010);
  });

  test("combines trim and downmix in one pass", () => {
    const source = makeSource(10, 2);
    const slice = sliceAudioBuffer(
      source,
      options({ startSeconds: 2, endSeconds: 3, mono: true })
    );
    expect(slice.length).toBe(SAMPLE_RATE);
    expect(slice.numberOfChannels).toBe(1);
    expect(slice.getChannelData(0)[0]).toBe(2 * SAMPLE_RATE + 500_000);
  });

  test("a mono source is not altered by the mono flag", () => {
    const source = makeSource(1, 1);
    const slice = sliceAudioBuffer(source, options({ endSeconds: 1, mono: true }));
    expect(slice.numberOfChannels).toBe(1);
    expect(slice.getChannelData(0)[7]).toBe(7);
  });
});

test.describe("shouldSliceBuffer", () => {
  test("declines an untrimmed window", () => {
    const source = makeSource(600, 2);
    expect(shouldSliceBuffer(source, options({ startSeconds: 0, endSeconds: 600 }))).toBe(false);
  });

  test("declines when the ratio is not worth a copy", () => {
    // Exactly 90 % of the source: the ratio clause alone rejects this.
    const source = makeSource(10, 2);
    expect(shouldSliceBuffer(source, options({ startSeconds: 0, endSeconds: 9 }))).toBe(false);
  });

  test("declines when the saving is below the byte floor even though the ratio passes", () => {
    // 10 s stereo is 3 528 000 bytes; half of it passes the 0.9 ratio comfortably, but the
    // 1 764 000 bytes saved are under the 2 MiB floor. Without that clause this returns true and
    // the slice is a pure-loss copy.
    const source = makeSource(10, 2);
    expect(shouldSliceBuffer(source, options({ startSeconds: 0, endSeconds: 5 }))).toBe(false);
  });

  test("accepts a short cue taken from a long track", () => {
    const source = makeSource(600, 2);
    expect(shouldSliceBuffer(source, options({ startSeconds: 300, endSeconds: 312 }))).toBe(true);
  });

  test("declines a collapsed window rather than producing a degenerate slice", () => {
    const source = makeSource(600, 2);
    expect(shouldSliceBuffer(source, options({ startSeconds: 5, endSeconds: 5 }))).toBe(false);
  });
});

test("source-time envelope values survive the buffer-time conversion", () => {
  // The silent failure this guards: the envelope anchors the fade-in to trimStartMs, so feeding
  // it buffer-relative time pins the gain at 0 and the cue plays inaudibly. The engine converts
  // by offsetting `source.start`, never by shifting what it hands the envelope.
  const settings = {
    trimStartMs: 30_000,
    trimEndMs: 42_000,
    fadeInEnabled: true,
    fadeInMs: 1000,
    fadeOutEnabled: false,
    fadeOutMs: 0
  };
  const sliceStartSeconds = 30;

  const toSourceTime = (bufferSeconds: number) => sliceStartSeconds + bufferSeconds;

  expect(getEnvelopeValue(settings, toSourceTime(0), 42)).toBe(0);
  expect(getEnvelopeValue(settings, toSourceTime(0.5), 42)).toBeCloseTo(Math.sin(Math.PI / 4), 12);
  expect(getEnvelopeValue(settings, toSourceTime(1), 42)).toBe(1);

  // Without the conversion every fade-in sample would be clamped to zero.
  expect(getEnvelopeValue(settings, 0, 42)).toBe(0);
  expect(getEnvelopeValue(settings, 0.5, 42)).toBe(0);
  expect(getEnvelopeValue(settings, 1, 42)).toBe(0);
});

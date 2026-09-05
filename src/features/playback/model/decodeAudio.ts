/**
 * Decoding, trimming and downmixing of playback buffers.
 *
 * `decodeAudioData` has no partial-decode API, so a slice always costs a full decode first: PEAK
 * memory is unchanged, but steady state is what collapses. A 12-second cue taken from a 10-minute
 * track goes from ~211 MiB resident to ~4 MiB, and a panel of twelve such cues from ~2.5 GiB to
 * ~50 MiB. The transient spike is bounded to one buffer at a time because the warm-up is serial,
 * and it is strictly no worse than before, where that 211 MiB was permanent.
 *
 * Written against structural types rather than the DOM `AudioBuffer` so the trim and downmix math
 * can be unit tested in Node, where Web Audio does not exist.
 */

export type ReadableAudioBuffer = {
  length: number;
  duration: number;
  sampleRate: number;
  numberOfChannels: number;
  getChannelData: (channel: number) => Float32Array;
};

export type AudioBufferFactory = (
  channels: number,
  length: number,
  sampleRate: number
) => ReadableAudioBuffer;

export type SliceOptions = {
  startSeconds: number;
  endSeconds: number;
  mono: boolean;
  createBuffer: AudioBufferFactory;
};

/** Slicing has to pay for itself: for most cells there is no trim at all, and copying a buffer
 * to produce an identical one is pure loss. */
const MIN_SLICE_RATIO = 0.9;
const MIN_SLICE_SAVING_BYTES = 2 * 1024 * 1024;

export const DECODE_SAMPLE_RATE = 44_100;

function getFrameRange(source: ReadableAudioBuffer, startSeconds: number, endSeconds: number) {
  const startFrame = Math.max(0, Math.min(source.length, Math.round(startSeconds * source.sampleRate)));
  const endFrame = Math.max(
    startFrame,
    Math.min(source.length, Math.round(endSeconds * source.sampleRate))
  );
  return { startFrame, endFrame };
}

/** Measures only — it never allocates, so it does not take a buffer factory. */
export function shouldSliceBuffer(
  source: ReadableAudioBuffer,
  options: Omit<SliceOptions, "createBuffer">
): boolean {
  const { startFrame, endFrame } = getFrameRange(source, options.startSeconds, options.endSeconds);
  const sliceFrames = endFrame - startFrame;
  if (sliceFrames <= 0) {
    return false;
  }

  const channels = source.numberOfChannels;
  const fullBytes = source.length * channels * 4;
  const sliceBytes = sliceFrames * channels * 4;

  return sliceBytes < fullBytes * MIN_SLICE_RATIO && fullBytes - sliceBytes > MIN_SLICE_SAVING_BYTES;
}

/**
 * Trim and optional mono downmix in one pass — no intermediate buffer.
 */
export function sliceAudioBuffer(
  source: ReadableAudioBuffer,
  options: SliceOptions
): ReadableAudioBuffer {
  const { startFrame, endFrame } = getFrameRange(source, options.startSeconds, options.endSeconds);
  const sliceLength = Math.max(1, endFrame - startFrame);
  const sourceChannels = source.numberOfChannels;
  const outputChannels = options.mono ? 1 : sourceChannels;
  const target = options.createBuffer(outputChannels, sliceLength, source.sampleRate);

  if (options.mono && sourceChannels > 1) {
    const output = target.getChannelData(0);
    const inputs = Array.from({ length: sourceChannels }, (_, index) => source.getChannelData(index));
    for (let frame = 0; frame < sliceLength; frame += 1) {
      let sum = 0;
      for (const input of inputs) {
        sum += input[startFrame + frame] ?? 0;
      }
      output[frame] = sum / sourceChannels;
    }
    return target;
  }

  for (let channel = 0; channel < outputChannels; channel += 1) {
    const input = source.getChannelData(channel);
    target.getChannelData(channel).set(input.subarray(startFrame, startFrame + sliceLength));
  }
  return target;
}

/**
 * Slices a real `AudioBuffer` into another real `AudioBuffer`.
 *
 * The cast to `AudioBuffer` lives here rather than at the call site, because this is the only
 * place that knows the factory is `OfflineAudioContext.createBuffer` and therefore really does
 * produce one. The context is built lazily inside the factory: iOS caps concurrent contexts, and
 * the common case is a cell with no trim, where no buffer is ever created.
 *
 * `createBuffer` rather than `new AudioBuffer()`: the constructor needs Safari 14.1+, the method
 * is universal. A buffer created on an offline context plays fine on a live one — decoding
 * already relies on exactly that.
 */
export function sliceToAudioBuffer(
  source: AudioBuffer,
  options: Omit<SliceOptions, "createBuffer">
): AudioBuffer {
  let context: OfflineAudioContext | null = null;
  const createBuffer: AudioBufferFactory = (channels, length, sampleRate) => {
    context ??= new OfflineAudioContext(1, 1, DECODE_SAMPLE_RATE);
    return context.createBuffer(channels, length, sampleRate);
  };
  return sliceAudioBuffer(source, { ...options, createBuffer }) as AudioBuffer;
}

export async function decodeAudioBlob(blob: Blob): Promise<AudioBuffer> {
  const arrayBuffer = await blob.arrayBuffer();
  const context = new OfflineAudioContext(1, 1, DECODE_SAMPLE_RATE);
  return context.decodeAudioData(arrayBuffer);
}

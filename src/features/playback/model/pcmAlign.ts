/**
 * PCM comparison helpers for the MP3 alignment measurement and the seam continuity check.
 *
 * Two very different jobs, and the difference matters:
 *
 * - `findAlignmentOffset` runs ONCE PER MEDIA, during warm-up, to measure how far a mid-file decode
 *   sits from its nominal sample position. That offset is not derivable from a constant: measured
 *   on a real 192 kbps LAME file it was 2257 samples = 1152 (one preamble frame) + 1105 (LAME's
 *   encoder delay, which the full decode strips because it sees the LAME header and a standalone
 *   mid-file slice does not). It is a property of the file and the decoder together.
 * - `getMaxAbsStep` runs at every seam, and is O(window) with a 64-sample window.
 *
 * A per-seam cross-correlation was considered and rejected. It costs 2048 x 4097 ~ 8.4 M
 * multiply-accumulates every few seconds per playing track, and — decisively — on a sustained
 * 220 Hz tone (period 200.5 samples) a +/-2048 search window contains about 20 peaks of correlation
 * near 1.0, so a "peak must beat its runner-up" acceptance test rejects exactly the tonal material
 * a music soundboard is full of. Measuring once and checking continuity cheaply is both faster and
 * more honest.
 *
 * Dependency-free and DOM-free: plain Float32Array in, numbers out, unit testable in Node.
 */

export function rms(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const value of samples) {
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Largest absolute difference between consecutive samples.
 *
 * This is the click detector. Compared against the same signal's own step in an equivalent window
 * it is amplitude-independent, so it does not need calibrating per fixture.
 */
export function getMaxAbsStep(samples: Float32Array): number {
  let max = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const step = Math.abs((samples[index] ?? 0) - (samples[index - 1] ?? 0));
    if (step > max) {
      max = step;
    }
  }
  return max;
}

/** Root-mean-square of the difference between a reference and a window of a haystack. */
export function residualRms(
  reference: Float32Array,
  haystack: Float32Array,
  haystackOffset: number
): number {
  if (reference.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let index = 0; index < reference.length; index += 1) {
    const want = haystack[haystackOffset + index];
    const got = reference[index] ?? 0;
    if (want === undefined) {
      return Number.POSITIVE_INFINITY;
    }
    const diff = got - want;
    sum += diff * diff;
  }
  return Math.sqrt(sum / reference.length);
}

export type AlignmentResult = {
  /**
   * Offset from the nominal position, in samples, of the best accepted match — or null when
   * nothing met the acceptance criteria.
   */
  lag: number | null;
  peakCorrelation: number;
  /** Residual at the accepted lag; 0 means the samples were identical. */
  residual: number;
  /** How many lags met the acceptance criteria. More than one means the signal is periodic. */
  acceptedCount: number;
};

export type FindAlignmentOptions = {
  reference: Float32Array;
  haystack: Float32Array;
  /** Where in `haystack` the reference is expected to sit if nothing shifted it. */
  nominalOffset: number;
  searchRadius: number;
  /** Residual at or below this counts as a match. Identical bytes through one decoder give 0. */
  maxResidual?: number;
};

/**
 * Finds where a reference window really sits inside a haystack.
 *
 * Among every lag that meets `maxResidual`, the one CLOSEST TO ZERO wins, and `acceptedCount`
 * reports how many there were. That tie-break is the guard against periodic material: a pure tone
 * matches at every multiple of its period, and picking the largest correlation would then return an
 * arbitrary multiple as the encoder delay. A caller measuring a per-media offset must therefore
 * treat `acceptedCount > 1` as "measure another window and require agreement" rather than as a
 * result — one window can never distinguish a period from a delay.
 */
export function findAlignmentOffset(options: FindAlignmentOptions): AlignmentResult {
  const { reference, haystack, nominalOffset, searchRadius } = options;
  const maxResidual = options.maxResidual ?? 1e-3;
  if (reference.length === 0) {
    return { lag: null, peakCorrelation: 0, residual: Number.POSITIVE_INFINITY, acceptedCount: 0 };
  }

  let referenceEnergy = 0;
  for (const value of reference) {
    referenceEnergy += value * value;
  }

  let bestLag: number | null = null;
  let bestResidual = Number.POSITIVE_INFINITY;
  let bestCorrelation = 0;
  let accepted = 0;

  for (let lag = -searchRadius; lag <= searchRadius; lag += 1) {
    const offset = nominalOffset + lag;
    if (offset < 0 || offset + reference.length > haystack.length) {
      continue;
    }

    let dot = 0;
    let energy = 0;
    for (let index = 0; index < reference.length; index += 1) {
      const a = reference[index] ?? 0;
      const b = haystack[offset + index] ?? 0;
      dot += a * b;
      energy += b * b;
    }
    const correlation = dot / Math.sqrt(referenceEnergy * energy + 1e-30);
    const residual = residualRms(reference, haystack, offset);

    if (residual <= maxResidual) {
      accepted += 1;
      if (bestLag === null || Math.abs(lag) < Math.abs(bestLag)) {
        bestLag = lag;
        bestResidual = residual;
        bestCorrelation = correlation;
      }
    }
    if (correlation > bestCorrelation && bestLag === null) {
      bestCorrelation = correlation;
    }
  }

  return {
    lag: bestLag,
    peakCorrelation: bestCorrelation,
    residual: bestLag === null ? Number.POSITIVE_INFINITY : bestResidual,
    acceptedCount: accepted
  };
}

/**
 * Continuity check for a seam, at the cost of a 64-sample scan.
 *
 * Compares the step across the join against the material's own largest step nearby. A dropped or
 * repeated fragment shows up as a step far outside what the signal itself produces; a correctly
 * aligned seam is indistinguishable from the middle of a buffer.
 *
 * `referenceMaxStep` of 0 means the neighbourhood is silent, where any step is a defect — so the
 * check demands the seam be silent too rather than dividing by zero.
 */
export function isSeamContinuous(input: {
  seamWindow: Float32Array;
  referenceMaxStep: number;
  tolerance?: number;
}): boolean {
  const tolerance = input.tolerance ?? 1.5;
  const seamStep = getMaxAbsStep(input.seamWindow);
  if (input.referenceMaxStep <= 0) {
    return seamStep <= 1e-6;
  }
  return seamStep <= input.referenceMaxStep * tolerance;
}

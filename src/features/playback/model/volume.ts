/**
 * How master volume and a cell's own offset combine, split so they can live on separate gain nodes.
 *
 * The factorisation is EXACT for every reachable input, and that is what makes the split safe
 * rather than approximately safe. `masterVolume` is 0..100, so the master term is 0..1;
 * `volumeOffset` is -100..+300 (`VOLUME_OFFSET_MIN`/`MAX` in the audio editor), so the cell term is
 * 0..4. Their product is therefore never above 4, which means the `Math.min(4, ...)` clamp in the
 * combined form never binds — and the two-node form reproduces the one-node value bit for bit.
 *
 * That matters because boosting a single quiet cue to 400 % is deliberate, documented behaviour.
 * Moving master volume onto a shared node must not quietly cap it.
 *
 * Pure and DOM-free so the identity below can be checked over the whole input lattice in the unit
 * tier, rather than asserted in a comment.
 */

export const MAX_EFFECTIVE_VOLUME = 4;

/** What the shared master node carries: master volume and mute, nothing per-cell. */
export function getMasterGainValue(masterVolume: number, masterMuted: boolean): number {
  if (masterMuted) {
    return 0;
  }
  return clamp(masterVolume / 100, 0, 1);
}

/** What a route's own node carries: that cell's offset, nothing global. */
export function getCellGainValue(volumeOffset: number): number {
  return clamp(1 + volumeOffset / 100, 0, MAX_EFFECTIVE_VOLUME);
}

/**
 * The combined value, as a single node would apply it.
 *
 * Kept because the media-element fallback route cannot use the shared bus — it builds its own
 * `AudioContext` and its own `destination`, so nothing on the main context can reach it.
 */
export function getEffectiveVolume(masterVolume: number, cellVolumeOffset: number): number {
  return clamp(
    (masterVolume / 100) * (1 + cellVolumeOffset / 100),
    0,
    MAX_EFFECTIVE_VOLUME
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

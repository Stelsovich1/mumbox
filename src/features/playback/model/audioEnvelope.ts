/**
 * Shared fade/trim math for preview, playback and the planned MP3 export.
 *
 * INVARIANT: every time value handed to this module is a position within the ORIGINAL media
 * file (source time), never a position inside a sliced playback buffer. `getEnvelopeValue`
 * anchors the fade-in to `trimStartMs`, so passing buffer-relative time silently pins the gain
 * to 0 and the cue plays inaudibly with no error anywhere. Code that plays a sliced buffer must
 * convert buffer time to source time before calling in.
 */
export type AudioEnvelopeSettings = {
  trimStartMs: number | null;
  trimEndMs: number | null;
  fadeInEnabled: boolean;
  fadeInMs: number;
  fadeOutEnabled: boolean;
  fadeOutMs: number;
};

const ENVELOPE_CURVE_POINTS = 256;
const ENVELOPE_MAX_CURVE_POINTS = 4096;
const ENVELOPE_MIN_FADE_POINTS = 16;
const ENVELOPE_MIN_CURVE_SECONDS = 0.01;

export function getTrimStartSeconds(settings: AudioEnvelopeSettings) {
  return (settings.trimStartMs ?? 0) / 1000;
}

export function getTrimEndSeconds(settings: AudioEnvelopeSettings, durationSeconds: number) {
  return (settings.trimEndMs ?? durationSeconds * 1000) / 1000;
}

function smoothFadeIn(progress: number) {
  return Math.sin(Math.min(1, Math.max(0, progress)) * (Math.PI / 2));
}

function smoothFadeOut(progress: number) {
  return Math.sin(Math.min(1, Math.max(0, progress)) * (Math.PI / 2));
}

export function getEnvelopeValue(
  settings: AudioEnvelopeSettings,
  currentSeconds: number,
  endSeconds: number
) {
  const startSeconds = getTrimStartSeconds(settings);
  let multiplier = 1;

  if (settings.fadeInEnabled && settings.fadeInMs > 0) {
    multiplier = Math.min(
      multiplier,
      smoothFadeIn((currentSeconds - startSeconds) / (settings.fadeInMs / 1000))
    );
  }

  if (settings.fadeOutEnabled && settings.fadeOutMs > 0) {
    multiplier = Math.min(
      multiplier,
      smoothFadeOut((endSeconds - currentSeconds) / (settings.fadeOutMs / 1000))
    );
  }

  return Math.min(1, Math.max(0, multiplier));
}

/**
 * `setValueCurveAtTime` samples uniformly across the whole remaining window, so a fade that is
 * much shorter than that window falls between two samples and gets stretched into a long linear
 * ramp that starts early. Scale the point count so the shortest enabled fade always gets enough
 * samples, capped so a very long cue with a very short fade degrades gracefully instead of
 * allocating without bound.
 */
function getCurvePointCount(settings: AudioEnvelopeSettings, remainingSeconds: number) {
  const fadeSeconds: number[] = [];
  if (settings.fadeInEnabled && settings.fadeInMs > 0) {
    fadeSeconds.push(settings.fadeInMs / 1000);
  }
  if (settings.fadeOutEnabled && settings.fadeOutMs > 0) {
    fadeSeconds.push(settings.fadeOutMs / 1000);
  }

  const shortestFadeSeconds = fadeSeconds.length > 0 ? Math.min(...fadeSeconds) : 0;
  if (shortestFadeSeconds <= 0) {
    return ENVELOPE_CURVE_POINTS;
  }

  const needed =
    Math.ceil((ENVELOPE_MIN_FADE_POINTS * remainingSeconds) / shortestFadeSeconds) + 1;
  return Math.min(ENVELOPE_MAX_CURVE_POINTS, Math.max(ENVELOPE_CURVE_POINTS, needed));
}

/**
 * Returns true when an automation curve was scheduled, false when the gain was pinned to a
 * single value instead. Callers that keep their own fallback (the audio editor preview) use the
 * return value rather than catching.
 */
export function scheduleEnvelope(
  gain: GainNode,
  settings: AudioEnvelopeSettings,
  currentSeconds: number,
  endSeconds: number,
  /**
   * Absolute context time the curve should start at. Defaults to `gain.context.currentTime`, which
   * is what every caller wanted before segment streaming existed.
   *
   * A streamed route schedules its first source slightly ahead of `currentTime` so the app knows
   * the exact frame it begins on — measured as necessary, because `start(0)` never reports where it
   * actually landed. Without this parameter the envelope would be anchored to `currentTime` while
   * the audio starts a render quantum later, putting the fades ahead of the sound by that much.
   */
  startTime?: number
): boolean {
  const now = startTime ?? gain.context.currentTime;
  const remainingSeconds = Math.max(0, endSeconds - currentSeconds);
  const initialValue = getEnvelopeValue(settings, currentSeconds, endSeconds);

  gain.gain.cancelScheduledValues(now);

  if (remainingSeconds <= ENVELOPE_MIN_CURVE_SECONDS || !Number.isFinite(remainingSeconds)) {
    gain.gain.setValueAtTime(initialValue, now);
    return false;
  }

  // No `setValueAtTime` here on purpose. Per spec `setValueCurveAtTime` throws InvalidStateError
  // when any automation event sits inside [startTime, startTime + duration], and that interval
  // is start-inclusive — so scheduling `initialValue` at exactly `now` made the curve illegal by
  // construction. It was also redundant: it is bit-identical to curve[0].
  const pointCount = getCurvePointCount(settings, remainingSeconds);
  const curve = Float32Array.from({ length: pointCount }, (_, index) => {
    const progress = index / Math.max(1, pointCount - 1);
    const sampleTime = currentSeconds + remainingSeconds * progress;
    return getEnvelopeValue(settings, sampleTime, endSeconds);
  });

  try {
    gain.gain.setValueCurveAtTime(curve, now, remainingSeconds);
    return true;
  } catch {
    // Safari can still reject an overlapping curve; a flat value is better than an exception
    // that aborts the caller's loop mid-iteration.
    //
    // The fallback needs its own guard: the only situation that rejects the curve is an earlier
    // setValueCurveAtTime still running across `now`, and setting a value inside a running curve
    // throws too. Callers include the rAF progress loop, where a throw would stop progress,
    // volume sync and loop restarts for every route until the page is reloaded.
    try {
      gain.gain.setValueAtTime(initialValue, now);
    } catch {
      // Nothing further to try; the running curve keeps control of the gain.
    }
    return false;
  }
}

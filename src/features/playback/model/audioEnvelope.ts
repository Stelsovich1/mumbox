export type AudioEnvelopeSettings = {
  trimStartMs: number | null;
  trimEndMs: number | null;
  fadeInEnabled: boolean;
  fadeInMs: number;
  fadeOutEnabled: boolean;
  fadeOutMs: number;
};

const ENVELOPE_CURVE_POINTS = 256;

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

export function scheduleEnvelope(
  gain: GainNode,
  settings: AudioEnvelopeSettings,
  currentSeconds: number,
  endSeconds: number
) {
  const now = gain.context.currentTime;
  const remainingSeconds = Math.max(0, endSeconds - currentSeconds);
  const initialValue = getEnvelopeValue(settings, currentSeconds, endSeconds);

  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(initialValue, now);

  if (remainingSeconds <= 0.01) {
    return;
  }

  const curve = Float32Array.from({ length: ENVELOPE_CURVE_POINTS }, (_, index) => {
    const progress = index / Math.max(1, ENVELOPE_CURVE_POINTS - 1);
    const sampleTime = currentSeconds + remainingSeconds * progress;
    return getEnvelopeValue(settings, sampleTime, endSeconds);
  });

  gain.gain.setValueCurveAtTime(curve, now, remainingSeconds);
}

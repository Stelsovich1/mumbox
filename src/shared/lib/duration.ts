export function formatDuration(durationMs: number | null) {
  if (durationMs === null) {
    return "--:--";
  }

  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes)}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * A file that fires neither `loadedmetadata` nor `error` used to hang this promise forever. That
 * is worse than a leak: `autoImportAudioFiles` awaits `Promise.all` over batches of 24, so a
 * single stuck file froze the whole import behind a backdrop with no way out.
 */
const DURATION_TIMEOUT_MS = 5000;

export async function readAudioDurationMs(file: File) {
  const url = URL.createObjectURL(file);
  const audio = new Audio(url);
  audio.preload = "metadata";

  try {
    return await new Promise<number | null>((resolve) => {
      let timeoutId: number | null = window.setTimeout(() => {
        timeoutId = null;
        resolve(null);
      }, DURATION_TIMEOUT_MS);

      const settle = (value: number | null) => {
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
          timeoutId = null;
        }
        resolve(value);
      };

      audio.addEventListener(
        "loadedmetadata",
        () => {
          settle(Number.isFinite(audio.duration) ? audio.duration * 1000 : null);
        },
        { once: true }
      );
      audio.addEventListener(
        "error",
        () => {
          settle(null);
        },
        { once: true }
      );
    });
  } finally {
    try {
      // Safari keeps the media resource loader alive after the object URL is revoked unless the
      // source is cleared and reloaded.
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    } catch {
      // Teardown must never turn a completed read into a rejection: this promise is awaited
      // inside a Promise.all over an import batch, and one throw would abort the whole import.
    }
    URL.revokeObjectURL(url);
  }
}

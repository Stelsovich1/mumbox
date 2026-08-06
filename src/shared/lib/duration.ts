export function formatDuration(durationMs: number | null) {
  if (durationMs === null) {
    return "--:--";
  }

  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes)}:${seconds.toString().padStart(2, "0")}`;
}

export async function readAudioDurationMs(file: File) {
  const url = URL.createObjectURL(file);

  try {
    return await new Promise<number | null>((resolve) => {
      const audio = new Audio(url);
      audio.preload = "metadata";
      audio.addEventListener(
        "loadedmetadata",
        () => {
          resolve(Number.isFinite(audio.duration) ? audio.duration * 1000 : null);
        },
        { once: true }
      );
      audio.addEventListener(
        "error",
        () => {
          resolve(null);
        },
        { once: true }
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

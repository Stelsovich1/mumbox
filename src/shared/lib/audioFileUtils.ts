const audioExtensions = [".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".opus", ".webm"];

export function isAudioFile(file: File) {
  const fileName = file.name.toLowerCase();
  return file.type.startsWith("audio/") || audioExtensions.some((extension) => fileName.endsWith(extension));
}

function getAudioMimeCandidates(fileName: string, mimeType: string) {
  if (mimeType) {
    return [mimeType];
  }
  const extension = fileName.toLowerCase().slice(fileName.lastIndexOf("."));
  const mimeByExtension: Record<string, string[]> = {
    ".mp3": ["audio/mpeg"],
    ".wav": ["audio/wav", "audio/x-wav"],
    ".ogg": ["audio/ogg"],
    ".m4a": ["audio/mp4", "audio/x-m4a"],
    ".aac": ["audio/aac"],
    ".flac": ["audio/flac"],
    ".opus": ["audio/opus", "audio/ogg"],
    ".webm": ["audio/webm"]
  };

  return mimeByExtension[extension] ?? [];
}

export function isPlayableAudio(fileName: string, mimeType: string) {
  const audio = document.createElement("audio");
  const candidates = getAudioMimeCandidates(fileName, mimeType);

  return candidates.length === 0 || candidates.some((candidate) => audio.canPlayType(candidate) !== "");
}

export function isDuplicateMediaFile(
  file: File,
  media: { fileName: string; size?: number; mimeType: string }[]
) {
  return media.some((item) => {
    if (item.fileName !== file.name) {
      return false;
    }
    if (typeof item.size === "number") {
      return item.size === file.size;
    }

    return item.mimeType === file.type || !file.type;
  });
}

export function filterValidAudioFiles(
  files: File[],
  existingMedia: { fileName: string; size?: number; mimeType: string }[]
) {
  const audioFiles = files.filter(isAudioFile);
  const unsupportedFiles = audioFiles.filter((file) => !isPlayableAudio(file.name, file.type));
  const playableFiles = audioFiles.filter((file) => isPlayableAudio(file.name, file.type));
  const duplicateFiles = playableFiles.filter((file) => isDuplicateMediaFile(file, existingMedia));
  const validFiles = playableFiles.filter((file) => !isDuplicateMediaFile(file, existingMedia));

  return {
    unsupportedFiles,
    duplicateFiles,
    validFiles
  };
}

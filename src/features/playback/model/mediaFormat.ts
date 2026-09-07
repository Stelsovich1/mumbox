/**
 * Which media files are eligible for a byte-range decode, decided from magic bytes only.
 *
 * The MIME type is deliberately not consulted. `file.type` is routinely empty on the media the app
 * imports, `audioFileUtils.ts` fills that gap with `mimeByExtension` — a guess from the file name —
 * and iOS reports its own idea of a type. Since the head of the file has to be read anyway to find
 * the first frame or the `fmt ` chunk, the bytes are both cheaper and truthful.
 *
 * Everything not recognised here keeps today's full-decode path, byte for byte. This module is the
 * only place that decides that, so adding a format later is a change in one function.
 */
import { findFirstFrame, parseId3v2Size } from "./mp3FrameIndex";

export type PartialMediaFormat = "mp3" | "wav" | "unsupported";

/**
 * How much of the head is worth reading before giving up on finding a first frame.
 *
 * An ID3v2 tag with cover art can be hundreds of kilobytes, so the caller reads the tag size first
 * and then reads again at the first frame rather than pulling a megabyte up front.
 */
export const FORMAT_PROBE_BYTES = 8192;
/** How far past a tag to keep scanning for a sync word before declaring the file unsupported. */
export const FORMAT_SYNC_SCAN_BYTES = 64 * 1024;

function matchesAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

/**
 * Classifies a file from the bytes at its start.
 *
 * `head` should hold at least `FORMAT_PROBE_BYTES`; a larger window only helps a file with leading
 * junk. A file whose ID3v2 tag is bigger than the window comes back `unsupported`, so a caller that
 * wants to be thorough reads the tag size with `parseId3v2Size` and probes again past it.
 */
export function sniffMediaFormat(head: Uint8Array): PartialMediaFormat {
  // RF64 and BW64 are 64-bit RIFF variants whose `data` size lives in a separate chunk. They are
  // refused rather than mis-parsed as WAV.
  if (matchesAscii(head, 0, "RF64") || matchesAscii(head, 0, "BW64")) {
    return "unsupported";
  }
  if (matchesAscii(head, 0, "RIFF") && matchesAscii(head, 8, "WAVE")) {
    return "wav";
  }

  // Containers that must not fall through to the MP3 sync scan: a stray 0xFFEx byte pair inside
  // any of them would otherwise look like a frame header.
  if (
    matchesAscii(head, 0, "OggS") ||
    matchesAscii(head, 0, "fLaC") ||
    matchesAscii(head, 4, "ftyp") ||
    (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3)
  ) {
    return "unsupported";
  }

  const tagBytes = parseId3v2Size(head);
  const limit = Math.min(head.length, Math.max(tagBytes, 0) + FORMAT_SYNC_SCAN_BYTES);
  return findFirstFrame(head, tagBytes, limit) === null ? "unsupported" : "mp3";
}

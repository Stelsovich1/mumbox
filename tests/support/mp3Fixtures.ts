/**
 * Access to the real MP3 corpus in `tests/fixtures/audio/` (gitignored).
 *
 * Every MP3 branch in the app used to be reachable only from unit tests over hand-written 4-byte
 * headers: `partialSource.ts` has no unit coverage at all, and `ensureMp3Alignment` was reached by
 * no e2e and no perf test. That is why a defect as large as "the streamed path never engages for
 * MP3" could sit in a suite this thorough — the fixtures are all WAV, and the WAV probe takes a
 * different branch.
 *
 * WHAT THE CORPUS IS, measured rather than assumed: MPEG-1 Layer III, 44 100 Hz, stereo,
 * 192 kbps nominal, `samplesPerFrame` 1152, no ID3v2 tag (first frame at byte 0), 192-417 s.
 * Seven carry a LAME `Info` header, nine carry no Xing/Info/VBRI at all. At 192 kbps / 44.1 kHz a
 * frame is 626.94 bytes, so the padding bit alternates 626/627 and `constantFrameBytes` resolves to
 * `null` for all sixteen.
 *
 * WHAT IT DOES NOT COVER, and a green run here must not be read as covering: ID3v2 (least of all
 * with cover art, which is what the staged read in `buildMp3Probe` exists for), MPEG-2 and 2.5
 * (`samplesPerFrame` 576 — a hardcoded 1152 would be a bug), mono, a genuine CBR stream with no
 * padding alternation (so `fillConstantBitrateIndex` and `verifyConstantFrameBytes` still have no
 * real material), a Xing header with a TOC, and ID3v1/APE/Lyrics3 trailers (`findTrailerOffset`).
 * Those branches stay on the unit tier.
 */
import { existsSync, readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";

export const MP3_FIXTURE_DIR = join(process.cwd(), "tests", "fixtures", "audio");

export const MP3_FIXTURE_SKIP_REASON =
  "Drop real MP3 files into tests/fixtures/audio/ to run the MP3 decoder tests.";

export function hasMp3Fixtures(minimum = 1): boolean {
  return listMp3Fixtures().length >= minimum;
}

export function listMp3Fixtures(): string[] {
  if (!existsSync(MP3_FIXTURE_DIR)) {
    return [];
  }
  return readdirSync(MP3_FIXTURE_DIR)
    .filter((name) => name.toLowerCase().endsWith(".mp3"))
    .sort();
}

export type Mp3FixtureFile = { name: string; mimeType: "audio/mpeg"; buffer: Buffer };

/**
 * Files ready for `setInputFiles`.
 *
 * `maxFrames` truncates on a frame boundary, which matters for more than speed: a full 7 MB track
 * decodes to ~105 MB of PCM, and a test that assigns several of them is measuring the browser's
 * memory limits rather than the behaviour under test. Truncating keeps every header property of the
 * original — it is the same stream, just shorter.
 */
export function readMp3Fixtures(count: number, maxFrames?: number): Mp3FixtureFile[] {
  return listMp3Fixtures()
    .slice(0, count)
    .map((name) => {
      const full = readFileSync(join(MP3_FIXTURE_DIR, name));
      return {
        name,
        mimeType: "audio/mpeg" as const,
        buffer: maxFrames === undefined ? full : truncateToFrames(full, maxFrames)
      };
    });
}

const MPEG1_L3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG1_SAMPLE_RATES = [44_100, 48_000, 32_000, 0];

/**
 * Length of the MPEG-1 Layer III frame starting at `offset`, or null when there is no frame there.
 *
 * Deliberately a private re-implementation rather than an import of `mp3FrameIndex.ts`: that module
 * is the thing under test, and a fixture builder that shares its frame arithmetic would agree with
 * it even when both are wrong.
 */
function frameBytesAt(bytes: Buffer, offset: number): number | null {
  const b1 = bytes[offset];
  const b2 = bytes[offset + 1];
  const b3 = bytes[offset + 2];
  if (b1 === undefined || b2 === undefined || b3 === undefined) {
    return null;
  }
  // Sync word, MPEG-1 (version bits 11), Layer III (layer bits 01).
  if (b1 !== 0xff || (b2 & 0xe0) !== 0xe0 || (b2 & 0x18) !== 0x18 || (b2 & 0x06) !== 0x02) {
    return null;
  }
  const bitrate = MPEG1_L3_BITRATES[(b3 >> 4) & 0x0f];
  const sampleRate = MPEG1_SAMPLE_RATES[(b3 >> 2) & 0x03];
  if (!bitrate || !sampleRate) {
    return null;
  }
  return Math.floor((1152 / 8) * bitrate * 1000 / sampleRate) + ((b3 >> 1) & 1);
}

export function truncateToFrames(bytes: Buffer, maxFrames: number): Buffer {
  let offset = 0;
  while (offset < bytes.length && frameBytesAt(bytes, offset) === null) {
    offset += 1;
  }
  for (let frame = 0; frame < maxFrames; frame += 1) {
    const size = frameBytesAt(bytes, offset);
    if (size === null || offset + size > bytes.length) {
      return bytes;
    }
    offset += size;
  }
  return bytes.subarray(0, offset);
}

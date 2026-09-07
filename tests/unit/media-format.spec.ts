import { expect, test } from "@playwright/test";

import { sniffMediaFormat } from "../../src/features/playback/model/mediaFormat";

/**
 * Format detection is by magic bytes only. The MIME type is not consulted, and these tests pin
 * that: a WAV mislabelled `audio/mpeg` must still be read as WAV, because `file.type` is routinely
 * empty on imported media and `mimeByExtension` in `audioFileUtils.ts` is a guess from the name.
 */

function bytes(...values: (number | string)[]): Uint8Array {
  const flat: number[] = [];
  for (const value of values) {
    if (typeof value === "string") {
      for (const character of value) {
        flat.push(character.charCodeAt(0));
      }
    } else {
      flat.push(value);
    }
  }
  return new Uint8Array(flat);
}

function pad(head: Uint8Array, total = 512): Uint8Array {
  const out = new Uint8Array(Math.max(total, head.length));
  out.set(head);
  out.fill(0x5a, head.length);
  return out;
}

/** Two consecutive MPEG-1 Layer III 192 kbps frames: 626 bytes each. */
function mp3Frames(count = 2, at = 0, total = 2048): Uint8Array {
  const out = new Uint8Array(total);
  out.fill(0x5a);
  for (let frame = 0; frame < count; frame += 1) {
    const offset = at + frame * 626;
    out[offset] = 0xff;
    out[offset + 1] = 0xfb;
    out[offset + 2] = 0xb0;
    out[offset + 3] = 0x00;
  }
  return out;
}

test("RIFF/WAVE is wav", () => {
  expect(sniffMediaFormat(pad(bytes("RIFF", 0, 0, 0, 0, "WAVEfmt ")))).toBe("wav");
});

test("a wav whose MIME says audio/mpeg is still wav", () => {
  // The bytes decide. Trusting the type here would send a WAV down the MP3 frame scanner.
  expect(sniffMediaFormat(pad(bytes("RIFF", 1, 2, 3, 4, "WAVE")))).toBe("wav");
});

test("RF64 and BW64 are refused rather than read as wav", () => {
  // 64-bit RIFF keeps its data size in a separate chunk, so parsing it as WAV would read a wrong
  // length.
  expect(sniffMediaFormat(pad(bytes("RF64", 0, 0, 0, 0, "WAVE")))).toBe("unsupported");
  expect(sniffMediaFormat(pad(bytes("BW64", 0, 0, 0, 0, "WAVE")))).toBe("unsupported");
});

test("an RF64 file whose audio happens to contain frame headers is still refused", () => {
  // This is what the RF64 guard is actually for, and the only case that can tell it apart from
  // doing nothing: RF64 already fails the RIFF test, so a plain RF64 header comes back unsupported
  // either way. Only PCM that happens to hold two agreeing Layer III headers reaches the sync scan
  // and would be misread as MP3. Found by a mutation round, where deleting the guard survived.
  const rf64 = mp3Frames(2, 64, 4096);
  rf64.set(bytes("RF64"), 0);
  rf64.set(bytes("WAVE"), 8);
  expect(sniffMediaFormat(rf64)).toBe("unsupported");
});

test("two consecutive Layer III frames are mp3", () => {
  expect(sniffMediaFormat(mp3Frames())).toBe("mp3");
});

test("a single frame-looking byte pair is not mp3", () => {
  // An 11-bit sync pattern turns up by chance roughly every 2 KB, so one match proves nothing.
  expect(sniffMediaFormat(mp3Frames(1))).toBe("unsupported");
});

test("frames after leading junk are still found", () => {
  expect(sniffMediaFormat(mp3Frames(2, 700))).toBe("mp3");
});

test("an ID3v2 tag is skipped to reach the frames", () => {
  const tagPayload = 1024;
  const head = new Uint8Array(4096);
  head.fill(0x00);
  head.set(bytes("ID3", 0x04, 0x00, 0x00), 0);
  head[6] = (tagPayload >>> 21) & 0x7f;
  head[7] = (tagPayload >>> 14) & 0x7f;
  head[8] = (tagPayload >>> 7) & 0x7f;
  head[9] = tagPayload & 0x7f;
  // Cover-art-like bytes that look like a sync word, inside the tag.
  head[100] = 0xff;
  head[101] = 0xfb;
  const frames = mp3Frames(2, 0, 2048);
  head.set(frames.subarray(0, 2048), 10 + tagPayload);

  expect(sniffMediaFormat(head)).toBe("mp3");
});

test.describe("containers that must not fall through to the sync scan", () => {
  test("ADTS AAC shares the sync pattern but is not Layer III", () => {
    const adts = new Uint8Array(2048);
    adts.fill(0x5a);
    for (let frame = 0; frame < 4; frame += 1) {
      const offset = frame * 200;
      adts[offset] = 0xff;
      adts[offset + 1] = 0xf1;
      adts[offset + 2] = 0x50;
      adts[offset + 3] = 0x80;
    }
    expect(sniffMediaFormat(adts)).toBe("unsupported");
  });

  test("Ogg", () => {
    expect(sniffMediaFormat(pad(bytes("OggS", 0, 2, 0, 0)))).toBe("unsupported");
  });

  test("FLAC", () => {
    expect(sniffMediaFormat(pad(bytes("fLaC", 0, 0, 0, 34)))).toBe("unsupported");
  });

  test("MP4 and M4A", () => {
    expect(sniffMediaFormat(pad(bytes(0, 0, 0, 0x20, "ftypM4A ")))).toBe("unsupported");
  });

  test("Matroska and WebM", () => {
    expect(sniffMediaFormat(pad(bytes(0x1a, 0x45, 0xdf, 0xa3)))).toBe("unsupported");
  });
});

test("empty and tiny inputs are unsupported, not a crash", () => {
  expect(sniffMediaFormat(new Uint8Array(0))).toBe("unsupported");
  expect(sniffMediaFormat(new Uint8Array([0xff]))).toBe("unsupported");
  expect(sniffMediaFormat(bytes("RIF"))).toBe("unsupported");
});

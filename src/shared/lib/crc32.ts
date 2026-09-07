function makeCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const crc32Table = makeCrc32Table();

/**
 * Running state for a CRC that is fed in pieces. Opaque on purpose: it is the pre-final,
 * un-inverted accumulator, so it must not be mistaken for a checksum.
 */
export const CRC32_INITIAL = 0xffffffff;

/**
 * Folds one chunk into a running CRC-32 (IEEE 802.3, the polynomial ZIP uses).
 *
 * Exists so a project export can checksum a multi-megabyte entry without materialising it: the
 * writer reads the blob in slices and folds each one in, which is what keeps the export peak at one
 * slice instead of one whole media file.
 *
 * Indexed loop rather than `for...of`: this runs once over every byte of every project export, and
 * the iterator protocol on a `Uint8Array` measured 55-138 MB/s against 240 MB/s here — the widest
 * gap on a cold JIT, which is exactly the first large entry of an export. The `?? 0` guards are
 * `noUncheckedIndexedAccess` noise and cost nothing measurable; the loop shape is the whole win.
 *
 * No `>>> 0` inside the loop on purpose: `crc` goes negative there, but `& 0xff` takes the low bits
 * regardless of sign and `>>> 8` reads the value as unsigned, so the result is identical.
 *
 * `prefer-for-of` is the rule that produced the slow shape in the first place, so it is switched off
 * for this one loop rather than obeyed. `crc32.spec.ts` pins the result against the `for...of`
 * version, which is what makes ignoring the rule safe: nothing else in the app verifies a CRC.
 */
export function updateCrc32(state: number, bytes: Uint8Array) {
  let crc = state;
  // eslint-disable-next-line @typescript-eslint/prefer-for-of
  for (let index = 0; index < bytes.length; index += 1) {
    crc = (crc32Table[(crc ^ (bytes[index] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  }

  return crc;
}

/** Turns a running state into the checksum ZIP stores. */
export function finalizeCrc32(state: number) {
  return (state ^ 0xffffffff) >>> 0;
}

/** CRC-32 over a byte range that is already in memory. */
export function getCrc32(bytes: Uint8Array) {
  return finalizeCrc32(updateCrc32(CRC32_INITIAL, bytes));
}

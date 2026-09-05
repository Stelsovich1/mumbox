/**
 * SHA-256 of a blob's bytes, lowercase hex — the dedup key for project merge.
 *
 * Returns `null` when `crypto.subtle` is unavailable (an insecure origin), which is the signal for
 * callers to fall back to the filename+size rule in `audioFileUtils`.
 *
 * Sequential by contract: `arrayBuffer()` materialises the whole file, so hashing several large
 * blobs concurrently multiplies the transient memory that gets a mobile tab killed.
 */
export async function computeContentHash(data: Blob): Promise<string | null> {
  const subtle = globalThis.crypto.subtle as SubtleCrypto | undefined;
  if (!subtle) {
    return null;
  }

  try {
    const digest = await subtle.digest("SHA-256", await data.arrayBuffer());
    return toHex(new Uint8Array(digest));
  } catch {
    return null;
  }
}

export function toHex(bytes: Uint8Array) {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }

  return hex;
}

export const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

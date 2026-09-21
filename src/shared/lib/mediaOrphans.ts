/**
 * Stored audio blobs that the project no longer names.
 *
 * REPORTED, never deleted, and that is a deliberate limit rather than an unfinished feature. A key
 * with no matching media entry is normal in at least six legitimate windows: the audio import
 * writes blobs before the reducer learns about them, a project import writes the whole archive
 * before `state/import`, a failed persist barrier leaves the OUTGOING blobs in place on purpose,
 * `deleteMediaFromLibrary` dispatches before it deletes and keeps the blobs when the barrier fails,
 * and both the single-file and the merge write paths roll back partially. In the failed-barrier
 * case the state on disk still names those blobs while the state in memory does not — so deleting
 * "orphans" there destroys exactly the data the barrier was written to protect.
 *
 * A number is still worth showing: it is the only way to see that an import died halfway.
 */
export function planOrphanMediaKeys(
  storedKeys: readonly string[],
  knownMediaIds: readonly string[],
  prefix: string
): string[] {
  const known = new Set(knownMediaIds);
  return storedKeys
    .filter((key) => key.startsWith(prefix))
    .filter((key) => !known.has(key.slice(prefix.length)));
}

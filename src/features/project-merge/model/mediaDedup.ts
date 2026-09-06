import { isDuplicateMediaFile } from "../../../shared/lib/audioFileUtils";

export type DedupCandidate = {
  id: string;
  fileName: string;
  size?: number;
  mimeType: string;
  contentHash?: string;
};

export type MediaDedupPlan = {
  /** Incoming media id -> the id to use in the merged project. */
  mediaIdMap: Map<string, string>;
  /** Incoming ids that are genuinely new and must be written to storage. */
  keptIncomingIds: string[];
  /** How many incoming assets were matched to something already present. */
  reusedCount: number;
};

function matches(current: DedupCandidate, incoming: DedupCandidate) {
  // A content hash beats a file name in both directions: same bytes under two names is one asset,
  // and different bytes under one name are two. That is the entire point of hashing.
  if (current.contentHash && incoming.contentHash) {
    return current.contentHash === incoming.contentHash;
  }

  // One side predates hashing, so fall back to the rule the importer has always used.
  return isDuplicateMediaFile(
    { name: incoming.fileName, size: incoming.size ?? 0, type: incoming.mimeType },
    [current]
  );
}

/**
 * Decides which incoming media are already in the project.
 *
 * Assets kept along the way join the comparison pool, so two copies of the same file inside the
 * incoming project also collapse to one.
 */
export function planMediaDedup(
  current: readonly DedupCandidate[],
  incoming: readonly DedupCandidate[]
): MediaDedupPlan {
  const pool: DedupCandidate[] = [...current];
  const mediaIdMap = new Map<string, string>();
  const keptIncomingIds: string[] = [];
  let reusedCount = 0;

  for (const candidate of incoming) {
    const existing = pool.find((entry) => matches(entry, candidate));
    if (existing) {
      mediaIdMap.set(candidate.id, existing.id);
      reusedCount += 1;
      continue;
    }

    mediaIdMap.set(candidate.id, candidate.id);
    keptIncomingIds.push(candidate.id);
    pool.push(candidate);
  }

  return { mediaIdMap, keptIncomingIds, reusedCount };
}

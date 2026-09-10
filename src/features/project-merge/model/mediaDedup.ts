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
  /**
   * Pairs that looked alike but could not be decided by their bytes.
   *
   * They are KEPT, and the count exists so the user can be told that deduplication did not run
   * rather than being shown a number that implies it did.
   */
  undecidedCount: number;
};

export type MediaMatch = "same" | "different" | "unknown";

/**
 * Three-valued on purpose.
 *
 * The old rule was boolean, and its fallback — same file name, same byte length — was allowed to
 * assert IDENTITY. That is the default path, not an edge case: the current project's assets only
 * gain a `contentHash` as a side effect of saving, so a project that has never been saved has no
 * hashes at all and the whole merge deduplicated on name and size.
 *
 * Two different `bell.mp3` of the same length is routine — jingles exported from one preset — and
 * the failure is silent and unrecoverable from the UI: the incoming cell points at the current
 * project's audio and the incoming blob is never written.
 *
 * The two errors are asymmetric. A false DUPLICATE substitutes different audio into a cue with no
 * trace. A false NEW costs disk and shows up as a second visible row the user can hear, compare and
 * delete. So identity must be proven, and everything else keeps both.
 */
export function compareMedia(current: DedupCandidate, incoming: DedupCandidate): MediaMatch {
  if (current.contentHash && incoming.contentHash) {
    return current.contentHash === incoming.contentHash ? "same" : "different";
  }
  // Still a useful negative, and a cheap one: nothing differing in name or length can be the same
  // bytes. This is what keeps the maps below small and the hashing rare.
  if (
    !isDuplicateMediaFile(
      { name: incoming.fileName, size: incoming.size ?? 0, type: incoming.mimeType },
      [current]
    )
  ) {
    return "different";
  }
  // Same name, same size, and at least one side unhashed — exactly the case that used to be
  // asserted as identity.
  return "unknown";
}

/**
 * Decides which incoming media are already in the project.
 *
 * Indexed rather than scanned: a hash map for the decided case, a size bucket for the rest. Assets
 * kept along the way join both, so two copies of one file inside the incoming project still
 * collapse to one — and first insert wins, preserving the previous first-match semantics.
 */
export function planMediaDedup(
  current: readonly DedupCandidate[],
  incoming: readonly DedupCandidate[]
): MediaDedupPlan {
  const byHash = new Map<string, string>();
  const bySize = new Map<number | "?", DedupCandidate[]>();

  const addToPool = (candidate: DedupCandidate) => {
    if (candidate.contentHash && !byHash.has(candidate.contentHash)) {
      byHash.set(candidate.contentHash, candidate.id);
    }
    const key = candidate.size ?? "?";
    const bucket = bySize.get(key);
    if (bucket) {
      bucket.push(candidate);
    } else {
      bySize.set(key, [candidate]);
    }
  };

  for (const candidate of current) {
    addToPool(candidate);
  }

  const mediaIdMap = new Map<string, string>();
  const keptIncomingIds: string[] = [];
  let reusedCount = 0;
  let undecidedCount = 0;

  for (const candidate of incoming) {
    let matchedId: string | null = null;
    let undecided = false;

    if (candidate.contentHash) {
      matchedId = byHash.get(candidate.contentHash) ?? null;
    }
    if (matchedId === null) {
      // Only members of the same size bucket can match under any rule, so this is the whole
      // comparison set — plus the size-less bucket, which `isDuplicateMediaFile` can still match
      // across sizes.
      const pool = [...(bySize.get(candidate.size ?? "?") ?? []), ...(bySize.get("?") ?? [])];
      for (const entry of pool) {
        const verdict = compareMedia(entry, candidate);
        if (verdict === "same") {
          matchedId = entry.id;
          break;
        }
        if (verdict === "unknown") {
          undecided = true;
        }
      }
    }

    if (matchedId !== null) {
      mediaIdMap.set(candidate.id, matchedId);
      reusedCount += 1;
      continue;
    }
    if (undecided) {
      undecidedCount += 1;
    }
    mediaIdMap.set(candidate.id, candidate.id);
    keptIncomingIds.push(candidate.id);
    addToPool(candidate);
  }

  return { mediaIdMap, keptIncomingIds, reusedCount, undecidedCount };
}

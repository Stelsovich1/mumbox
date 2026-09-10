import type { SerializableAppState } from "../../../app/model/appState";
import type { MediaStorageProgress } from "../../../app/model/appState";
import { computeContentHash } from "../../../shared/lib/contentHash";
// Type-only: features must not import each other at runtime, and this one only needs the shape.
import type { ImportedProject } from "../../file-config";
import { DedupCandidate, planMediaDedup } from "./mediaDedup";

export type MergePreparation = {
  /** Current state with hashes filled in — use THIS as the merge's `current`. */
  current: SerializableAppState;
  /** Incoming state with hashes filled in where they were missing. */
  incoming: SerializableAppState;
  mediaIdMap: Map<string, string>;
  keptIncomingIds: string[];
  reusedCount: number;
  /** Pairs that could not be decided by their bytes; they are kept. */
  undecidedCount: number;
  /** Everything hashed along the way, from both sides, so a minute of work is not thrown away. */
  computedHashes: { mediaId: string; contentHash: string }[];
  /** Bytes that will actually be written, after deduplication. */
  survivorBytes: number;
};

export type PrepareMergeOptions = {
  /**
   * Reads a stored blob for the CURRENT project.
   *
   * Injected rather than imported: `getMediaBlob` lives behind `react` and `idb-keyval`, and a
   * runtime import of it would put this module out of reach of the unit tier — which is where its
   * rules are actually pinned. The same idiom `mergeProjectState` already uses for `createPanelId`.
   */
  loadBlob?: (mediaId: string) => Promise<Blob | undefined>;
  onProgress?: (progress: MediaStorageProgress) => void;
};

function toCandidates(state: SerializableAppState): DedupCandidate[] {
  return state.media.map((media) => ({
    id: media.id,
    fileName: media.fileName,
    size: media.size,
    mimeType: media.mimeType,
    contentHash: media.contentHash
  }));
}

/**
 * Which assets in the same size bucket still need hashing.
 *
 * Every matching rule in play — hash equality and the name-plus-size fallback alike — implies equal
 * byte length. So a bucket with one member cannot contain a duplicate under any rule and needs no
 * hash at all. That turns hashing from "every asset on both sides" into "only the assets that could
 * possibly collide", and the case it still pays for is exactly the dangerous one: two different
 * files of identical length.
 *
 * Size-less assets are a legacy corner and are always hashed, because the fallback can match them
 * across sizes.
 */
function selectMediaToHash(
  current: readonly DedupCandidate[],
  incoming: readonly DedupCandidate[]
): Set<string> {
  const bySize = new Map<number | "?", DedupCandidate[]>();
  for (const candidate of [...current, ...incoming]) {
    const key = candidate.size ?? "?";
    const bucket = bySize.get(key);
    if (bucket) {
      bucket.push(candidate);
    } else {
      bySize.set(key, [candidate]);
    }
  }

  const wanted = new Set<string>();
  for (const [key, bucket] of bySize) {
    if (key === "?" || bucket.length > 1) {
      for (const candidate of bucket) {
        if (!candidate.contentHash) {
          wanted.add(candidate.id);
        }
      }
    }
  }
  return wanted;
}

/**
 * Works out what a merge would write, without writing anything.
 *
 * Hashes are backfilled on BOTH sides now. Backfilling only the incoming project left the common
 * case — a current project that has never been saved, and therefore has no hashes at all —
 * deduplicating on file name and byte length, which is not evidence of identity.
 *
 * Sequential, because `computeContentHash` materialises a whole blob and hashing several large ones
 * at once multiplies the transient memory a mobile tab dies on.
 */
export async function prepareMerge(
  current: SerializableAppState,
  project: ImportedProject,
  options: PrepareMergeOptions = {}
): Promise<MergePreparation> {
  const blobById = new Map(project.mediaBlobs.map((item) => [item.id, item.blob]));
  const hashedIncoming = [...project.state.media];
  const hashedCurrent = [...current.media];
  const computedHashes: { mediaId: string; contentHash: string }[] = [];

  const wanted = selectMediaToHash(toCandidates(current), toCandidates(project.state));
  const total = wanted.size;
  let done = 0;

  const report = () => {
    done += 1;
    options.onProgress?.({
      completed: done,
      total,
      label: `Сравнение аудио ${String(done)} из ${String(total)}`
    });
  };

  for (const [index, media] of hashedIncoming.entries()) {
    if (media.contentHash || !wanted.has(media.id)) {
      continue;
    }
    const blob = blobById.get(media.id);
    if (!blob) {
      continue;
    }
    const contentHash = await computeContentHash(blob);
    report();
    if (contentHash) {
      hashedIncoming[index] = { ...media, contentHash };
      computedHashes.push({ mediaId: media.id, contentHash });
    }
  }

  for (const [index, media] of hashedCurrent.entries()) {
    if (media.contentHash || !wanted.has(media.id) || !options.loadBlob) {
      continue;
    }
    const blob = await options.loadBlob(media.id);
    if (!blob) {
      continue;
    }
    const contentHash = await computeContentHash(blob);
    report();
    if (contentHash) {
      hashedCurrent[index] = { ...media, contentHash };
      computedHashes.push({ mediaId: media.id, contentHash });
    }
  }

  const incoming: SerializableAppState = { ...project.state, media: hashedIncoming };
  const currentWithHashes: SerializableAppState = { ...current, media: hashedCurrent };
  const { mediaIdMap, keptIncomingIds, reusedCount, undecidedCount } = planMediaDedup(
    toCandidates(currentWithHashes),
    toCandidates(incoming)
  );
  const survivorBytes = keptIncomingIds.reduce(
    (sum, id) => sum + (blobById.get(id)?.size ?? 0),
    0
  );

  return {
    current: currentWithHashes,
    incoming,
    mediaIdMap,
    keptIncomingIds,
    reusedCount,
    undecidedCount,
    computedHashes,
    survivorBytes
  };
}

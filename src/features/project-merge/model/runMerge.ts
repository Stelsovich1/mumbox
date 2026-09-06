import type { SerializableAppState } from "../../../app/model/appState";
import { computeContentHash } from "../../../shared/lib/contentHash";
import { ImportedProject } from "../../file-config";
import { DedupCandidate, planMediaDedup } from "./mediaDedup";

export type MergePreparation = {
  /** Incoming state with hashes filled in where they were missing. */
  incoming: SerializableAppState;
  mediaIdMap: Map<string, string>;
  keptIncomingIds: string[];
  reusedCount: number;
  /** Bytes that will actually be written, after deduplication. */
  survivorBytes: number;
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
 * Works out what a merge would write, without writing anything.
 *
 * Hashes are backfilled for incoming assets that lack one — a project saved before hashing existed
 * — sequentially, because hashing several large blobs at once multiplies the transient memory a
 * mobile tab dies on.
 */
export async function prepareMerge(
  current: SerializableAppState,
  project: ImportedProject
): Promise<MergePreparation> {
  const blobById = new Map(project.mediaBlobs.map((item) => [item.id, item.blob]));
  const hashed = [...project.state.media];

  for (const [index, media] of hashed.entries()) {
    if (media.contentHash) {
      continue;
    }
    const blob = blobById.get(media.id);
    if (!blob) {
      continue;
    }
    const contentHash = await computeContentHash(blob);
    if (contentHash) {
      hashed[index] = { ...media, contentHash };
    }
  }

  const incoming: SerializableAppState = { ...project.state, media: hashed };
  const { mediaIdMap, keptIncomingIds, reusedCount } = planMediaDedup(
    toCandidates(current),
    toCandidates(incoming)
  );
  const survivorBytes = keptIncomingIds.reduce(
    (sum, id) => sum + (blobById.get(id)?.size ?? 0),
    0
  );

  return { incoming, mediaIdMap, keptIncomingIds, reusedCount, survivorBytes };
}

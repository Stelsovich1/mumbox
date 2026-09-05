import { formatCountRu } from "../../../shared/lib/pluralizeRu";
import { getMediaLabel } from "./mediaSort";
import { MediaAsset } from "./types";

export type MediaDeletionTarget = Pick<MediaAsset, "id" | "alias" | "fileName">;

const RECORD_FORMS = ["запись", "записи", "записей"] as const;

/**
 * The confirmation headline. One target names it — alias first, file name as the fallback — several
 * are counted with correct Russian agreement (2 записи, 5 записей).
 */
export function buildMediaDeletionHeadline(targets: readonly MediaDeletionTarget[]) {
  const first = targets[0];
  if (!first) {
    return "";
  }
  if (targets.length === 1) {
    return `Вы действительно хотите удалить "${getMediaLabel(first)}" из медиатеки?`;
  }

  return `Удалить ${formatCountRu(targets.length, RECORD_FORMS)} из медиатеки`;
}

export function buildAffectedCellsNote(affectedCellCount: number) {
  if (affectedCellCount <= 0) {
    return "";
  }

  return `Будет очищено ячеек: ${String(affectedCellCount)}`;
}

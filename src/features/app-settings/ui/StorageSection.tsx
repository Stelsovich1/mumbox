import { Alert, Box, Button, Typography } from "@mui/material";
import { useCallback, useEffect, useState } from "react";

import { MediaAsset } from "../../../entities/media/model/types";
import { findUnusedMediaIds } from "../../../entities/media/model/unusedMedia";
import { GridCell } from "../../../entities/cell/model/types";
import { getSnapshot } from "../../../shared/lib/diagnostics";
import { clearMediaCaches, getMediaCacheBytes } from "../../../shared/lib/mediaCacheRegistry";
import { planOrphanMediaKeys } from "../../../shared/lib/mediaOrphans";

type StorageSectionProps = {
  media: MediaAsset[];
  cellsByPanel: Record<string, Record<string, GridCell>>;
  panelCount: number;
  persistenceFailed: boolean;
  /** Lists every media key in the blob store. Injected so this component stays free of idb-keyval. */
  listStoredMediaKeys: () => Promise<string[]>;
  mediaBlobPrefix: string;
  onDeleteMedia: (mediaIds: string[]) => void;
  /** Notified after the decoded caches were cleared, so the shell can say what happened. */
  onClearDecodedCache: () => void;
};

type Summary = {
  usage: number | null;
  quota: number | null;
  pcmBytes: number;
  cacheBytes: number;
  orphanCount: number;
};

function formatBytes(bytes: number | null): string {
  if (bytes === null) {
    return "неизвестно";
  }
  if (bytes < 1024 * 1024) {
    return `${String(Math.round(bytes / 1024))} КБ`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${String(Math.round(bytes / 1024 / 1024))} МБ`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} ГБ`;
}

export function StorageSection({
  media,
  cellsByPanel,
  panelCount,
  persistenceFailed,
  listStoredMediaKeys,
  mediaBlobPrefix,
  onDeleteMedia,
  onClearDecodedCache
}: StorageSectionProps) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [persistent, setPersistent] = useState<boolean | null>(null);
  const [pendingUnused, setPendingUnused] = useState<string[] | null>(null);

  const unusedIds = findUnusedMediaIds(media, cellsByPanel);
  const unusedBytes = media
    .filter((asset) => unusedIds.includes(asset.id))
    .reduce((sum, asset) => sum + (asset.size ?? 0), 0);
  const mediaBytes = media.reduce((sum, asset) => sum + (asset.size ?? 0), 0);
  const configuredCells = Object.values(cellsByPanel).reduce(
    (sum, cells) => sum + Object.values(cells).filter((cell) => cell.mediaId !== null).length,
    0
  );

  const refresh = useCallback(async () => {
    // `navigator.storage.estimate()` directly, NOT the shared `estimateStorage` helper: that one
    // also calls `navigator.storage.persist()`, which can raise a permission prompt. Asking for
    // persistent storage is a deliberate act and has its own button below.
    let usage: number | null = null;
    let quota: number | null = null;
    try {
      const estimate = await navigator.storage.estimate();
      usage = estimate.usage ?? null;
      quota = estimate.quota ?? null;
    } catch {
      // An estimate is a nicety; the rest of the summary is still worth showing.
    }
    const snapshot = await getSnapshot();
    let orphanCount = 0;
    try {
      orphanCount = planOrphanMediaKeys(
        await listStoredMediaKeys(),
        media.map((asset) => asset.id),
        mediaBlobPrefix
      ).length;
    } catch {
      orphanCount = 0;
    }
    setSummary({
      usage,
      quota,
      pcmBytes: snapshot.pcm.totalBytes,
      cacheBytes: getMediaCacheBytes(),
      orphanCount
    });
  }, [listStoredMediaKeys, media, mediaBlobPrefix]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <Box data-testid="settings-section-storage" sx={{ display: "grid", gap: 2 }}>
      {persistenceFailed ? (
        <Alert severity="error">
          Проект сейчас не сохраняется. Освободите место на устройстве - пока это не так, удалять
          аудио отсюда не стоит.
        </Alert>
      ) : null}

      <Box sx={{ display: "grid", gap: 0.5 }}>
        <Typography data-testid="storage-usage">
          Занято в браузере: {formatBytes(summary?.usage ?? null)} из{" "}
          {formatBytes(summary?.quota ?? null)}
        </Typography>
        <Typography>
          Аудио: {String(media.length)} файлов, {formatBytes(mediaBytes)}
        </Typography>
        <Typography>
          Панелей: {String(panelCount)}, занятых ячеек: {String(configuredCells)}
        </Typography>
        <Typography>В памяти сейчас: {formatBytes(summary?.cacheBytes ?? null)}</Typography>
        <Typography variant="caption" color="text.secondary">
          Браузер обычно показывает больше, чем сумма файлов. Это нормально, лишнее он освобождает
          сам.
        </Typography>
      </Box>

      <Box sx={{ display: "grid", gap: 1, justifyItems: "start" }}>
        <Button
          variant="outlined"
          onClick={() => {
            // The probe cache stays: see `clearMediaCaches`. It is not the memory being reclaimed,
            // and dropping it can cost the byte-range path for the whole browser.
            clearMediaCaches({ except: ["media-probes"] });
            onClearDecodedCache();
            void refresh();
          }}
        >
          Освободить память
        </Button>
        <Typography variant="caption" color="text.secondary">
          Освобождает память сразу. Аудио не удаляется, ячейки снова станут мгновенными после
          переключения панели или первого нажатия.
        </Typography>

        <Button
          variant="outlined"
          color="warning"
          disabled={unusedIds.length === 0}
          onClick={() => {
            setPendingUnused(unusedIds);
          }}
        >
          Удалить аудио вне ячеек ({String(unusedIds.length)})
        </Button>
        <Typography variant="caption" color="text.secondary">
          Сюда попадает и то, что вы только что добавили и ещё не разложили по ячейкам.
        </Typography>

        <Button
          variant="outlined"
          onClick={() => {
            void (async () => {
              try {
                setPersistent(await navigator.storage.persist());
              } catch {
                setPersistent(null);
              }
              void refresh();
            })();
          }}
        >
          Запросить постоянное хранилище
        </Button>
        <Typography variant="caption" color="text.secondary">
          {persistent === null
            ? "Просит браузер не удалять данные приложения, когда на устройстве мало места."
            : persistent
              ? "Браузер согласился хранить данные постоянно."
              : "Браузер отказал."}
        </Typography>
      </Box>

      {(summary?.orphanCount ?? 0) > 0 ? (
        <Typography variant="caption" color="text.secondary" data-testid="storage-orphans">
          Потерянных файлов в хранилище: {String(summary?.orphanCount ?? 0)}. Остаются после
          прерванного импорта. Приложение их не удаляет: точно так же выглядит импорт, который ещё
          идёт. Чтобы избавиться - сохраните проект в файл и импортируйте заново.
        </Typography>
      ) : null}

      {pendingUnused ? (
        <Alert
          severity="warning"
          action={
            <Box sx={{ display: "flex", gap: 1 }}>
              <Button
                color="inherit"
                onClick={() => {
                  onDeleteMedia(pendingUnused);
                  setPendingUnused(null);
                  void refresh();
                }}
              >
                Удалить безвозвратно
              </Button>
              <Button
                color="inherit"
                onClick={() => {
                  setPendingUnused(null);
                }}
              >
                Отмена
              </Button>
            </Box>
          }
        >
          Удалить {String(pendingUnused.length)} файлов на {formatBytes(unusedBytes)}? Это аудио не
          стоит ни в одной ячейке, включая скрытые уменьшением сетки. Отменить нельзя.
        </Alert>
      ) : null}
    </Box>
  );
}

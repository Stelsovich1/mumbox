import type { Page } from "@playwright/test";

import { DECODE_SAMPLE_RATE, decodedByteLength, makeWavBytes, wavByteLength } from "./audioFixtures";
import type { WavSpec } from "./audioFixtures";

/**
 * Seeds a whole project — IndexedDB media blobs plus the localStorage layout — without a single
 * UI interaction, so a 144-cell panel costs one navigation instead of 144 file imports.
 *
 * Two contracts are duplicated here rather than imported from `src`:
 *   - the idb-keyval database/store names, and
 *   - the position-stable cell id scheme `cell-${row * 12 + column}`.
 * Importing `src/app/model/appState.ts` would drag `react` and `idb-keyval` into the seeding
 * path for three lines of id math. Both duplications are pinned by `tests/e2e/storage-contract.spec.ts`,
 * which fails loudly if either contract drifts.
 */

export const IDB_DATABASE_NAME = "keyval-store";
export const IDB_STORE_NAME = "keyval";
export const MEDIA_BLOB_PREFIX = "mumbox:media:";
export const STATE_STORAGE_KEY = "mumbox:state:v1";
export const MAX_GRID_SIZE = 12;

export type GridSize = 6 | 8 | 10 | 12;

export type SeededMedia = {
  id: string;
  fileName: string;
  alias: string;
  color: string;
  mimeType: string;
  spec: WavSpec;
  durationMs: number;
  sizeBytes: number;
  decodedBytes: number;
};

export type SeedPlan = {
  panels: number;
  gridSize: GridSize;
  /** How many distinct blobs to create; cells are assigned round-robin over them. */
  distinctMedia: number;
  spec: WavSpec;
  /** Cells per panel that receive media, counted in cell order. */
  filledCellsPerPanel: number;
  masterVolume?: number;
  masterMuted?: boolean;
  stopOthers?: boolean;
  /** Trim applied to every filled cell, in ms. */
  trimStartMs?: number | null;
  trimEndMs?: number | null;
  /**
   * Per-cell overrides applied to filled cells, indexed by their position among the filled
   * cells of the panel. Runs in Node, so it is never serialized into the page.
   */
  cellPatch?: (filledIndex: number, panelIndex: number) => Record<string, unknown>;
};

export type SeedResult = {
  media: SeededMedia[];
  panelIds: string[];
  cellIdsByPanel: Record<string, string[]>;
  filledCellIdsByPanel: Record<string, string[]>;
  mediaIdByCell: Record<string, string>;
  /** Decoded PCM bytes for the distinct media referenced by each panel. */
  expectedDecodedBytesByPanel: Record<string, number>;
  expectedDecodedBytesTotal: number;
  expectedIdbBytes: number;
};

export function getCellId(row: number, column: number): string {
  return `cell-${String(row * MAX_GRID_SIZE + column)}`;
}

export function getPanelCellIds(gridSize: GridSize): string[] {
  const cellIds: string[] = [];
  for (let row = 0; row < gridSize; row += 1) {
    for (let column = 0; column < gridSize; column += 1) {
      cellIds.push(getCellId(row, column));
    }
  }
  return cellIds;
}

const CELL_COLORS = ["#ffcc66", "#6df7a5", "#7fd1ff", "#ff8fb1", "#c6a0ff", "#ffd7a1"];

function makeCell(id: string, mediaId: string | null, plan: SeedPlan) {
  return {
    id,
    mediaId,
    aliasOverride: "",
    colorOverride: null,
    playbackMode: "once" as const,
    volumeOffset: 0,
    hotkey: "",
    trimStartMs: mediaId ? (plan.trimStartMs ?? null) : null,
    trimEndMs: mediaId ? (plan.trimEndMs ?? null) : null,
    fadeInEnabled: false,
    fadeInMs: 0,
    fadeOutEnabled: false,
    fadeOutMs: 0
  };
}

export function buildSeed(plan: SeedPlan): SeedResult & { state: unknown } {
  const sizeBytes = wavByteLength(plan.spec);
  const decodedBytes = decodedByteLength(plan.spec);
  const durationMs = Math.round(plan.spec.seconds * 1000);

  const media: SeededMedia[] = Array.from({ length: plan.distinctMedia }, (_, index) => ({
    id: `media-seed-${String(index).padStart(4, "0")}`,
    fileName: `seed-${String(index).padStart(4, "0")}.wav`,
    alias: `Seed ${String(index)}`,
    color: CELL_COLORS[index % CELL_COLORS.length] ?? "#ffcc66",
    mimeType: "audio/wav",
    spec: plan.spec,
    durationMs,
    sizeBytes,
    decodedBytes
  }));

  const panelIds: string[] = [];
  const cellIdsByPanel: Record<string, string[]> = {};
  const filledCellIdsByPanel: Record<string, string[]> = {};
  const mediaIdByCell: Record<string, string> = {};
  const expectedDecodedBytesByPanel: Record<string, number> = {};
  const panels: unknown[] = [];
  const cellsByPanel: Record<string, Record<string, unknown>> = {};

  let assignCursor = 0;

  for (let panelIndex = 0; panelIndex < plan.panels; panelIndex += 1) {
    const panelId = `panel-seed-${String(panelIndex)}`;
    const cellIds = getPanelCellIds(plan.gridSize);
    const filledCount = Math.min(plan.filledCellsPerPanel, cellIds.length);
    const filled: string[] = [];
    const cells: Record<string, unknown> = {};
    const panelMediaIds = new Set<string>();

    for (const [index, cellId] of cellIds.entries()) {
      if (index < filledCount && media.length > 0) {
        const asset = media[assignCursor % media.length];
        assignCursor += 1;
        if (asset) {
          cells[cellId] = {
            ...makeCell(cellId, asset.id, plan),
            ...(plan.cellPatch?.(filled.length, panelIndex) ?? {})
          };
          filled.push(cellId);
          mediaIdByCell[`${panelId}:${cellId}`] = asset.id;
          panelMediaIds.add(asset.id);
          continue;
        }
      }
      cells[cellId] = makeCell(cellId, null, plan);
    }

    panelIds.push(panelId);
    cellIdsByPanel[panelId] = cellIds;
    filledCellIdsByPanel[panelId] = filled;
    cellsByPanel[panelId] = cells;
    expectedDecodedBytesByPanel[panelId] = panelMediaIds.size * decodedBytes;
    panels.push({
      id: panelId,
      name: `Panel ${String(panelIndex + 1)}`,
      gridSize: plan.gridSize,
      cellIds
    });
  }

  const usedMediaIds = new Set(Object.values(mediaIdByCell));

  const state = {
    panels,
    activePanelId: panelIds[0] ?? "",
    cellsByPanel,
    media: media.map((asset) => ({
      id: asset.id,
      fileName: asset.fileName,
      alias: asset.alias,
      color: asset.color,
      mimeType: asset.mimeType,
      size: asset.sizeBytes,
      durationMs: asset.durationMs,
      createdAt: new Date(0).toISOString()
    })),
    masterVolume: plan.masterVolume ?? 80,
    masterMuted: plan.masterMuted ?? false,
    stopOthers: plan.stopOthers ?? false
  };

  return {
    state,
    media,
    panelIds,
    cellIdsByPanel,
    filledCellIdsByPanel,
    mediaIdByCell,
    expectedDecodedBytesByPanel,
    expectedDecodedBytesTotal: usedMediaIds.size * decodedBytes,
    expectedIdbBytes: media.length * sizeBytes
  };
}

/**
 * Establishes the origin without booting the app, writes the blobs and the state, and leaves the
 * page on a static asset. The caller navigates to "/" afterwards.
 *
 * `addInitScript` is deliberately not used: the IndexedDB write is asynchronous and the engine's
 * warm-up effect would race it.
 */
export async function seedProject(page: Page, plan: SeedPlan): Promise<SeedResult> {
  const seed = buildSeed(plan);

  await page.goto("/mumbox/favicon.svg");

  await page.evaluate(
    async (payload) => {
      // The WAV writer is shipped as source text (~1 KB) and rebuilt here, so a 144-cell seed
      // generates its blobs inside the page instead of pushing hundreds of MB over CDP.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
      const makeWav = new Function(`return (${payload.wavSource})`)() as (
        spec: unknown
      ) => Uint8Array;

      const openDatabase = (version?: number) =>
        new Promise<IDBDatabase>((resolve, reject) => {
          const request =
            version === undefined
              ? indexedDB.open(payload.dbName)
              : indexedDB.open(payload.dbName, version);
          request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(payload.storeName)) {
              request.result.createObjectStore(payload.storeName);
            }
          };
          request.onsuccess = () => {
            resolve(request.result);
          };
          request.onerror = () => {
            reject(request.error ?? new Error("indexedDB.open failed"));
          };
        });

      let db = await openDatabase();
      if (!db.objectStoreNames.contains(payload.storeName)) {
        const nextVersion = db.version + 1;
        db.close();
        db = await openDatabase(nextVersion);
      }

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(payload.storeName, "readwrite");
        const store = tx.objectStore(payload.storeName);
        for (const asset of payload.media) {
          const bytes = makeWav(asset.spec);
          const file = new File([bytes], asset.fileName, { type: asset.mimeType });
          store.put(file, `${payload.blobPrefix}${asset.id}`);
        }
        tx.oncomplete = () => {
          resolve();
        };
        tx.onerror = () => {
          reject(tx.error ?? new Error("seed transaction failed"));
        };
        tx.onabort = () => {
          reject(tx.error ?? new Error("seed transaction aborted"));
        };
      });

      db.close();
      localStorage.setItem(payload.storageKey, JSON.stringify(payload.state));
    },
    {
      wavSource: makeWavBytes.toString(),
      dbName: IDB_DATABASE_NAME,
      storeName: IDB_STORE_NAME,
      blobPrefix: MEDIA_BLOB_PREFIX,
      storageKey: STATE_STORAGE_KEY,
      state: seed.state,
      media: seed.media.map((asset) => ({
        id: asset.id,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        spec: asset.spec
      }))
    }
  );

  return seed;
}

export async function readSeededKeys(page: Page): Promise<string[]> {
  return page.evaluate(
    async ({ dbName, storeName }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(request.error ?? new Error("indexedDB.open failed"));
        };
      });
      if (!db.objectStoreNames.contains(storeName)) {
        db.close();
        return [];
      }
      const keys = await new Promise<string[]>((resolve, reject) => {
        const request = db.transaction(storeName, "readonly").objectStore(storeName).getAllKeys();
        request.onsuccess = () => {
          resolve(request.result.map((key) => (typeof key === "string" ? key : JSON.stringify(key))));
        };
        request.onerror = () => {
          reject(request.error ?? new Error("getAllKeys failed"));
        };
      });
      db.close();
      return keys;
    },
    { dbName: IDB_DATABASE_NAME, storeName: IDB_STORE_NAME }
  );
}

export async function readStorageEstimate(page: Page): Promise<StorageEstimate> {
  return page.evaluate(async () => {
    const storage = navigator.storage as { estimate?: () => Promise<StorageEstimate> } | undefined;
    if (!storage?.estimate) {
      return {};
    }
    return storage.estimate();
  });
}

export { DECODE_SAMPLE_RATE };

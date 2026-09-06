import type { Page } from "@playwright/test";

/**
 * Writes rows straight into the projects store.
 *
 * Handle-less rows only: a fake handle carries function properties, and structured clone throws
 * `DataCloneError` on those, so a handle can never survive a round trip through IndexedDB in a
 * test. Handle-bearing rows are exercised in-session through `installFilePickerMock` instead.
 */

export const PROJECTS_DB_NAME = "mumbox-projects";
export const PROJECTS_STORE_NAME = "projects";

export type SeededProjectRow = {
  id: string;
  fileName: string;
  projectName?: string;
  description?: string;
  sizeBytes?: number | null;
  savedAt?: string;
  panelCount?: number | null;
  mediaCount?: number | null;
};

export async function seedProjectRows(page: Page, rows: SeededProjectRow[]) {
  await page.goto("/mumbox/favicon.svg");
  await page.evaluate(
    async (payload: { db: string; store: string; rows: SeededProjectRow[] }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(payload.db, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore(payload.store);
        };
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(request.error ?? new Error("open failed"));
        };
      });

      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(payload.store, "readwrite");
        const store = transaction.objectStore(payload.store);
        for (const row of payload.rows) {
          store.put(
            {
              id: row.id,
              fileName: row.fileName,
              projectName: row.projectName ?? "",
              description: row.description ?? "",
              sizeBytes: row.sizeBytes ?? 2048,
              savedAt: row.savedAt ?? new Date(0).toISOString(),
              lastOpenedAt: null,
              panelCount: row.panelCount ?? 1,
              mediaCount: row.mediaCount ?? 1
            },
            row.id
          );
        }
        transaction.oncomplete = () => {
          resolve();
        };
        transaction.onerror = () => {
          reject(transaction.error ?? new Error("write failed"));
        };
      });

      database.close();
    },
    { db: PROJECTS_DB_NAME, store: PROJECTS_STORE_NAME, rows }
  );
}

export function readProjectRowIds(page: Page) {
  return page.evaluate(
    async (payload: { db: string; store: string }) => {
      const names = await indexedDB.databases();
      if (!names.some((entry) => entry.name === payload.db)) {
        return [];
      }

      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(payload.db);
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(request.error ?? new Error("open failed"));
        };
      });

      if (!database.objectStoreNames.contains(payload.store)) {
        database.close();
        return [];
      }

      const keys = await new Promise<string[]>((resolve, reject) => {
        const request = database
          .transaction(payload.store, "readonly")
          .objectStore(payload.store)
          .getAllKeys();
        request.onsuccess = () => {
          resolve(request.result.map(String));
        };
        request.onerror = () => {
          reject(request.error ?? new Error("read failed"));
        };
      });

      database.close();

      return keys;
    },
    { db: PROJECTS_DB_NAME, store: PROJECTS_STORE_NAME }
  );
}

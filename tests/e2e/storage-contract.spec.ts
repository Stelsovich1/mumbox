import { expect, test } from "@playwright/test";

import { makeWavBuffer, SIZES } from "../support/audioFixtures";
import {
  APP_DB_NAME,
  APP_STORE_NAME,
  getPanelCellIds,
  IDB_DATABASE_NAME,
  IDB_STORE_NAME,
  MEDIA_BLOB_PREFIX,
  readSeededKeys,
  seedProject,
  STATE_RECORD_KEY
} from "../support/seedProject";
import {
  PROJECTS_DB_NAME,
  PROJECTS_STORE_NAME,
  readProjectRowIds,
  seedProjectRows
} from "../support/seedProjects";

/**
 * Drift guards for the two contracts `tests/support/seedProject.ts` duplicates instead of
 * importing. If idb-keyval changes its default database or store name, or if the cell-id scheme
 * in `getPanelCellIds` changes, these fail loudly rather than letting the seeder silently write
 * into a store nobody reads.
 */

test("idb-keyval writes imported media where the seeding helper expects them", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("audio-file-input").setInputFiles({
    name: "contract.wav",
    mimeType: "audio/wav",
    buffer: makeWavBuffer({ seconds: 0.25, channels: 1, freqHz: 220 })
  });
  const importDialog = page.getByRole("dialog", { name: "Импорт аудио" });
  await expect(importDialog).toBeVisible();
  await importDialog.getByRole("cell", { name: "contract.wav", exact: true }).click();
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(importDialog).toBeHidden();

  const databases = await page.evaluate(async () => {
    const list = await indexedDB.databases();
    return list.map((entry) => entry.name ?? "");
  });
  expect(databases).toContain(IDB_DATABASE_NAME);

  const stores = await page.evaluate(async (dbName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName);
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(request.error ?? new Error("open failed"));
      };
    });
    const names = Array.from(db.objectStoreNames);
    db.close();
    return names;
  }, IDB_DATABASE_NAME);
  expect(stores).toContain(IDB_STORE_NAME);

  const keys = await readSeededKeys(page);
  const mediaKeys = keys.filter((key) => key.startsWith(MEDIA_BLOB_PREFIX));
  expect(mediaKeys).toHaveLength(1);
});

test("seeded cell ids match the ids the app renders", async ({ page }) => {
  const seed = await seedProject(page, {
    panels: 1,
    gridSize: 12,
    distinctMedia: 2,
    spec: SIZES.small,
    filledCellsPerPanel: 3
  });
  await page.goto("/");

  const panelId = seed.panelIds[0] ?? "";
  const expectedCellIds = seed.cellIdsByPanel[panelId] ?? [];
  expect(expectedCellIds).toEqual(getPanelCellIds(12));

  await expect(page.locator("[data-cell-id]")).toHaveCount(expectedCellIds.length);
  const renderedCellIds = await page.locator("[data-cell-id]").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-cell-id") ?? "")
  );
  expect(renderedCellIds).toEqual(expectedCellIds);
});

test("seeded media blobs are readable by the app", async ({ page }) => {
  const seed = await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 2,
    spec: SIZES.small,
    filledCellsPerPanel: 2
  });
  await page.goto("/");

  const keys = await readSeededKeys(page);
  for (const asset of seed.media) {
    expect(keys).toContain(`${MEDIA_BLOB_PREFIX}${asset.id}`);
  }

  // The seeded layout must actually render the assigned media, which proves the state shape
  // survives `sanitizeImportedState`.
  await expect(page.getByRole("button", { name: "Ячейка 1 Seed 0" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ячейка 2 Seed 1" })).toBeVisible();
});

test("the projects list lives in its own database, keyed by row id", async ({ page }) => {
  await seedProjectRows(page, [{ id: "project-contract", fileName: "contract.mumbox" }]);

  const database = await page.evaluate(async (name: string) => {
    const databases = await indexedDB.databases();

    return databases.find((entry) => entry.name === name)?.name ?? null;
  }, PROJECTS_DB_NAME);
  expect(database).toBe(PROJECTS_DB_NAME);

  const storeNames = await page.evaluate(
    (payload: { db: string }) =>
      new Promise<string[]>((resolve, reject) => {
        const request = indexedDB.open(payload.db);
        request.onsuccess = () => {
          const names = Array.from(request.result.objectStoreNames);
          request.result.close();
          resolve(names);
        };
        request.onerror = () => {
          reject(request.error ?? new Error("open failed"));
        };
      }),
    { db: PROJECTS_DB_NAME }
  );
  expect(storeNames).toContain(PROJECTS_STORE_NAME);
  expect(await readProjectRowIds(page)).toEqual(["project-contract"]);
});

test("a full reset empties both the media store and the projects store", async ({ page }) => {
  // idb-keyval's clear() only reaches the default store, so clearing the projects database is an
  // explicit extra call. This pins that it is actually made.
  await seedProjectRows(page, [{ id: "project-contract", fileName: "contract.mumbox" }]);
  const seed = await seedProject(page, {
    panels: 1,
    gridSize: 6,
    distinctMedia: 1,
    spec: SIZES.small,
    filledCellsPerPanel: 1
  });
  await page.goto("/");

  expect(await readSeededKeys(page)).toContain(`${MEDIA_BLOB_PREFIX}${seed.media[0]?.id ?? ""}`);

  await page.getByRole("button", { name: "Проект" }).click();
  await page.getByText("Стереть все данные").click();
  await page.getByRole("button", { name: "Да, стереть" }).click();
  await expect(page.getByText("Все данные MUMBOX стерты")).toBeVisible();

  await expect
    .poll(async () => (await readSeededKeys(page)).filter((key) => key.startsWith(MEDIA_BLOB_PREFIX)))
    .toEqual([]);
  await expect.poll(async () => readProjectRowIds(page)).toEqual([]);
});

/**
 * The layout lives in its own IndexedDB database now.
 *
 * This is the drift guard for that, mirroring the idb-keyval one above: if the app and the seeding
 * helper ever disagree about the database, store or key, every seeded test would quietly exercise
 * a fresh project instead of the one it set up.
 */
test("the app writes its layout where the seeding helper expects it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Добавить панель" }).click();
  await expect(page.getByRole("tab", { name: "Panel 2" })).toBeVisible();

  await expect
    .poll(
      async () =>
        page.evaluate(
          async ({ dbName, storeName, key }) => {
            const db = await new Promise<IDBDatabase | null>((resolve) => {
              const request = indexedDB.open(dbName);
              request.onsuccess = () => {
                resolve(request.result);
              };
              request.onerror = () => {
                resolve(null);
              };
            });
            if (!db?.objectStoreNames.contains(storeName)) {
              db?.close();
              return null;
            }
            const value = await new Promise<unknown>((resolve) => {
              const request = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
              request.onsuccess = () => {
                resolve(request.result);
              };
              request.onerror = () => {
                resolve(null);
              };
            });
            db.close();
            return value === undefined || value === null
              ? null
              : (value as { panels: { name: string }[] }).panels.map((panel) => panel.name);
          },
          { dbName: APP_DB_NAME, storeName: APP_STORE_NAME, key: STATE_RECORD_KEY }
        ),
      { timeout: 10_000 }
    )
    .not.toBeNull();
});

/**
 * A layout written by an older build must survive the move.
 *
 * The old localStorage key is deliberately left in place after migrating — the app is a PWA with
 * `registerType: "prompt"`, so a user can stay on the previous build for weeks, and deleting it
 * would open an empty project there.
 */
test("state written by an older build is migrated and then read from IndexedDB", async ({ page }) => {
  const legacy = {
    panels: [{ id: "panel-legacy", name: "Старая", gridSize: 6, cellIds: ["cell-0"] }],
    activePanelId: "panel-legacy",
    cellsByPanel: { "panel-legacy": {} },
    media: [],
    masterVolume: 80,
    masterMuted: false,
    stopOthers: false
  };
  await page.addInitScript(
    ({ key, value }) => {
      localStorage.setItem(key, JSON.stringify(value));
    },
    { key: "mumbox:state:v1", value: legacy }
  );
  await page.goto("/");

  await expect(page.getByRole("tab", { name: "Старая" })).toBeVisible();
  await expect
    .poll(
      async () =>
        page.evaluate(
          async ({ dbName, storeName, key }) => {
            const db = await new Promise<IDBDatabase | null>((resolve) => {
              const request = indexedDB.open(dbName);
              request.onsuccess = () => {
                resolve(request.result);
              };
              request.onerror = () => {
                resolve(null);
              };
            });
            if (!db?.objectStoreNames.contains(storeName)) {
              db?.close();
              return false;
            }
            const value = await new Promise<unknown>((resolve) => {
              const request = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
              request.onsuccess = () => {
                resolve(request.result);
              };
              request.onerror = () => {
                resolve(null);
              };
            });
            db.close();
            return Boolean(value);
          },
          { dbName: APP_DB_NAME, storeName: APP_STORE_NAME, key: STATE_RECORD_KEY }
        ),
      { timeout: 10_000 }
    )
    .toBe(true);

  // And the old key is still readable, so going back to the previous build is not data loss.
  const legacyStillThere = await page.evaluate(() =>
    Boolean(localStorage.getItem("mumbox:state:v1"))
  );
  expect(legacyStillThere).toBe(true);
});

/**
 * A FAILED read is not an empty one, and the difference is the most destructive thing this layer
 * could get wrong: if the data is there and only the read failed, the first write would replace a
 * real project with a fresh one. So the app starts empty AND stops writing.
 */
test("a failed read leaves the stored project untouched", async ({ page }) => {
  await page.addInitScript(() => {
    const original = indexedDB.open.bind(indexedDB);
    Object.defineProperty(indexedDB, "open", {
      configurable: true,
      value: (name: string, version?: number) => {
        if (name === "mumbox-app") {
          throw new DOMException("blocked", "InvalidStateError");
        }
        return version === undefined ? original(name) : original(name, version);
      }
    });
  });
  await page.goto("/");

  // Usable, and honest about not saving.
  await expect(page.getByRole("button", { name: "Режим редактирования" })).toBeVisible();
  await expect(page.getByText("Состояние не сохраняется. Сохраните проект в файл")).toBeVisible();
  await expect(page.getByTestId("error-boundary")).toHaveCount(0);

  // A dispatch must not start writing over whatever is really in that store.
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Добавить панель" }).click();
  await expect(page.getByRole("tab", { name: "Panel 2" })).toBeVisible();
  await expect(page.getByTestId("error-boundary")).toHaveCount(0);
});

/** Reads the stored layout's panel names, or null when there is nothing to read. */
async function readStoredPanelNames(page: import("@playwright/test").Page) {
  return page.evaluate(
    async ({ dbName, storeName, key }) => {
      const db = await new Promise<IDBDatabase | null>((resolve) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          resolve(null);
        };
      });
      if (!db?.objectStoreNames.contains(storeName)) {
        db?.close();
        return null;
      }
      const value = await new Promise<unknown>((resolve) => {
        const request = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          resolve(null);
        };
      });
      db.close();
      if (value === undefined || value === null) {
        return null;
      }
      return (value as { panels: { name: string }[] }).panels.map((panel) => panel.name);
    },
    { dbName: APP_DB_NAME, storeName: APP_STORE_NAME, key: STATE_RECORD_KEY }
  );
}

test("a failed read really does leave the stored project on disk", async ({ page }) => {
  // The test above this one asserts the app survives a failed read. It never seeds a project and
  // never reads the store back, so the destructive half — writing an empty project over a real one
  // — was named in a title and asserted nowhere. This is that half.
  await page.goto("/");
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Добавить панель" }).click();
  await expect(page.getByRole("tab", { name: "Panel 2" })).toBeVisible();
  await expect.poll(() => readStoredPanelNames(page), { timeout: 10_000 }).toEqual([
    "Panel 1",
    "Panel 2"
  ]);

  await page.addInitScript(() => {
    const original = indexedDB.open.bind(indexedDB);
    let failed = false;
    Object.defineProperty(indexedDB, "open", {
      configurable: true,
      value: (name: string, version?: number) => {
        // Once only: the app must be unable to READ the layout, while the assertion below still
        // needs a working handle to prove the layout is still there.
        if (name === "mumbox-app" && !failed) {
          failed = true;
          throw new DOMException("blocked", "InvalidStateError");
        }
        return version === undefined ? original(name) : original(name, version);
      }
    });
  });
  await page.reload();

  // Empty on screen, and honest about it.
  await expect(page.getByRole("tab", { name: "Panel 2" })).toHaveCount(0);
  await expect(page.getByText("Состояние не сохраняется. Сохраните проект в файл")).toBeVisible();

  // Now edit. Under a handle that had been started anyway, this is the dispatch that would replace
  // the real project with the fresh one.
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Добавить панель" }).click();
  await expect(page.getByRole("tab", { name: "Panel 2" })).toBeVisible();

  await expect.poll(() => readStoredPanelNames(page), { timeout: 5_000 }).toEqual([
    "Panel 1",
    "Panel 2"
  ]);
});

test("a stored layout that is not a layout leaves a usable app, not a blank page", async ({
  page
}) => {
  // `hydrateAppState` catches, and nothing exercised the catch: the seeder always writes a
  // well-formed record. Unlike the import path there is no validation between the store and the
  // reducer, so a truncated or hand-edited record throws inside the boot promise — `setBoot` never
  // runs, the gate keeps rendering null, and the user gets a permanently blank page with no error
  // boundary and no way out short of clearing site data.
  await page.goto("/mumbox/favicon.svg");
  await page.evaluate(
    async ({ dbName, storeName, key }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore(storeName);
        };
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(request.error ?? new Error("open failed"));
        };
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).put({ panels: null, cellsByPanel: null }, key);
        tx.oncomplete = () => {
          resolve();
        };
        tx.onerror = () => {
          reject(tx.error ?? new Error("write failed"));
        };
      });
      db.close();
    },
    { dbName: APP_DB_NAME, storeName: APP_STORE_NAME, key: STATE_RECORD_KEY }
  );

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Режим редактирования" })).toBeVisible();
  await expect(page.getByTestId("error-boundary")).toHaveCount(0);
  // And still usable rather than merely rendered.
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Добавить панель" }).click();
  await expect(page.getByRole("tab", { name: "Panel 2" })).toBeVisible();
});

test("a burst of volume changes is written once, and within the max wait", async ({ page }) => {
  // Two halves of the debounce, and only the first was ever exercised. The trailing delay is what
  // stops sixty writes a second during a slider drag; the 2 s CAP is what stops a continuous
  // gesture from re-arming that delay forever and never writing at all — where a tab killed
  // mid-gesture loses everything since the previous edit.
  //
  // Counted on `ui:v1` now, because that is where a volume change lands. `state:v1` is counted
  // too, and the assertion on it is the point of the split: a drag must not rewrite the layout.
  await page.goto("/");
  await expect(page.getByLabel("Общая громкость")).toBeVisible();

  const writes = await page.evaluate(async () => {
    const slider = document.querySelector<HTMLInputElement>(
      'input[aria-label="Общая громкость"]'
    );
    if (!slider) {
      throw new Error("slider missing");
    }
    let uiPuts = 0;
    let layoutPuts = 0;
    const store = IDBObjectStore.prototype as unknown as {
      put: (this: IDBObjectStore, value: unknown, key?: IDBValidKey) => IDBRequest;
    };
    const originalPut = store.put;
    Object.defineProperty(IDBObjectStore.prototype, "put", {
      configurable: true,
      value: function put(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        if (this.name === "state" && key === "ui:v1") {
          uiPuts += 1;
        }
        if (this.name === "state" && key === "state:v1") {
          layoutPuts += 1;
        }
        return originalPut.call(this, value, key);
      }
    });

    // A continuous gesture: one change every 16 ms for 3 s, i.e. well past the 2 s cap.
    //
    // Through the prototype setter because React tracks the input's last value on the node and
    // ignores an `input` event whose value it believes it already has - assigning `slider.value`
    // directly would fire events the app never sees.
    const descriptor = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    );
    const setValue = (element: HTMLInputElement, value: string) => {
      descriptor?.set?.call(element, value);
    };
    const started = performance.now();
    // A monotonic sweep rather than a 40/41 toggle: the writer drops a write whose payload equals
    // the one it last stored, and with two values the cap write and the trailing write landed on
    // the same number often enough to look like a debounce that never fired.
    let volume = 40;
    while (performance.now() - started < 3000) {
      volume = (volume % 100) + 1;
      setValue(slider, String(volume));
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 16));
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1200));
    Object.defineProperty(IDBObjectStore.prototype, "put", {
      configurable: true,
      value: originalPut
    });
    return { uiPuts, layoutPuts };
  });

  // Far fewer than the ~190 dispatches, which is the debounce doing its job...
  expect(writes.uiPuts).toBeLessThan(20);
  // ...and at least one landed DURING the gesture, which is the cap doing its job: without it the
  // trailing timer is re-armed on every change and the count here would be exactly one.
  expect(writes.uiPuts).toBeGreaterThan(1);
  // The layout is written at most once here — this test starts with no stored project, so the
  // first write of the session has to create `state:v1`. Every write after it is the sidecar.
  expect(writes.layoutPuts).toBeLessThanOrEqual(1);
});

/**
 * Switching panels must not rewrite the layout.
 *
 * `panel/select` changes one string. It used to persist the whole serialized project — and the
 * localStorage mirror on top of that — so cycling tabs pushed `navigator.storage.estimate()` up by
 * roughly the project size per switch: LevelDB appends the new value and keeps the old one until
 * compaction. The number recovered on its own, the write amplification behind it did not.
 */
test("cycling panels writes the hot-fields record, never the layout", async ({ page }) => {
  await seedProject(page, {
    panels: 3,
    gridSize: 6,
    distinctMedia: 1,
    spec: SIZES.small,
    filledCellsPerPanel: 1
  });
  await page.goto("/");
  const [firstPanel, secondPanel, thirdPanel] = ["Panel 1", "Panel 2", "Panel 3"];
  await expect(page.getByRole("tab", { name: firstPanel })).toBeVisible();

  type PutCounts = { ui: number; layout: number };
  type CountingWindow = Window & { __putCounts?: PutCounts; __restorePut?: () => void };
  // Counted in the page and READ back on demand: the object a `page.evaluate` returns is a
  // serialized copy, so polling one would poll a snapshot that can never change.
  await page.evaluate(() => {
    const store = IDBObjectStore.prototype as unknown as {
      put: (this: IDBObjectStore, value: unknown, key?: IDBValidKey) => IDBRequest;
    };
    const originalPut = store.put;
    const counts = { ui: 0, layout: 0 };
    (window as CountingWindow).__putCounts = counts;
    Object.defineProperty(IDBObjectStore.prototype, "put", {
      configurable: true,
      value: function put(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        if (this.name === "state" && key === "ui:v1") {
          counts.ui += 1;
        }
        if (this.name === "state" && key === "state:v1") {
          counts.layout += 1;
        }
        return originalPut.call(this, value, key);
      }
    });
    (window as CountingWindow).__restorePut = () => {
      Object.defineProperty(IDBObjectStore.prototype, "put", {
        configurable: true,
        value: originalPut
      });
    };
  });
  const readCounts = () =>
    page.evaluate(() => (window as CountingWindow).__putCounts ?? { ui: 0, layout: 0 });

  // Two full cycles, ending back where it started, with a pause past the 400 ms trailing debounce
  // after each switch. Without the pause the whole cycle collapses into one write whose content
  // equals what is already stored — which the dedup then drops, leaving nothing to count.
  for (let round = 0; round < 2; round += 1) {
    for (const panel of [secondPanel, thirdPanel, firstPanel]) {
      await page.getByRole("tab", { name: panel }).click();
      await expect(page.getByRole("tab", { name: panel })).toHaveAttribute(
        "aria-selected",
        "true"
      );
      await page.waitForTimeout(500);
    }
  }
  // Past the 400 ms trailing debounce and the 2 s cap.
  await expect.poll(async () => (await readCounts()).ui, { timeout: 5_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(1_200);
  await page.evaluate(() => {
    (window as CountingWindow).__restorePut?.();
  });

  const counts = await readCounts();
  expect(counts.layout).toBe(0);
  expect(counts.ui).toBeGreaterThan(0);

  // And the switch is still durable: the sidecar is what the next boot reads it from.
  await page.reload();
  await expect(page.getByRole("tab", { name: firstPanel })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await page.getByRole("tab", { name: thirdPanel }).click();
  await expect(page.getByRole("tab", { name: thirdPanel })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await page.waitForTimeout(1_200);
  await page.reload();
  await expect(page.getByRole("tab", { name: thirdPanel })).toHaveAttribute(
    "aria-selected",
    "true"
  );
});

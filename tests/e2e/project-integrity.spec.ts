import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { makeWavBuffer } from "../support/audioFixtures";
import { MEDIA_BLOB_PREFIX, readSeededKeys } from "../support/seedProject";
import { installFilePickerMock } from "../support/fileSystemAccessMock";
import { findEntry, parseArchive, readEntryText, replaceEntryBytes } from "../support/mumboxArchive";

/**
 * What happens to the user's project when the file they hand over is not what it claims to be.
 *
 * The reader used to check the archive's shape loosely and its CONTENT not at all: no CRC was ever
 * compared, `File.slice` past the end quietly returned fewer bytes, and the media blobs it handed
 * back were lazy views whose bytes had never been read. Import then deleted the old audio BEFORE
 * writing the new — on the strength of a comment claiming the zip had been "materialised and
 * validated" — so a file that was corrupt in the middle, or that had become unreadable since it was
 * picked, left the previous project deleted, the new one half written, and every pad silent.
 *
 * Each test here builds a real project through the app's own export path and then damages one
 * specific thing, so what is under test is the reader rather than a hand-written archive.
 */

test.use({ timezoneId: "UTC" });
test.skip(({ isMobile }) => isMobile, "the project menu is not offered on a coarse pointer");

const AUDIO = {
  name: "shared.wav",
  mimeType: "audio/wav",
  buffer: makeWavBuffer({ seconds: 0.25, channels: 1, freqHz: 220 })
};

async function installAudioMock(page: Page) {
  await page.addInitScript(() => {
    class MockAudio extends EventTarget {
      duration = 10;
      currentTime = 0;
      paused = true;
      volume = 1;
      loop = false;
      preload = "";

      constructor() {
        super();
        window.setTimeout(() => {
          this.dispatchEvent(new Event("loadedmetadata"));
        }, 0);
      }

      play() {
        return Promise.resolve();
      }

      pause() {
        // no-op
      }

      load() {
        // no-op
      }
    }
    Object.defineProperty(window, "Audio", { value: MockAudio, configurable: true });
  });
}

/** Builds a one-cell project and returns the path of the exported file. */
async function buildProject(page: Page): Promise<string> {
  await installFilePickerMock(page, { mode: "unsupported" });
  await installAudioMock(page);
  await page.goto("/");

  await page.getByTestId("audio-file-input").setInputFiles(AUDIO);
  await page.getByLabel("Выбрать все аудио").click();
  await page.getByRole("button", { name: "Сохранить" }).click();
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Пустая ячейка 1", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать shared.wav" }).click();
  await page.getByRole("button", { name: "Сохранить настройки ячейки" }).click();
  await page.getByRole("button", { name: "Режим редактирования" }).click();

  await page.getByRole("button", { name: "Проект" }).click();
  await page.getByRole("menuitem", { name: "Сохранить проект" }).click();
  await page.getByLabel("Имя проекта").fill("Исходный");
  await page.getByLabel("Имя файла проекта").fill("source");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  const download = await downloadPromise;

  const path = join(tmpdir(), `integrity-${String(Date.now())}-${String(Math.random()).slice(2)}.mumbox`);
  await download.saveAs(path);
  return path;
}

async function damage(path: string, mutate: (bytes: Buffer) => void): Promise<string> {
  const bytes = await readFile(path);
  mutate(bytes);
  const damaged = `${path}.damaged.mumbox`;
  await writeFile(damaged, bytes);
  return damaged;
}

async function importFile(page: Page, path: string) {
  // Straight at the input, the same way `projects.spec.ts` does it. The menu entry only exists to
  // put a confirmation in front of the picker; `handleProjectFile` runs off the change event, and
  // going through it here would test the dialog rather than the reader.
  await page.getByTestId("project-file-input").setInputFiles(path);
}

/** The layout the app must still be showing after a refused import. */
async function expectProjectIntact(page: Page) {
  await expect(page.getByRole("button", { name: "Ячейка 1 shared.wav" })).toBeVisible();
  // And still interactive: a throw inside the reducer used to unwind the whole tree.
  await expect(page.getByRole("button", { name: "Режим редактирования" })).toBeVisible();
  await expect(page.getByTestId("error-boundary")).toHaveCount(0);
}

test("a corrupt audio payload is refused and the current project survives", async ({ page }) => {
  // The headline case for both B2 and B4. A flipped byte in the middle of PCM still decodes
  // perfectly, which is exactly why nothing but a checksum can see it — and why the old reader
  // imported it, having already deleted the previous project's audio.
  const source = await buildProject(page);
  const damaged = await damage(source, (bytes) => {
    const archive = parseArchive(bytes);
    const media = findEntry(archive, (name) => name.startsWith("media/"));
    const at = media.dataStart + Math.floor(media.compressedSize / 2);
    bytes[at] = (bytes[at] ?? 0) ^ 0xff;
  });

  await importFile(page, damaged);
  await expect(page.getByText(/Файл проекта повреждён/)).toBeVisible();
  await expectProjectIntact(page);
});

test("a grown entry size is refused", async ({ page }) => {
  // Consistent in both headers, so only the bound against the directory catches it.
  const source = await buildProject(page);
  const damaged = await damage(source, (bytes) => {
    const archive = parseArchive(bytes);
    const media = findEntry(archive, (name) => name.startsWith("media/"));
    const grown = media.compressedSize + 64;
    bytes.writeUInt32LE(grown, media.centralOffset + 20);
    bytes.writeUInt32LE(grown, media.centralOffset + 24);
    bytes.writeUInt32LE(grown, media.localOffset + 18);
    bytes.writeUInt32LE(grown, media.localOffset + 22);
  });

  await importFile(page, damaged);
  await expect(page.getByText(/Файл проекта повреждён/)).toBeVisible();
  await expectProjectIntact(page);
});

test("a size changed in the directory alone is refused", async ({ page }) => {
  // The other half of the pair: the local header still disagrees, which is what `header-mismatch`
  // exists for. Both variants are kept because they fail through different checks.
  const source = await buildProject(page);
  const damaged = await damage(source, (bytes) => {
    const archive = parseArchive(bytes);
    const media = findEntry(archive, (name) => name.startsWith("media/"));
    bytes.writeUInt32LE(media.compressedSize + 8, media.centralOffset + 20);
    bytes.writeUInt32LE(media.compressedSize + 8, media.centralOffset + 24);
  });

  await importFile(page, damaged);
  await expect(page.getByText(/Файл проекта повреждён/)).toBeVisible();
  await expectProjectIntact(page);
});

test("a deflated entry is refused", async ({ page }) => {
  const source = await buildProject(page);
  const damaged = await damage(source, (bytes) => {
    const archive = parseArchive(bytes);
    const media = findEntry(archive, (name) => name.startsWith("media/"));
    bytes.writeUInt16LE(8, media.centralOffset + 10);
  });

  await importFile(page, damaged);
  await expect(page.getByText(/Файл проекта повреждён/)).toBeVisible();
  await expectProjectIntact(page);
});

test("an entry-count mismatch is refused", async ({ page }) => {
  const source = await buildProject(page);
  const damaged = await damage(source, (bytes) => {
    const archive = parseArchive(bytes);
    const count = archive.entries.length - 1;
    bytes.writeUInt16LE(count, archive.eocdOffset + 8);
    bytes.writeUInt16LE(count, archive.eocdOffset + 10);
  });

  await importFile(page, damaged);
  await expect(page.getByText(/Файл проекта повреждён/)).toBeVisible();
  await expectProjectIntact(page);
});

test("a manifest without panels is refused before the reducer sees it", async ({ page }) => {
  // The rename is the same length, so no offset moves, and the CRC is recomputed — otherwise the
  // checksum would fire first and the test would prove the wrong thing.
  const source = await buildProject(page);
  const damaged = await damage(source, (bytes) => {
    const archive = parseArchive(bytes);
    const manifest = findEntry(archive, (name) => name === "project.json");
    const text = readEntryText(bytes, manifest).replace('"panels"', '"panelZ"');
    replaceEntryBytes(bytes, manifest, Buffer.from(text, "utf8"));
  });

  await importFile(page, damaged);
  await expect(page.getByText(/Файл проекта повреждён/)).toBeVisible();
  await expectProjectIntact(page);
});

test("a manifest without cellsByPanel is refused", async ({ page }) => {
  const source = await buildProject(page);
  const damaged = await damage(source, (bytes) => {
    const archive = parseArchive(bytes);
    const manifest = findEntry(archive, (name) => name === "project.json");
    const text = readEntryText(bytes, manifest).replace('"cellsByPanel"', '"cellsByPaneX"');
    replaceEntryBytes(bytes, manifest, Buffer.from(text, "utf8"));
  });

  await importFile(page, damaged);
  await expect(page.getByText(/Файл проекта повреждён/)).toBeVisible();
  await expectProjectIntact(page);
});

test("a manifest from another version is refused", async ({ page }) => {
  const source = await buildProject(page);
  const damaged = await damage(source, (bytes) => {
    const archive = parseArchive(bytes);
    const manifest = findEntry(archive, (name) => name === "project.json");
    const text = readEntryText(bytes, manifest).replace('"version":2', '"version":9');
    replaceEntryBytes(bytes, manifest, Buffer.from(text, "utf8"));
  });

  await importFile(page, damaged);
  await expect(page.getByText(/Файл проекта повреждён/)).toBeVisible();
  await expectProjectIntact(page);
});

test("a valid project still imports", async ({ page }) => {
  // The negative control, and it is not optional: every test above passes on a reader that refuses
  // everything.
  const source = await buildProject(page);
  await importFile(page, source);
  await expect(page.getByText(/Проект импортирован/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Ячейка 1 shared.wav" })).toBeVisible();
});

/**
 * The persist barrier around the one irreversible step of an import.
 *
 * Import writes the incoming audio, applies the state, and only then deletes the outgoing audio.
 * That ordering is only safe while the applied state is DURABLE: between the dispatch and the
 * write, the persisted state still names exactly the blobs about to be deleted, so a write that
 * never landed turns the deletion into permanent loss of a project the app still shows on screen.
 *
 * The barrier that was supposed to close this window did nothing at all. React schedules the
 * persistence effect on a macrotask and runs it after the commit, while `await` resolves in a
 * microtask - so the flush ran first, found nothing queued, wrote nothing, and resolved. And it
 * could not have reported a failure even if it had run, because every write was wrapped in a catch
 * that swallowed the rejection into a console line.
 */
async function countMediaBlobs(page: Page): Promise<number> {
  const keys = await readSeededKeys(page);
  return keys.filter((key) => key.startsWith(MEDIA_BLOB_PREFIX)).length;
}

/** Fails writes to the app-state store only, leaving media writes and every read working. */
async function breakStateWrites(page: Page) {
  await page.addInitScript(() => {
    const store = IDBObjectStore.prototype as unknown as {
      put: (this: IDBObjectStore, value: unknown, key?: IDBValidKey) => IDBRequest;
    };
    const originalPut = store.put;
    Object.defineProperty(IDBObjectStore.prototype, "put", {
      configurable: true,
      value: function put(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        if (this.name === "state") {
          throw new DOMException("simulated", "QuotaExceededError");
        }
        return originalPut.call(this, value, key);
      }
    });
  });
}

test("a successful import replaces the previous audio", async ({ page }) => {
  // The control for the test below. Without it, a barrier that simply never deletes would pass.
  const source = await buildProject(page);
  expect(await countMediaBlobs(page)).toBe(1);

  await importFile(page, source);
  await expect(page.getByText(/Проект импортирован/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Ячейка 1 shared.wav" })).toBeVisible();
  // One in, one out: the import regenerates media ids, so a surviving old blob would show up here.
  await expect.poll(() => countMediaBlobs(page)).toBe(1);
});

test("an import whose state never reached storage keeps the previous audio", async ({ page }) => {
  const source = await buildProject(page);
  expect(await countMediaBlobs(page)).toBe(1);

  await breakStateWrites(page);
  await page.reload();
  await expect(page.getByRole("button", { name: "Ячейка 1 shared.wav" })).toBeVisible();

  await importFile(page, source);
  // Both sets of blobs, and this is the assertion that matters: keeping the old ones costs quota,
  // deleting them costs the project, because the state a reload will find still names them.
  await expect.poll(() => countMediaBlobs(page)).toBe(2);
  await expect(page.getByRole("button", { name: "Ячейка 1 shared.wav" })).toBeVisible();
  await expect(page.getByTestId("error-boundary")).toHaveCount(0);
  // The user is told, by one of two messages. Both are correct and they share one snackbar, so
  // which one is on screen depends on whether the sticky storage banner committed first; pinning
  // either alone would be pinning a scheduling detail.
  await expect(
    page.getByText(
      /Проект импортирован, но не сохранён|Состояние не сохраняется. Сохраните проект в файл/
    )
  ).toBeVisible();
});

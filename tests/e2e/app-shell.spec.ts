import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdir, readFile, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const audioFile = {
  name: "launch.wav",
  mimeType: "audio/wav",
  buffer: Buffer.from("RIFF....WAVEfmt ")
};

const secondAudioFile = {
  name: "alarm.mp3",
  mimeType: "audio/mpeg",
  buffer: Buffer.from("ID3")
};

const longAudioFile = {
  name: "this-is-a-very-long-audio-file-name-without-readable-spaces-for-title-hover.wav",
  mimeType: "audio/wav",
  buffer: Buffer.from("RIFF....WAVEfmt ")
};

function makeCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const crc32Table = makeCrc32Table();

function getCrc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc32Table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeStoredZip(entries: { name: string; data: Buffer }[]) {
  const fileParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const crc32 = getCrc32(entry.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc32, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    fileParts.push(local, entry.data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc32, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + entry.data.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([...fileParts, ...centralParts, end]);
}

const textFile = {
  name: "notes.txt",
  mimeType: "text/plain",
  buffer: Buffer.from("not audio")
};

async function installAudioMock(page: Page, options: { decodedDuration?: number } = {}) {
  await page.addInitScript(({ decodedDuration }) => {
    class MockAudio extends EventTarget {
      currentTime = 0;
      duration = 10;
      loop = false;
      preload = "";
      paused = true;
      volume = 1;

      constructor() {
        super();
        const audioWindow = window as Window & { __mumboxAudioInstances?: MockAudio[] };
        audioWindow.__mumboxAudioInstances = audioWindow.__mumboxAudioInstances ?? [];
        audioWindow.__mumboxAudioInstances.push(this);
        window.setTimeout(() => {
          this.dispatchEvent(new Event("loadedmetadata"));
        }, 0);
      }

      play() {
        this.paused = false;
        return Promise.resolve();
      }

      pause() {
        this.paused = true;
        this.dispatchEvent(new Event("pause"));
      }
    }

    Object.defineProperty(window, "Audio", {
      value: MockAudio
    });

    class MockAudioParam {
      value = 1;
      curveCalls = 0;

      cancelScheduledValues() {
        return this;
      }

      setValueAtTime(value: number) {
        this.value = value;
        return this;
      }

      setValueCurveAtTime(values: Float32Array) {
        this.curveCalls += 1;
        this.value = values[0] ?? this.value;
        return this;
      }
    }

    class MockGainNode {
      gain = new MockAudioParam();
      context: MockAudioContext;

      constructor(context: MockAudioContext) {
        this.context = context;
        const audioWindow = window as Window & { __mumboxGainNodes?: MockGainNode[] };
        audioWindow.__mumboxGainNodes = audioWindow.__mumboxGainNodes ?? [];
        audioWindow.__mumboxGainNodes.push(this);
      }

      connect() {
        return this;
      }
    }

    class MockAudioContext {
      currentTime = 0;
      destination = {};
      state = "running";

      decodeAudioData() {
        const audioWindow = window as Window & { __mumboxDecodeAudioCalls?: number };
        audioWindow.__mumboxDecodeAudioCalls = (audioWindow.__mumboxDecodeAudioCalls ?? 0) + 1;
        return Promise.resolve({
          duration: decodedDuration ?? 10,
          length: 4096,
          numberOfChannels: 1,
          getChannelData: () =>
            Float32Array.from({ length: 4096 }, (_, index) => Math.sin(index / 18) * 0.7)
        });
      }

      createMediaElementSource() {
        return {
          connect: (node: MockGainNode) => node
        };
      }

      createGain() {
        return new MockGainNode(this);
      }

      resume() {
        this.state = "running";
        return Promise.resolve();
      }

      close() {
        return Promise.resolve();
      }
    }

    Object.defineProperty(window, "AudioContext", {
      value: MockAudioContext
    });
  }, options);
}

async function importAudio(page: Page, alias: string) {
  await page.getByTestId("audio-file-input").setInputFiles(audioFile);
  const importDialog = page.getByRole("dialog", { name: "Импорт аудио" });
  await expect(importDialog).toBeVisible();
  await importDialog.getByRole("cell", { name: "launch.wav", exact: true }).click();
  await page.getByLabel("Псевдоним launch.wav").fill(alias);
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(importDialog).toBeHidden();
}

async function assignFirstCell(page: Page) {
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Пустая ячейка 1", exact: true }).click();
  await expect(page.getByRole("table", { name: "Выбор медиа" })).toBeVisible();
  await page.getByRole("button", { name: "Выбрать launch.wav" }).click();
}

async function assignCell(page: Page, cellNumber: number, fileName = "launch.wav") {
  await page.getByRole("button", { name: `Пустая ячейка ${String(cellNumber)}`, exact: true }).click();
  await expect(page.getByRole("table", { name: "Выбор медиа" })).toBeVisible();
  await page.getByRole("button", { name: `Выбрать ${fileName}` }).click();
}

function makeStoredCell(id: string, mediaId: string | null) {
  return {
    id,
    mediaId,
    aliasOverride: "",
    colorOverride: null,
    playbackMode: "once",
    volumeOffset: 0,
    hotkey: "",
    trimStartMs: null,
    trimEndMs: null,
    fadeInEnabled: false,
    fadeInMs: 0,
    fadeOutEnabled: false,
    fadeOutMs: 0
  };
}

async function seedStoredState(page: Page, state: unknown) {
  await page.addInitScript(
    ({ key, value }) => {
      localStorage.setItem(key, JSON.stringify(value));
    },
    { key: "mumbox:state:v1", value: state }
  );
  await page.goto("/");
}

async function openFileMenu(page: Page) {
  await page.getByRole("button", { name: "Проект" }).click();
}

async function touchDragCell(page: Page, fromCellId: string, toCellId: string) {
  const source = page.locator(`[data-cell-id="${fromCellId}"]`);
  const target = page.locator(`[data-cell-id="${toCellId}"]`);
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();

  if (!sourceBox || !targetBox) {
    throw new Error("Cell boxes are not available for touch drag");
  }

  const start = {
    x: sourceBox.x + sourceBox.width / 2,
    y: sourceBox.y + sourceBox.height / 2
  };
  const end = {
    x: targetBox.x + targetBox.width / 2,
    y: targetBox.y + targetBox.height / 2
  };

  await source.evaluate(
    (element, point) => {
      element.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          pointerId: 7,
          pointerType: "touch",
          isPrimary: true,
          clientX: point.x,
          clientY: point.y,
          button: 0,
          buttons: 1
        })
      );
    },
    start
  );
  await page.waitForTimeout(220);
  await source.evaluate(
    (element, point) => {
      element.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          pointerId: 7,
          pointerType: "touch",
          isPrimary: true,
          clientX: point.x,
          clientY: point.y,
          button: 0,
          buttons: 1
        })
      );
    },
    end
  );
  await source.evaluate(
    (element, point) => {
      element.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          pointerId: 7,
          pointerType: "touch",
          isPrimary: true,
          clientX: point.x,
          clientY: point.y,
          button: 0,
          buttons: 0
        })
      );
    },
    end
  );
}

test("renders the MUMBOX shell", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText("MUMBOX", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Проект" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Panel 1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Добавить панель" })).toHaveCount(0);
  await expect(page.getByLabel("Рабочая сетка 8 на 8")).toBeVisible();
  await expect(page.getByLabel("Общая громкость")).toBeVisible();
});

test("shows a dismissible mobile browser install recommendation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-landscape", "Install recommendation is mobile-only.");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const recommendation = page.getByText("Добавьте ярлык на главный экран, чтобы установить MUMBOX.");
  await expect(recommendation).toBeVisible();
  await page.getByRole("button", { name: "ОК" }).click();
  await expect(recommendation).toHaveCount(0);

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.getByLabel("Рабочая сетка 8 на 8")).toBeVisible();
});

test("ignores a stale visual viewport keyboard height when no field is focused", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-landscape", "visual viewport behavior is mobile-specific.");
  await page.addInitScript(() => {
    const viewport = new EventTarget() as EventTarget & {
      height: number;
      width: number;
      offsetTop: number;
      offsetLeft: number;
      scale: number;
    };
    viewport.height = 260;
    viewport.width = 932;
    viewport.offsetTop = 0;
    viewport.offsetLeft = 0;
    viewport.scale = 1;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 430 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  });
  await page.goto("/");

  await expect
    .poll(async () =>
      page.evaluate(() => document.documentElement.style.getPropertyValue("--app-height"))
    )
    .toBe("430px");
});

test("opens project FAQ from the file menu", async ({ page }) => {
  await page.goto("/");

  await openFileMenu(page);
  await page.getByRole("menuitem", { name: "ЧАВО" }).click();
  await expect(page.getByRole("dialog", { name: "Документация MUMBOX" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Оглавление ЧАВО" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Медиатека и проекты" })).toBeVisible();
  await expect(page.getByText("Разработчик вдохновлялся мобильным приложением RemixLive")).toBeVisible();
  await expect(page.getByText("локальном браузерном хранилище IndexedDB")).toBeVisible();
  await expect(page.getByText("Developer: Stelsovich1.")).toBeVisible();
  await page.getByRole("button", { name: "ОК" }).click();
  await expect(page.getByRole("dialog", { name: "Документация MUMBOX" })).toHaveCount(0);
});

test("hides app update controls when no new version is available", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("dialog", { name: "Доступна новая версия" })).toHaveCount(0);
  await openFileMenu(page);
  await expect(page.getByRole("menuitem", { name: "Обновить приложение" })).toHaveCount(0);
});

test("prevents selection in workspace controls and highlights edit mode", async ({ page }) => {
  await page.goto("/");

  const workspace = page.getByLabel("Рабочая сетка 8 на 8");
  await expect(workspace).toHaveCSS("user-select", "none");
  await expect(page.getByLabel("Панель управления")).toHaveCSS("user-select", "none");
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await expect(workspace).toHaveCSS("border-top-color", "rgb(255, 204, 102)");
});

test("does not keep cell selection highlighted outside edit mode", async ({ page }) => {
  await page.goto("/");

  await importAudio(page, "Select Pad");
  await assignFirstCell(page);
  const cell = page.locator('[data-cell-id="cell-0"]');
  await expect(cell).toHaveAttribute("data-selected", "true");
  await page.getByRole("button", { name: "Сохранить настройки ячейки" }).click();
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await expect(cell).toHaveAttribute("data-selected", "false");
});

test("exports, resets, and imports a project with audio", async ({
  page
}, testInfo) => {
  await installAudioMock(page);
  await page.goto("/");

  const projectInput = page.getByTestId("project-file-input");
  const projectAccept = await projectInput.getAttribute("accept");
  await expect(projectInput).toHaveAttribute("accept", /\.mumbox/);
  await expect(projectInput).toHaveAttribute("accept", /application\/vnd\.mumbox\.project\+zip/);
  await expect(projectInput).toHaveAttribute("accept", /application\/zip/);
  expect(projectAccept).not.toContain("application/vnd.mumbox.project+json");
  if (testInfo.project.name === "mobile-landscape") {
    await expect(projectInput).toHaveAttribute("accept", /application\/octet-stream/);
  } else {
    expect(projectAccept).not.toContain("application/octet-stream");
  }

  await importAudio(page, "Portable Pad");
  await assignFirstCell(page);
  await page.getByRole("button", { name: "Сохранить настройки ячейки" }).click();

  await openFileMenu(page);
  await page.getByText("Экспорт проекта").click();
  await expect(page.getByRole("dialog", { name: "Проект готов к сохранению" })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Выбрать место" }).click();
  const download = await downloadPromise;
  await expect(page.getByText("Браузер открыл сохранение проекта: mumbox-project.mumbox")).toHaveCount(0);
  expect(download.suggestedFilename()).toBe("mumbox-project.mumbox");
  const projectPath = join(tmpdir(), `mumbox-project-${Date.now().toString()}.mumbox`);
  await download.saveAs(projectPath);
  const projectText = await readFile(projectPath, "utf8");
  expect(projectText).toContain('"panels"');
  expect(projectText).toContain('"mediaBlobs"');

  await openFileMenu(page);
  await page.getByText("Стереть все данные").click();
  await expect(page.getByRole("dialog", { name: "Стереть все данные?" })).toBeVisible();
  await page.getByRole("button", { name: "Да, стереть" }).click();
  await expect(page.getByRole("button", { name: "Пустая ячейка 1", exact: true })).toBeVisible();

  await page.getByTestId("project-file-input").setInputFiles(projectPath);
  await expect(page.getByText(`Проект импортирован: ${projectPath.split("/").at(-1) ?? ""}`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Ячейка 1 Portable Pad" })).toBeVisible();
});

test("warns before overwriting layout on project import", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Добавить панель" }).click();
  await openFileMenu(page);
  await expect(page.getByText("Импорт проекта")).toBeVisible();
  await expect(page.getByText("Импортировать из файла")).toHaveCount(0);
  await page.getByText("Импорт проекта").click();
  const warning = page.getByText("Импорт проекта перезапишет текущую рабочую раскладку и медиатеку");
  await expect(warning).toBeVisible();
  await page.getByRole("button", { name: "Отмена" }).click();
});

test("manages panels and grid size", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Добавить панель" })).toHaveCount(0);
  await page.getByRole("tab", { name: "Panel 1" }).dblclick();
  await expect(page.getByLabel("Название панели")).toHaveCount(0);

  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await expect(page.locator("header")).toHaveCSS("border-bottom-color", "rgba(236, 90, 167, 0.22)");
  await page.getByRole("button", { name: "Добавить панель" }).click();
  await expect(page.getByRole("tab", { name: "Panel 2" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Panel 1" })).toHaveCSS("color", "rgb(255, 204, 102)");
  await expect(page.getByRole("tab", { name: "Panel 2" })).toHaveCSS("color", "rgb(255, 204, 102)");
  await expect(page.getByRole("button", { name: "Удалить панель Panel 1" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Удалить панель Panel 2" })).toBeVisible();

  await page.getByRole("tab", { name: "Panel 2" }).dblclick();
  await page.getByLabel("Название панели").fill("Launch");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: "Launch" })).toBeVisible();

  await page.getByRole("tab", { name: "Launch" }).hover();
  await page.getByRole("button", { name: "Удалить панель Launch" }).click();
  await expect(page.getByText('Вы действительно хотите удалить панель "Launch"?')).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Launch" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Panel 1" })).toHaveAttribute("aria-selected", "true");

  await page.getByRole("button", { name: "Добавить панель" }).click();

  await page.getByRole("button", { name: "Размер сетки" }).click();
  await page.getByRole("button", { name: "6x6" }).click();
  await expect(page.getByLabel("Рабочая сетка 6 на 6")).toBeVisible();
  await expect(page.getByRole("button", { name: /Пустая ячейка/ })).toHaveCount(36);
});

test("copies a panel with duplicate-safe default name and independent cells", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "panel copy dialog select is covered once on desktop");
  const mediaAsset = {
    id: "media-source",
    fileName: "source.wav",
    alias: "Source Media",
    color: "#ec5aa7",
    mimeType: "audio/wav",
    size: 16,
    durationMs: 10000,
    createdAt: new Date().toISOString()
  };
  const cellIds = Array.from({ length: 36 }, (_, index) => `cell-${String(index)}`);
  const sourceCell = {
    ...makeStoredCell("cell-0", mediaAsset.id),
    aliasOverride: "Source Cell",
    colorOverride: "#2f80ed",
    playbackMode: "loop",
    volumeOffset: -12,
    hotkey: "K",
    trimStartMs: 1200,
    trimEndMs: 6400,
    fadeInEnabled: true,
    fadeInMs: 300,
    fadeOutEnabled: true,
    fadeOutMs: 450
  };

  await seedStoredState(page, {
    panels: [
      { id: "panel-alpha", name: "Alpha", gridSize: 6, cellIds },
      { id: "panel-alpha-copy", name: "Alpha_copy", gridSize: 6, cellIds }
    ],
    activePanelId: "panel-alpha",
    cellsByPanel: {
      "panel-alpha": {
        "cell-0": sourceCell,
        "cell-1": makeStoredCell("cell-1", null)
      },
      "panel-alpha-copy": {
        "cell-0": makeStoredCell("cell-0", null)
      }
    },
    media: [mediaAsset],
    masterVolume: 80,
    masterMuted: false,
    stopOthers: false
  });

  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Скопировать панель" }).click();
  const dialog = page.getByRole("dialog", { name: "Скопировать панель" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Панель" })).toHaveText("Alpha");
  await expect(page.getByPlaceholder("Alpha_copy")).toBeVisible();
  await dialog.getByRole("button", { name: "Скопировать" }).click();

  await expect(page.getByRole("tab", { name: "Alpha_copy_2" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Alpha_copy_2" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Рабочая сетка 6 на 6")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ячейка 1 Source Cell" })).toBeVisible();
  const copiedCell = page.locator('[data-cell-id="cell-0"]');
  await expect(copiedCell).toHaveAttribute("data-hotkey", "K");
  await expect(copiedCell).toHaveAttribute("data-playback-mode", "loop");
  await expect(copiedCell).toHaveAttribute("data-volume-offset", "-12");
  await expect(copiedCell).toHaveAttribute("data-trim-start-ms", "1200");
  await expect(copiedCell).toHaveAttribute("data-trim-end-ms", "6400");
  await expect(copiedCell).toHaveAttribute("data-fade-in-ms", "300");
  await expect(copiedCell).toHaveAttribute("data-fade-out-ms", "450");

  await page.getByRole("button", { name: "Ячейка 1 Source Cell" }).click();
  await page.getByLabel("Псевдоним ячейки").fill("Changed Copy");
  await page.getByRole("button", { name: "Сохранить настройки ячейки" }).click();
  await expect(page.getByRole("button", { name: "Ячейка 1 Changed Copy" })).toBeVisible();

  await page.getByRole("tab", { name: "Alpha", exact: true }).click();
  await expect(page.getByRole("button", { name: "Ячейка 1 Source Cell" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ячейка 1 Changed Copy" })).toHaveCount(0);
});

test("copies a selected panel with a custom name", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "panel copy dialog select is covered once on desktop");
  const mediaAsset = {
    id: "media-beta",
    fileName: "beta.wav",
    alias: "Beta Media",
    color: "#ec5aa7",
    mimeType: "audio/wav",
    size: 16,
    durationMs: 10000,
    createdAt: new Date().toISOString()
  };
  const cellIds = Array.from({ length: 36 }, (_, index) => `cell-${String(index)}`);

  await seedStoredState(page, {
    panels: [
      { id: "panel-alpha", name: "Alpha", gridSize: 6, cellIds },
      { id: "panel-beta", name: "Beta", gridSize: 8, cellIds: Array.from({ length: 64 }, (_, index) => `cell-${String(index)}`) }
    ],
    activePanelId: "panel-alpha",
    cellsByPanel: {
      "panel-alpha": {
        "cell-0": makeStoredCell("cell-0", null)
      },
      "panel-beta": {
        "cell-0": {
          ...makeStoredCell("cell-0", mediaAsset.id),
          aliasOverride: "Beta Cell"
        }
      }
    },
    media: [mediaAsset],
    masterVolume: 80,
    masterMuted: false,
    stopOthers: false
  });

  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Скопировать панель" }).click();
  const dialog = page.getByRole("dialog", { name: "Скопировать панель" });
  await dialog.getByRole("combobox", { name: "Панель" }).click();
  await page.getByRole("option", { name: "Beta" }).click();
  await page.getByLabel("Имя копии панели").fill("Beta Stage");
  await dialog.getByRole("button", { name: "Скопировать" }).click();

  await expect(page.getByRole("tab", { name: "Beta Stage" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Рабочая сетка 8 на 8")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ячейка 1 Beta Cell" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Пустая ячейка 2", exact: true })).toBeVisible();
});

test("asks confirmation only before deleting a panel with filled cells", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "delete confirmation dialog is covered once on desktop");
  const mediaAsset = {
    id: "media-delete",
    fileName: "delete.wav",
    alias: "Delete Media",
    color: "#ec5aa7",
    mimeType: "audio/wav",
    size: 16,
    durationMs: 10000,
    createdAt: new Date().toISOString()
  };
  const cellIds = Array.from({ length: 36 }, (_, index) => `cell-${String(index)}`);

  await seedStoredState(page, {
    panels: [
      { id: "panel-safe", name: "Safe", gridSize: 6, cellIds },
      { id: "panel-filled", name: "Filled", gridSize: 6, cellIds }
    ],
    activePanelId: "panel-filled",
    cellsByPanel: {
      "panel-safe": {
        "cell-0": makeStoredCell("cell-0", null)
      },
      "panel-filled": {
        "cell-0": {
          ...makeStoredCell("cell-0", mediaAsset.id),
          aliasOverride: "Filled Cell"
        }
      }
    },
    media: [mediaAsset],
    masterVolume: 80,
    masterMuted: false,
    stopOthers: false
  });

  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("tab", { name: "Filled" }).hover();
  await page.getByRole("button", { name: "Удалить панель Filled" }).click();
  const dialog = page.getByRole("dialog", { name: "Удалить панель?" });
  await expect(dialog).toBeVisible();
  await expect(page.getByText('Вы действительно хотите удалить панель "Filled"?')).toBeVisible();

  await dialog.getByRole("button", { name: "Отмена" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Filled" })).toBeVisible();

  await page.getByRole("tab", { name: "Filled" }).hover();
  await page.getByRole("button", { name: "Удалить панель Filled" }).click();
  await dialog.getByRole("button", { name: "Удалить" }).click();
  await expect(page.getByRole("tab", { name: "Filled" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Safe" })).toHaveAttribute("aria-selected", "true");
});

test("keeps panel copy controls usable on mobile landscape", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-landscape", "mobile spacing is viewport-specific");
  await page.goto("/");

  await page.getByRole("button", { name: "Режим редактирования" }).click();
  const addButton = page.getByRole("button", { name: "Добавить панель" });
  const copyButton = page.getByRole("button", { name: "Скопировать панель" });
  await expect(addButton).toBeVisible();
  await expect(copyButton).toBeVisible();

  const addBox = await addButton.boundingBox();
  const copyBox = await copyButton.boundingBox();
  if (!addBox || !copyBox) {
    throw new Error("Panel action buttons are not available");
  }
  const gap = copyBox.x - (addBox.x + addBox.width);
  expect(addBox.width).toBeGreaterThanOrEqual(32);
  expect(copyBox.width).toBeGreaterThanOrEqual(32);
  expect(gap).toBeGreaterThanOrEqual(5);
  expect(gap).toBeLessThanOrEqual(12);

  await copyButton.click();
  const dialog = page.getByRole("dialog", { name: "Скопировать панель" });
  await expect(dialog).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  if (!dialogBox) {
    throw new Error("Panel copy dialog is not available");
  }
  expect(dialogBox.width).toBeLessThanOrEqual(908);
  expect(dialogBox.height).toBeLessThanOrEqual(406);
});

test("keeps configured cells at the same coordinates when the grid grows", async ({ page }) => {
  await installAudioMock(page);
  await page.goto("/");

  await importAudio(page, "Stable Pad");
  await page.getByRole("button", { name: "Размер сетки" }).click();
  await page.getByRole("button", { name: "6x6" }).click();
  await expect(page.getByLabel("Рабочая сетка 6 на 6")).toBeVisible();

  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await assignCell(page, 8);
  await page.getByRole("button", { name: "Сохранить настройки ячейки" }).click();
  await expect(page.locator('[data-cell-id="cell-13"]')).toHaveAttribute("aria-label", "Ячейка 8 Stable Pad");

  await page.getByRole("button", { name: "Размер сетки" }).click();
  await page.getByRole("button", { name: "8x8" }).click();
  await expect(page.getByLabel("Рабочая сетка 8 на 8")).toBeVisible();
  await expect(page.locator('[data-cell-id="cell-13"]')).toHaveAttribute("aria-label", "Ячейка 10 Stable Pad");
  await expect(page.getByRole("button", { name: "Ячейка 8 Stable Pad" })).toHaveCount(0);

  await page.getByRole("button", { name: "Размер сетки" }).click();
  await page.getByRole("button", { name: "12x12" }).click();
  await expect(page.getByLabel("Рабочая сетка 12 на 12")).toBeVisible();
  await expect(page.locator('[data-cell-id="cell-13"]')).toHaveAttribute("aria-label", "Ячейка 14 Stable Pad");
});

test("renames panels from double tap on mobile landscape in edit mode", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-landscape", "double tap rename is mobile-specific");
  await page.goto("/");

  await page.getByRole("tab", { name: "Panel 1" }).dblclick();
  await expect(page.getByLabel("Название панели")).toHaveCount(0);

  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Добавить панель" }).click();
  const panelTab = page.getByRole("tab", { name: "Panel 2" });
  const panelBox = await panelTab.boundingBox();
  if (!panelBox) {
    throw new Error("Panel tab box is not available");
  }

  const tapX = panelBox.x + panelBox.width / 2;
  const tapY = panelBox.y + panelBox.height / 2;
  await page.touchscreen.tap(tapX, tapY);
  await page.waitForTimeout(80);
  await page.touchscreen.tap(tapX, tapY);

  await page.getByLabel("Название панели").fill("Mobile Launch");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: "Mobile Launch" })).toBeVisible();
});

test("keeps cells outside the smaller grid after switching 12x12 to 6x6 and back", async ({ page }) => {
  await installAudioMock(page);
  await page.goto("/");

  await importAudio(page, "Outer Pad");
  await page.getByRole("button", { name: "Размер сетки" }).click();
  await page.getByRole("button", { name: "12x12" }).click();
  await expect(page.getByLabel("Рабочая сетка 12 на 12")).toBeVisible();

  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await assignCell(page, 84);
  await page.getByLabel("Псевдоним ячейки").fill("Outer Cell");
  await page.getByRole("button", { name: "Сохранить настройки ячейки" }).click();
  await expect(page.getByRole("button", { name: "Ячейка 84 Outer Cell" })).toBeVisible();

  await page.getByRole("button", { name: "Размер сетки" }).click();
  await page.getByRole("button", { name: "6x6" }).click();
  await expect(page.getByLabel("Рабочая сетка 6 на 6")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ячейка 84 Outer Cell" })).toHaveCount(0);

  await page.getByRole("button", { name: "Размер сетки" }).click();
  await page.getByRole("button", { name: "12x12" }).click();
  await expect(page.getByRole("button", { name: "Ячейка 84 Outer Cell" })).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Рабочая сетка 12 на 12")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ячейка 84 Outer Cell" })).toBeVisible();
});

test("does not show playback state from another panel on empty cells", async ({ page }) => {
  await installAudioMock(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Добавить панель" }).click();
  await page.getByRole("tab", { name: "Panel 1" }).click();
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await importAudio(page, "Panel One Pad");
  await assignFirstCell(page);
  await page.getByRole("button", { name: "Сохранить настройки ячейки" }).click();
  await page.getByRole("button", { name: "Режим редактирования" }).click();

  const panelOneCell = page.locator('[data-cell-id="cell-0"]');
  await panelOneCell.click();
  await expect(panelOneCell).toHaveAttribute("data-playing", "true");

  await page.getByRole("tab", { name: "Panel 2" }).click();
  const panelTwoCell = page.locator('[data-cell-id="cell-0"]');
  await expect(panelTwoCell).toHaveAttribute("aria-label", "Пустая ячейка 1");
  await expect(panelTwoCell).toHaveAttribute("data-playing", "false");
  await expect(panelTwoCell).toHaveAttribute("data-warm-state", "idle");
});

test("copies a configured cell to the same panel using the first free cell", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "copy dialog select is covered once on desktop");
  await installAudioMock(page);
  await page.goto("/");

  await importAudio(page, "Launch Pad");
  await assignFirstCell(page);
  await page.getByRole("button", { name: "Скопировать", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Скопировать" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Панель" })).toHaveText("Panel 1");
  await expect(page.getByText("Копия будет помещена в первую свободную ячейку: #1")).toBeVisible();
  await page
    .getByRole("dialog", { name: "Скопировать" })
    .getByRole("button", { name: "Скопировать" })
    .click();

  await expect(page.getByRole("button", { name: "Ячейка 1 Launch Pad" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ячейка 2 launch.wav_copy" })).toBeVisible();
  await expect(page.locator('[data-cell-id="cell-1"]')).toHaveAttribute("data-hotkey", "");
});

test("copies a configured cell to another panel and hides panels without free cells", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "copy dialog select is covered once on desktop");
  await installAudioMock(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Добавить панель" }).click();
  await page.getByRole("tab", { name: "Panel 1" }).click();
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await importAudio(page, "Shared Pad");
  await assignFirstCell(page);
  await page.getByRole("button", { name: "Скопировать", exact: true }).click();

  await page.getByRole("combobox", { name: "Панель" }).click();
  await expect(page.getByRole("option", { name: "Panel 1" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Panel 2" })).toBeVisible();
  await page.getByRole("option", { name: "Panel 2" }).click();
  await expect(page.getByText("Копия будет помещена в первую свободную ячейку: #0")).toBeVisible();
  await page
    .getByRole("dialog", { name: "Скопировать" })
    .getByRole("button", { name: "Скопировать" })
    .click();

  await page.getByRole("button", { name: "Сохранить настройки ячейки" }).click();
  await page.getByRole("tab", { name: "Panel 2" }).click();
  await expect(page.getByRole("button", { name: "Ячейка 1 launch.wav_copy" })).toBeVisible();

  const mediaAsset = {
    id: "media-filled",
    fileName: "filled.wav",
    alias: "Filled",
    color: "#ec5aa7",
    mimeType: "audio/wav",
    size: 16,
    durationMs: 10000,
    createdAt: new Date().toISOString()
  };
  const panel1Ids = Array.from({ length: 2 }, (_, index) => `cell-${String(index)}`);
  const panel2Ids = Array.from({ length: 2 }, (_, index) => `cell-${String(index)}`);
  await seedStoredState(page, {
    panels: [
      { id: "panel-full", name: "Full", gridSize: 6, cellIds: panel1Ids },
      { id: "panel-open", name: "Open", gridSize: 6, cellIds: panel2Ids }
    ],
    activePanelId: "panel-open",
    cellsByPanel: {
      "panel-full": Object.fromEntries(panel1Ids.map((id) => [id, makeStoredCell(id, mediaAsset.id)])),
      "panel-open": {
        "cell-0": makeStoredCell("cell-0", mediaAsset.id),
        "cell-1": makeStoredCell("cell-1", null)
      }
    },
    media: [mediaAsset],
    masterVolume: 80,
    masterMuted: false,
    stopOthers: false
  });
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Ячейка 1 Filled" }).click();
  await page.getByRole("button", { name: "Скопировать", exact: true }).click();
  await page.getByRole("combobox", { name: "Панель" }).click();
  await expect(page.getByRole("option", { name: "Full" })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "Open" })).toBeVisible();
});

test("disables copy for filled cells when every visible target cell is occupied", async ({ page }) => {
  const mediaAsset = {
    id: "media-full",
    fileName: "full.wav",
    alias: "Full",
    color: "#ec5aa7",
    mimeType: "audio/wav",
    size: 16,
    durationMs: 10000,
    createdAt: new Date().toISOString()
  };
  const cellIds = Array.from({ length: 36 }, (_, index) => `cell-${String(index)}`);
  await seedStoredState(page, {
    panels: [{ id: "panel-full", name: "Full", gridSize: 6, cellIds }],
    activePanelId: "panel-full",
    cellsByPanel: {
      "panel-full": Object.fromEntries(cellIds.map((id) => [id, makeStoredCell(id, mediaAsset.id)]))
    },
    media: [mediaAsset],
    masterVolume: 80,
    masterMuted: false,
    stopOthers: false
  });

  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Ячейка 1 Full" }).click();
  await expect(page.getByRole("button", { name: "Скопировать", exact: true })).toBeDisabled();
});

test("imports audio and assigns it to a grid cell", async ({ page }) => {
  await installAudioMock(page);
  await page.goto("/");

  await page.getByTestId("audio-file-input").setInputFiles(audioFile);
  await expect(page.getByRole("dialog", { name: "Импорт аудио" })).toBeVisible();
  await expect(page.getByText("launch.wav")).toBeVisible();
  await expect(page.getByText("0:10")).toBeVisible();
  await expect(page.getByRole("button", { name: "Сохранить" })).toBeDisabled();
  await page.getByLabel("Выбрать launch.wav").click();
  await page.getByLabel("Псевдоним launch.wav").fill("Launch Pad");
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByRole("dialog", { name: "Импорт аудио" })).toBeHidden();

  await assignFirstCell(page);
  await page.getByRole("button", { name: "Сохранить настройки ячейки" }).click();

  await expect(page.getByRole("button", { name: "Ячейка 1 Launch Pad" })).toBeVisible();
});

test("wraps cell labels to two lines and breaks long file names", async ({ page }) => {
  await installAudioMock(page);
  await page.goto("/");

  await page.getByTestId("audio-file-input").setInputFiles([longAudioFile]);
  await page.getByLabel(`Выбрать ${longAudioFile.name}`).click();
  await page.getByRole("button", { name: "Сохранить" }).click();
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Пустая ячейка 1", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать " + longAudioFile.name }).click();

  const label = page.getByTestId("cell-label-cell-0");
  await expect(label).toHaveText(longAudioFile.name);
  await expect(label).toHaveCSS("white-space", "normal");
  await expect(label).toHaveCSS("overflow-wrap", "anywhere");
  const labelStyle = await label.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      lineClamp: style.getPropertyValue("-webkit-line-clamp"),
      fontSize: Number.parseFloat(style.fontSize)
    };
  });
  expect(labelStyle.lineClamp).toBe("2");
  expect(labelStyle.fontSize).toBeGreaterThanOrEqual(9);
});

test("selects imported audio by clicking the import table row", async ({ page }) => {
  await installAudioMock(page);
  await page.goto("/");

  await page.getByTestId("audio-file-input").setInputFiles(audioFile);
  await expect(page.getByRole("button", { name: "Сохранить" })).toBeDisabled();

  const importFileCell = page.getByRole("cell", { name: "launch.wav", exact: true });
  await importFileCell.click();
  await expect(page.getByRole("button", { name: "Сохранить" })).toBeEnabled();

  await importFileCell.click();
  await expect(page.getByRole("button", { name: "Сохранить" })).toBeDisabled();
});

test("opens media picker immediately for an empty cell", async ({ page }) => {
  await installAudioMock(page);
  await page.goto("/");

  await importAudio(page, "Launch Pad");
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Пустая ячейка 1", exact: true }).click();

  await expect(page.getByRole("table", { name: "Выбор медиа" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Выбрать медиа", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Выбрать launch.wav" })).toBeVisible();
});

test("shows empty media placeholder for an empty library", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Пустая ячейка 1", exact: true }).click();

  await expect(page.getByRole("table", { name: "Выбор медиа" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Выбрать медиа", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Очистить" })).toHaveCount(0);
  await expect(page.getByText("Нет аудио")).toBeVisible();
});

test("imports one file, multiple files, and an audio folder", async ({ page }) => {
  await installAudioMock(page);
  await page.goto("/");

  const audioInput = page.getByTestId("audio-file-input");
  const audioAccept = await audioInput.getAttribute("accept");
  await expect(audioInput).toHaveAttribute("accept", /\.mp3/);
  await expect(audioInput).toHaveAttribute("accept", /\.wav/);
  await expect(audioInput).toHaveAttribute("accept", /\.m4a/);
  expect(audioAccept).not.toContain("audio/*");
  await expect(page.getByTestId("audio-folder-input")).toHaveAttribute("accept", audioAccept ?? "");

  await page.getByTestId("audio-file-input").setInputFiles(audioFile);
  await expect(page.getByRole("dialog", { name: "Импорт аудио" })).toBeVisible();
  await expect(page.getByText("launch.wav")).toBeVisible();
  await expect(page.getByText("0:10")).toBeVisible();
  await page.getByRole("button", { name: "Отменить" }).click();

  await page.getByTestId("audio-file-input").setInputFiles([audioFile, secondAudioFile]);
  await expect(page.getByText("launch.wav")).toBeVisible();
  await expect(page.getByText("alarm.mp3")).toBeVisible();
  await page.getByRole("button", { name: "Отменить" }).click();

  const folderInput = page.getByTestId("audio-folder-input");
  const folderPath = join(tmpdir(), `mumbox-audio-folder-${Date.now().toString()}`);
  await mkdir(folderPath, { recursive: true });
  await writeFile(join(folderPath, audioFile.name), audioFile.buffer);
  await writeFile(join(folderPath, secondAudioFile.name), secondAudioFile.buffer);
  await writeFile(join(folderPath, textFile.name), textFile.buffer);

  await expect(folderInput).toHaveAttribute("webkitdirectory", "");
  await folderInput.setInputFiles(folderPath);
  await expect(page.getByText("launch.wav")).toBeVisible();
  await expect(page.getByText("alarm.mp3")).toBeVisible();
  await expect(page.getByText("notes.txt")).toBeHidden();
});

test("filters import audio table by file name", async ({ page }) => {
  await installAudioMock(page);
  await page.goto("/");

  await page.getByTestId("audio-file-input").setInputFiles([audioFile, secondAudioFile]);
  await page.getByLabel("Поиск импортируемых аудио").fill("alarm");
  await expect(page.getByText("alarm.mp3")).toBeVisible();
  await expect(page.getByText("launch.wav")).toHaveCount(0);
  await page.getByLabel("Поиск импортируемых аудио").fill("missing");
  await expect(page.getByText("Нет аудио")).toBeVisible();
});

test("skips duplicate point audio imports and reports unsupported formats", async ({ page }) => {
  await installAudioMock(page);
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.canPlayType = function canPlayType(type: string) {
      return type === "audio/flac" ? "" : "probably";
    };
  });
  await page.goto("/");

  await importAudio(page, "Existing Launch");
  await page.getByTestId("audio-file-input").setInputFiles(audioFile);
  await expect(page.getByText("Дубликаты уже есть в медиатеке и пропущены: 1")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Импорт аудио" })).toHaveCount(0);

  await page.getByTestId("audio-file-input").setInputFiles({
    name: "unsupported.flac",
    mimeType: "audio/flac",
    buffer: Buffer.from("fLaC")
  });
  await expect(page.getByText("Формат не поддерживается на этом устройстве: unsupported.flac")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Импорт аудио" })).toHaveCount(0);
});

test("warns for large project files and rejects unsupported project audio", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "large placeholder file is enough to cover the shared flow");
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.canPlayType = function canPlayType(type: string) {
      return type === "audio/flac" ? "" : "probably";
    };
  });
  await page.goto("/");

  const largeProjectPath = join(tmpdir(), `large-mumbox-${Date.now().toString()}.mumbox`);
  await writeFile(largeProjectPath, "{}");
  await truncate(largeProjectPath, 101 * 1024 * 1024);
  await page.getByTestId("project-file-input").setInputFiles(largeProjectPath);
  await expect(page.getByRole("dialog", { name: "Большой файл проекта" })).toBeVisible();
  await page.getByRole("button", { name: "Отмена" }).click();

  const unsupportedProject = {
    kind: "mumbox-project",
    version: 2,
    exportedAt: new Date().toISOString(),
    state: {
      panels: [{ id: "panel-test", name: "Panel 1", gridSize: 8, cellIds: ["cell-0"] }],
      activePanelId: "panel-test",
      cellsByPanel: {
        "panel-test": {
          "cell-0": {
            id: "cell-0",
            mediaId: "media-test",
            aliasOverride: "",
            colorOverride: null,
            playbackMode: "once",
            volumeOffset: 0,
            hotkey: "",
            trimStartMs: null,
            trimEndMs: null,
            fadeInEnabled: false,
            fadeInMs: 0,
            fadeOutEnabled: false,
            fadeOutMs: 0
          }
        }
      },
      media: [
        {
          id: "media-test",
          fileName: "unsupported.flac",
          alias: "Unsupported",
          color: "#ec5aa7",
          mimeType: "audio/flac",
          size: 4,
          durationMs: null,
          createdAt: new Date().toISOString()
        }
      ],
      masterVolume: 80,
      masterMuted: false,
      stopOthers: false
    },
    mediaBlobs: [
      {
        id: "media-test",
        fileName: "unsupported.flac",
        mimeType: "audio/flac",
        size: 4
      }
    ]
  };
  const unsupportedProjectPath = join(tmpdir(), `unsupported-mumbox-${Date.now().toString()}.mumbox`);
  await writeFile(
    unsupportedProjectPath,
    makeStoredZip([
      { name: "project.json", data: Buffer.from(JSON.stringify(unsupportedProject)) },
      { name: "media/media-test", data: Buffer.from("fLaC") }
    ])
  );
  await page.getByTestId("project-file-input").setInputFiles(unsupportedProjectPath);
  await expect(page.getByText("Проект содержит неподдерживаемый формат: unsupported.flac")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ячейка 1 Unsupported" })).toHaveCount(0);
});

test("keeps import table aligned and renders a large audio folder", async ({ page }) => {
  await installAudioMock(page);
  await page.goto("/");

  const folderPath = join(tmpdir(), `mumbox-large-audio-folder-${Date.now().toString()}`);
  await mkdir(folderPath, { recursive: true });
  await Promise.all(
    Array.from({ length: 120 }, (_, index) =>
      writeFile(join(folderPath, `track-${index.toString().padStart(3, "0")}.wav`), audioFile.buffer)
    )
  );

  await page.getByTestId("audio-folder-input").setInputFiles(folderPath);
  const importTable = page.getByRole("table", { name: "Импортируемые аудио" });
  const rowGroup = importTable.getByRole("rowgroup");
  await rowGroup.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(importTable.getByText(/track-\d{3}\.wav/).first()).toBeVisible();
  await expect(importTable.getByText("0:10").first()).toBeVisible();
  await expect
    .poll(async () =>
      importTable.evaluate((table) => {
        const rows = Array.from(table.querySelectorAll('[role="row"]'));
        const headerColumns = rows[0] ? getComputedStyle(rows[0]).gridTemplateColumns : "";
        const firstRowColumns = rows[1] ? getComputedStyle(rows[1]).gridTemplateColumns : "";
        return Boolean(headerColumns) && headerColumns === firstRowColumns;
      })
    )
    .toBe(true);
  await rowGroup.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(importTable.getByText(/track-\d{3}\.wav/).first()).toBeVisible();
});

test("persists configured cells after reload", async ({ page }) => {
  await page.goto("/");

  await importAudio(page, "Reloaded Pad");
  await assignFirstCell(page);

  await page.reload();

  await expect(page.getByRole("button", { name: "Ячейка 1 Reloaded Pad" })).toBeVisible();
});

test("switches playback mode and gate active state", async ({ page }) => {
  await installAudioMock(page);
  await page.goto("/");

  await importAudio(page, "Gate Pad");
  await assignFirstCell(page);
  await expect(page.getByTestId("once-left-boundary")).toBeVisible();
  await expect(page.getByTestId("once-right-boundary")).toBeVisible();
  await page.getByRole("radio", { name: "Gate" }).check();
  await expect(page.getByTestId("once-left-boundary")).toHaveCount(0);
  await expect(page.getByTestId("once-right-boundary")).toHaveCount(0);
  await page.getByRole("button", { name: "Сохранить настройки ячейки" }).click();
  await page.getByRole("button", { name: "Режим редактирования" }).click();

  const cell = page.locator('[data-cell-id="cell-0"]');
  await expect(cell).toHaveAttribute("data-playback-mode", "gate");
  await cell.dispatchEvent("pointerdown");
  await expect(cell).toHaveAttribute("data-playing", "true");
  await cell.dispatchEvent("pointerup");
  await expect(cell).toHaveAttribute("data-playing", "false");

  await page.getByRole("button", { name: "Останавливать другие ячейки" }).click();
  await expect(page.getByRole("button", { name: "Останавливать другие ячейки" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
});

test("playback modes toggle, stop, clear, and react to cell volume", async ({ page }) => {
  await installAudioMock(page);
  await page.goto("/");

  await importAudio(page, "Mode Pad");
  await assignFirstCell(page);
  await page.getByRole("button", { name: "Сохранить настройки ячейки" }).click();
  await page.getByRole("button", { name: "Режим редактирования" }).click();

  const cell = page.locator('[data-cell-id="cell-0"]');
  await cell.click();
  await expect(cell).toHaveAttribute("data-playing", "true");
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const audioWindow = window as Window & {
          __mumboxGainNodes?: { gain: { value: number } }[];
        };
        return audioWindow.__mumboxGainNodes?.at(-1)?.gain.value;
      })
    )
    .toBeCloseTo(0.8);
  await page.getByRole("button", { name: "Отключить звук" }).click();
  await expect(page.getByRole("button", { name: "Включить звук" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Общая громкость")).toBeDisabled();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const audioWindow = window as Window & {
          __mumboxGainNodes?: { gain: { value: number } }[];
        };
        return audioWindow.__mumboxGainNodes?.at(-1)?.gain.value;
      })
    )
    .toBeCloseTo(0);
  await page.getByRole("button", { name: "Включить звук" }).click();
  await expect(page.getByLabel("Общая громкость")).toBeEnabled();
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await expect(cell).toHaveAttribute("data-playing", "false");
  await cell.click();
  await expect(page.getByText("Длительность: 0:10")).toBeVisible();
  await expect(page.getByLabel("Значение громкости аудио")).toHaveCount(0);
  await page.getByRole("button", { name: "Открыть редактор аудио" }).click();
  await page.getByLabel("Значение громкости аудио в редакторе").fill("50");
  await page.getByRole("button", { name: "Сохранить редактор аудио" }).click();
  await page.getByRole("button", { name: "Сохранить настройки ячейки" }).click();
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await expect(page.getByRole("button", { name: "Режим редактирования" })).toHaveAttribute(
    "aria-pressed",
    "false"
  );
  await page.getByRole("button", { name: "Остановить все аудио" }).click();
  await expect(cell).toHaveAttribute("data-playing", "false");
  await cell.click();
  await expect(cell).toHaveAttribute("data-playing", "true");
  await cell.click();
  await expect(cell).toHaveAttribute("data-playing", "false");
  await cell.click();
  await expect(cell).toHaveAttribute("data-playing", "true");
  await page.getByRole("button", { name: "Остановить все аудио" }).click();
  await expect(cell).toHaveAttribute("data-playing", "false");

  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await cell.click();
  await page.getByRole("radio", { name: "Loop" }).check();
  await page.getByRole("button", { name: "Сохранить настройки ячейки" }).click();
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await expect(cell).toHaveAttribute("data-playback-mode", "loop");
  await cell.click();
  await expect(cell).toHaveAttribute("data-playing", "true");
  await cell.click();
  await expect(cell).toHaveAttribute("data-playing", "false");

  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await cell.click();
  await page.getByRole("radio", { name: "Gate" }).check();
  await page.getByRole("button", { name: "Сохранить настройки ячейки" }).click();
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await expect(cell).toHaveAttribute("data-playback-mode", "gate");
  await cell.dispatchEvent("pointerdown");
  await expect(cell).toHaveAttribute("data-playing", "true");
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const audioWindow = window as Window & {
          __mumboxGainNodes?: { gain: { value: number } }[];
        };
        return audioWindow.__mumboxGainNodes?.at(-1)?.gain.value;
      })
    )
    .toBeCloseTo(1.2);
  await cell.dispatchEvent("pointerup");
  await expect(cell).toHaveAttribute("data-playing", "false");

  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await cell.click();
  await page.getByRole("button", { name: "Очистить" }).click();
  const clearDialog = page.getByRole("dialog", { name: "Очистить ячейку?" });
  await expect(clearDialog).toBeVisible();
  await clearDialog.getByRole("button", { name: "Отмена" }).click();
  await expect(clearDialog).toHaveCount(0);
  await expect(cell).toHaveAttribute("aria-label", "Ячейка 1 Mode Pad");

  await page.getByRole("button", { name: "Очистить" }).click();
  await clearDialog.getByRole("button", { name: "Очистить" }).click();
  await expect(cell).toHaveAttribute("data-playing", "false");
  await expect(cell).toHaveAttribute("aria-label", "Пустая ячейка 1");
});

test("uses decoded audio duration for the editor timeline", async ({ page }) => {
  await installAudioMock(page, { decodedDuration: 12.5 });
  await page.goto("/");

  await importAudio(page, "Decoded Pad");
  await assignFirstCell(page);
  await page.getByRole("button", { name: "Открыть редактор аудио" }).click();

  await expect(page.locator("p", { hasText: "launch.wav · 0:13" }).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Диапазон воспроизведения" }).first()).toHaveAttribute(
    "aria-valuemax",
    "12.5"
  );
});

test("deletes media from the edit picker with confirmation", async ({ page }) => {
  await installAudioMock(page);
  await page.goto("/");

  await page.getByTestId("audio-file-input").setInputFiles([audioFile, secondAudioFile]);
  await page.getByLabel("Выбрать все аудио").click();
  await page.getByRole("button", { name: "Сохранить" }).click();
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Пустая ячейка 1", exact: true }).click();
  await expect(page.getByRole("table", { name: "Выбор медиа" })).toBeVisible();
  await expect(page.getByText("alarm.mp3")).toBeVisible();
  await page.getByLabel("Поиск медиа").fill("alarm");
  await expect(page.getByText("alarm.mp3")).toBeVisible();
  await expect(page.getByText("launch.wav")).toHaveCount(0);
  await page.getByLabel("Поиск медиа").fill("");
  await page.getByRole("radio", { name: "Фильтр по цвету медиа #ffcc66" }).click();
  await expect(page.getByText("по фильтру нет аудио")).toBeVisible();
  await page.getByLabel("Поиск медиа").fill("missing");
  await expect(page.getByText("по фильтру нет аудио")).toBeVisible();
  await page.getByRole("button", { name: "Сбросить" }).click();
  await expect(page.getByText("Нет аудио")).toBeVisible();
  await page.getByLabel("Поиск медиа").fill("");
  await page.getByRole("radio", { name: "Фильтр по цвету медиа #6df7a5" }).click();
  await expect(page.getByText("alarm.mp3")).toBeVisible();
  await expect(page.getByText("launch.wav")).toHaveCount(0);
  await page.getByRole("button", { name: "Сбросить" }).click();
  const pickerTable = page.getByRole("table", { name: "Выбор медиа" });
  await expect
    .poll(async () =>
      pickerTable.evaluate((table) => {
        const header = table.querySelector('[role="row"]');
        const firstDataRow = table.querySelector('[role="button"][aria-label^="Выбрать"]');
        return header && firstDataRow
          ? getComputedStyle(header).gridTemplateColumns === getComputedStyle(firstDataRow).gridTemplateColumns
          : false;
      })
    )
    .toBe(true);

  await page.getByRole("button", { name: "Выбрать alarm.mp3" }).hover();
  await page.getByRole("button", { name: "Удалить из медиатеки alarm.mp3" }).click();
  await expect(page.getByText('Вы действительно хотите удалить "alarm.mp3" из медиатеки?')).toBeVisible();
  await page.getByRole("button", { name: "Удалить", exact: true }).click();
  await expect(page.getByText("alarm.mp3")).toHaveCount(0);
});

test("resizes cell settings panel and exposes full media file names as titles", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop hover and panel width are desktop-specific");
  await installAudioMock(page);
  await page.goto("/");

  await page.getByTestId("audio-file-input").setInputFiles([longAudioFile]);
  await page.getByLabel(`Выбрать ${longAudioFile.name}`).click();
  await page.getByRole("button", { name: "Сохранить" }).click();
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Пустая ячейка 1", exact: true }).click();

  const drawer = page.getByRole("complementary", { name: "Настройки ячейки" });
  const initialBox = await drawer.boundingBox();
  const resizer = page.getByTestId("settings-panel-resizer");
  const resizerBox = await resizer.boundingBox();
  if (!initialBox || !resizerBox) {
    throw new Error("Settings panel or resizer box is not available");
  }

  await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + resizerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizerBox.x - 140, resizerBox.y + resizerBox.height / 2);
  await page.mouse.up();

  const widenedBox = await drawer.boundingBox();
  expect(widenedBox?.width ?? 0).toBeGreaterThan(initialBox.width + 80);
  expect(widenedBox?.width ?? 0).toBeLessThanOrEqual(initialBox.width * 2 + 2);

  const fileNameCell = page.getByText(longAudioFile.name).first();
  await expect(fileNameCell).toHaveCSS("text-overflow", "ellipsis");
  await expect(fileNameCell).toHaveAttribute("title", longAudioFile.name);
});

test("moves a configured cell by drag and drop without resetting settings", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "native drag behavior is desktop-specific");
  await installAudioMock(page);
  await page.goto("/");

  await importAudio(page, "Move Pad");
  await assignFirstCell(page);
  await page.getByRole("radio", { name: "Loop" }).check();
  await page.getByRole("button", { name: "Назначить" }).click();
  await expect(page.getByLabel("Нажмите комбинацию клавиш")).toBeFocused();
  await page.keyboard.press("M");
  await page.getByRole("button", { name: "Сохранить" }).click();
  await page.getByRole("button", { name: "Сохранить настройки ячейки" }).click();

  const source = page.locator('[data-cell-id="cell-0"]');
  const target = page.locator('[data-cell-id="cell-2"]');
  await source.dragTo(target);

  await expect(source).toHaveAttribute("aria-label", "Пустая ячейка 1");
  await expect(target).toHaveAttribute("aria-label", "Ячейка 3 Move Pad");
  await expect(target).toHaveAttribute("data-playback-mode", "loop");
  await expect(target).toHaveAttribute("data-hotkey", "M");
  await expect(page.getByTestId("cell-hotkey-cell-2")).toHaveText("M");
  await page.reload();
  await expect(page.locator('[data-cell-id="cell-2"]')).toHaveAttribute("aria-label", "Ячейка 3 Move Pad");
  await expect(page.locator('[data-cell-id="cell-2"]')).toHaveAttribute("data-playback-mode", "loop");
  await expect(page.getByTestId("cell-hotkey-cell-2")).toHaveText("M");
});

test("keeps selected cell settings open after moving the selected cell", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "native drag selection is desktop-specific");
  await installAudioMock(page);
  await page.goto("/");

  await importAudio(page, "Move Selected Pad");
  await assignFirstCell(page);
  await expect(page.locator('[data-cell-id="cell-0"]')).toHaveAttribute("data-selected", "true");

  const source = page.locator('[data-cell-id="cell-0"]');
  const target = page.locator('[data-cell-id="cell-2"]');
  await source.dragTo(target);

  await expect(source).toHaveAttribute("data-selected", "false");
  await expect(target).toHaveAttribute("data-selected", "true");
  await expect(page.getByLabel("Псевдоним ячейки")).toHaveValue("Move Selected Pad");
  await expect(page.getByText("Длительность: 0:10")).toBeVisible();
  await expect(page.getByRole("table", { name: "Выбор медиа" })).toHaveCount(0);
});

test("moves cells on touch after a short hold in edit mode", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-landscape", "touch drag behavior is mobile-specific");
  await page.goto("/");

  await importAudio(page, "Touch Move Pad");
  await assignFirstCell(page);
  await expect(page.locator('[data-cell-id="cell-0"]')).toHaveCSS("touch-action", "none");
  await touchDragCell(page, "cell-0", "cell-3");

  await expect(page.locator('[data-cell-id="cell-0"]')).toHaveAttribute("aria-label", "Пустая ячейка 1");
  await expect(page.locator('[data-cell-id="cell-3"]')).toHaveAttribute("aria-label", "Ячейка 4 Touch Move Pad");
  await expect(page.locator('[data-cell-id="cell-3"]')).toHaveAttribute("data-selected", "true");
});

test("swaps configured cells when dragging onto an occupied cell", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "native drag behavior is desktop-specific");
  await installAudioMock(page);
  await page.goto("/");

  await page.getByTestId("audio-file-input").setInputFiles([audioFile, secondAudioFile]);
  await page.getByLabel("Выбрать все аудио").click();
  await page.getByRole("button", { name: "Сохранить" }).click();
  await page.getByRole("button", { name: "Режим редактирования" }).click();

  await assignCell(page, 1, "launch.wav");
  await page.getByRole("radio", { name: "Loop" }).check();
  await page.getByRole("button", { name: "Назначить" }).click();
  await page.getByLabel("Нажмите комбинацию клавиш").press("L");
  await page.getByRole("button", { name: "Сохранить" }).click();
  await page.getByRole("button", { name: "Сохранить настройки ячейки" }).click();

  await assignCell(page, 2, "alarm.mp3");
  await page.getByRole("radio", { name: "Gate" }).check();
  await page.getByRole("button", { name: "Сохранить настройки ячейки" }).click();

  const source = page.locator('[data-cell-id="cell-0"]');
  const target = page.locator('[data-cell-id="cell-1"]');
  await source.dragTo(target);

  await expect(source).toHaveAttribute("aria-label", "Ячейка 1 alarm.mp3");
  await expect(source).toHaveAttribute("data-playback-mode", "gate");
  await expect(target).toHaveAttribute("aria-label", "Ячейка 2 launch.wav");
  await expect(target).toHaveAttribute("data-playback-mode", "loop");
  await expect(target).toHaveAttribute("data-hotkey", "L");
  await expect(page.getByTestId("cell-hotkey-cell-1")).toHaveText("L");
});

test("binds hotkeys only once per panel and triggers playback outside edit mode", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "hotkey settings are desktop-only");
  await installAudioMock(page);
  await page.goto("/");

  await importAudio(page, "Hot Pad");
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await assignCell(page, 1);
  await page.getByRole("button", { name: "Назначить" }).click();
  await page.getByLabel("Нажмите комбинацию клавиш").press("Control+A");
  await page.getByRole("button", { name: "Сохранить" }).click();
  await page.getByRole("button", { name: "Сохранить настройки ячейки" }).click();

  await assignCell(page, 2);
  await page.getByRole("button", { name: "Назначить" }).click();
  await page.getByLabel("Нажмите комбинацию клавиш").press("Control+A");
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByText("Эта комбинация уже используется на текущей панели")).toBeVisible();
  await page.getByRole("button", { name: "Отмена" }).click();
  await page.getByRole("button", { name: "Сохранить настройки ячейки" }).click();

  const firstCell = page.locator('[data-cell-id="cell-0"]');
  await page.keyboard.press("Control+A");
  await expect(firstCell).toHaveAttribute("data-playing", "false");
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.keyboard.press("Control+A");
  await expect(firstCell).toHaveAttribute("data-playing", "true");
});

test("edits cell audio trim and fades in the waveform editor", async ({ page }) => {
  await installAudioMock(page);
  await page.goto("/");

  await importAudio(page, "Edit Pad");
  await assignFirstCell(page);
  await page.getByRole("button", { name: "Открыть редактор аудио" }).click();
  await expect(page.getByRole("dialog", { name: "Редактор аудио" })).toBeVisible();
  await page.getByRole("button", { name: "Плей редактора" }).click();
  await expect(page.getByRole("button", { name: "Пауза редактора" })).toBeVisible();
  await expect(page.getByText("Preview играет")).toHaveCount(0);
  await expect(page.getByTestId("audio-editor-playhead")).toBeVisible();
  await page.getByTestId("audio-editor-timeline").click({ position: { x: 220, y: 80 } });
  await expect(page.getByTestId("audio-editor-playhead")).toBeVisible();
  await page.getByRole("button", { name: "Пауза редактора" }).click();
  await page.getByRole("button", { name: "Стоп редактора" }).click();
  await page.getByRole("button", { name: "Зациклить preview" }).click();
  await expect(page.getByRole("button", { name: "Зациклить preview" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await page.getByLabel("Масштаб таймлайна").fill("3");
  await expect(page.getByLabel("Начало сек")).toHaveAttribute("step", "0.01");
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const audioWindow = window as Window & { __mumboxDecodeAudioCalls?: number };
        return audioWindow.__mumboxDecodeAudioCalls ?? 0;
      })
    )
    .toBeGreaterThan(0);
  await page.getByLabel("Начало сек").fill("1.2");
  await page.getByLabel("Конец сек").fill("7.4");
  await expect(page.getByText("launch.wav · 0:06")).toHaveCount(2);
  await page.getByLabel("Нарастание").check();
  await page.getByLabel("Затухание").check();
  await page.getByLabel("Секунды").first().fill("0.5");
  await page.getByLabel("Секунды").nth(1).fill("0.7");
  await page.getByLabel("Значение громкости аудио в редакторе").fill("100");
  await expect(page.getByTestId("fade-in-region")).toBeVisible();
  await expect(page.getByTestId("fade-out-region")).toBeVisible();
  await page.getByRole("button", { name: "Сохранить редактор аудио" }).click();

  const cell = page.locator('[data-cell-id="cell-0"]');
  await expect(cell).toHaveAttribute("data-trim-start-ms", "1200");
  await expect(cell).toHaveAttribute("data-trim-end-ms", "7400");
  await expect(cell).toHaveAttribute("data-fade-in-ms", "500");
  await expect(cell).toHaveAttribute("data-fade-out-ms", "700");
  await expect(cell).toHaveAttribute("data-volume-offset", "100");
  await page.getByRole("button", { name: "Сохранить настройки ячейки" }).click();
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await cell.click();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const audioWindow = window as Window & {
          __mumboxAudioInstances?: { currentTime: number }[];
        };
        return audioWindow.__mumboxAudioInstances?.at(-1)?.currentTime;
      })
    )
    .toBeCloseTo(1.2);
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const audioWindow = window as Window & {
          __mumboxGainNodes?: { gain: { value: number } }[];
        };
        return audioWindow.__mumboxGainNodes?.at(-1)?.gain.value;
      })
    )
    .toBeCloseTo(1.6);

  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await cell.click();
  await page.getByRole("button", { name: "Открыть редактор аудио" }).click();
  await page.getByRole("button", { name: "Сбросить" }).click();
  await expect(page.getByText("Вы действительно хотите сбросить настройки аудиозаписи?")).toBeVisible();
  await page
    .getByRole("dialog", { name: "Сброс настроек аудиозаписи" })
    .getByRole("button", { name: "Сбросить" })
    .click();
  await page.getByRole("button", { name: "Сохранить редактор аудио" }).click();
  await expect(cell).toHaveAttribute("data-trim-start-ms", "");
  await expect(cell).toHaveAttribute("data-trim-end-ms", "");
});

test("keeps the zoomed waveform scrollable while preserving pointer editing modes", async ({
  context,
  page
}, testInfo) => {
  await installAudioMock(page);
  await page.goto("/");

  await importAudio(page, "Scroll Pad");
  await assignFirstCell(page);
  await page.getByRole("button", { name: "Открыть редактор аудио" }).click();
  await expect(page.getByRole("dialog", { name: "Редактор аудио" })).toBeVisible();
  await page.getByLabel("Масштаб таймлайна").fill("8");
  await expect(page.getByText("Масштаб: 8.0x")).toBeVisible();

  const timeline = page.getByTestId("audio-editor-timeline");
  await expect
    .poll(async () =>
      timeline.evaluate((element) => element.scrollWidth - element.clientWidth)
    )
    .toBeGreaterThan(0);

  const waveformCanvas = page.getByTestId("audio-editor-waveform");
  await expect
    .poll(async () =>
      waveformCanvas.evaluate((element) => {
        const canvasWidth = element.getBoundingClientRect().width;
        const timeline = element.closest('[data-testid="audio-editor-timeline"]');
        return timeline ? canvasWidth <= timeline.clientWidth + 1 : false;
      })
    )
    .toBe(true);
  const initialCanvasLeft = await waveformCanvas.evaluate((element) => element.getBoundingClientRect().left);

  await timeline.evaluate((element) => {
    element.scrollLeft = 96;
  });
  await expect.poll(async () => timeline.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await expect
    .poll(async () =>
      waveformCanvas.evaluate(
        (element, expectedLeft) => Math.abs(element.getBoundingClientRect().left - expectedLeft) <= 1,
        initialCanvasLeft
      )
    )
    .toBe(true);

  if (testInfo.project.name === "mobile-landscape") {
    await timeline.evaluate((element) => {
      element.scrollLeft = 0;
    });
    await expect(timeline).toHaveCSS("touch-action", "pan-x");

    const box = await timeline.boundingBox();
    expect(box).not.toBeNull();
    if (!box) {
      return;
    }

    const client = await context.newCDPSession(page);
    const y = box.y + box.height / 2;
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: box.x + box.width * 0.8, y }]
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: box.x + box.width * 0.2, y }]
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: []
    });

    await expect.poll(async () => timeline.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    return;
  }

  await expect(timeline).toHaveCSS("touch-action", "none");
  await timeline.evaluate((element) => {
    element.scrollLeft = 0;
  });

  const playhead = page.getByTestId("audio-editor-playhead");
  const beforeLeft = await playhead.evaluate((element) => getComputedStyle(element).left);
  const box = await timeline.boundingBox();
  expect(box).not.toBeNull();
  if (!box) {
    return;
  }

  await page.mouse.move(box.x + 24, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2);
  await page.mouse.up();

  await expect
    .poll(async () => playhead.evaluate((element) => getComputedStyle(element).left))
    .not.toBe(beforeLeft);
});

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
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

const textFile = {
  name: "notes.txt",
  mimeType: "text/plain",
  buffer: Buffer.from("not audio")
};

async function installAudioMock(page: Page) {
  await page.addInitScript(() => {
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
  });
}

async function importAudio(page: Page, alias: string) {
  await page.getByTestId("audio-file-input").setInputFiles(audioFile);
  await page.getByLabel("Выбрать launch.wav").click();
  await page.getByLabel("Псевдоним launch.wav").fill(alias);
  await page.getByRole("button", { name: "Сохранить" }).click();
}

async function assignFirstCell(page: Page) {
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Пустая ячейка 1", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать медиа" }).click();
  await page.getByRole("button", { name: "Выбрать launch.wav" }).click();
}

async function assignCell(page: Page, cellNumber: number, fileName = "launch.wav") {
  await page.getByRole("button", { name: `Пустая ячейка ${String(cellNumber)}`, exact: true }).click();
  await page.getByRole("button", { name: "Выбрать медиа" }).click();
  await page.getByRole("button", { name: `Выбрать ${fileName}` }).click();
}

async function openFileMenu(page: Page) {
  await page.getByRole("button", { name: "Файл" }).click();
}

test("renders the MUMBOX shell", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText("MUMBOX")).toBeVisible();
  await expect(page.getByRole("button", { name: "Файл" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Panel 1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Добавить панель" })).toBeVisible();
  await expect(page.getByLabel("Рабочая сетка 8 на 8")).toBeVisible();
  await expect(page.getByLabel("Общая громкость")).toBeVisible();
});

test("opens project FAQ from the file menu", async ({ page }) => {
  await page.goto("/");

  await openFileMenu(page);
  await page.getByRole("menuitem", { name: "ЧАВО" }).click();
  await expect(page.getByRole("dialog", { name: "Документация MUMBOX" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Оглавление ЧАВО" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Медиатека и конфиги" })).toBeVisible();
  await expect(page.getByText("Разработчик вдохновлялся мобильным приложением RemixLive")).toBeVisible();
  await expect(page.getByText("локальном браузерном хранилище IndexedDB")).toBeVisible();
  await expect(page.getByText("Developer: Stelsovich1.")).toBeVisible();
  await page.getByRole("button", { name: "ОК" }).click();
  await expect(page.getByRole("dialog", { name: "Документация MUMBOX" })).toHaveCount(0);
});

test("prevents selection in workspace controls and highlights edit mode", async ({ page }) => {
  await page.goto("/");

  const workspace = page.getByLabel("Рабочая сетка 8 на 8");
  await expect(workspace).toHaveCSS("user-select", "none");
  await expect(page.getByLabel("Панель управления")).toHaveCSS("user-select", "none");
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await expect(workspace).toHaveCSS("border-top-color", "rgb(255, 204, 102)");
});

test("saves config with a save dialog and warns before overwriting layout on import", async ({
  page
}) => {
  await page.addInitScript(() => {
    const configWindow = window as Window & {
      __mumboxSavePickerSuggestedName?: string;
      __mumboxSavedConfigText?: string;
      showSaveFilePicker?: (options: {
        suggestedName: string;
      }) => Promise<{
        name: string;
        createWritable: () => Promise<{
          write: (data: Blob) => Promise<void>;
          close: () => Promise<void>;
        }>;
      }>;
    };

    configWindow.showSaveFilePicker = (options) => {
      configWindow.__mumboxSavePickerSuggestedName = options.suggestedName;
      return Promise.resolve({
        name: "custom-mumbox.json",
        createWritable: () =>
          Promise.resolve({
          write: async (data: Blob) => {
            configWindow.__mumboxSavedConfigText = await data.text();
          },
          close: () => {
            configWindow.__mumboxSavedConfigText =
              configWindow.__mumboxSavedConfigText ?? "";
            return Promise.resolve();
          }
        })
      });
    };
  });
  await page.goto("/");

  await openFileMenu(page);
  await page.getByText("Сохранить в файл").click();
  await expect(page.getByText("Конфиг сохранен: custom-mumbox.json")).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const configWindow = window as Window & {
          __mumboxSavePickerSuggestedName?: string;
          __mumboxSavedConfigText?: string;
        };
        return {
          suggestedName: configWindow.__mumboxSavePickerSuggestedName,
          hasPanels: configWindow.__mumboxSavedConfigText?.includes('"panels"') ?? false
        };
      })
    )
    .toEqual({ suggestedName: "mumbox-config.json", hasPanels: true });

  await page.getByRole("button", { name: "Добавить панель" }).click();
  await openFileMenu(page);
  await expect(page.getByText("Импортировать конфиг")).toBeVisible();
  await expect(page.getByText("Импортировать из файла")).toHaveCount(0);
  await page.getByText("Импортировать конфиг").click();
  const warning = page.getByText("Импорт конфига перезапишет текущую рабочую раскладку");
  await expect(warning).toBeVisible();
  const warningToast = page.locator(".MuiSnackbar-root", {
    hasText: "Импорт конфига перезапишет текущую рабочую раскладку"
  });
  await expect
    .poll(async () => {
      const box = await warningToast.boundingBox();
      return page.evaluate(
        ({ boxCenterX }) => Math.abs(window.innerWidth / 2 - boxCenterX),
        { boxCenterX: (box?.x ?? 0) + (box?.width ?? 0) / 2 }
      );
    })
    .toBeLessThan(2);
  await expect
    .poll(async () => {
      const box = await warningToast.boundingBox();
      return page.evaluate(
        ({ boxCenterY }) => Math.abs(window.innerHeight / 2 - boxCenterY),
        { boxCenterY: (box?.y ?? 0) + (box?.height ?? 0) / 2 }
      );
    })
    .toBeLessThan(2);
  await page.getByRole("button", { name: "Отмена" }).click();
});

test("manages panels and grid size", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Добавить панель" }).click();
  await expect(page.getByRole("tab", { name: "Panel 2" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Удалить панель Panel 1" })).toHaveCount(0);

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

test("imports one file, multiple files, and an audio folder", async ({ page }) => {
  await installAudioMock(page);
  await page.goto("/");

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
        return { headerColumns, firstRowColumns };
      })
    )
    .toEqual(expect.objectContaining({ headerColumns: expect.any(String), firstRowColumns: expect.any(String) }));
  await expect
    .poll(async () =>
      importTable.evaluate((table) => {
        const rows = Array.from(table.querySelectorAll('[role="row"]'));
        return rows[0] && rows[1]
          ? getComputedStyle(rows[0]).gridTemplateColumns === getComputedStyle(rows[1]).gridTemplateColumns
          : false;
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
  await page.getByRole("radio", { name: "Gate" }).check();
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
  await cell.click();
  await expect(page.getByText("Длительность: 0:10")).toBeVisible();
  await page.getByLabel("Значение громкости аудио").fill("50");
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const audioWindow = window as Window & {
          __mumboxGainNodes?: { gain: { value: number } }[];
        };
        return audioWindow.__mumboxGainNodes?.at(-1)?.gain.value;
      })
    )
    .toBeCloseTo(1);
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
    .toBeCloseTo(1);
  await cell.dispatchEvent("pointerup");
  await expect(cell).toHaveAttribute("data-playing", "false");

  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await cell.click();
  await page.getByRole("button", { name: "Очистить" }).click();
  await expect(cell).toHaveAttribute("data-playing", "false");
  await page.getByRole("button", { name: "Сохранить настройки ячейки" }).click();
  await expect(cell).toHaveAttribute("aria-label", "Пустая ячейка 1");
});

test("deletes media from the edit picker with confirmation", async ({ page }) => {
  await installAudioMock(page);
  await page.goto("/");

  await page.getByTestId("audio-file-input").setInputFiles([audioFile, secondAudioFile]);
  await page.getByLabel("Выбрать все аудио").click();
  await page.getByRole("button", { name: "Сохранить" }).click();
  await page.getByRole("button", { name: "Режим редактирования" }).click();
  await page.getByRole("button", { name: "Пустая ячейка 1", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать медиа" }).click();
  await expect(page.getByText("alarm.mp3")).toBeVisible();
  await page.getByLabel("Поиск медиа").fill("alarm");
  await expect(page.getByText("alarm.mp3")).toBeVisible();
  await expect(page.getByText("launch.wav")).toHaveCount(0);
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

test("moves a configured cell by drag and drop without resetting settings", async ({ page }) => {
  await installAudioMock(page);
  await page.goto("/");

  await importAudio(page, "Move Pad");
  await assignFirstCell(page);
  await page.getByRole("radio", { name: "Loop" }).check();
  await page.getByRole("button", { name: "Назначить" }).click();
  await page.getByLabel("Нажмите комбинацию клавиш").press("M");
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

test("swaps configured cells when dragging onto an occupied cell", async ({ page }) => {
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

test("binds hotkeys only once per panel and triggers playback outside edit mode", async ({ page }) => {
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
  await page.getByLabel("Нарастание").check();
  await page.getByLabel("Затухание").check();
  await page.getByLabel("Секунды").first().fill("0.5");
  await page.getByLabel("Секунды").nth(1).fill("0.7");
  await page.getByLabel("Значение громкости аудио в редакторе").fill("25");
  await expect(page.getByTestId("fade-in-region")).toBeVisible();
  await expect(page.getByTestId("fade-out-region")).toBeVisible();
  await page.getByRole("button", { name: "Сохранить редактор аудио" }).click();

  const cell = page.locator('[data-cell-id="cell-0"]');
  await expect(cell).toHaveAttribute("data-trim-start-ms", "1200");
  await expect(cell).toHaveAttribute("data-trim-end-ms", "7400");
  await expect(cell).toHaveAttribute("data-fade-in-ms", "500");
  await expect(cell).toHaveAttribute("data-fade-out-ms", "700");
  await expect(cell).toHaveAttribute("data-volume-offset", "25");
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

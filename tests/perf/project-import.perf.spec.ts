import { test } from "@playwright/test";

import { hasMp3Fixtures, MP3_FIXTURE_SKIP_REASON } from "../support/mp3Fixtures";
import { buildMockProject } from "../support/mockProject";
import { expectWithinBaseline } from "./support/baseline";
import { perfGoto } from "./support/instrument";

/**
 * What a project import actually costs, per phase.
 *
 * There was no coverage of this at all: `import.perf.spec.ts` measures importing loose AUDIO files,
 * and `project-integrity.spec.ts` imports a one-cell project holding a quarter-second WAV. So the
 * one path a user waits on — a real project of MP3s — had no number attached to it, and the
 * reordering that made the reader hand out lazy `File.slice` views turned one pass over the archive
 * into three without anything failing.
 *
 * Phases are read from the progress label rather than timed from the outside, because "the import
 * is slow" is not actionable and "the write phase is 80 % of it" is. The recorder is a
 * `MutationObserver` installed before boot: polling would alias against phases shorter than the
 * poll interval, and the write phase advances once per media.
 *
 * TWO SIZES, and the default is the small one. Sixteen whole corpus files are ~110 MB to import and
 * then eighteen cells to warm, which is minutes per run — too slow to keep in a tier anyone runs.
 * The truncated fixture keeps every property the import path depends on (real frame headers, real
 * archive, real IndexedDB writes, all nine cell shapes) and runs in seconds. `PERF_BIG_IMPORT=1`
 * asks for the full-size measurement, which is the one to quote at a user.
 *
 * Metrics are `record`: this scenario has no history, and a threshold invented on one machine is
 * how a perf tier becomes the thing everyone ignores. The exception is `standaloneVerifyMs`, gated
 * `exact` at zero — a non-zero value means the separate verification pass is back, and with it the
 * second full read of the source file.
 */

const BIG = process.env.PERF_BIG_IMPORT === "1";
const PANELS = 2;
const MEDIA_COUNT = BIG ? 16 : 8;
/** About 40 s at 192 kbps / 44.1 kHz, which is long enough for the segment ladder to engage. */
const MAX_FRAMES = 1530;

type PhaseSample = { label: string; at: number };

async function installProgressRecorder(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const samples: PhaseSample[] = [];
    (window as unknown as { __progressLog: PhaseSample[] }).__progressLog = samples;

    const record = () => {
      const node = document.querySelector('[data-testid="operation-progress"]');
      const label = node?.textContent ?? "";
      if (label === "") {
        return;
      }
      // The label carries "N из M", which changes on every media. Only the phase matters here.
      const phase = label.replace(/\s*\d+\s*из\s*\d+\s*$/u, "").trim();
      const last = samples.at(-1);
      if (last?.label === phase) {
        return;
      }
      samples.push({ label: phase, at: performance.now() });
    };

    // `addInitScript` runs before the document has a body, so the observer is attached on
    // `DOMContentLoaded` rather than immediately.
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        new MutationObserver(record).observe(document.body, {
          subtree: true,
          childList: true,
          characterData: true
        });
      },
      { once: true }
    );
  });
}

type ImportProbe = {
  readMs: number;
  readBytes: number;
  readCount: number;
  writeMs: number;
  writeBytes: number;
  writeCount: number;
};

/**
 * Attributes the import's cost to the two things it does with bytes.
 *
 * Without it the phase timings say "the write phase is almost all of it" and stop there, which is
 * not enough to fix anything: that phase reads the archive, folds a CRC and writes to IndexedDB.
 * Measured directly, IndexedDB takes 4 ms per MiB — so a phase costing 184 ms per MiB is not
 * spending it there, and knowing that is the difference between batching transactions (worth ~1 %)
 * and looking at the read.
 */
async function installImportProbe(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const probe: ImportProbe = {
      readMs: 0,
      readBytes: 0,
      readCount: 0,
      writeMs: 0,
      writeBytes: 0,
      writeCount: 0
    };
    (window as unknown as { __importProbe: ImportProbe }).__importProbe = probe;

    /* eslint-disable @typescript-eslint/unbound-method -- both originals are re-invoked with an
       explicit receiver below, which is the whole point of capturing them. */
    const originalArrayBuffer = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob) {
      const startedAt = performance.now();
      const size = this.size;
      return originalArrayBuffer.call(this).then((buffer) => {
        probe.readMs += performance.now() - startedAt;
        probe.readBytes += size;
        probe.readCount += 1;
        return buffer;
      });
    };

    // Timed to transaction COMPLETE, not to the request: the commit is where a write becomes
    // durable, and it is the part a per-entry transaction pays over and over.
    const originalPut = IDBObjectStore.prototype.put;
    /* eslint-enable @typescript-eslint/unbound-method */
    IDBObjectStore.prototype.put = function put(
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey
    ) {
      const startedAt = performance.now();
      const size = value instanceof Blob ? value.size : 0;
      const request = key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
      this.transaction.addEventListener(
        "complete",
        () => {
          probe.writeMs += performance.now() - startedAt;
          probe.writeBytes += size;
          probe.writeCount += 1;
        },
        { once: true }
      );
      return request;
    };
  });
}

test.skip(!hasMp3Fixtures(2), MP3_FIXTURE_SKIP_REASON);

test("importing a real project reports its cost per phase", async ({ page }) => {
  const project = buildMockProject({
    panels: PANELS,
    gridSize: 6,
    mediaCount: MEDIA_COUNT,
    ...(BIG ? {} : { maxFrames: MAX_FRAMES })
  });

  await installProgressRecorder(page);
  await installImportProbe(page);
  await perfGoto(page, "/");

  const startedAt = Date.now();
  await page.getByTestId("project-file-input").setInputFiles(project.path);
  // Matched on EITHER outcome, so a refused import fails here with the app's own wording instead of
  // timing out minutes later on a success message that was never coming.
  const outcome = page.getByText(
    /Проект импортирован|Не удалось|повреждён|не хватило|Это не файл проекта/
  );
  await test.expect(outcome).toBeVisible({ timeout: BIG ? 600_000 : 120_000 });
  const totalMs = Date.now() - startedAt;
  await test.expect(outcome).toHaveText(/Проект импортирован/);

  // One clock for the terminator. `totalMs` is Node's, the samples are the page's, and adding one
  // to the other made the last phase come out as the whole import — which is how "the write phase
  // is all of it" got into the first reading of these numbers.
  const { samples, endedAt } = await page.evaluate(() => ({
    samples: (window as unknown as { __progressLog: PhaseSample[] }).__progressLog,
    endedAt: performance.now()
  }));
  // Each phase runs until the next one starts; the last one ends when the import does.
  const phases = samples.map((sample, index) => ({
    label: sample.label,
    ms: Math.round((samples[index + 1]?.at ?? endedAt) - sample.at)
  }));
  const firstAt = samples[0]?.at ?? endedAt;
  const accountedMs = phases.reduce((sum, phase) => sum + phase.ms, 0);
  const phaseMs = (match: RegExp) =>
    phases.filter((phase) => match.test(phase.label)).reduce((sum, phase) => sum + phase.ms, 0);

  const probe = await page.evaluate(
    () => (window as unknown as { __importProbe: ImportProbe }).__importProbe
  );
  // What the phases do NOT cover: everything after the last progress update — the reducer dispatch,
  // the persist barrier, the deletion of the outgoing blobs, and React getting the message on
  // screen. It has to be named, or it hides inside whichever phase happened to be showing.
  const tailMs = Math.round(endedAt - firstAt - accountedMs + 0);
  const audioMib = project.audioBytes / 1024 / 1024;
  console.log(
    `[perf] blob reads ${String(probe.readCount)} = ${String(Math.round(probe.readMs))} ms / ` +
      `${(probe.readBytes / 1024 / 1024).toFixed(1)} MiB · ` +
      `idb writes ${String(probe.writeCount)} = ${String(Math.round(probe.writeMs))} ms / ` +
      `${(probe.writeBytes / 1024 / 1024).toFixed(1)} MiB`
  );
  console.log(
    `[perf] tail after last phase ${String(tailMs)} ms
[perf] import ${audioMib.toFixed(1)} MiB audio, ${String(project.mediaCount)} media, ` +
      `${String(project.cellCount)} cells, total ${String(totalMs)} ms\n` +
      phases.map((phase) => `  ${phase.label}: ${String(phase.ms)} ms`).join("\n")
  );

  expectWithinBaseline(BIG ? "project-import-16-mp3-whole" : "project-import-8-mp3-40s", {
    totalMs: { value: totalMs, unit: "ms", gate: "record" },
    msPerAudioMib: { value: Math.round(totalMs / audioMib), unit: "ms", gate: "record" },
    readProjectMs: { value: phaseMs(/Чтение проекта/u), unit: "ms", gate: "record" },
    writeMs: { value: phaseMs(/запись аудио/iu), unit: "ms", gate: "record" },
    storageCheckMs: { value: phaseMs(/Проверка хранилища/u), unit: "ms", gate: "record" },
    standaloneVerifyMs: { value: phaseMs(/^Проверка аудио$/u), unit: "ms", gate: "exact" },
    audioMib: { value: Math.round(audioMib), unit: "MiB", gate: "record" },
    blobReadMs: { value: Math.round(probe.readMs), unit: "ms", gate: "record" },
    blobReadMib: { value: Math.round(probe.readBytes / 1024 / 1024), unit: "MiB", gate: "record" },
    idbWriteMs: { value: Math.round(probe.writeMs), unit: "ms", gate: "record" },
    idbWriteMib: { value: Math.round(probe.writeBytes / 1024 / 1024), unit: "MiB", gate: "record" },
    progressSpanMs: { value: Math.round(endedAt - firstAt), unit: "ms", gate: "record" },
    tailMs: { value: tailMs, unit: "ms", gate: "record" }
  });
});

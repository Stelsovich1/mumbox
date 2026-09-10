import { expect, test } from "@playwright/test";

import {
  createSemaphore,
  LIVE_DECODE_CONCURRENCY
} from "../../src/features/playback/model/decodeSemaphore";

/**
 * The gate had no test of its own, and the property that matters is not "the width is respected" —
 * it is that speculative work cannot starve work the user is already listening to.
 *
 * The failure it exists to prevent: a warm-up of a heavy panel holds every slot with decodes of a
 * few seconds each; the press path and then the segment chain queue behind them; the head is 0.5 s
 * long, so the chain misses its deadline and the cue ends there. A single FIFO queue produces that
 * with no bug anywhere in it — which is why the lanes, not a priority flag, are the fix.
 */

/** A task whose completion the test controls, so nothing here depends on timing. */
function controllable() {
  let release: (() => void) | undefined;
  let started = false;
  const task = async () => {
    started = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  return {
    task,
    hasStarted: () => started,
    release: () => {
      release?.();
    }
  };
}

/** Lets every already-resolved promise settle, without leaning on a timer. */
async function settle() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

test("a live decode does not queue behind a full background lane", async () => {
  // The whole point. With one shared queue the live task below starts only after a background task
  // finishes — and a `decodeAudioData` cannot be cancelled or preempted, so "after" can be seconds.
  const semaphore = createSemaphore(2);
  const first = controllable();
  const second = controllable();
  const live = controllable();

  void semaphore.run(first.task);
  void semaphore.run(second.task);
  await settle();
  expect(semaphore.active("background")).toBe(2);

  void semaphore.run(live.task, "live");
  await settle();
  expect(live.hasStarted()).toBe(true);
  expect(semaphore.active("live")).toBe(1);

  first.release();
  second.release();
  live.release();
});

test("the background lane still bounds itself, and admits exactly one waiter per release", async () => {
  // The reason the gate exists at all: simultaneous decodes multiply the transient allocation that
  // gets a mobile tab killed. A release that woke every waiter would defeat it in one line.
  const semaphore = createSemaphore(2);
  const running = [controllable(), controllable()];
  const waiting = [controllable(), controllable()];

  for (const entry of [...running, ...waiting]) {
    void semaphore.run(entry.task);
  }
  await settle();
  expect(running.map((entry) => entry.hasStarted())).toEqual([true, true]);
  expect(waiting.map((entry) => entry.hasStarted())).toEqual([false, false]);
  expect(semaphore.waiting("background")).toBe(2);

  running[0]?.release();
  await settle();
  expect(waiting[0]?.hasStarted()).toBe(true);
  expect(waiting[1]?.hasStarted()).toBe(false);
  expect(semaphore.active("background")).toBe(2);

  running[1]?.release();
  await settle();
  expect(waiting[1]?.hasStarted()).toBe(true);

  for (const entry of waiting) {
    entry.release();
  }
});

test("the live lane is bounded too, because six pads must not mean six decodes", async () => {
  // A lane that let every live route decode at once would reintroduce exactly the unsynchronised
  // concurrency the shared gate was added for — `stopOthers` is off by default, so several pads
  // playing together is the ordinary case, not the extreme one.
  const semaphore = createSemaphore(4);
  const tasks = Array.from({ length: LIVE_DECODE_CONCURRENCY + 2 }, () => controllable());
  for (const entry of tasks) {
    void semaphore.run(entry.task, "live");
  }
  await settle();

  expect(semaphore.active("live")).toBe(LIVE_DECODE_CONCURRENCY);
  expect(semaphore.waiting("live")).toBe(2);
  expect(tasks.filter((entry) => entry.hasStarted())).toHaveLength(LIVE_DECODE_CONCURRENCY);

  tasks[0]?.release();
  await settle();
  expect(tasks.filter((entry) => entry.hasStarted())).toHaveLength(LIVE_DECODE_CONCURRENCY + 1);

  for (const entry of tasks) {
    entry.release();
  }
});

test("work in one lane does not count against the other", async () => {
  const semaphore = createSemaphore(2);
  const background = controllable();
  const live = controllable();

  void semaphore.run(background.task);
  void semaphore.run(live.task, "live");
  await settle();

  expect(semaphore.active("background")).toBe(1);
  expect(semaphore.active("live")).toBe(1);
  expect(semaphore.limit("background")).toBe(2);
  expect(semaphore.limit("live")).toBe(LIVE_DECODE_CONCURRENCY);

  background.release();
  live.release();
});

test("omitting the lane means background, so speculative callers cannot get the fast one by accident", async () => {
  // The default is the safe direction: a new call site that forgets to think about it pays the
  // bound rather than silently widening the concurrency the memory argument rests on.
  const semaphore = createSemaphore(1);
  const first = controllable();
  const second = controllable();

  void semaphore.run(first.task);
  void semaphore.run(second.task);
  await settle();

  expect(first.hasStarted()).toBe(true);
  expect(second.hasStarted()).toBe(false);
  expect(semaphore.active("background")).toBe(1);
  expect(semaphore.active("live")).toBe(0);

  first.release();
  second.release();
});

test("a task that throws still releases its slot", async () => {
  // Otherwise one rejected decode narrows the lane for the rest of the session, and the symptom is
  // a warm-up that gets slower the longer the app runs.
  const semaphore = createSemaphore(1);
  await expect(
    semaphore.run(() => Promise.reject(new Error("decode failed")))
  ).rejects.toThrow("decode failed");
  expect(semaphore.active("background")).toBe(0);

  let ran = false;
  await semaphore.run(async () => {
    ran = true;
    await Promise.resolve();
  });
  expect(ran).toBe(true);
});

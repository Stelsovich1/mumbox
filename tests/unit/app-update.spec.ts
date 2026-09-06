import { expect, test } from "@playwright/test";

import {
  applyServiceWorkerUpdate,
  shouldCheckForUpdate,
  UPDATE_CHECK_MIN_INTERVAL_MS,
  UPDATE_RELOAD_FALLBACK_MS
} from "../../src/shared/lib/appUpdate";

type Posted = { type: string };

type FakeWorker = {
  postMessage: (message: Posted) => void;
  posted: Posted[];
};

function makeWorker(): FakeWorker {
  const posted: Posted[] = [];
  return {
    posted,
    postMessage: (message) => {
      posted.push(message);
    }
  };
}

type FakeRegistration = {
  waiting: FakeWorker | null;
  updateCalls: number;
  update: () => Promise<void>;
};

function makeRegistration(options: {
  waiting?: FakeWorker | null;
  onUpdate?: (registration: FakeRegistration) => void | Promise<void>;
}): FakeRegistration {
  const registration: FakeRegistration = {
    waiting: options.waiting ?? null,
    updateCalls: 0,
    update: async () => {
      registration.updateCalls += 1;
      await options.onUpdate?.(registration);
    }
  };
  return registration;
}

type FakeContainer = {
  listeners: (() => void)[];
  addEventListener: (type: string, listener: () => void, options?: unknown) => void;
  fireControllerChange: () => void;
};

function makeContainer(): FakeContainer {
  const listeners: (() => void)[] = [];
  return {
    listeners,
    addEventListener: (type, listener) => {
      if (type === "controllerchange") {
        listeners.push(listener);
      }
    },
    fireControllerChange: () => {
      for (const listener of listeners) {
        listener();
      }
    }
  };
}

type Harness = {
  reloads: number;
  timers: { callback: () => void; ms: number }[];
  runTimers: () => void;
};

function makeHarness(): Harness {
  const harness: Harness = {
    reloads: 0,
    timers: [],
    runTimers: () => {
      const pending = harness.timers.splice(0, harness.timers.length);
      for (const timer of pending) {
        timer.callback();
      }
    }
  };
  return harness;
}

function run(
  harness: Harness,
  registration: FakeRegistration | null,
  container: FakeContainer | null,
  sendSkipWaiting?: () => Promise<void> | void
): Promise<void> {
  return applyServiceWorkerUpdate({
    registration: registration as unknown as ServiceWorkerRegistration | null,
    container: container as unknown as ServiceWorkerContainer | null,
    sendSkipWaiting,
    reload: () => {
      harness.reloads += 1;
    },
    setTimer: (callback, ms) => {
      harness.timers.push({ callback, ms });
    }
  });
}

test("messages the waiting worker directly instead of relying on the plugin", async () => {
  const harness = makeHarness();
  const waiting = makeWorker();
  const registration = makeRegistration({ waiting });

  await run(harness, registration, makeContainer());

  expect(waiting.posted).toEqual([{ type: "SKIP_WAITING" }]);
  // Already waiting: nothing to re-check.
  expect(registration.updateCalls).toBe(0);
});

test("reloads on controllerchange", async () => {
  const harness = makeHarness();
  const container = makeContainer();

  await run(harness, makeRegistration({ waiting: makeWorker() }), container);
  expect(harness.reloads).toBe(0);

  container.fireControllerChange();
  expect(harness.reloads).toBe(1);
});

test("reloads on the fallback timer when controllerchange never fires", async () => {
  const harness = makeHarness();

  await run(harness, makeRegistration({ waiting: makeWorker() }), makeContainer());
  expect(harness.timers.map((timer) => timer.ms)).toEqual([UPDATE_RELOAD_FALLBACK_MS]);

  harness.runTimers();
  expect(harness.reloads).toBe(1);
});

test("reloads only once when both the timer and controllerchange land", async () => {
  const harness = makeHarness();
  const container = makeContainer();

  await run(harness, makeRegistration({ waiting: makeWorker() }), container);
  container.fireControllerChange();
  harness.runTimers();

  expect(harness.reloads).toBe(1);
});

test("re-checks for a worker when none is waiting, then messages the one that appears", async () => {
  const harness = makeHarness();
  const waiting = makeWorker();
  const registration = makeRegistration({
    waiting: null,
    onUpdate: (current) => {
      current.waiting = waiting;
    }
  });

  await run(harness, registration, makeContainer());

  expect(registration.updateCalls).toBe(1);
  expect(waiting.posted).toEqual([{ type: "SKIP_WAITING" }]);
});

test("still reloads when there is no registration at all", async () => {
  const harness = makeHarness();

  await run(harness, null, makeContainer());
  harness.runTimers();

  expect(harness.reloads).toBe(1);
});

test("arms the fallback before awaiting, so a hanging update() still reloads", () => {
  const harness = makeHarness();
  const registration = makeRegistration({
    waiting: null,
    onUpdate: () => new Promise<void>(() => undefined)
  });

  // Deliberately not awaited: this `update()` never settles.
  void run(harness, registration, makeContainer());

  // The timer was armed before the first await.
  expect(harness.timers).toHaveLength(1);
  harness.runTimers();
  expect(harness.reloads).toBe(1);
});

test("a throwing plugin call does not stop the flow", async () => {
  const harness = makeHarness();
  const waiting = makeWorker();
  const registration = makeRegistration({ waiting });

  await run(harness, registration, makeContainer(), () => {
    throw new Error("no registration yet");
  });

  expect(waiting.posted).toEqual([{ type: "SKIP_WAITING" }]);
  harness.runTimers();
  expect(harness.reloads).toBe(1);
});

test("update check is throttled but never blocked by a backwards clock", () => {
  expect(shouldCheckForUpdate(null, 0)).toBe(true);
  expect(shouldCheckForUpdate(1000, 1000 + UPDATE_CHECK_MIN_INTERVAL_MS - 1)).toBe(false);
  expect(shouldCheckForUpdate(1000, 1000 + UPDATE_CHECK_MIN_INTERVAL_MS)).toBe(true);
  expect(shouldCheckForUpdate(1000, 500)).toBe(true);
  expect(shouldCheckForUpdate(1000, 1500, 100)).toBe(true);
});

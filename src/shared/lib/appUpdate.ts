/**
 * Applying a waiting service worker.
 *
 * The reload is owned here rather than left to `virtual:pwa-register/react`, because the plugin's
 * reload path silently does nothing on a phone:
 *
 * - `updateServiceWorker(true)` ignores its argument. The call only posts SKIP_WAITING; the reload
 *   lives in a `controlling` listener the plugin installs, and that listener reloads only when
 *   `event.isUpdate` is true. workbox-window latches `isUpdate` from
 *   `Boolean(navigator.serviceWorker.controller)` once, at registration time. A standalone iOS
 *   launch routinely has no controller on that first navigation, so the flag stays false for the
 *   whole session: the new worker activates and the page never reloads. That is the "tapped
 *   «Обновить», nothing happened, relaunching helped" report.
 * - `wb.messageSkipWaiting()` no-ops when `registration.waiting` is null, without an error. A
 *   `registration.update()` still installing leaves exactly that gap, and on mobile the visibility
 *   handler runs `update()` constantly.
 *
 * So: message the waiting worker directly, and reload on `controllerchange` OR on a timer,
 * whichever lands first. A reload with nothing new to serve costs one navigation; the current
 * behaviour costs the user the update.
 */

/**
 * How long to wait for `controllerchange` before reloading anyway. Long enough for a local
 * activation, short enough that the user does not tap the button a second time.
 */
export const UPDATE_RELOAD_FALLBACK_MS = 2000;

/**
 * Floor between two `registration.update()` calls. The trigger is `visibilitychange`, which on a
 * phone fires on every app switch, notification and lock — unthrottled it keeps a worker
 * perpetually in `installing`, which is the state where `waiting` is null and the button does
 * nothing.
 */
export const UPDATE_CHECK_MIN_INTERVAL_MS = 60_000;

export type ApplyServiceWorkerUpdateOptions = {
  registration: ServiceWorkerRegistration | null;
  container: ServiceWorkerContainer | null;
  /** The plugin's `updateServiceWorker`; kept in the flow so its own reload path still works. */
  sendSkipWaiting?: () => Promise<void> | void;
  reload: () => void;
  setTimer: (callback: () => void, ms: number) => void;
  fallbackMs?: number;
};

function postSkipWaiting(registration: ServiceWorkerRegistration | null): void {
  try {
    registration?.waiting?.postMessage({ type: "SKIP_WAITING" });
  } catch {
    // A worker that went redundant between the read and the post throws; the fallback reload
    // still applies whatever did activate.
  }
}

export async function applyServiceWorkerUpdate(
  options: ApplyServiceWorkerUpdateOptions
): Promise<void> {
  const { registration, container, sendSkipWaiting, reload, setTimer } = options;
  const fallbackMs = options.fallbackMs ?? UPDATE_RELOAD_FALLBACK_MS;

  let reloaded = false;
  const reloadOnce = () => {
    if (reloaded) {
      return;
    }
    reloaded = true;
    reload();
  };

  container?.addEventListener("controllerchange", reloadOnce, { once: true });
  // Armed before anything awaits: `update()` can hang on a dead network, and a hang must still
  // end in a reload.
  setTimer(reloadOnce, fallbackMs);

  postSkipWaiting(registration);
  try {
    await sendSkipWaiting?.();
  } catch {
    // The plugin path is a bonus. The direct postMessage above is the one that has to land.
  }

  if (!registration?.waiting) {
    try {
      await registration?.update();
    } catch {
      // Offline, or the check raced another one. Nothing to apply, and the reload is already armed.
    }
    postSkipWaiting(registration);
  }
}

/**
 * `lastCheckAt` is `null` before the first check. A clock that moved backwards (a phone waking up
 * after an NTP correction) is treated as "check now" rather than locking the check out for a
 * minute.
 */
export function shouldCheckForUpdate(
  lastCheckAt: number | null,
  now: number,
  minIntervalMs: number = UPDATE_CHECK_MIN_INTERVAL_MS
): boolean {
  if (lastCheckAt === null || now < lastCheckAt) {
    return true;
  }
  return now - lastCheckAt >= minIntervalMs;
}

import { defineConfig, devices } from "@playwright/test";

/**
 * Performance tier. Never part of `npm run test:e2e`.
 *
 * Port 4174 so it cannot collide with a developer's running preview, and `reuseExistingServer:
 * false` because a stale `dist` silently invalidates every number. `serviceWorkers: "block"` is
 * scoped to this config only — the e2e suite has an update-banner test that needs the SW.
 */
export default defineConfig({
  testDir: "./tests/perf",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 600_000,
  reporter: [["list"], ["json", { outputFile: "perf-results/raw.json" }]],
  use: {
    baseURL: "http://127.0.0.1:4174",
    serviceWorkers: "block",
    launchOptions: {
      args: ["--js-flags=--expose-gc", "--autoplay-policy=no-user-gesture-required"]
    }
  },
  webServer: {
    command: "npm run build && npm run preview -- --port 4174",
    url: "http://127.0.0.1:4174",
    reuseExistingServer: false,
    timeout: 180_000
  },
  projects: [
    {
      name: "perf-desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }
    }
  ]
});

import { defineConfig } from "@playwright/test";

/**
 * Pure-Node unit tier. Separate config file rather than a project inside `playwright.config.ts`
 * because `webServer` is a top-level field and cannot be scoped per project — a unit project in
 * the main config would still boot `build && preview`.
 *
 * Specs here must not request the `page` fixture, so no browser is launched. Modules under test
 * must stay free of `import.meta.env`, CSS and JSX: Playwright's loader transpiles TypeScript but
 * runs no Vite plugins.
 */
export default defineConfig({
  testDir: "./tests/unit",
  fullyParallel: true,
  timeout: 10_000,
  reporter: "list",
  projects: [{ name: "node" }]
});

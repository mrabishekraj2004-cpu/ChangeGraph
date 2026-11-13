import { defineConfig } from "@playwright/test";

const baseURL = process.env.BASE_URL || "http://localhost:3000";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 60_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1280, height: 900 },
  },
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: "npm run dev -- --hostname localhost",
        url: `${baseURL}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
          ...process.env,
          AUTH_SECRET: process.env.AUTH_SECRET || "playwright-only-secret-that-is-long-enough",
          CHANGEGRAPH_DB_PATH: process.env.CHANGEGRAPH_DB_PATH || "./data/playwright.db",
          CHANGEGRAPH_SEED_DEMO: "true",
        },
      },
});

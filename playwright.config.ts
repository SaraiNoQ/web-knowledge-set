import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4174",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm exec tsx tests/e2e-server.ts",
    url: "http://127.0.0.1:4174/health",
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    { name: "auth", testMatch: "**/auth.setup.ts" },
    {
      name: "chromium",
      testIgnore: "**/auth.setup.ts",
      dependencies: ["auth"],
      use: { storageState: "test-results/e2e-auth.json" },
    },
    {
      name: "firefox-scrollbar",
      testMatch: "**/scrollbar-firefox.spec.ts",
      dependencies: ["auth"],
      use: { browserName: "firefox", storageState: "test-results/e2e-auth.json" },
    },
    {
      name: "firefox-popup",
      testMatch: "**/extension-popup.spec.ts",
      use: { browserName: "firefox" },
    },
  ],
});

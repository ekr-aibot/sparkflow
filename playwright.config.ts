import { defineConfig } from "@playwright/test";

// On NixOS the bundled Playwright chromium won't run because its
// dynamic linker path is wrong for the host. Point at a system
// chromium via PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH instead. The
// `test:e2e` npm script hardcodes /run/current-system/sw/bin/chromium.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: "test/web",
  testMatch: /.*\.e2e\.ts$/,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 30_000,
  use: {
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
});

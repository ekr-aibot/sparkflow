import { defineConfig } from "@playwright/test";

// On NixOS the bundled chromium binary won't run. Set
// PLAYWRIGHT_EXECUTABLE_PATH to a system chromium / chrome (or use a
// nixpkgs flake that provides playwright-driver) — we honor it here.
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;

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

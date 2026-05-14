import { test, expect } from "@playwright/test";
import { startWebServer, type WebServerHandle } from "./server-fixture.js";
import { writeFileSync, mkdirSync, utimesSync, unlinkSync } from "node:fs";
import { join } from "node:path";

let server: WebServerHandle;

test.beforeAll(async () => {
  server = await startWebServer();
});

test.afterAll(async () => {
  if (server) await server.stop();
});

test.describe("Dashboard Widget E2E", () => {
  test("widget appears and reloads when dashboard.html is created/updated", async ({ page }) => {
    const sparkflowDir = join(server.cwd, ".sparkflow");
    mkdirSync(sparkflowDir, { recursive: true });

    // 1. Initial load: no dashboard
    await page.goto(server.url, { waitUntil: "domcontentloaded" });
    const widget = page.locator(".dw");
    await expect(widget).not.toBeVisible();

    // 2. Create dashboard.html -> widget appears
    const dashPath = join(sparkflowDir, "dashboard.html");
    const content1 = "<html><body>Dashboard V1</body></html>";
    writeFileSync(dashPath, content1);

    // Polling is 2s; allow extra time for CI to populate #repo-filter via SSE
    await expect(widget).toBeVisible({ timeout: 8000 });
    await expect(widget.locator(".dw-label")).toHaveText("Dashboard");

    // 3. Expand widget and check iframe content
    await widget.locator(".dw-header").click();
    await expect(widget).toHaveClass(/dw--expanded/);

    const iframe = widget.locator("iframe.dw-iframe");
    await expect(iframe).toBeVisible();

    // Check iframe content using frameLocator (auto-waits for frame to load)
    const frameLocator = page.frameLocator("iframe.dw-iframe");
    await expect(frameLocator.locator("body")).toHaveText("Dashboard V1", { timeout: 5000 });

    // 4. Update dashboard.html -> iframe reloads
    // Capture old src to check for cache-buster change
    const oldSrc = await iframe.getAttribute("src");
    expect(oldSrc).toMatch(/\/repos\/[^/]+\/dashboard/);

    const content2 = "<html><body>Dashboard V2</body></html>";
    writeFileSync(dashPath, content2);
    // Bump mtime to ensure Last-Modified changes
    const now = new Date();
    utimesSync(dashPath, now, now);

    // Wait for iframe to reload and show new content (poll cycle up to 2s + load time)
    await expect(frameLocator.locator("body")).toHaveText("Dashboard V2", { timeout: 8000 });

    const newSrc = await iframe.getAttribute("src");
    expect(newSrc).not.toBe(oldSrc);
    expect(newSrc).toMatch(/\?\d+$/);

    // 5. Delete dashboard.html -> widget hides
    // rmSync(dashPath) // Sometimes rmSync fails on open files in CI
    writeFileSync(dashPath, ""); // Empty file might still show widget but empty.
    // The handler returns 404 for missing file.
    // Let's try to actually delete it.
    unlinkSync(dashPath);

    await expect(widget).not.toBeVisible({ timeout: 5000 });
  });

  test("expand state persists across page reloads", async ({ page }) => {
    const sparkflowDir = join(server.cwd, ".sparkflow");
    mkdirSync(sparkflowDir, { recursive: true });
    writeFileSync(join(sparkflowDir, "dashboard.html"), "<html><body>Persist Test</body></html>");

    await page.goto(server.url, { waitUntil: "domcontentloaded" });
    const widget = page.locator(".dw");
    await expect(widget).toBeVisible({ timeout: 8000 });

    // Ensure it's collapsed initially
    await expect(widget).not.toHaveClass(/dw--expanded/);

    // Expand it
    await widget.locator(".dw-header").click();
    await expect(widget).toHaveClass(/dw--expanded/);

    // Reload page
    await page.reload({ waitUntil: "domcontentloaded" });

    // Should still be expanded
    const widgetAfter = page.locator(".dw");
    await expect(widgetAfter).toBeVisible({ timeout: 5000 });
    await expect(widgetAfter).toHaveClass(/dw--expanded/);
  });
});

import { test, expect } from "@playwright/test";
import { startWebServer, type WebServerHandle } from "./server-fixture.js";
import { writeFileSync, mkdirSync, utimesSync, unlinkSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

  test("SPA dashboard renders progress bar and sections from state.json", async ({ page }) => {
    // Get the repoId from /repos
    const reposRes = await fetch(`${server.url.replace(/\?.*/, "")}/repos?token=${server.token}`);
    const reposBody = await reposRes.json() as { repos: Array<{ repoId: string }> };
    const repoId = reposBody.repos[0]?.repoId;
    expect(repoId).toBeTruthy();

    const sparkflowDir = join(server.cwd, ".sparkflow");
    const dashDir = join(sparkflowDir, "dashboard");
    mkdirSync(dashDir, { recursive: true });

    // Copy SPA assets from source
    const spaDir = resolve(__dirname, "../../src/dashboard/auto-develop-spa");
    for (const file of ["index.html", "app.js", "style.css"]) {
      writeFileSync(join(dashDir, file), readFileSync(join(spaDir, file)));
    }

    // Write a fixture state.json
    const stateData = {
      workflow: "auto-develop",
      sections: [
        {
          title: "Phase 1",
          tasks: [
            { id: "t1", line: 2, status: "done", text: "Set up repo" },
            { id: "t2", line: 3, status: "blocked", text: "Deploy service", blockedReason: "needs infra" },
          ],
        },
        {
          title: "Phase 2",
          tasks: [
            { id: "t3", line: 5, status: "pending", text: "Write docs" },
          ],
        },
      ],
      summary: { done: 1, pending: 1, blocked: 1, in_progress: 0, total: 3 },
      recent: [{ event: "blocked", task: "Deploy service", at: new Date().toISOString() }],
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(join(dashDir, "state.json"), JSON.stringify(stateData));

    const dashUrl = `http://127.0.0.1:${server.port}/repos/${repoId}/dashboard?token=${server.token}`;
    await page.goto(dashUrl, { waitUntil: "domcontentloaded" });

    // Progress bar should be present (1/3 done = 33%)
    await expect(page.locator(".progress-bar")).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".progress-label")).toContainText("1 / 3 done");

    // Section headings should be visible
    await expect(page.locator(".section__title").first()).toContainText("Phase 1");

    // Blocked task should appear in pinned panel
    await expect(page.locator(".pinned-panel")).toBeVisible();
    await expect(page.locator(".pinned-task--blocked")).toContainText("Deploy service");

    // Recent activity strip should show the blocked event
    await expect(page.locator(".recent")).toBeVisible();

    // Now mutate state.json and verify SSE update updates DOM within 2s
    const stateData2 = { ...stateData, summary: { done: 2, pending: 1, blocked: 0, in_progress: 0, total: 3 } };
    stateData2.sections[0].tasks[1].status = "done";
    // Remove blocked from sections
    writeFileSync(join(dashDir, "state.json"), JSON.stringify(stateData2));
    const tmpFile = join(dashDir, "state.json.tmp");
    writeFileSync(tmpFile, JSON.stringify(stateData2));
    // Use atomic rename (mirrors how CLI does it)
    const { renameSync } = await import("node:fs");
    renameSync(tmpFile, join(dashDir, "state.json"));

    // Progress bar should update to show 2/3
    await expect(page.locator(".progress-label")).toContainText("2 / 3 done", { timeout: 3000 });
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

import { test, expect } from "@playwright/test";
import { startWebServer, type WebServerHandle } from "./server-fixture.js";

let server: WebServerHandle;

test.beforeAll(async () => {
  server = await startWebServer();
});

test.afterAll(async () => {
  if (server) await server.stop();
});

function makeJobSnapshot(jobs: object[]): string {
  return `data: ${JSON.stringify({ jobs })}\n\n`;
}

const regularJob = {
  id: "aabbccdd1122",
  workflowPath: "/tmp/my-flow.json",
  workflowName: "my-flow",
  state: "running",
  summary: "working…",
  startTime: Date.now(),
  activeSteps: {},
};

const monitorJob1 = {
  id: "deadbeef0001",
  workflowPath: "/tmp/monitor1.json",
  workflowName: "monitor1",
  kind: "monitor",
  state: "running",
  summary: "watching…",
  startTime: Date.now(),
  activeSteps: {},
};

const monitorJob2 = {
  id: "deadbeef0002",
  workflowPath: "/tmp/monitor2.json",
  workflowName: "monitor2",
  kind: "monitor",
  state: "running",
  summary: "watching…",
  startTime: Date.now(),
  activeSteps: {},
};

// Intercept /events with a synthetic SSE stream.
async function routeEvents(page: import("@playwright/test").Page, jobs: object[]) {
  await page.route("**/events", (route) => {
    route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
      body: makeJobSnapshot(jobs),
    });
  });
}

test("healthy monitor jobs are hidden by default; toggle shows them", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await routeEvents(page, [regularJob, monitorJob1, monitorJob2]);
  await page.goto(server.url, { waitUntil: "domcontentloaded" });

  // Wait for job list to reflect the SSE payload.
  await page.waitForFunction(() => {
    const count = document.getElementById("job-count");
    return count && count.textContent !== "";
  }, null, { timeout: 5000 });

  // Only the regular job should be visible.
  await expect(page.locator(".job-card")).toHaveCount(1);
  await expect(page.locator(".job-card .name")).toContainText("my-flow");

  // Count shows 1 (excludes hidden monitors).
  await expect(page.locator("#job-count")).toHaveText("1 total");

  // Monitor toggle is visible and shows "(2)".
  await expect(page.locator("#monitor-toggle-label")).toBeVisible();
  await expect(page.locator("#monitor-toggle-count")).toContainText("(2)");

  // Checkbox is unchecked.
  await expect(page.locator("#pref-show-monitors")).not.toBeChecked();

  // Toggle on → all 3 cards visible.
  await page.locator("#pref-show-monitors").check();
  await expect(page.locator(".job-card")).toHaveCount(3);
  await expect(page.locator("#job-count")).toHaveText("3 total");

  await ctx.close();
});

test("showMonitors state persists to localStorage", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await routeEvents(page, [regularJob, monitorJob1]);
  await page.goto(server.url, { waitUntil: "domcontentloaded" });

  await page.waitForFunction(() => {
    const label = document.getElementById("monitor-toggle-label");
    return label && !label.hidden;
  }, null, { timeout: 5000 });

  // Check the toggle on.
  await page.locator("#pref-show-monitors").check();

  // localStorage key should be set.
  const stored = await page.evaluate(() => localStorage.getItem("sparkflow:showMonitors"));
  expect(stored).toBe("true");

  // Reload → checkbox should still be checked.
  await routeEvents(page, [regularJob, monitorJob1]);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const label = document.getElementById("monitor-toggle-label");
    return label && !label.hidden;
  }, null, { timeout: 5000 });

  await expect(page.locator("#pref-show-monitors")).toBeChecked();
  await expect(page.locator(".job-card")).toHaveCount(2);

  await ctx.close();
});

test("failed monitor auto-surfaces even when toggle is off", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const failedMonitor = { ...monitorJob1, id: "deadbeef0099", state: "failed" };

  await routeEvents(page, [regularJob, failedMonitor]);
  await page.goto(server.url, { waitUntil: "domcontentloaded" });

  await page.waitForFunction(() => {
    const count = document.getElementById("job-count");
    return count && count.textContent !== "";
  }, null, { timeout: 5000 });

  // Toggle is off by default (new context = clean localStorage).
  await expect(page.locator("#pref-show-monitors")).not.toBeChecked();

  // Failed monitor should be visible despite toggle being off.
  await expect(page.locator(".job-card")).toHaveCount(2);

  await ctx.close();
});

test("monitor toggle is hidden when no monitor jobs exist", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await routeEvents(page, [regularJob]);
  await page.goto(server.url, { waitUntil: "domcontentloaded" });

  await page.waitForFunction(() => {
    const count = document.getElementById("job-count");
    return count && count.textContent !== "";
  }, null, { timeout: 5000 });

  await expect(page.locator("#monitor-toggle-label")).toBeHidden();
  await expect(page.locator(".job-card")).toHaveCount(1);

  await ctx.close();
});

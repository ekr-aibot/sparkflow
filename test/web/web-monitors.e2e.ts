import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { startWebServer, type WebServerHandle } from "./server-fixture.js";

let server: WebServerHandle;

test.beforeAll(async () => {
  server = await startWebServer();
});

test.afterAll(async () => {
  if (server) await server.stop();
});

// ---- synthetic job fixtures ----

function makeJobs(overrides: { monitorState?: string } = {}) {
  const now = Date.now();
  return [
    {
      id: "aabb11223344",
      workflowPath: "/work.json",
      workflowName: "my-workflow",
      state: "running",
      summary: "doing work",
      startTime: now,
    },
    {
      id: "mon111222333",
      workflowPath: "/mon1.json",
      workflowName: "pr-watcher",
      kind: "monitor",
      state: overrides.monitorState ?? "running",
      summary: "watching PRs",
      startTime: now,
    },
    {
      id: "mon444555666",
      workflowPath: "/mon2.json",
      workflowName: "issue-watcher",
      kind: "monitor",
      state: "running",
      summary: "watching issues",
      startTime: now,
    },
  ];
}

// ---- helpers ----

// Stub xterm/addon-fit so client.js loads even without vendored files,
// then intercept the SSE feed with a synthetic job snapshot.
async function openWithJobs(
  browser: Browser,
  jobs: object[],
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();

  // Pre-set auth cookie so we go straight to the page without the redirect.
  await ctx.addCookies([
    { name: "sf_token", value: server.token, domain: "127.0.0.1", path: "/" },
  ]);

  const page = await ctx.newPage();

  // Stub missing xterm vendor files so client.js ES module loads successfully.
  await page.route("**/xterm.mjs", (route) =>
    route.fulfill({
      contentType: "application/javascript; charset=utf-8",
      body: `
export class Terminal {
  constructor(opts) { this._listeners = []; }
  loadAddon(a) {}
  open(el) {}
  write(s) {}
  reset() {}
  dispose() {}
  onData(cb) { this._listeners.push(cb); }
  get cols() { return 80; }
  get rows() { return 24; }
}
`,
    }),
  );

  await page.route("**/addon-fit.mjs", (route) =>
    route.fulfill({
      contentType: "application/javascript; charset=utf-8",
      body: `export class FitAddon { fit() {} }`,
    }),
  );

  await page.route("**/xterm.css", (route) =>
    route.fulfill({ contentType: "text/css", body: "" }),
  );

  // Deliver a single SSE snapshot with our synthetic jobs.
  // Playwright closes the connection after route.fulfill(); the EventSource
  // will reconnect (getting the same data again), which is harmless.
  await page.route("**/events", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
      body: `data: ${JSON.stringify({ jobs })}\n\n`,
    }),
  );

  await page.goto(`http://127.0.0.1:${server.port}/`);
  // Wait until at least one job card or the empty placeholder appears.
  await page.waitForSelector(".job-card, .empty");

  return { ctx, page };
}

// ---- tests ----

test("hides healthy monitor jobs by default", async ({ browser }) => {
  const { ctx, page } = await openWithJobs(browser, makeJobs());
  try {
    // Only the regular job should be rendered.
    await expect(page.locator(".job-card")).toHaveCount(1);

    // Monitor toggle label is visible and shows the correct count.
    const label = page.locator("#monitor-toggle-label");
    await expect(label).not.toHaveAttribute("hidden");
    await expect(page.locator("#monitor-toggle-count")).toContainText("(2)");

    // Job count reflects visible jobs only.
    await expect(page.locator("#job-count")).toContainText("1 total");

    // Checkbox starts unchecked.
    await expect(page.locator("#pref-show-monitors")).not.toBeChecked();
  } finally {
    await ctx.close();
  }
});

test("shows all jobs when monitor toggle is checked", async ({ browser }) => {
  const { ctx, page } = await openWithJobs(browser, makeJobs());
  try {
    await expect(page.locator(".job-card")).toHaveCount(1);

    await page.locator("#pref-show-monitors").check();

    // All 3 cards should now be visible.
    await expect(page.locator(".job-card")).toHaveCount(3);

    // Preference should be persisted to localStorage.
    const stored = await page.evaluate(() => localStorage.getItem("sparkflow:showMonitors"));
    expect(stored).toBe("true");
  } finally {
    await ctx.close();
  }
});

test("monitor visibility preference is restored after page reload", async ({ browser }) => {
  const { ctx, page } = await openWithJobs(browser, makeJobs());
  try {
    // Enable monitors.
    await page.locator("#pref-show-monitors").check();
    await expect(page.locator(".job-card")).toHaveCount(3);

    // Reload; the route is still active so SSE delivers the same snapshot.
    await page.reload();
    await page.waitForSelector(".job-card");

    // Checkbox should be restored from localStorage and all cards visible.
    await expect(page.locator("#pref-show-monitors")).toBeChecked();
    await expect(page.locator(".job-card")).toHaveCount(3);
  } finally {
    await ctx.close();
  }
});

test("auto-surfaces a failed monitor even when toggle is off", async ({ browser }) => {
  const jobs = makeJobs({ monitorState: "failed" });
  const { ctx, page } = await openWithJobs(browser, jobs);
  try {
    // Regular job + failed monitor card = 2. Healthy monitor stays hidden.
    await expect(page.locator(".job-card")).toHaveCount(2);
    await expect(page.locator("#pref-show-monitors")).not.toBeChecked();
  } finally {
    await ctx.close();
  }
});

test("hides monitor toggle when there are no monitor jobs", async ({ browser }) => {
  const regularOnly = [makeJobs()[0]];
  const { ctx, page } = await openWithJobs(browser, regularOnly);
  try {
    await expect(page.locator(".job-card")).toHaveCount(1);
    await expect(page.locator("#monitor-toggle-label")).toHaveAttribute("hidden");
  } finally {
    await ctx.close();
  }
});

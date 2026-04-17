import { test, expect, request as pwRequest } from "@playwright/test";
import { startWebServer, type WebServerHandle } from "./server-fixture.js";

let server: WebServerHandle;

test.beforeAll(async () => {
  server = await startWebServer();
});

test.afterAll(async () => {
  if (server) await server.stop();
});

// ---- HTTP-only checks (no browser, fast) ----

test("rejects unauthenticated requests with 401", async () => {
  const ctx = await pwRequest.newContext();
  const res = await ctx.get(`http://127.0.0.1:${server.port}/`, { maxRedirects: 0 });
  expect(res.status()).toBe(401);
  await ctx.dispose();
});

test("rejects requests with a wrong token", async () => {
  const ctx = await pwRequest.newContext();
  const res = await ctx.get(`http://127.0.0.1:${server.port}/?token=deadbeef`, { maxRedirects: 0 });
  expect(res.status()).toBe(401);
  await ctx.dispose();
});

test("first request with valid token sets cookie and redirects", async () => {
  const ctx = await pwRequest.newContext();
  const res = await ctx.get(server.url, { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  const setCookie = res.headers()["set-cookie"] ?? "";
  expect(setCookie).toContain("sf_token=");
  expect(setCookie).toContain(server.token);
  await ctx.dispose();
});

test("/events streams an initial empty job snapshot", async () => {
  // Use raw fetch so we can read the SSE stream incrementally without a browser.
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${server.port}/events`, {
    headers: { Cookie: `sf_token=${server.token}` },
    signal: ctrl.signal,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const m = buf.match(/^data: (\{[^\n]*\})\n\n/m);
    if (m) {
      const payload = JSON.parse(m[1]) as { jobs: unknown[] };
      expect(Array.isArray(payload.jobs)).toBe(true);
      expect(payload.jobs).toHaveLength(0);
      ctrl.abort();
      return;
    }
  }
  ctrl.abort();
  throw new Error(`Did not receive an SSE data frame within 5s. Buffer:\n${buf}`);
});

// ---- Browser-driven checks ----

test("loads the page, terminal renders, and chat WS receives PTY output", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // First navigation with token in URL → 302 → cookie + reload of /. Playwright follows redirects.
  await page.goto(server.url, { waitUntil: "networkidle" });

  // Layout sanity.
  await expect(page.locator("#chat")).toBeVisible();
  await expect(page.locator("#status")).toBeVisible();

  // xterm.js mounts a `.xterm` div inside #chat.
  await page.waitForSelector("#chat .xterm", { timeout: 10000 });

  // The fake-chat fixture prints SF_TEST_READY immediately. xterm renders it
  // into the screen buffer; we read it back via the Terminal API.
  const readyText = await page.waitForFunction(() => {
    // xterm exposes its buffer; we sample by scanning the visible text.
    const term = document.querySelector("#chat .xterm-rows");
    if (!term) return null;
    const text = term.textContent ?? "";
    return text.includes("SF_TEST_READY") ? text : null;
  }, null, { timeout: 10000 });
  expect(await readyText.jsonValue()).toContain("SF_TEST_READY");

  // Type into the terminal — the fake chat will echo it back as `ECHO:hi\r\n`.
  await page.locator("#chat .xterm-helper-textarea").focus();
  await page.keyboard.type("hi\r");
  const echoText = await page.waitForFunction(() => {
    const term = document.querySelector("#chat .xterm-rows");
    const text = term?.textContent ?? "";
    return text.includes("ECHO:hi") ? text : null;
  }, null, { timeout: 10000 });
  expect(await echoText.jsonValue()).toContain("ECHO:hi");

  // Status panel renders the empty-state message from the SSE feed.
  await expect(page.locator("#job-list .empty")).toContainText("No jobs running");

  await ctx.close();
});

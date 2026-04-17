import { test, expect } from "@playwright/test";
import WebSocket from "ws";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startWebServer, type WebServerHandle } from "./server-fixture.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let server: WebServerHandle;

test.beforeAll(async () => {
  server = await startWebServer();
});

test.afterAll(async () => {
  if (server) await server.stop();
});

const cookieHeader = () => `sf_token=${server.token}`;
const httpBase = () => `http://127.0.0.1:${server.port}`;

// ---- Static assets ----

test("serves /static/index.html with text/html", async () => {
  const res = await fetch(`${httpBase()}/static/index.html`, { headers: { Cookie: cookieHeader() } });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  const body = await res.text();
  expect(body).toContain("<title>sparkflow</title>");
});

test("serves /static/xterm.mjs with javascript content-type", async () => {
  const res = await fetch(`${httpBase()}/static/xterm.mjs`, { headers: { Cookie: cookieHeader() } });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/javascript");
  const body = await res.text();
  expect(body.length).toBeGreaterThan(1000);
});

test("serves /static/xterm.css with text/css", async () => {
  const res = await fetch(`${httpBase()}/static/xterm.css`, { headers: { Cookie: cookieHeader() } });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/css");
});

test("serves /static/addon-fit.mjs", async () => {
  const res = await fetch(`${httpBase()}/static/addon-fit.mjs`, { headers: { Cookie: cookieHeader() } });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/javascript");
});

test("404 on unknown route", async () => {
  const res = await fetch(`${httpBase()}/does-not-exist`, { headers: { Cookie: cookieHeader() } });
  expect(res.status).toBe(404);
});

test("401 on /static/* without token", async () => {
  const res = await fetch(`${httpBase()}/static/index.html`);
  expect(res.status).toBe(401);
});

// ---- WebSocket /chat ----

function openWs(opts: { cookie?: boolean; query?: string } = {}): Promise<WebSocket> {
  const qs = opts.query !== undefined ? `?token=${opts.query}` : "";
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.Cookie = cookieHeader();
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/chat${qs}`, { headers });
  return new Promise((res, rej) => {
    ws.once("open", () => res(ws));
    ws.once("error", (err) => rej(err));
  });
}

function nextMessage(ws: WebSocket, predicate?: (msg: { type?: string; bytes?: string }) => boolean): Promise<{ type?: string; bytes?: string }> {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => {
      ws.off("message", onMsg);
      rej(new Error("Timed out waiting for WS message"));
    }, 5000);
    const onMsg = (raw: WebSocket.RawData) => {
      let parsed: { type?: string; bytes?: string };
      try { parsed = JSON.parse(raw.toString()) as { type?: string; bytes?: string }; } catch { return; }
      if (predicate && !predicate(parsed)) return;
      clearTimeout(timer);
      ws.off("message", onMsg);
      res(parsed);
    };
    ws.on("message", onMsg);
  });
}

test("WS /chat upgrade is rejected without token", async () => {
  await expect(openWs()).rejects.toThrow(/401|Unexpected server response/);
});

test("WS /chat upgrade is rejected with wrong token", async () => {
  await expect(openWs({ query: "deadbeef" })).rejects.toThrow(/401|Unexpected server response/);
});

test("WS /chat with valid token receives the ring buffer (SF_TEST_READY)", async () => {
  const ws = await openWs({ query: server.token });
  try {
    const msg = await nextMessage(ws, (m) => m.type === "data" && typeof m.bytes === "string");
    const decoded = Buffer.from(msg.bytes!, "base64").toString("utf-8");
    expect(decoded).toContain("SF_TEST_READY");
  } finally {
    ws.close();
  }
});

test("WS /chat round-trips bytes through the PTY (echo)", async () => {
  const ws = await openWs({ query: server.token });
  try {
    // Drain the initial ring buffer.
    await nextMessage(ws, (m) => m.type === "data" && typeof m.bytes === "string");

    const payload = "ping\r";
    ws.send(JSON.stringify({ type: "data", bytes: Buffer.from(payload, "utf-8").toString("base64") }));

    // Wait for an echo frame containing "ECHO:ping" (the fake-chat fixture's echo prefix).
    const echo = await nextMessage(ws, (m) => {
      if (m.type !== "data" || typeof m.bytes !== "string") return false;
      const decoded = Buffer.from(m.bytes, "base64").toString("utf-8");
      return decoded.includes("ECHO:ping");
    });
    expect(Buffer.from(echo.bytes!, "base64").toString("utf-8")).toContain("ECHO:ping");
  } finally {
    ws.close();
  }
});

test("WS /chat tolerates resize messages", async () => {
  const ws = await openWs({ query: server.token });
  try {
    await nextMessage(ws, (m) => m.type === "data" && typeof m.bytes === "string");
    ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    // No response expected for resize; just verify the connection stays open.
    await new Promise((r) => setTimeout(r, 200));
    expect(ws.readyState).toBe(WebSocket.OPEN);
  } finally {
    ws.close();
  }
});

// ---- JSON API for job actions ----

test("GET /api/jobs/unknown/log → 404", async () => {
  const res = await fetch(`${httpBase()}/api/jobs/bogus/log`, { headers: { Cookie: cookieHeader() } });
  expect(res.status).toBe(404);
  const body = await res.json();
  expect(body.error).toMatch(/Job not found/i);
});

test("POST /api/jobs/unknown/kill → 400 with error", async () => {
  const res = await fetch(`${httpBase()}/api/jobs/bogus/kill`, {
    method: "POST",
    headers: { Cookie: cookieHeader() },
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toMatch(/not found/i);
});

test("POST /api/jobs/unknown/restart → 400 with error", async () => {
  const res = await fetch(`${httpBase()}/api/jobs/bogus/restart`, {
    method: "POST",
    headers: { Cookie: cookieHeader() },
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toMatch(/not found/i);
});

test("401 on /api/* without token", async () => {
  const res = await fetch(`${httpBase()}/api/jobs/bogus/log`);
  expect(res.status).toBe(401);
});

// ---- Live reload: edits to src/web/static/* are picked up without a rebuild ----

test("serves app files from src/ — editing src is visible on next request", async () => {
  const repoRoot = resolve(__dirname, "..", "..");
  const srcPath = resolve(repoRoot, "src", "web", "static", "client.js");
  const original = readFileSync(srcPath, "utf-8");
  const marker = `/* live-reload-check-${Date.now()} */`;
  writeFileSync(srcPath, `${original}\n${marker}\n`);
  try {
    const res = await fetch(`${httpBase()}/static/client.js`, { headers: { Cookie: cookieHeader() } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(marker);
  } finally {
    writeFileSync(srcPath, original);
  }
});

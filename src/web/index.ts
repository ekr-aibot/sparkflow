#!/usr/bin/env node

/**
 * Web-mode entry: HTTP + SSE + WebSocket server that hosts the sparkflow
 * dashboard in a browser. The chat pane is a real `claude` process spawned
 * under a pseudo-tty and proxied byte-for-byte over WebSocket.
 *
 * Invocation: web <socket-path> <cwd> <port> <chat-cmd> [chat-args...]
 *   chat-cmd is followed by every arg the chat tool needs, including the
 *   --mcp-config path and --append-system-prompt invocation prepared by the
 *   parent (src/tui/index.ts). All extra args after the port belong to chat.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, statSync, unlinkSync } from "node:fs";
import { extname, resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { spawn as ptySpawn, type IPty } from "node-pty";
import { IpcServer } from "../mcp/ipc.js";
import { JobManager } from "../tui/job-manager.js";
import { handleIpcRequest } from "../tui/ipc-handler.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// index.js lives at <pkg>/dist/src/web/. Package root is three up.
const PKG_ROOT = resolve(__dirname, "..", "..", "..");
const STATIC_DIR = resolve(__dirname, "static");
const NODE_MODULES = resolve(PKG_ROOT, "node_modules");

const RING_BUFFER_BYTES = 64 * 1024;

interface Args {
  socketPath: string;
  cwd: string;
  port: number;
  chatCmd: string;
  chatArgs: string[];
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  if (argv.length < 4) {
    console.error("Usage: web <socket-path> <cwd> <port> <chat-cmd> [chat-args...]");
    process.exit(1);
  }
  const [socketPath, cwd, portStr, chatCmd, ...chatArgs] = argv;
  const port = parseInt(portStr, 10);
  if (Number.isNaN(port) || port < 0) {
    console.error(`Invalid port: ${portStr}`);
    process.exit(1);
  }
  return { socketPath, cwd, port, chatCmd, chatArgs };
}

function getCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}

function getQueryToken(url: string): string | undefined {
  const idx = url.indexOf("?");
  if (idx === -1) return undefined;
  const params = new URLSearchParams(url.slice(idx + 1));
  return params.get("token") ?? undefined;
}

function authorized(req: IncomingMessage, token: string): boolean {
  if (getCookie(req, "sf_token") === token) return true;
  if (getQueryToken(req.url ?? "") === token) return true;
  return false;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf-8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.byteLength,
    "cache-control": "no-store",
  });
  res.end(payload);
}

function serveFile(res: ServerResponse, absPath: string): void {
  try {
    const stat = statSync(absPath);
    if (!stat.isFile()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const body = readFileSync(absPath);
    const mime = MIME[extname(absPath).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, {
      "content-type": mime,
      "content-length": body.byteLength,
      "cache-control": "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
}

function resolveStatic(name: string): string | null {
  // Static files served from src/web/static/ and from node_modules/ for xterm assets.
  const safe = name.replace(/^\/+/, "").replace(/\.\./g, "");
  const localCandidates: Record<string, string> = {
    "index.html": join(STATIC_DIR, "index.html"),
    "client.js": join(STATIC_DIR, "client.js"),
    "style.css": join(STATIC_DIR, "style.css"),
    "xterm.css": join(NODE_MODULES, "@xterm", "xterm", "css", "xterm.css"),
    "xterm.mjs": join(NODE_MODULES, "@xterm", "xterm", "lib", "xterm.mjs"),
    "addon-fit.mjs": join(NODE_MODULES, "@xterm", "addon-fit", "lib", "addon-fit.mjs"),
  };
  return localCandidates[safe] ?? null;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const token = randomBytes(32).toString("hex");

  // --- core services (mirror status-display, but in-process with the web server) ---
  const jobManager = new JobManager(args.cwd);
  jobManager.rehydrate();

  try { unlinkSync(args.socketPath); } catch { /* not present */ }
  const ipcServer = new IpcServer(args.socketPath);
  ipcServer.onRequest((msg) => handleIpcRequest(msg, jobManager, args.cwd));
  await ipcServer.listen();

  // --- HTTP server ---
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    const pathname = url.split("?")[0];

    // Token gate.
    const cookieOk = getCookie(req, "sf_token") === token;
    const queryOk = getQueryToken(url) === token;
    if (!cookieOk && !queryOk) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("unauthorized");
      return;
    }
    // First hit via `?token=…` with no cookie yet: set the cookie and redirect
    // to a clean /. Subsequent requests use the cookie.
    if (!cookieOk && queryOk && pathname === "/") {
      res.writeHead(302, {
        "set-cookie": `sf_token=${token}; Path=/; HttpOnly; SameSite=Strict`,
        location: "/",
      });
      res.end();
      return;
    }

    if (pathname === "/" || pathname === "/index.html") {
      const file = resolveStatic("index.html");
      if (file) return serveFile(res, file);
    }

    if (pathname.startsWith("/static/")) {
      const file = resolveStatic(pathname.slice("/static/".length));
      if (file) return serveFile(res, file);
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    if (pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const send = () => {
        try {
          res.write(`data: ${JSON.stringify({ jobs: jobManager.getJobs() })}\n\n`);
        } catch { /* client gone */ }
      };
      send();
      jobManager.onUpdate(send);
      // Heartbeat every 15s so reverse proxies / tabs don't time the stream out.
      const heartbeat = setInterval(() => {
        try { res.write(": ping\n\n"); } catch { /* ignore */ }
      }, 15000);
      req.on("close", () => clearInterval(heartbeat));
      return;
    }

    // ---- JSON API ----
    // GET /api/jobs/:id/log?since=N  → { lines: string[], length: number, state: JobState }
    const logMatch = pathname.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)\/log$/);
    if (logMatch && req.method === "GET") {
      const jobId = logMatch[1];
      const detail = jobManager.getJobDetail(jobId);
      if (!detail) return sendJson(res, 404, { error: `Job not found: ${jobId}` });
      const params = new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?") + 1) : "");
      const sinceRaw = parseInt(params.get("since") ?? "0", 10);
      const length = detail.output.length;
      const since = Number.isFinite(sinceRaw) && sinceRaw >= 0 && sinceRaw <= length ? sinceRaw : 0;
      const lines = detail.output.slice(since);
      return sendJson(res, 200, { lines, length, state: detail.info.state });
    }

    const killMatch = pathname.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)\/kill$/);
    if (killMatch && req.method === "POST") {
      const r = jobManager.killJob(killMatch[1]);
      return r.ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 400, { error: r.error ?? "kill failed" });
    }

    const restartMatch = pathname.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)\/restart$/);
    if (restartMatch && req.method === "POST") {
      jobManager.restartJob(restartMatch[1], "fresh").then((r) => {
        if (r.ok) sendJson(res, 200, { ok: true, newJobId: r.newJobId });
        else sendJson(res, 400, { error: r.error ?? "restart failed" });
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 500, { error: msg });
      });
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  // --- WebSocket server (chat) ---
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").split("?")[0] !== "/chat" || !authorized(req, token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  // --- Single global PTY hosting the chat tool ---
  const pty: IPty = ptySpawn(args.chatCmd, args.chatArgs, {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd: args.cwd,
    env: process.env as Record<string, string>,
  });

  // Ring buffer so refreshed/late tabs can catch up to recent output.
  let ring = Buffer.alloc(0);
  pty.onData((data) => {
    const chunk = Buffer.from(data, "utf-8");
    ring = ring.length + chunk.length <= RING_BUFFER_BYTES
      ? Buffer.concat([ring, chunk])
      : Buffer.concat([ring.subarray(ring.length + chunk.length - RING_BUFFER_BYTES), chunk]);
    const payload = JSON.stringify({ type: "data", bytes: chunk.toString("base64") });
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  });

  pty.onExit(({ exitCode }) => {
    console.error(`[sparkflow web] chat process exited (code=${exitCode}); shutting down`);
    shutdown(0);
  });

  wss.on("connection", (ws: WebSocket) => {
    // Replay buffer so the new tab sees recent context.
    if (ring.length > 0) {
      ws.send(JSON.stringify({ type: "data", bytes: ring.toString("base64") }));
    }
    ws.on("message", (raw) => {
      let parsed: unknown;
      try { parsed = JSON.parse(raw.toString("utf-8")); } catch { return; }
      const msg = parsed as { type?: string; bytes?: string; cols?: number; rows?: number };
      if (msg.type === "data" && typeof msg.bytes === "string") {
        try { pty.write(Buffer.from(msg.bytes, "base64").toString("utf-8")); } catch { /* ignore */ }
      } else if (msg.type === "resize" && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
        try { pty.resize(Math.max(1, msg.cols!), Math.max(1, msg.rows!)); } catch { /* ignore */ }
      }
    });
  });

  // --- Bind ---
  server.listen(args.port, "127.0.0.1", () => {
    const address = server.address();
    const boundPort = typeof address === "object" && address ? address.port : args.port;
    process.stderr.write(
      `\n[sparkflow web] ready at http://127.0.0.1:${boundPort}/?token=${token}\n` +
      `[sparkflow web] press Ctrl-C to quit\n\n`,
    );
  });

  // --- Lifecycle ---
  let shuttingDown = false;
  function shutdown(code: number): void {
    if (shuttingDown) return;
    shuttingDown = true;
    try { pty.kill(); } catch { /* ignore */ }
    jobManager.killAll();
    ipcServer.close().finally(() => {
      server.close(() => process.exit(code));
      // Belt and braces: force-exit if close hangs on lingering SSE clients.
      setTimeout(() => process.exit(code), 1000).unref();
    });
  }
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGHUP", () => shutdown(0));
}

main().catch((err) => {
  console.error("[sparkflow web] fatal:", err);
  process.exit(1);
});

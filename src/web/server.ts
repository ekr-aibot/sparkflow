#!/usr/bin/env node

/**
 * Child process spawned by src/web/index.ts (the supervisor). Owns the HTTP
 * server, WebSocket chat bridge, SSE job feed, JSON API, and JobManager.
 *
 * The claude PTY lives in the parent so it survives hot-reloads of this
 * process. We connect to the parent's PTY bridge (a unix socket) to stream
 * chat bytes in both directions.
 *
 * Invocation (by the supervisor): server <ipc-socket-path> <cwd> <port> <pty-bridge-socket-path>
 * Environment:
 *   SPARKFLOW_WEB_TOKEN — auth token (required; shared across restarts by the supervisor)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection, type Socket } from "node:net";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { extname, resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { IpcServer } from "../mcp/ipc.js";
import { JobManager } from "../tui/job-manager.js";
import { handleIpcRequest } from "../tui/ipc-handler.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// server.js lives at <pkg>/dist/src/web/. Package root is three up.
const PKG_ROOT = resolve(__dirname, "..", "..", "..");
const STATIC_DIR = resolve(__dirname, "static");
const SRC_STATIC_DIR = resolve(PKG_ROOT, "src", "web", "static");
const NODE_MODULES = resolve(PKG_ROOT, "node_modules");

interface Args {
  socketPath: string;
  cwd: string;
  port: number;
  ptyBridgePath: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  if (argv.length < 4) {
    console.error("Usage: server <ipc-socket> <cwd> <port> <pty-bridge-socket>");
    process.exit(1);
  }
  const [socketPath, cwd, portStr, ptyBridgePath] = argv;
  const port = parseInt(portStr, 10);
  if (Number.isNaN(port) || port < 0) {
    console.error(`Invalid port: ${portStr}`);
    process.exit(1);
  }
  return { socketPath, cwd, port, ptyBridgePath };
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

function enrichJobs(jobManager: JobManager): Array<Record<string, unknown>> {
  return jobManager.getJobs().map((info) => {
    const detail = jobManager.getJobDetail(info.id);
    const activeSteps = detail ? deriveActiveSteps(detail.output) : {};
    return { ...info, activeSteps };
  });
}

function deriveActiveSteps(output: string[]): Record<string, string> {
  const active: Record<string, string> = {};
  for (const line of output) {
    if (line.startsWith("{")) {
      try {
        const ev = JSON.parse(line) as { type?: string; step?: string; state?: string };
        if (ev.type === "step_status" && typeof ev.step === "string" && typeof ev.state === "string") {
          if (ev.state === "running") active[ev.step] = "running";
          else delete active[ev.step];
        } else if (ev.type === "workflow_start" || ev.type === "workflow_complete") {
          for (const k of Object.keys(active)) delete active[k];
        }
        continue;
      } catch { /* not JSON; fall through */ }
    }
    const m = line.match(/^\[(\S+)\] (running|succeeded|failed)/);
    if (m) {
      const [, step, state] = m;
      if (state === "running") active[step] = "running";
      else delete active[step];
    }
  }
  return active;
}

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

const APP_FILES = new Set(["index.html", "client.js", "style.css"]);
const VENDOR_FILES: Record<string, string> = {
  "xterm.css": join(NODE_MODULES, "@xterm", "xterm", "css", "xterm.css"),
  "xterm.mjs": join(NODE_MODULES, "@xterm", "xterm", "lib", "xterm.mjs"),
  "addon-fit.mjs": join(NODE_MODULES, "@xterm", "addon-fit", "lib", "addon-fit.mjs"),
};

function resolveStatic(name: string): string | null {
  const safe = name.replace(/^\/+/, "").replace(/\.\./g, "");
  if (APP_FILES.has(safe)) {
    const srcPath = join(SRC_STATIC_DIR, safe);
    if (existsSync(srcPath)) return srcPath;
    return join(STATIC_DIR, safe);
  }
  return VENDOR_FILES[safe] ?? null;
}

/**
 * Connects to the supervisor's PTY bridge. Abstracts the newline-delimited
 * JSON frame protocol so WS handlers just see `onData(bytes)` / `write(bytes)`.
 */
interface PtyBridge {
  // Latest snapshot (ring buffer replay) received from the supervisor.
  getSnapshot(): Buffer;
  // Stream of new bytes from the PTY.
  onData(cb: (chunk: Buffer) => void): void;
  // Write bytes into the PTY.
  write(bytes: Buffer): void;
  // Ask the PTY to resize.
  resize(cols: number, rows: number): void;
}

function connectPtyBridge(socketPath: string): Promise<PtyBridge> {
  return new Promise((resolve, reject) => {
    const sock: Socket = createConnection(socketPath);
    let snapshot = Buffer.alloc(0);
    const dataCbs: Array<(b: Buffer) => void> = [];
    let buf = "";
    let resolved = false;

    sock.setEncoding("utf-8");
    sock.on("data", (chunk) => {
      buf += chunk as unknown as string;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { type?: string; bytes?: string };
          if (msg.type === "snapshot" && typeof msg.bytes === "string") {
            snapshot = Buffer.from(msg.bytes, "base64");
            if (!resolved) { resolved = true; resolve(bridge); }
          } else if (msg.type === "pty_data" && typeof msg.bytes === "string") {
            if (!resolved) { resolved = true; resolve(bridge); }
            const b = Buffer.from(msg.bytes, "base64");
            for (const cb of dataCbs) cb(b);
          }
        } catch { /* ignore malformed line */ }
      }
    });
    sock.on("error", (err) => {
      if (!resolved) { resolved = true; reject(err); }
    });
    sock.on("close", () => {
      console.error("[sparkflow server] lost PTY bridge — supervisor gone; exiting");
      process.exit(0);
    });

    const bridge: PtyBridge = {
      getSnapshot: () => snapshot,
      onData: (cb) => { dataCbs.push(cb); },
      write: (bytes) => {
        sock.write(JSON.stringify({ type: "pty_write", bytes: bytes.toString("base64") }) + "\n");
      },
      resize: (cols, rows) => {
        sock.write(JSON.stringify({ type: "pty_resize", cols, rows }) + "\n");
      },
    };

    // If the supervisor sends no initial snapshot (empty ring on first connect),
    // resolve after a short grace period so startup isn't blocked indefinitely.
    setTimeout(() => {
      if (!resolved) { resolved = true; resolve(bridge); }
    }, 250);
  });
}

async function main(): Promise<void> {
  const args = parseArgs();
  const token = process.env.SPARKFLOW_WEB_TOKEN;
  if (!token || !/^[0-9a-f]{64}$/.test(token)) {
    console.error("[sparkflow server] missing or malformed SPARKFLOW_WEB_TOKEN env var");
    process.exit(1);
  }

  const jobManager = new JobManager(args.cwd);
  jobManager.rehydrate();

  try { unlinkSync(args.socketPath); } catch { /* not present */ }
  const ipcServer = new IpcServer(args.socketPath);
  ipcServer.onRequest((msg) => handleIpcRequest(msg, jobManager, args.cwd));
  await ipcServer.listen();

  const bridge = await connectPtyBridge(args.ptyBridgePath);

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    const pathname = url.split("?")[0];

    const cookieOk = getCookie(req, "sf_token") === token;
    const queryOk = getQueryToken(url) === token;
    if (!cookieOk && !queryOk) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("unauthorized");
      return;
    }
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
          res.write(`data: ${JSON.stringify({ jobs: enrichJobs(jobManager) })}\n\n`);
        } catch { /* client gone */ }
      };
      send();
      jobManager.onUpdate(send);
      const heartbeat = setInterval(() => {
        try { res.write(": ping\n\n"); } catch { /* ignore */ }
      }, 15000);
      req.on("close", () => clearInterval(heartbeat));
      return;
    }

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

    const removeMatch = pathname.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)\/remove$/);
    if (removeMatch && req.method === "POST") {
      const r = jobManager.removeJob(removeMatch[1]);
      return r.ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 400, { error: r.error ?? "remove failed" });
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").split("?")[0] !== "/chat" || !authorized(req, token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  // Fan PTY bytes out to all WS clients.
  bridge.onData((chunk) => {
    const payload = JSON.stringify({ type: "data", bytes: chunk.toString("base64") });
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  });

  wss.on("connection", (ws: WebSocket) => {
    const snap = bridge.getSnapshot();
    if (snap.length > 0) {
      ws.send(JSON.stringify({ type: "data", bytes: snap.toString("base64") }));
    }
    ws.on("message", (raw) => {
      let parsed: unknown;
      try { parsed = JSON.parse(raw.toString("utf-8")); } catch { return; }
      const msg = parsed as { type?: string; bytes?: string; cols?: number; rows?: number };
      if (msg.type === "data" && typeof msg.bytes === "string") {
        try { bridge.write(Buffer.from(msg.bytes, "base64")); } catch { /* ignore */ }
      } else if (msg.type === "resize" && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
        try { bridge.resize(Math.max(1, msg.cols!), Math.max(1, msg.rows!)); } catch { /* ignore */ }
      }
    });
  });

  server.listen(args.port, "127.0.0.1", () => {
    const address = server.address();
    const boundPort = typeof address === "object" && address ? address.port : args.port;
    process.stderr.write(
      `\n[sparkflow web] ready at http://127.0.0.1:${boundPort}/?token=${token}\n` +
      `[sparkflow web] press Ctrl-C to quit\n\n`,
    );
  });

  // SIGTERM/SIGHUP = supervisor requesting a hot-reload: detach from jobs and
  // let the detached sparkflow-run processes keep running. The next server
  // child will rehydrate them.
  // SIGINT (Ctrl-C) = user really quitting: kill running jobs and clear state.
  let exiting = false;
  function finishExit(code: number): void {
    ipcServer.close().finally(() => {
      server.close(() => process.exit(code));
      setTimeout(() => process.exit(code), 1000).unref();
    });
  }
  function onReload(): void {
    if (exiting) return;
    exiting = true;
    jobManager.release();
    finishExit(0);
  }
  function onQuit(): void {
    if (exiting) return;
    exiting = true;
    jobManager.killAll();
    finishExit(0);
  }
  process.on("SIGINT", onQuit);
  process.on("SIGTERM", onReload);
  process.on("SIGHUP", onReload);
}

main().catch((err) => {
  console.error("[sparkflow server] fatal:", err);
  process.exit(1);
});

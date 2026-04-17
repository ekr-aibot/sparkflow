#!/usr/bin/env node

/**
 * Web-mode supervisor (parent process). Persistent across hot-reloads.
 *
 * Owns the pieces that must survive a backend code change:
 *   - the claude PTY (so your in-flight chat isn't nuked when you edit a
 *     handler),
 *   - the ring buffer of recent PTY output (for browser-tab reconnects),
 *   - the auth token (so the cookie stays valid across restarts),
 *   - the PTY-bridge unix socket that the child connects to.
 *
 * Spawns src/web/server.js as a child process — that's where HTTP / WS /
 * SSE / JobManager / static serving lives. In --dev mode (SPARKFLOW_WEB_DEV=1)
 * we watch dist/src/web/ and kill the child whenever a file changes; an
 * `exit` handler respawns it.
 *
 * Invocation (from src/tui/index.ts): index <ipc-socket> <cwd> <port> <chat-cmd> [chat-args...]
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { mkdtempSync, unlinkSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawn as ptySpawn, type IPty } from "node-pty";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SERVER_ENTRY = resolve(__dirname, "server.js");
const WATCH_DIR = resolve(__dirname); // dist/src/web/

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
    console.error("Usage: index <ipc-socket> <cwd> <port> <chat-cmd> [chat-args...]");
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

/**
 * Pick a free port on 127.0.0.1 and return it, so the server child can be
 * respawned with a fixed port across reloads (browser cookie is scoped to
 * host:port, so a shifting port would force the user to re-auth every time).
 */
function pickPort(preferred: number): Promise<number> {
  if (preferred > 0) return Promise.resolve(preferred);
  return new Promise<number>((res, rej) => {
    const s = createNetServer();
    s.once("error", rej);
    s.listen({ host: "127.0.0.1", port: 0 }, () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => res(port));
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs();
  const dev = process.env.SPARKFLOW_WEB_DEV === "1";
  const token = randomBytes(32).toString("hex");
  const pinnedPort = await pickPort(args.port);

  // Temp dir for our unix sockets.
  const workDir = mkdtempSync(join(tmpdir(), "sparkflow-web-"));
  const ptyBridgePath = join(workDir, "pty.sock");

  // --- Spawn claude PTY (persistent). -----------------------------------
  const pty: IPty = ptySpawn(args.chatCmd, args.chatArgs, {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd: args.cwd,
    env: process.env as Record<string, string>,
  });

  let ring = Buffer.alloc(0);
  const ptyClients = new Set<Socket>();

  pty.onData((data) => {
    const chunk = Buffer.from(data, "utf-8");
    ring = ring.length + chunk.length <= RING_BUFFER_BYTES
      ? Buffer.concat([ring, chunk])
      : Buffer.concat([ring.subarray(ring.length + chunk.length - RING_BUFFER_BYTES), chunk]);
    const frame = JSON.stringify({ type: "pty_data", bytes: chunk.toString("base64") }) + "\n";
    for (const c of ptyClients) {
      try { c.write(frame); } catch { /* ignore */ }
    }
  });

  pty.onExit(({ exitCode }) => {
    console.error(`[sparkflow web] chat process exited (code=${exitCode}); shutting down`);
    // Treat the PTY dying like a user quit: tear down running workflows too.
    shutdown(0, "SIGINT");
  });

  // --- PTY bridge unix socket. Child reconnects here after each restart. --
  const bridgeServer: NetServer = createNetServer((sock) => {
    ptyClients.add(sock);
    sock.setEncoding("utf-8");
    // Replay the ring buffer so the child can forward it to reconnecting tabs.
    if (ring.length > 0) {
      sock.write(JSON.stringify({ type: "snapshot", bytes: ring.toString("base64") }) + "\n");
    }
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk as unknown as string;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { type?: string; bytes?: string; cols?: number; rows?: number };
          if (msg.type === "pty_write" && typeof msg.bytes === "string") {
            pty.write(Buffer.from(msg.bytes, "base64").toString("utf-8"));
          } else if (msg.type === "pty_resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
            pty.resize(Math.max(1, msg.cols), Math.max(1, msg.rows));
          }
        } catch { /* ignore bad frame */ }
      }
    });
    sock.on("close", () => ptyClients.delete(sock));
    sock.on("error", () => { ptyClients.delete(sock); });
  });

  try { unlinkSync(ptyBridgePath); } catch { /* not present */ }
  await new Promise<void>((res) => bridgeServer.listen(ptyBridgePath, () => res()));

  // --- Spawn and supervise the server child. ------------------------------
  let child: ChildProcess | null = null;
  let respawnTimer: NodeJS.Timeout | null = null;
  let shuttingDown = false;
  let consecutiveCrashes = 0;
  let lastSpawnAt = 0;

  function spawnChild(): void {
    lastSpawnAt = Date.now();
    child = spawn(
      process.execPath,
      [SERVER_ENTRY, args.socketPath, args.cwd, String(pinnedPort), ptyBridgePath],
      {
        cwd: args.cwd,
        stdio: "inherit",
        env: { ...process.env, SPARKFLOW_WEB_TOKEN: token },
      },
    );
    child.on("exit", (code, signal) => {
      if (shuttingDown) return;
      if (!dev) {
        // Server child exited on its own (not supervisor-initiated). Tear
        // everything down. No child to signal — it's already gone.
        shutdownSelf(code ?? 0);
        return;
      }
      // Dev mode: respawn. Exponential backoff if the child keeps crashing
      // within a second of starting (usually means a syntax error the user
      // hasn't fixed yet).
      const lifespan = Date.now() - lastSpawnAt;
      consecutiveCrashes = lifespan < 1000 ? consecutiveCrashes + 1 : 0;
      const delay = Math.min(2000, 100 * Math.pow(2, Math.max(0, consecutiveCrashes - 1)));
      if (signal !== "SIGTERM" && signal !== "SIGINT") {
        console.error(`[sparkflow web] server child exited (code=${code}, signal=${signal}); respawning in ${delay}ms…`);
      }
      setTimeout(() => { if (!shuttingDown) spawnChild(); }, delay).unref();
    });
  }
  spawnChild();

  // --- Dev watcher: kill the child on any .js change under dist/src/web/. -
  let watcher: FSWatcher | null = null;
  if (dev) {
    try {
      watcher = fsWatch(WATCH_DIR, { recursive: true }, (_evt, filename) => {
        if (!filename || typeof filename !== "string") return;
        if (!filename.endsWith(".js")) return;
        // Don't restart on changes to our own code — re-running the supervisor
        // is the user's job. Only server-side changes trigger a respawn.
        if (filename === "index.js") return;
        if (respawnTimer) clearTimeout(respawnTimer);
        respawnTimer = setTimeout(() => {
          if (!child || shuttingDown) return;
          console.error(`[sparkflow web] detected change in ${filename} — restarting server…`);
          try { child.kill("SIGTERM"); } catch { /* already gone */ }
        }, 80);
      });
      console.error(`[sparkflow web] dev mode: watching ${WATCH_DIR} for changes`);
    } catch (err) {
      console.error(`[sparkflow web] failed to start dev watcher: ${(err as Error).message}`);
    }
  }

  // --- Lifecycle. ---------------------------------------------------------
  function closeSupervisorResources(): void {
    if (watcher) { try { watcher.close(); } catch { /* ignore */ } }
    try { pty.kill(); } catch { /* ignore */ }
    try { bridgeServer.close(); } catch { /* ignore */ }
    try { unlinkSync(ptyBridgePath); } catch { /* ignore */ }
  }

  // Relay the received signal to the server child so it can decide whether
  // to kill running jobs (SIGINT = user really quit) or just release them
  // (SIGTERM/SIGHUP = external shutdown; detached sparkflow-run processes
  // keep going, the next supervisor launch rehydrates them).
  function shutdown(code: number, signal: "SIGINT" | "SIGTERM"): void {
    if (shuttingDown) return;
    shuttingDown = true;
    closeSupervisorResources();
    if (child) { try { child.kill(signal); } catch { /* ignore */ } }
    // Give the child a moment to flush state / kill jobs before we exit.
    setTimeout(() => process.exit(code), 500).unref();
  }

  // Used when the server child died on its own (not via supervisor signal).
  function shutdownSelf(code: number): void {
    if (shuttingDown) return;
    shuttingDown = true;
    closeSupervisorResources();
    setTimeout(() => process.exit(code), 150).unref();
  }

  process.on("SIGINT", () => shutdown(0, "SIGINT"));
  process.on("SIGTERM", () => shutdown(0, "SIGTERM"));
  process.on("SIGHUP", () => shutdown(0, "SIGTERM"));
}

main().catch((err) => {
  console.error("[sparkflow web] fatal:", err);
  process.exit(1);
});

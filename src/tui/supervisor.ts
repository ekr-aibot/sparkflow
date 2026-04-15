#!/usr/bin/env node

/**
 * Dev-mode supervisor: wraps status-display, watches dist/ for changes,
 * and respawns the child on rebuild. In-flight jobs survive because they're
 * spawned detached and their state is persisted.
 *
 * Invocation mirrors status-display: <socket-path> [cwd] [tmux-session]
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const STATUS_DISPLAY = resolve(__dirname, "status-display.js");
// supervisor.js lives at <pkg>/dist/src/tui/; dist/ is two up, pkg root is three up.
const DIST_DIR = resolve(__dirname, "..", "..");
const PKG_ROOT = resolve(DIST_DIR, "..");
const WATCH_DIR = DIST_DIR;
const TSC_BIN = resolve(PKG_ROOT, "node_modules", ".bin", "tsc");
const DEBOUNCE_MS = 200;
const SHUTDOWN_GRACE_MS = 3000;

function log(msg: string): void {
  // Write above the status pane render area with CR to avoid interfering.
  process.stderr.write(`[supervisor] ${msg}\n`);
}

async function waitForExit(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  return new Promise((res) => {
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, graceMs);
    child.once("exit", () => {
      clearTimeout(timer);
      res();
    });
  });
}

function startTscWatch(tmuxSession: string | undefined): ChildProcess | null {
  // Only run tsc if we can find it and a tsconfig exists at pkg root
  // (i.e. sparkflow was installed from source, not as a published package).
  if (!existsSync(TSC_BIN) || !existsSync(resolve(PKG_ROOT, "tsconfig.json"))) {
    log(`tsc not found at ${TSC_BIN} — run 'npx tsc --watch' in another terminal`);
    return null;
  }

  // Prefer a dedicated tmux window so tsc output doesn't clobber the status pane.
  // Fall back to spawning tsc attached to supervisor stderr if tmux isn't available.
  if (tmuxSession) {
    try {
      execFileSync("tmux", [
        "new-window", "-d",
        "-t", tmuxSession,
        "-n", "tsc",
        "sh", "-c", `cd ${shellQuote(PKG_ROOT)} && exec ${shellQuote(TSC_BIN)} --watch --preserveWatchOutput`,
      ], { stdio: "pipe" });
      log(`tsc --watch running in tmux window 'tsc' (Ctrl-b w to view)`);
      return null; // tmux owns the process lifecycle
    } catch (err) {
      log(`failed to open tsc tmux window: ${(err as Error).message}`);
    }
  }

  // Fallback: spawn attached. Output goes to supervisor stderr.
  const tsc = spawn(TSC_BIN, ["--watch", "--preserveWatchOutput"], {
    cwd: PKG_ROOT,
    stdio: ["ignore", "inherit", "inherit"],
  });
  tsc.on("exit", (code, signal) => {
    log(`tsc --watch exited (code=${code} signal=${signal})`);
  });
  return tsc;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

async function main(): Promise<void> {
  const childArgs = process.argv.slice(2);
  const tmuxSession = childArgs[2];

  let child: ChildProcess | null = null;
  let tscChild: ChildProcess | null = null;
  let shuttingDown = false;
  let restartPending = false;
  let restarting = false;

  // Kick off TypeScript watcher so source edits auto-rebuild.
  tscChild = startTscWatch(tmuxSession);

  const spawnChild = (): ChildProcess => {
    const c = spawn(process.execPath, [STATUS_DISPLAY, ...childArgs], {
      stdio: "inherit",
      env: process.env,
    });
    c.on("exit", (code, signal) => {
      if (shuttingDown) return;
      // If we didn't ask for a restart and the child exited cleanly, exit too.
      if (!restarting) {
        log(`child exited (code=${code} signal=${signal}), supervisor exiting`);
        process.exit(code ?? 0);
      }
    });
    return c;
  };

  const restart = async () => {
    if (restarting || shuttingDown) {
      restartPending = true;
      return;
    }
    restarting = true;
    log("change detected → reloading status-display");
    if (child) {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      await waitForExit(child, SHUTDOWN_GRACE_MS);
    }
    child = spawnChild();
    restarting = false;
    if (restartPending) {
      restartPending = false;
      restart();
    }
  };

  let debounce: NodeJS.Timeout | null = null;
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(WATCH_DIR, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      if (!String(filename).endsWith(".js")) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => restart(), DEBOUNCE_MS);
    });
  } catch (err) {
    log(`fs.watch failed, hot-reload disabled: ${(err as Error).message}`);
  }

  // Forward quit signals to the child.
  const forwardAndExit = (sig: NodeJS.Signals) => {
    shuttingDown = true;
    if (watcher) try { watcher.close(); } catch { /* ignore */ }
    if (child) try { child.kill(sig); } catch { /* ignore */ }
    if (tscChild) try { tscChild.kill("SIGTERM"); } catch { /* ignore */ }
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
  };
  process.on("SIGINT", () => forwardAndExit("SIGINT"));
  process.on("SIGHUP", () => forwardAndExit("SIGHUP"));
  // SIGTERM on supervisor means the *whole session* is quitting, not a reload.
  process.on("SIGTERM", () => forwardAndExit("SIGINT"));

  child = spawnChild();
}

main().catch((err) => {
  console.error("[supervisor] fatal:", err);
  process.exit(1);
});

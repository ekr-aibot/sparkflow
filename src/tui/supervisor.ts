#!/usr/bin/env node

/**
 * Dev-mode supervisor: wraps status-display, watches dist/ for changes,
 * and respawns the child on rebuild. In-flight jobs survive because they're
 * spawned detached and their state is persisted.
 *
 * Invocation mirrors status-display: <socket-path> [cwd] [tmux-session]
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const STATUS_DISPLAY = resolve(__dirname, "status-display.js");
// supervisor.js lives at <pkg>/dist/src/tui/; dist/ is two up, pkg root is three up.
const DIST_DIR = resolve(__dirname, "..", "..");
const PKG_ROOT = resolve(DIST_DIR, "..");
const DOC_DIR = resolve(PKG_ROOT, "doc");
const WATCH_DIR = DIST_DIR;
const TSC_BIN = resolve(PKG_ROOT, "node_modules", ".bin", "tsc");
const DEBOUNCE_MS = 200;
const SHUTDOWN_GRACE_MS = 3000;

type DocSnapshot = Map<string, string>;

function readDocDir(): DocSnapshot {
  const snapshot: DocSnapshot = new Map();
  if (!existsSync(DOC_DIR)) return snapshot;
  const walk = (abs: string) => {
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(abs, entry);
      let s;
      try { s = statSync(full); } catch { continue; }
      if (s.isDirectory()) {
        walk(full);
      } else if (s.isFile()) {
        try {
          const rel = relative(DOC_DIR, full);
          snapshot.set(rel, readFileSync(full, "utf-8"));
        } catch {
          // Unreadable file — skip.
        }
      }
    }
  };
  walk(DOC_DIR);
  return snapshot;
}

function lineDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const out: string[] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      out.push(`  ${a[i - 1]}`);
      i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      out.push(`- ${a[i - 1]}`);
      i--;
    } else {
      out.push(`+ ${b[j - 1]}`);
      j--;
    }
  }
  while (i > 0) { out.push(`- ${a[i - 1]}`); i--; }
  while (j > 0) { out.push(`+ ${b[j - 1]}`); j--; }
  return out.reverse().join("\n");
}

function buildDocDiff(prev: DocSnapshot, next: DocSnapshot): { changed: string[]; markdown: string } {
  const changed: string[] = [];
  const sections: string[] = [];
  const allKeys = new Set<string>([...prev.keys(), ...next.keys()]);
  for (const key of [...allKeys].sort()) {
    const before = prev.get(key);
    const after = next.get(key);
    if (before === after) continue;
    changed.push(key);
    if (before === undefined) {
      sections.push(`### ${key} (added)\n\n\`\`\`\n${after}\n\`\`\``);
    } else if (after === undefined) {
      sections.push(`### ${key} (removed)\n\nFile was deleted.`);
    } else {
      sections.push(`### ${key} (changed)\n\n\`\`\`diff\n${lineDiff(before, after)}\n\`\`\``);
    }
  }
  return { changed, markdown: sections.join("\n\n") };
}

function writeReloadNotice(cwd: string, prev: DocSnapshot, next: DocSnapshot): void {
  const stateDir = join(cwd, ".sparkflow", "state");
  try {
    mkdirSync(stateDir, { recursive: true });
  } catch {
    return;
  }
  const { changed, markdown } = buildDocDiff(prev, next);
  const ts = new Date().toISOString();
  const header = changed.length === 0
    ? `# sparkflow reloaded at ${ts}\n\nNo documentation changes.\n`
    : `# sparkflow reloaded at ${ts}\n\nDocumentation files changed: ${changed.join(", ")}\n\n${markdown}\n`;
  try {
    writeFileSync(join(stateDir, "reload-doc-diff.md"), header);
  } catch { /* ignore */ }
  try {
    const record = JSON.stringify({ ts, changedDocs: changed }) + "\n";
    appendFileSync(join(stateDir, "reload-log.jsonl"), record);
  } catch { /* ignore */ }
}

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
  const supervisedCwd = childArgs[1] ?? process.cwd();
  const tmuxSession = childArgs[2];

  let child: ChildProcess | null = null;
  let tscChild: ChildProcess | null = null;
  let shuttingDown = false;
  let restartPending = false;
  let restarting = false;
  let docSnapshot: DocSnapshot = readDocDir();

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
    // Compute doc diff between the snapshot we have and current doc/ contents,
    // so the MCP bridge can inject "what changed" into Claude's next response.
    const nextDocs = readDocDir();
    writeReloadNotice(supervisedCwd, docSnapshot, nextDocs);
    docSnapshot = nextDocs;
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

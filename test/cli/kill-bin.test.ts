import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { PersistedJob } from "../../src/tui/state-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../..");
const KILL_BIN = join(REPO_ROOT, "dist/src/cli/kill-bin.js");

function spawnLongLived(ignoreSigterm = false): ChildProcess {
  const code = ignoreSigterm
    ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
    : "setInterval(() => {}, 1000);";
  return spawn(process.execPath, ["-e", code], { stdio: "ignore", detached: false });
}

function writeJobFile(cwd: string, id: string, pid: number): void {
  const dir = join(cwd, ".sparkflow", "state", "jobs");
  mkdirSync(dir, { recursive: true });
  const job: PersistedJob = {
    info: {
      id,
      workflowPath: "/nonexistent/wf.json",
      workflowName: "test",
      state: "running",
      summary: "",
      startTime: Date.now(),
    },
    pid,
    logPath: join(cwd, ".sparkflow", "logs", `${id}.log`),
    logOffset: 0,
  };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(job, null, 2));
}

function writeDashboardJson(sparkflowHome: string, pid: number): void {
  mkdirSync(sparkflowHome, { recursive: true });
  const info = {
    socketPath: join(sparkflowHome, "dashboard.sock"),
    port: 19998,
    token: "testtoken",
    pid,
    version: "0.1.0",
    startedAt: Date.now(),
  };
  writeFileSync(join(sparkflowHome, "dashboard.json"), JSON.stringify(info, null, 2));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

// Use async spawn so the event loop remains live — if we block with spawnSync,
// child-process zombies never get reaped and isAlive() always returns true.
async function runBin(
  args: string[],
  env?: Record<string, string>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [KILL_BIN, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("runBin timed out after 15s"));
    }, 15000);
    proc.once("exit", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    proc.once("error", reject);
  });
}

describe("sparkflow-kill binary", () => {
  let tmpDir: string;
  let children: ChildProcess[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sparkflow-killbin-"));
    children = [];
  });

  afterEach(async () => {
    for (const c of children) {
      try {
        if (c.pid && isAlive(c.pid)) c.kill("SIGKILL");
      } catch { /* ignore */ }
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("exits 0 with 'no running' message when nothing is running", async () => {
    const { status, stdout } = await runBin(["--cwd", tmpDir]);
    expect(status).toBe(0);
    expect(stdout).toContain("No running Sparkflow");
  });

  it("kills a running job, exits 0", async () => {
    const child = spawnLongLived();
    children.push(child);
    expect(child.pid).toBeGreaterThan(0);
    writeJobFile(tmpDir, "bintest00001", child.pid!);

    const { status, stdout } = await runBin(["--cwd", tmpDir]);
    expect(status).toBe(0);
    expect(stdout).toContain("Terminated gracefully: 1");
    expect(await waitDead(child.pid!)).toBe(true);
  });

  it("kills frontend daemon with --all", async () => {
    const sparkflowHome = mkdtempSync(join(tmpdir(), "sparkflow-home-"));
    try {
      const child = spawnLongLived();
      children.push(child);
      expect(child.pid).toBeGreaterThan(0);
      writeDashboardJson(sparkflowHome, child.pid!);

      const { status, stdout } = await runBin(["--cwd", tmpDir, "--all"], {
        SPARKFLOW_HOME: sparkflowHome,
      });
      expect(status).toBe(0);
      expect(stdout).toContain("frontend daemon");
      expect(await waitDead(child.pid!)).toBe(true);
    } finally {
      try { rmSync(sparkflowHome, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("--help prints usage and exits 0", async () => {
    const { status, stdout } = await runBin(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("Usage: sparkflow-kill");
    expect(stdout).toContain("--all");
    expect(stdout).toContain("--force");
  });

  it("unknown flag exits non-zero", async () => {
    const { status, stderr } = await runBin(["--unknown-flag"]);
    expect(status).not.toBe(0);
    expect(stderr).toContain("Unknown flag");
  });
});

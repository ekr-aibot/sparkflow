import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runKillAll, formatSummary } from "../../src/cli/kill-all.js";
import type { PersistedJob } from "../../src/tui/state-store.js";

function spawnLongLived(ignoreSigterm = false): ChildProcess {
  // A tiny node process that stays alive until killed.
  const code = ignoreSigterm
    ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
    : "setInterval(() => {}, 1000);";
  return spawn(process.execPath, ["-e", code], {
    stdio: "ignore",
    detached: false,
  });
}

function writeJobFile(
  cwd: string,
  id: string,
  pid: number,
  state: PersistedJob["info"]["state"] = "running",
): void {
  const dir = join(cwd, ".sparkflow", "state", "jobs");
  mkdirSync(dir, { recursive: true });
  const job: PersistedJob = {
    info: {
      id,
      workflowPath: "/nonexistent/wf.json",
      workflowName: "test",
      state,
      summary: "",
      startTime: Date.now(),
    },
    pid,
    logPath: join(cwd, ".sparkflow", "logs", `${id}.log`),
    logOffset: 0,
  };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(job, null, 2));
}

function writeEnginePidFile(cwd: string, pid: number): void {
  const dir = join(cwd, ".sparkflow", "state");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "engine-daemon.pid"), String(pid));
}

function writeDashboardJson(sparkflowHome: string, pid: number): void {
  mkdirSync(sparkflowHome, { recursive: true });
  const info = {
    socketPath: join(sparkflowHome, "dashboard.sock"),
    port: 19999,
    token: "testtoken",
    pid,
    version: "0.1.0",
    startedAt: Date.now(),
  };
  writeFileSync(join(sparkflowHome, "dashboard.json"), JSON.stringify(info, null, 2));
}

function writeDashboardLock(sparkflowHome: string, pid: number): void {
  writeFileSync(join(sparkflowHome, "dashboard.lock"), String(pid));
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

describe("runKillAll", () => {
  let tmpDir: string;
  let children: ChildProcess[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sparkflow-killall-"));
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

  it("returns zero totals when no state dir exists", async () => {
    const summary = await runKillAll({ cwd: tmpDir, force: false });
    expect(summary).toMatchObject({
      total: 0,
      signalled: 0,
      terminated: 0,
      forceKilled: 0,
      stillAlive: 0,
      errors: [],
      jobsKilled: 0,
      engineDaemonKilled: false,
      frontendDaemonKilled: false,
    });
  });

  it("skips terminal jobs (succeeded/failed) in state files", async () => {
    writeJobFile(tmpDir, "aaaaaaaaaaaa", 99999, "succeeded");
    writeJobFile(tmpDir, "bbbbbbbbbbbb", 99998, "failed");
    const summary = await runKillAll({ cwd: tmpDir, force: false });
    expect(summary.total).toBe(0);
  });

  it("skips state files whose pid is already dead", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await new Promise<void>((r) => child.once("exit", () => r()));
    writeJobFile(tmpDir, "deaddeaddead", child.pid ?? 1, "running");
    const summary = await runKillAll({ cwd: tmpDir, force: false });
    expect(summary.total).toBe(0);
  });

  it("SIGTERMs a running job and reports it terminated", async () => {
    const child = spawnLongLived();
    children.push(child);
    expect(child.pid).toBeGreaterThan(0);
    writeJobFile(tmpDir, "live00000001", child.pid!);

    const summary = await runKillAll({ cwd: tmpDir, force: false, timeoutMs: 2000 });
    expect(summary.total).toBe(1);
    expect(summary.signalled).toBe(1);
    expect(summary.terminated).toBe(1);
    expect(summary.forceKilled).toBe(0);
    expect(summary.stillAlive).toBe(0);
    expect(summary.errors).toEqual([]);
    expect(summary.jobsKilled).toBe(1);
    expect(summary.engineDaemonKilled).toBe(false);
    expect(await waitDead(child.pid!)).toBe(true);
  });

  it("without --force reports a SIGTERM-ignoring job as still alive", async () => {
    const child = spawnLongLived(true);
    children.push(child);
    // Give Node time to install the SIGTERM handler before we signal.
    await new Promise((r) => setTimeout(r, 200));
    writeJobFile(tmpDir, "stubborn0001", child.pid!);

    const summary = await runKillAll({ cwd: tmpDir, force: false, timeoutMs: 400 });
    expect(summary.total).toBe(1);
    expect(summary.terminated).toBe(0);
    expect(summary.stillAlive).toBe(1);
    expect(isAlive(child.pid!)).toBe(true);
  });

  it("with --force escalates to SIGKILL for a SIGTERM-ignoring job", async () => {
    const child = spawnLongLived(true);
    children.push(child);
    await new Promise((r) => setTimeout(r, 200));
    writeJobFile(tmpDir, "stubborn0002", child.pid!);

    const summary = await runKillAll({ cwd: tmpDir, force: true, timeoutMs: 400 });
    expect(summary.total).toBe(1);
    expect(summary.forceKilled).toBe(1);
    expect(summary.stillAlive).toBe(0);
    expect(await waitDead(child.pid!)).toBe(true);
  });

  it("kills multiple jobs in parallel", async () => {
    const a = spawnLongLived();
    const b = spawnLongLived();
    const c = spawnLongLived();
    children.push(a, b, c);
    writeJobFile(tmpDir, "multi0000001", a.pid!);
    writeJobFile(tmpDir, "multi0000002", b.pid!);
    writeJobFile(tmpDir, "multi0000003", c.pid!);

    const summary = await runKillAll({ cwd: tmpDir, force: false, timeoutMs: 2000 });
    expect(summary.total).toBe(3);
    expect(summary.terminated).toBe(3);
    expect(summary.stillAlive).toBe(0);
  });

  describe("engine daemon PID file", () => {
    it("SIGTERMs engine daemon from PID file and removes file on exit", async () => {
      const child = spawnLongLived();
      children.push(child);
      expect(child.pid).toBeGreaterThan(0);
      writeEnginePidFile(tmpDir, child.pid!);

      const summary = await runKillAll({ cwd: tmpDir, force: false, timeoutMs: 2000 });
      expect(summary.total).toBe(1);
      expect(summary.engineDaemonKilled).toBe(true);
      expect(summary.terminated).toBe(1);
      expect(summary.stillAlive).toBe(0);
      expect(await waitDead(child.pid!)).toBe(true);
      // PID file should be removed after daemon exits.
      expect(existsSync(join(tmpDir, ".sparkflow", "state", "engine-daemon.pid"))).toBe(false);
    });

    it("with --force, SIGKILLs SIGTERM-ignoring engine daemon", async () => {
      const child = spawnLongLived(true);
      children.push(child);
      await new Promise((r) => setTimeout(r, 200));
      writeEnginePidFile(tmpDir, child.pid!);

      const summary = await runKillAll({ cwd: tmpDir, force: true, timeoutMs: 400 });
      expect(summary.engineDaemonKilled).toBe(true);
      expect(summary.forceKilled).toBe(1);
      expect(summary.stillAlive).toBe(0);
      expect(await waitDead(child.pid!)).toBe(true);
      expect(existsSync(join(tmpDir, ".sparkflow", "state", "engine-daemon.pid"))).toBe(false);
    });

    it("skips stale engine PID file (dead pid) and leaves file untouched", async () => {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
      await new Promise<void>((r) => child.once("exit", () => r()));
      writeEnginePidFile(tmpDir, child.pid!);

      const summary = await runKillAll({ cwd: tmpDir, force: false, timeoutMs: 400 });
      expect(summary.total).toBe(0);
      expect(summary.engineDaemonKilled).toBe(false);
      // PID file left alone for stale entry.
      expect(existsSync(join(tmpDir, ".sparkflow", "state", "engine-daemon.pid"))).toBe(true);
    });
  });

  describe("frontend daemon (--all)", () => {
    let sparkflowHome: string;

    beforeEach(() => {
      sparkflowHome = mkdtempSync(join(tmpdir(), "sparkflow-home-"));
      process.env.SPARKFLOW_HOME = sparkflowHome;
    });

    afterEach(() => {
      delete process.env.SPARKFLOW_HOME;
      try { rmSync(sparkflowHome, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it("kills frontend daemon with --all and cleans up dashboard.lock", async () => {
      const child = spawnLongLived();
      children.push(child);
      expect(child.pid).toBeGreaterThan(0);
      writeDashboardJson(sparkflowHome, child.pid!);
      writeDashboardLock(sparkflowHome, child.pid!);

      const summary = await runKillAll({ cwd: tmpDir, force: false, all: true, timeoutMs: 2000 });
      expect(summary.frontendDaemonKilled).toBe(true);
      expect(summary.terminated).toBe(1);
      expect(summary.stillAlive).toBe(0);
      expect(await waitDead(child.pid!)).toBe(true);
      // Lock should be removed after killing.
      expect(existsSync(join(sparkflowHome, "dashboard.lock"))).toBe(false);
    });

    it("leaves frontend alive and dashboard.json untouched without --all", async () => {
      const child = spawnLongLived();
      children.push(child);
      writeDashboardJson(sparkflowHome, child.pid!);

      const summary = await runKillAll({ cwd: tmpDir, force: false, all: false, timeoutMs: 400 });
      expect(summary.frontendDaemonKilled).toBe(false);
      expect(summary.total).toBe(0);
      // Frontend process should still be alive.
      expect(isAlive(child.pid!)).toBe(true);
      // dashboard.json must be untouched.
      expect(existsSync(join(sparkflowHome, "dashboard.json"))).toBe(true);
    });

    it("skips silently when dashboard.json does not exist with --all", async () => {
      const summary = await runKillAll({ cwd: tmpDir, force: false, all: true, timeoutMs: 400 });
      expect(summary.total).toBe(0);
      expect(summary.frontendDaemonKilled).toBe(false);
    });
  });
});

describe("formatSummary", () => {
  const base = {
    total: 0,
    signalled: 0,
    terminated: 0,
    forceKilled: 0,
    stillAlive: 0,
    errors: [] as Array<{ jobId: string; pid: number; error: string }>,
    jobsKilled: 0,
    engineDaemonKilled: false as boolean,
    frontendDaemonKilled: false as boolean,
  };

  it("says nothing found when total is 0", () => {
    const out = formatSummary(base, false);
    expect(out).toBe("No running Sparkflow jobs or daemons found.");
  });

  it("reports still-alive count without --force", () => {
    const out = formatSummary(
      { ...base, total: 2, signalled: 2, terminated: 1, stillAlive: 1, jobsKilled: 1 },
      false,
    );
    expect(out).toContain("Still alive: 1");
    expect(out).toContain("--force");
  });

  it("reports force-killed count with --force", () => {
    const out = formatSummary(
      { ...base, total: 3, signalled: 3, terminated: 3, forceKilled: 1, jobsKilled: 3 },
      true,
    );
    expect(out).toContain("Force-killed: 1");
  });

  it("includes engine daemon in found description", () => {
    const out = formatSummary(
      {
        ...base,
        total: 4,
        signalled: 4,
        terminated: 4,
        jobsKilled: 3,
        engineDaemonKilled: true,
      },
      false,
    );
    expect(out).toContain("engine daemon");
    expect(out).toContain("3 running jobs");
  });

  it("includes frontend daemon in found description with --all", () => {
    const out = formatSummary(
      {
        ...base,
        total: 5,
        signalled: 5,
        terminated: 5,
        jobsKilled: 3,
        engineDaemonKilled: true,
        frontendDaemonKilled: true,
      },
      false,
    );
    expect(out).toContain("frontend daemon");
    expect(out).toContain("engine daemon");
  });
});

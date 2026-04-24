import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    expect(summary).toEqual({
      total: 0,
      signalled: 0,
      terminated: 0,
      forceKilled: 0,
      stillAlive: 0,
      errors: [],
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
});

describe("formatSummary", () => {
  it("says nothing found when total is 0", () => {
    const out = formatSummary(
      { total: 0, signalled: 0, terminated: 0, forceKilled: 0, stillAlive: 0, errors: [] },
      false,
    );
    expect(out).toBe("No running Sparkflow jobs found.");
  });

  it("reports still-alive count without --force", () => {
    const out = formatSummary(
      { total: 2, signalled: 2, terminated: 1, forceKilled: 0, stillAlive: 1, errors: [] },
      false,
    );
    expect(out).toContain("Still alive: 1");
    expect(out).toContain("--force");
  });

  it("reports force-killed count with --force", () => {
    const out = formatSummary(
      { total: 3, signalled: 3, terminated: 3, forceKilled: 1, stillAlive: 0, errors: [] },
      true,
    );
    expect(out).toContain("Force-killed: 1");
  });
});

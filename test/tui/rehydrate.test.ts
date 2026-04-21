import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, appendFileSync, mkdirSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JobManager } from "../../src/tui/job-manager.js";
import { StateStore } from "../../src/tui/state-store.js";

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("JobManager.rehydrate", () => {
  let tmpDir: string;
  let child: ChildProcess | null = null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sparkflow-rh-"));
  });

  afterEach(() => {
    if (child && !child.killed) {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("rehydrates a live job by pid and picks up new log lines from the saved offset", async () => {
    // Simulate a detached running job via `sleep 5`.
    child = spawn("sleep", ["5"], { detached: true, stdio: "ignore" });
    const pid = child.pid!;
    expect(pid).toBeGreaterThan(0);

    // Write an existing log file with a known byte offset.
    const logDir = join(tmpDir, ".sparkflow", "logs");
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, "job-test.log");
    const priorLine = "[stepA] running (claude-code)\n";
    appendFileSync(logPath, priorLine);

    // Persist the job as if a prior daemon had saved it with logOffset = end of priorLine.
    const store = new StateStore(tmpDir);
    store.saveJob({
      info: {
        id: "test",
        workflowPath: "/tmp/wf.json",
        workflowName: "wf",
        state: "running",
        summary: "rehydrating",
        startTime: Date.now() - 1000,
      },
      pid,
      logPath,
      logOffset: Buffer.byteLength(priorLine, "utf-8"),
    });

    // New daemon boots and rehydrates.
    const manager = new JobManager(tmpDir);
    manager.rehydrate();

    const jobs = manager.getJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe("test");
    expect(jobs[0].state).toBe("running");

    // Append a new line; the tailer should parse it and update state.
    appendFileSync(logPath, "[stepB] succeeded (shell)\n");
    await waitFor(() => manager.getJobs()[0].currentStep === "stepB");
    expect(manager.getJobs()[0].stepState).toBe("succeeded");

    manager.release();
  });

  it("persists and restores originalPlan/originalPlanText/originalCwd so restartJob works after a daemon reload", () => {
    const logDir = join(tmpDir, ".sparkflow", "logs");
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, "job-rst.log");
    appendFileSync(logPath, "");

    const store = new StateStore(tmpDir);
    store.saveJob({
      info: {
        id: "rst",
        workflowPath: "/tmp/wf.json",
        workflowName: "wf",
        state: "failed",
        summary: "exit 1",
        startTime: Date.now() - 1000,
        endTime: Date.now(),
      },
      pid: 2_000_000,
      logPath,
      logOffset: 0,
      originalCwd: "/tmp/project",
      originalPlan: "/tmp/plan.md",
      originalPlanText: "Step 1: do a thing\nStep 2: do another thing",
    });

    const reloaded = store.loadJobs();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].originalCwd).toBe("/tmp/project");
    expect(reloaded[0].originalPlan).toBe("/tmp/plan.md");
    expect(reloaded[0].originalPlanText).toContain("Step 1");
  });

  it("drops terminal monitor jobs even when the persisted pid still looks alive (recycled pid)", () => {
    const logDir = join(tmpDir, ".sparkflow", "logs");
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, "job-stale.log");
    appendFileSync(logPath, "");

    const store = new StateStore(tmpDir);
    store.saveJob({
      info: {
        id: "stale",
        workflowPath: "/tmp/wf.json",
        workflowName: "wf",
        kind: "monitor",
        state: "failed",
        summary: "exit code null",
        startTime: Date.now() - 10_000,
        endTime: Date.now() - 5_000,
      },
      pid: process.pid,
      logPath,
      logOffset: 0,
    });

    const manager = new JobManager(tmpDir);
    manager.rehydrate();
    expect(manager.getJobs()).toHaveLength(0);
    expect(store.loadJobs()).toHaveLength(0);

    manager.release();
  });

  it("drops dead monitor jobs entirely instead of leaving a failed ghost", () => {
    const logDir = join(tmpDir, ".sparkflow", "logs");
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, "job-mon.log");
    appendFileSync(logPath, "");

    const store = new StateStore(tmpDir);
    store.saveJob({
      info: {
        id: "mon",
        workflowPath: "/tmp/wf.json",
        workflowName: "wf",
        kind: "monitor",
        state: "running",
        summary: "was running",
        startTime: Date.now() - 1000,
      },
      pid: 2_000_000,
      logPath,
      logOffset: 0,
    });

    const manager = new JobManager(tmpDir);
    manager.rehydrate();
    expect(manager.getJobs()).toHaveLength(0);
    // State file should be gone so subsequent rehydrates stay clean.
    expect(store.loadJobs()).toHaveLength(0);

    manager.release();
  });

  it("marks a rehydrated job failed if its pid is already dead", () => {
    const logDir = join(tmpDir, ".sparkflow", "logs");
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, "job-dead.log");
    appendFileSync(logPath, "");

    const store = new StateStore(tmpDir);
    // pid 1 is init — exists but not our child. Use a high-range pid that won't be ours.
    // We simulate "dead" by using an arbitrarily large pid that shouldn't exist.
    store.saveJob({
      info: {
        id: "dead",
        workflowPath: "/tmp/wf.json",
        workflowName: "wf",
        state: "running",
        summary: "was running",
        startTime: Date.now() - 1000,
      },
      pid: 2_000_000,
      logPath,
      logOffset: 0,
    });

    const manager = new JobManager(tmpDir);
    manager.rehydrate();
    const jobs = manager.getJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].state).toBe("failed");

    manager.release();
  });
});

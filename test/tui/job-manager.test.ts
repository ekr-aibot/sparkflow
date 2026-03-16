import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JobManager } from "../../src/tui/job-manager.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Helper to wait for job manager updates
function waitForUpdate(manager: JobManager): Promise<void> {
  return new Promise((resolve) => {
    const original = manager.onUpdate.bind(manager);
    manager.onUpdate(() => resolve());
  });
}

// Helper to wait for a condition with timeout
async function waitFor(
  condition: () => boolean,
  timeoutMs = 5000,
  intervalMs = 50
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe("JobManager", () => {
  let manager: JobManager;
  let tmpDir: string;

  beforeEach(() => {
    manager = new JobManager();
    tmpDir = mkdtempSync(join(tmpdir(), "sparkflow-test-jm-"));
  });

  afterEach(() => {
    manager.killAll();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("starts with no jobs", () => {
    expect(manager.getJobs()).toEqual([]);
  });

  it("starts a job and assigns an ID", () => {
    // Use a command that will fail fast (sparkflow-run not available in test)
    // but we can still verify the job was created
    const id = manager.startJob("/nonexistent/workflow.json");

    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
    expect(id.length).toBe(12); // 6 bytes hex

    const jobs = manager.getJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0].id).toBe(id);
    expect(jobs[0].workflowPath).toBe("/nonexistent/workflow.json");
    expect(jobs[0].state).toBe("running");
    expect(jobs[0].startTime).toBeLessThanOrEqual(Date.now());
  });

  it("fires update callback when job starts", async () => {
    let updated = false;
    manager.onUpdate(() => { updated = true; });

    manager.startJob("/nonexistent/workflow.json");
    expect(updated).toBe(true);
  });

  it("tracks job failure when process exits with error", async () => {
    const id = manager.startJob("/nonexistent/workflow.json");

    // sparkflow-run won't be found or will fail, so wait for the job to end
    await waitFor(() => {
      const jobs = manager.getJobs();
      return jobs[0]?.state === "failed";
    });

    const jobs = manager.getJobs();
    expect(jobs[0].state).toBe("failed");
    expect(jobs[0].endTime).toBeDefined();
  });

  it("starts multiple jobs independently", () => {
    const id1 = manager.startJob("/tmp/wf1.json");
    const id2 = manager.startJob("/tmp/wf2.json");

    expect(id1).not.toBe(id2);
    expect(manager.getJobs().length).toBe(2);
  });

  it("returns job detail with output buffer", () => {
    const id = manager.startJob("/tmp/wf.json");
    const detail = manager.getJobDetail(id);

    expect(detail).not.toBeNull();
    expect(detail!.info.id).toBe(id);
    expect(Array.isArray(detail!.output)).toBe(true);
  });

  it("returns null for unknown job detail", () => {
    expect(manager.getJobDetail("nonexistent")).toBeNull();
  });

  it("answerQuestion returns false for unknown job", () => {
    expect(manager.answerQuestion("nonexistent", "answer")).toBe(false);
  });

  it("answerQuestion returns false for job without pending question", () => {
    const id = manager.startJob("/tmp/wf.json");
    expect(manager.answerQuestion(id, "answer")).toBe(false);
  });

  it("returns copies of job info (not references)", () => {
    manager.startJob("/tmp/wf.json");
    const jobs1 = manager.getJobs();
    const jobs2 = manager.getJobs();

    expect(jobs1[0]).toEqual(jobs2[0]);
    expect(jobs1[0]).not.toBe(jobs2[0]); // different objects
  });

  it("killAll terminates running processes", async () => {
    // Start a job that would run for a while
    manager.startJob("/tmp/wf.json");
    expect(manager.getJobs().length).toBe(1);

    // killAll should not throw
    manager.killAll();

    // Wait for the process to actually die
    await waitFor(() => {
      const jobs = manager.getJobs();
      return jobs[0]?.state === "failed";
    });
  });
});

describe("JobManager verbose line parsing", () => {
  let manager: JobManager;

  beforeEach(() => {
    manager = new JobManager();
  });

  afterEach(() => {
    manager.killAll();
  });

  it("handles process errors gracefully", async () => {
    const jobId = manager.startJob("/nonexistent");
    await waitFor(() => manager.getJobs()[0]?.state === "failed");
    expect(manager.getJobs()[0].state).toBe("failed");
  });
});

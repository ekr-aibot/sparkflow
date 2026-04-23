import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JobManager } from "../../src/tui/job-manager.js";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
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
    tmpDir = mkdtempSync(join(tmpdir(), "sparkflow-test-jm-"));
    manager = new JobManager(tmpDir);
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

  it("returns job detail with output array", () => {
    const id = manager.startJob("/tmp/wf.json");
    const detail = manager.getJobDetail(id);

    expect(detail).not.toBeNull();
    expect(detail!.info.id).toBe(id);
    expect(Array.isArray(detail!.output)).toBe(true);
  });

  it("returns null for unknown job detail", () => {
    expect(manager.getJobDetail("nonexistent")).toBeNull();
  });

  it("getJobDetail reads from log file, not in-memory buffer", () => {
    const id = manager.startJob("/tmp/wf.json");

    // Get the internal job record and write known content directly to the log file
    const job = (manager as unknown as { jobs: Map<string, { outputBuffer: string[]; logPath: string }> }).jobs.get(id);
    expect(job).toBeDefined();
    writeFileSync(job!.logPath, "hello-from-log\nsecond-line\n");
    job!.outputBuffer = [];

    const detail = manager.getJobDetail(id);
    expect(detail).not.toBeNull();
    expect(detail!.output).toEqual(["hello-from-log", "second-line"]);
  });

  it("getJobDetail falls back to in-memory buffer when log file missing", () => {
    const id = manager.startJob("/tmp/wf.json");

    // Point logPath at a nonexistent location and inject buffer content
    const job = (manager as unknown as { jobs: Map<string, { outputBuffer: string[]; logPath: string }> }).jobs.get(id);
    expect(job).toBeDefined();
    job!.logPath = "/nonexistent/path/that/does/not/exist.log";
    job!.outputBuffer = ["fallback-line-1", "fallback-line-2"];

    const detail = manager.getJobDetail(id);
    expect(detail).not.toBeNull();
    expect(detail!.output).toEqual(["fallback-line-1", "fallback-line-2"]);
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
  let tmpDir2: string;

  beforeEach(() => {
    tmpDir2 = mkdtempSync(join(tmpdir(), "sparkflow-test-jm2-"));
    manager = new JobManager(tmpDir2);
  });

  afterEach(() => {
    manager.killAll();
    try { rmSync(tmpDir2, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("handles process errors gracefully", async () => {
    const jobId = manager.startJob("/nonexistent");
    await waitFor(() => manager.getJobs()[0]?.state === "failed");
    expect(manager.getJobs()[0].state).toBe("failed");
  });
});

describe("JobManager.nudgeJob", () => {
  let manager: JobManager;
  let tmpDir3: string;

  beforeEach(() => {
    tmpDir3 = mkdtempSync(join(tmpdir(), "sparkflow-test-jm3-"));
    manager = new JobManager(tmpDir3);
  });

  afterEach(() => {
    manager.killAll();
    try { rmSync(tmpDir3, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns error for unknown job", () => {
    const result = manager.nudgeJob("nonexistent", "step1", "hello");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it("returns error when job is not running (terminal state)", async () => {
    const id = manager.startJob("/nonexistent/workflow.json");
    await waitFor(() => manager.getJobs()[0]?.state === "failed");
    const result = manager.nudgeJob(id, "step1", "hello");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not running/);
  });

  it("writes nudge line to child stdin when job is running", () => {
    // Write a valid workflow JSON so sparkflow-run can start
    const wfPath = join(tmpDir3, "wf.json");
    writeFileSync(wfPath, JSON.stringify({
      version: "1",
      name: "test",
      entry: "s",
      steps: { s: { name: "S", runtime: { type: "shell", command: "sleep", args: ["60"] } } },
    }));

    const id = manager.startJob(wfPath);
    const jobs = manager.getJobs();
    expect(jobs[0].state).toBe("running");

    // Mock the child stdin so we can inspect the write
    const job = (manager as unknown as { jobs: Map<string, { child: { stdin: { write: (s: string) => void }; }; info: { state: string } }> }).jobs.get(id);
    expect(job).toBeDefined();

    if (job?.child?.stdin) {
      const written: string[] = [];
      const originalWrite = job.child.stdin.write.bind(job.child.stdin);
      job.child.stdin.write = (s: string) => { written.push(s); return true; };

      const result = manager.nudgeJob(id, "step-a", "please do X instead");
      expect(result.ok).toBe(true);
      expect(written.length).toBe(1);
      const parsed = JSON.parse(written[0].trim());
      expect(parsed.type).toBe("nudge");
      expect(parsed.step_id).toBe("step-a");
      expect(parsed.message).toBe("please do X instead");

      // Restore
      job.child.stdin.write = originalWrite;
    }
  });

  it("canNudge is true for running jobs with a live child", () => {
    const wfPath = join(tmpDir3, "wf2.json");
    writeFileSync(wfPath, JSON.stringify({
      version: "1",
      name: "test",
      entry: "s",
      steps: { s: { name: "S", runtime: { type: "shell", command: "sleep", args: ["60"] } } },
    }));

    manager.startJob(wfPath);
    const jobs = manager.getJobs();
    expect(jobs[0].state).toBe("running");
    expect(jobs[0].canNudge).toBe(true);
  });

  it("claudeCodeSteps populated from workflow_steps event", () => {
    const id = manager.startJob("/tmp/wf.json");
    // Simulate receiving the workflow_steps event via handleStatusLine (private)
    const handleStatusLine = (manager as unknown as { handleStatusLine: (id: string, line: string) => void }).handleStatusLine.bind(manager);
    handleStatusLine(id, JSON.stringify({
      type: "workflow_steps",
      steps: [
        { id: "build", runtime: "shell" },
        { id: "review", runtime: "claude-code" },
        { id: "test", runtime: "gemini" },
      ],
    }));
    const jobs = manager.getJobs();
    expect(jobs[0].claudeCodeSteps).toEqual(["review"]);
  });

  it("activeSteps updated from step_status events", () => {
    const id = manager.startJob("/tmp/wf.json");
    const handleStatusLine = (manager as unknown as { handleStatusLine: (id: string, line: string) => void }).handleStatusLine.bind(manager);

    handleStatusLine(id, JSON.stringify({ type: "step_status", step: "build", state: "running" }));
    handleStatusLine(id, JSON.stringify({ type: "step_status", step: "test", state: "running" }));
    let jobs = manager.getJobs();
    expect(jobs[0].activeSteps).toContain("build");
    expect(jobs[0].activeSteps).toContain("test");

    handleStatusLine(id, JSON.stringify({ type: "step_status", step: "build", state: "succeeded" }));
    jobs = manager.getJobs();
    expect(jobs[0].activeSteps).not.toContain("build");
    expect(jobs[0].activeSteps).toContain("test");
  });
});

describe("JobManager startJob deduplicateByPath", () => {
  let manager: JobManager;
  let tmpDir: string;

  const minimalWorkflow = JSON.stringify({
    version: "1",
    name: "test",
    entry: "s",
    steps: { s: { name: "S", runtime: { type: "shell", command: "sleep", args: ["60"] } } },
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sparkflow-test-dedup-"));
    manager = new JobManager(tmpDir);
  });

  afterEach(() => {
    manager.killAll();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns the existing job ID instead of spawning a duplicate when deduplicateByPath is true", () => {
    const wfPath = join(tmpDir, "wf.json");
    writeFileSync(wfPath, minimalWorkflow);

    const id1 = manager.startJob(wfPath);
    expect(manager.getJobs()).toHaveLength(1);

    // Second call with deduplicateByPath: should return id1, not create a new job.
    const id2 = manager.startJob(wfPath, { deduplicateByPath: true });
    expect(id2).toBe(id1);
    expect(manager.getJobs()).toHaveLength(1);
  });

  it("spawns a new job when deduplicateByPath is false (default)", () => {
    const wfPath = join(tmpDir, "wf2.json");
    writeFileSync(wfPath, minimalWorkflow);

    const id1 = manager.startJob(wfPath);
    const id2 = manager.startJob(wfPath);
    expect(id1).not.toBe(id2);
    expect(manager.getJobs()).toHaveLength(2);
  });
});

describe("JobManager startJob path canonicalization", () => {
  let manager: JobManager;
  let tmpDir: string;

  const minimalWorkflow = JSON.stringify({
    version: "1",
    name: "test",
    entry: "s",
    steps: { s: { name: "S", runtime: { type: "shell", command: "true", args: [] } } },
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sparkflow-test-jm-paths-"));
    manager = new JobManager(tmpDir);
  });

  afterEach(() => {
    manager.killAll();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("resolves a bare workflow name to an absolute path before spawning", () => {
    const wfDir = join(tmpDir, ".sparkflow", "workflows");
    mkdirSync(wfDir, { recursive: true });
    const wfFile = join(wfDir, "my-flow.json");
    writeFileSync(wfFile, minimalWorkflow);

    const id = manager.startJob("my-flow");
    const job = manager.getJobs().find((j) => j.id === id);
    expect(job).toBeDefined();
    expect(job!.workflowPath).toBe(wfFile);
  });

  it("leaves an already-absolute path unchanged", () => {
    const id = manager.startJob("/absolute/workflow.json");
    const job = manager.getJobs().find((j) => j.id === id);
    expect(job).toBeDefined();
    expect(job!.workflowPath).toBe("/absolute/workflow.json");
  });

  it("throws when a bare name cannot be resolved", () => {
    expect(() => manager.startJob("no-such-workflow")).toThrow();
  });
});

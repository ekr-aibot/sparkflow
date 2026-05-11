import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseRoadmap, findActiveAutoDevelop } from "../../src/web/auto-develop-view.js";
import type { PersistedJob } from "../../src/tui/state-store.js";

// ---- parseRoadmap ----

describe("parseRoadmap", () => {
  it("parses a pending task", () => {
    const tasks = parseRoadmap("- [ ] do something");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ line: 1, status: "pending", text: "do something" });
  });

  it("parses a done task", () => {
    const tasks = parseRoadmap("- [x] already done");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ line: 1, status: "done", text: "already done" });
  });

  it("parses a blocked task", () => {
    const tasks = parseRoadmap("- [!] stuck here");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ line: 1, status: "blocked", text: "stuck here" });
  });

  it("extracts blocked reason from HTML comment", () => {
    const tasks = parseRoadmap("- [!] stuck <!-- blocked: waiting on PR #42 -->");
    expect(tasks[0].blockedReason).toBe("waiting on PR #42");
    expect(tasks[0].text).toBe("stuck");
  });

  it("ignores non-task lines", () => {
    const md = [
      "# ROADMAP",
      "",
      "Some prose here.",
      "- [ ] actual task",
      "  - not a task (indented)",
      "another line",
    ].join("\n");
    const tasks = parseRoadmap(md);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].text).toBe("actual task");
  });

  it("preserves task order and line numbers", () => {
    const md = [
      "- [x] first",
      "# heading",
      "- [ ] second",
      "- [!] third",
    ].join("\n");
    const tasks = parseRoadmap(md);
    expect(tasks).toHaveLength(3);
    expect(tasks[0]).toMatchObject({ line: 1, status: "done", text: "first" });
    expect(tasks[1]).toMatchObject({ line: 3, status: "pending", text: "second" });
    expect(tasks[2]).toMatchObject({ line: 4, status: "blocked", text: "third" });
  });

  it("returns empty array for empty input", () => {
    expect(parseRoadmap("")).toEqual([]);
  });

  it("returns empty array when no task lines present", () => {
    expect(parseRoadmap("# Title\n\nSome text.\n")).toEqual([]);
  });

  it("does not set blockedReason for a pending task without a comment", () => {
    const tasks = parseRoadmap("- [ ] plain pending");
    expect(tasks[0].blockedReason).toBeUndefined();
  });

  it("handles mixed tasks in a realistic roadmap", () => {
    const md = [
      "# Project Roadmap",
      "",
      "- [x] Set up CI",
      "- [x] Write parser",
      "- [!] Deploy to prod <!-- blocked: needs infra ticket -->",
      "- [ ] Write docs",
      "- [ ] Ship it",
    ].join("\n");
    const tasks = parseRoadmap(md);
    expect(tasks).toHaveLength(5);
    expect(tasks.filter((t) => t.status === "done")).toHaveLength(2);
    expect(tasks.filter((t) => t.status === "blocked")).toHaveLength(1);
    expect(tasks.filter((t) => t.status === "pending")).toHaveLength(2);
    expect(tasks[2].blockedReason).toBe("needs infra ticket");
  });
});

// ---- findActiveAutoDevelop ----

function makeJob(overrides: Partial<PersistedJob> & { id?: string; workflowName?: string; state?: string; startTime?: number; logPath?: string }): PersistedJob {
  return {
    info: {
      id: overrides.id ?? "job-1",
      workflowPath: "/path/to/wf.json",
      workflowName: overrides.workflowName ?? "auto-develop",
      state: (overrides.state ?? "running") as PersistedJob["info"]["state"],
      summary: "running",
      startTime: overrides.startTime ?? Date.now(),
    },
    pid: 99999,
    logPath: overrides.logPath ?? "/tmp/fake.log",
    logOffset: 0,
  };
}

describe("findActiveAutoDevelop", () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sparkflow-adv-"));
    stateDir = join(tmpDir, ".sparkflow", "state", "jobs");
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function saveJob(job: PersistedJob): void {
    writeFileSync(join(stateDir, `${job.info.id}.json`), JSON.stringify(job));
  }

  it("returns null when state directory does not exist", () => {
    const result = findActiveAutoDevelop(join(tmpDir, "nonexistent"));
    expect(result).toBeNull();
  });

  it("returns null when no jobs are present", () => {
    expect(findActiveAutoDevelop(tmpDir)).toBeNull();
  });

  it("returns null when no auto-develop jobs are running", () => {
    saveJob(makeJob({ id: "j1", workflowName: "other-workflow" }));
    saveJob(makeJob({ id: "j2", workflowName: "auto-develop", state: "succeeded" }));
    expect(findActiveAutoDevelop(tmpDir)).toBeNull();
  });

  it("returns the single running auto-develop job", () => {
    saveJob(makeJob({ id: "j1", startTime: 1000 }));
    const result = findActiveAutoDevelop(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.primary.jobId).toBe("j1");
    expect(result!.otherRunningCount).toBe(0);
  });

  it("returns the most recent running job when multiple exist", () => {
    saveJob(makeJob({ id: "older", startTime: 1000 }));
    saveJob(makeJob({ id: "newest", startTime: 9000 }));
    saveJob(makeJob({ id: "middle", startTime: 5000 }));
    const result = findActiveAutoDevelop(tmpDir);
    expect(result!.primary.jobId).toBe("newest");
    expect(result!.otherRunningCount).toBe(2);
  });

  it("ignores finished jobs and returns only the running one", () => {
    saveJob(makeJob({ id: "done", workflowName: "auto-develop", state: "succeeded", startTime: 9000 }));
    saveJob(makeJob({ id: "running", workflowName: "auto-develop", state: "running", startTime: 1000 }));
    const result = findActiveAutoDevelop(tmpDir);
    expect(result!.primary.jobId).toBe("running");
    expect(result!.otherRunningCount).toBe(0);
  });

  it("extracts currentTaskLine from log file with pick-next:meta event", () => {
    const logPath = join(tmpDir, "job.log");
    writeFileSync(logPath, [
      '[pick-next:meta] result: {"line": "5", "text": "implement auth"}',
      "some other log line",
      '[pick-next:meta] result: {"line": "12", "text": "write tests"}',
    ].join("\n"));
    saveJob(makeJob({ id: "j1", logPath }));
    const result = findActiveAutoDevelop(tmpDir);
    expect(result!.primary.currentTaskLine).toBe(12);
  });

  it("returns null currentTaskLine when log has no pick-next:meta events", () => {
    const logPath = join(tmpDir, "job.log");
    writeFileSync(logPath, "just regular log output\nno meta events here\n");
    saveJob(makeJob({ id: "j1", logPath }));
    const result = findActiveAutoDevelop(tmpDir);
    expect(result!.primary.currentTaskLine).toBeNull();
  });

  it("returns null currentTaskLine when log file is missing", () => {
    saveJob(makeJob({ id: "j1", logPath: join(tmpDir, "does-not-exist.log") }));
    const result = findActiveAutoDevelop(tmpDir);
    expect(result!.primary.currentTaskLine).toBeNull();
  });

  it("skips corrupt job state files", () => {
    writeFileSync(join(stateDir, "bad.json"), "{ not valid json");
    saveJob(makeJob({ id: "good" }));
    const result = findActiveAutoDevelop(tmpDir);
    expect(result!.primary.jobId).toBe("good");
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildAutoDevelopResponse } from "../../src/web/auto-develop-view.js";
import type { PersistedJob } from "../../src/tui/state-store.js";

function saveJob(stateDir: string, job: PersistedJob): void {
  writeFileSync(join(stateDir, `${job.info.id}.json`), JSON.stringify(job));
}

function makeRunningJob(id: string, logPath: string, startTime = 1000): PersistedJob {
  return {
    info: {
      id,
      workflowPath: "/wf/auto-develop.json",
      workflowName: "auto-develop",
      state: "running",
      currentStep: "develop",
      summary: "running",
      startTime,
    },
    pid: 12345,
    logPath,
    logOffset: 0,
  };
}

describe("buildAutoDevelopResponse (endpoint logic)", () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sparkflow-ade-"));
    stateDir = join(tmpDir, ".sparkflow", "state", "jobs");
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns roadmap_exists: false when ROADMAP.md is absent", () => {
    const resp = buildAutoDevelopResponse(tmpDir);
    expect(resp.roadmap_exists).toBe(false);
    expect(resp.tasks).toEqual([]);
    expect(resp.current_job).toBeNull();
    expect(resp.other_running_count).toBe(0);
    expect(resp.generated_at).toMatch(/^\d{4}-/);
  });

  it("returns parsed tasks when ROADMAP.md exists", () => {
    writeFileSync(join(tmpDir, "ROADMAP.md"), [
      "# Roadmap",
      "- [x] done one",
      "- [x] done two",
      "- [!] blocked task <!-- blocked: waiting on design -->",
      "- [ ] pending one",
      "- [ ] pending two",
    ].join("\n"));

    const resp = buildAutoDevelopResponse(tmpDir);
    expect(resp.roadmap_exists).toBe(true);
    expect(resp.tasks).toHaveLength(5);

    const done = resp.tasks.filter((t) => t.status === "done");
    const blocked = resp.tasks.filter((t) => t.status === "blocked");
    const pending = resp.tasks.filter((t) => t.status === "pending");

    expect(done).toHaveLength(2);
    expect(blocked).toHaveLength(1);
    expect(pending).toHaveLength(2);
    expect(blocked[0].blockedReason).toBe("waiting on design");
  });

  it("returns current_job null when no auto-develop job is running", () => {
    writeFileSync(join(tmpDir, "ROADMAP.md"), "- [ ] task one\n");
    const resp = buildAutoDevelopResponse(tmpDir);
    expect(resp.current_job).toBeNull();
    expect(resp.other_running_count).toBe(0);
  });

  it("returns current_job with correct fields when a job is running", () => {
    const logPath = join(tmpDir, "job.log");
    writeFileSync(logPath, '[pick-next:meta] result: {"line": "3", "text": "pending one"}\n');

    writeFileSync(join(tmpDir, "ROADMAP.md"), [
      "- [x] done one",
      "- [x] done two",
      "- [ ] pending one",
    ].join("\n"));

    saveJob(stateDir, makeRunningJob("j-abc", logPath, 1700000000000));

    const resp = buildAutoDevelopResponse(tmpDir);
    expect(resp.roadmap_exists).toBe(true);
    expect(resp.current_job).not.toBeNull();
    expect(resp.current_job!.id).toBe("j-abc");
    expect(resp.current_job!.currentStep).toBe("develop");
    expect(resp.current_job!.currentTaskLine).toBe(3);
    expect(resp.current_job!.startTime).toBe(1700000000000);
    expect(resp.other_running_count).toBe(0);
  });

  it("reports other_running_count when multiple jobs are running", () => {
    writeFileSync(join(tmpDir, "ROADMAP.md"), "- [ ] task\n");
    const logPath = join(tmpDir, "job.log");
    writeFileSync(logPath, "");

    saveJob(stateDir, makeRunningJob("j-newest", logPath, 9000));
    saveJob(stateDir, makeRunningJob("j-older1", logPath, 5000));
    saveJob(stateDir, makeRunningJob("j-older2", logPath, 1000));

    const resp = buildAutoDevelopResponse(tmpDir);
    expect(resp.current_job!.id).toBe("j-newest");
    expect(resp.other_running_count).toBe(2);
  });

  it("generated_at is a valid ISO timestamp", () => {
    const resp = buildAutoDevelopResponse(tmpDir);
    expect(() => new Date(resp.generated_at)).not.toThrow();
    expect(new Date(resp.generated_at).getTime()).toBeGreaterThan(0);
  });
});

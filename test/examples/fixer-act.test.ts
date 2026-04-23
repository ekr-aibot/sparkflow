import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const FIXER_ACT = new URL("../../examples/scripts/fixer-act.sh", import.meta.url).pathname;

function runFixerAct(
  decision: Record<string, unknown>,
  jobId: string,
  cwd: string,
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("bash", [FIXER_ACT], {
    cwd,
    env: {
      ...process.env,
      SPARKFLOW_FIXER_DECISION: JSON.stringify(decision),
      SPARKFLOW_INPUT_JOB_ID: jobId,
    },
    encoding: "utf-8",
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

describe("fixer-act.sh", () => {
  let tmpDir: string;

  function setup(): void {
    tmpDir = mkdtempSync(join(tmpdir(), "sf-fixer-act-test-"));
  }

  function teardown(): void {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }

  it("exits 0 and writes ALERT to stderr for alert-user action", () => {
    setup();
    try {
      const { status, stderr } = runFixerAct(
        { action: "alert-user", user_message: "Something went wrong" },
        "testjob123",
        tmpDir,
      );
      expect(status).toBe(0);
      expect(stderr).toContain("[fixer] ALERT");
      expect(stderr).toContain("testjob123");
      expect(stderr).toContain("Something went wrong");
    } finally {
      teardown();
    }
  });

  it("exits 1 for unknown action", () => {
    setup();
    try {
      const { status } = runFixerAct({ action: "unknown-action" }, "job1", tmpDir);
      expect(status).toBe(1);
    } finally {
      teardown();
    }
  });

  it("exits 1 for redispatch with missing workflow_path", () => {
    setup();
    try {
      const { status, stderr } = runFixerAct({ action: "redispatch" }, "job1", tmpDir);
      expect(status).toBe(1);
      expect(stderr).toContain("missing workflow_path");
    } finally {
      teardown();
    }
  });

  it("exits 0 and writes dispatch file for redispatch with workflow_path", () => {
    setup();
    try {
      const { status, stderr } = runFixerAct(
        { action: "redispatch", workflow_path: "/some/workflow.json", plan_text: "" },
        "job42",
        tmpDir,
      );
      expect(status).toBe(0);
      expect(stderr).toContain("[fixer] queued redispatch");
      expect(stderr).toContain("/some/workflow.json");

      // A dispatch file should have been created
      const queueDir = join(tmpDir, ".sparkflow", "dispatch-queue");
      const files = readdirSync(queueDir).filter((f) => f.endsWith(".json"));
      expect(files.length).toBe(1);
    } finally {
      teardown();
    }
  });
});

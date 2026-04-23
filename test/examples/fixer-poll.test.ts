import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const FIXER_POLL = new URL("../../examples/scripts/fixer-poll.sh", import.meta.url).pathname;

function runFixerPoll(cwd: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("bash", [FIXER_POLL], {
    cwd,
    env: { ...process.env },
    encoding: "utf-8",
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

function makeJobFile(dir: string, id: string, info: Record<string, unknown>): void {
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({ info: { id, ...info }, pid: 1, logPath: "/tmp/fake.log", logOffset: 0 }),
  );
}

describe("fixer-poll.sh", () => {
  let tmpDir: string;
  let jobsDir: string;

  function setup(): void {
    tmpDir = mkdtempSync(join(tmpdir(), "sf-fixer-poll-test-"));
    jobsDir = join(tmpDir, ".sparkflow", "state", "jobs");
    mkdirSync(jobsDir, { recursive: true });
  }

  function teardown(): void {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }

  it("returns [] when state dir is missing", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "sf-fixer-poll-empty-"));
    try {
      const { stdout, status } = runFixerPoll(emptyDir);
      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toEqual([]);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("includes unhandled failed jobs", () => {
    setup();
    try {
      makeJobFile(jobsDir, "job1", {
        state: "failed",
        workflowName: "my-workflow",
        workflowPath: "/flows/my-workflow.json",
        slug: "test-slug",
      });
      const { stdout, status } = runFixerPoll(tmpDir);
      expect(status).toBe(0);
      const items = JSON.parse(stdout);
      expect(items).toHaveLength(1);
      expect(items[0].job_id).toBe("job1");
      expect(items[0].workflow_name).toBe("my-workflow");
    } finally {
      teardown();
    }
  });

  it("excludes killed jobs (killedByUser: true)", () => {
    setup();
    try {
      makeJobFile(jobsDir, "killed1", {
        state: "failed",
        killedByUser: true,
        workflowName: "my-workflow",
        workflowPath: "/flows/my-workflow.json",
        slug: "",
      });
      const { stdout, status } = runFixerPoll(tmpDir);
      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toEqual([]);
    } finally {
      teardown();
    }
  });

  it("excludes succeeded jobs", () => {
    setup();
    try {
      makeJobFile(jobsDir, "ok1", {
        state: "succeeded",
        workflowName: "my-workflow",
        workflowPath: "/flows/my-workflow.json",
        slug: "",
      });
      const { stdout, status } = runFixerPoll(tmpDir);
      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toEqual([]);
    } finally {
      teardown();
    }
  });

  it("excludes fixer workflow by name", () => {
    setup();
    try {
      makeJobFile(jobsDir, "fixer1", {
        state: "failed",
        workflowName: "fixer",
        workflowPath: "/flows/fixer.json",
        slug: "",
      });
      const { stdout, status } = runFixerPoll(tmpDir);
      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toEqual([]);
    } finally {
      teardown();
    }
  });

  it("does not re-emit already-handled jobs", () => {
    setup();
    try {
      makeJobFile(jobsDir, "handled1", {
        state: "failed",
        workflowName: "my-workflow",
        workflowPath: "/flows/my-workflow.json",
        slug: "",
      });
      // Mark as handled
      const handledDir = join(tmpDir, ".sparkflow", "state", "handled-by-fixer");
      mkdirSync(handledDir, { recursive: true });
      writeFileSync(join(handledDir, "handled1"), "");

      const { stdout, status } = runFixerPoll(tmpDir);
      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toEqual([]);
    } finally {
      teardown();
    }
  });
});

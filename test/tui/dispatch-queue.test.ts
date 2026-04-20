import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { watchDispatchQueue, type StartWorkflowRequest } from "../../src/tui/dispatch-queue.js";

describe("dispatch queue watcher", () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanup.splice(0)) fn();
  });

  function poll(condition: () => boolean, timeout = 2000): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeout;
      const tick = () => {
        if (condition()) return resolve();
        if (Date.now() > deadline) return reject(new Error("timed out waiting for condition"));
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "sf-dq-test-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  function makeWatcher(
    queueDir: string,
    startWorkflow: (req: StartWorkflowRequest) => Promise<{ job_id?: string; error?: string }>
  ): void {
    const close = watchDispatchQueue(queueDir, startWorkflow);
    cleanup.push(close);
  }

  it("drains a valid request file and writes result", async () => {
    const calls: StartWorkflowRequest[] = [];
    const queueDir = join(makeDir(), "queue");
    makeWatcher(queueDir, async (req) => {
      calls.push(req);
      return { job_id: "test-job-1" };
    });

    writeFileSync(join(queueDir, "req.json"), JSON.stringify({
      workflow_path: "/tmp/wf.json",
      slug: "test run",
    }));

    await poll(() => existsSync(join(queueDir, "req.result.json")));

    expect(calls).toHaveLength(1);
    expect(calls[0].workflow_path).toBe("/tmp/wf.json");
    expect(calls[0].slug).toBe("test run");

    const result = JSON.parse(readFileSync(join(queueDir, "req.result.json"), "utf-8"));
    expect(result.job_id).toBe("test-job-1");
    expect(existsSync(join(queueDir, "req.json"))).toBe(false);
  });

  it("drains request files that exist at startup", async () => {
    const calls: StartWorkflowRequest[] = [];
    const baseDir = makeDir();
    const queueDir = join(baseDir, "queue");

    // Write file before watcher starts
    const { mkdirSync } = await import("node:fs");
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(join(queueDir, "startup.json"), JSON.stringify({ workflow_path: "/tmp/startup.json" }));

    makeWatcher(queueDir, async (req) => {
      calls.push(req);
      return { job_id: "startup-job" };
    });

    await poll(() => existsSync(join(queueDir, "startup.result.json")));

    expect(calls).toHaveLength(1);
    expect(calls[0].workflow_path).toBe("/tmp/startup.json");
    const result = JSON.parse(readFileSync(join(queueDir, "startup.result.json"), "utf-8"));
    expect(result.job_id).toBe("startup-job");
  });

  it("writes error result for invalid JSON", async () => {
    const queueDir = join(makeDir(), "queue");
    makeWatcher(queueDir, async () => ({ job_id: "should-not-reach" }));

    writeFileSync(join(queueDir, "bad.json"), "not valid json{{{");

    await poll(() => existsSync(join(queueDir, "bad.result.json")));

    const result = JSON.parse(readFileSync(join(queueDir, "bad.result.json"), "utf-8"));
    expect(result.error).toContain("invalid JSON");
    expect(existsSync(join(queueDir, "bad.json"))).toBe(false);
  });

  it("writes error result when workflow_path is missing", async () => {
    const queueDir = join(makeDir(), "queue");
    makeWatcher(queueDir, async () => ({ job_id: "should-not-reach" }));

    writeFileSync(join(queueDir, "nop.json"), JSON.stringify({ slug: "no-path" }));

    await poll(() => existsSync(join(queueDir, "nop.result.json")));

    const result = JSON.parse(readFileSync(join(queueDir, "nop.result.json"), "utf-8"));
    expect(result.error).toContain("workflow_path");
  });

  it("writes error result when startWorkflow returns error", async () => {
    const queueDir = join(makeDir(), "queue");
    makeWatcher(queueDir, async () => ({ error: "IPC disconnected" }));

    writeFileSync(join(queueDir, "fail.json"), JSON.stringify({ workflow_path: "/tmp/wf.json" }));

    await poll(() => existsSync(join(queueDir, "fail.result.json")));

    const result = JSON.parse(readFileSync(join(queueDir, "fail.result.json"), "utf-8"));
    expect(result.error).toBe("IPC disconnected");
    expect(existsSync(join(queueDir, "fail.json"))).toBe(false);
  });

  it("ignores .result.json files", async () => {
    const calls: StartWorkflowRequest[] = [];
    const queueDir = join(makeDir(), "queue");
    makeWatcher(queueDir, async (req) => { calls.push(req); return { job_id: "x" }; });

    writeFileSync(join(queueDir, "existing.result.json"), JSON.stringify({ job_id: "old" }));

    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toHaveLength(0);
  });

  it("ignores non-JSON files", async () => {
    const calls: StartWorkflowRequest[] = [];
    const queueDir = join(makeDir(), "queue");
    makeWatcher(queueDir, async (req) => { calls.push(req); return { job_id: "x" }; });

    writeFileSync(join(queueDir, "readme.txt"), "hello");

    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toHaveLength(0);
  });
});

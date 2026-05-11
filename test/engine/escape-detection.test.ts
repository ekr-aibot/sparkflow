import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process before any imports that use it
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  createInterface: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { WorkflowEngine } from "../../src/engine/engine.js";
import type { SparkflowWorkflow } from "../../src/schema/types.js";
import type { RuntimeAdapter, RuntimeContext, RuntimeResult } from "../../src/runtime/types.js";

const mockExec = vi.mocked(execFileSync);

const silentLogger = { info: () => {}, error: () => {} };

class MockAdapter implements RuntimeAdapter {
  constructor(private readonly result: RuntimeResult = { success: true, outputs: {} }) {}
  async run(_ctx: RuntimeContext): Promise<RuntimeResult> {
    return this.result;
  }
}

function makeAdapters(result?: RuntimeResult): Map<string, RuntimeAdapter> {
  const adapter = new MockAdapter(result);
  return new Map([
    ["shell", adapter],
    ["claude-code", adapter],
    ["custom", adapter],
  ]);
}

function makeIsolatedWorkflow(): SparkflowWorkflow {
  return {
    version: "1",
    name: "test-workflow",
    entry: "develop",
    defaults: { runtime: { type: "claude-code" } },
    steps: {
      develop: {
        name: "Develop",
        interactive: false,
        worktree: { mode: "isolated" },
      },
    },
  };
}

describe("WorkflowEngine worktree escape detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails the step when parent HEAD moves but worktree stays unchanged", async () => {
    const engineCwd = "/fake/repo";
    let parentRevParseCount = 0;

    mockExec.mockImplementation((cmd: string, args?: readonly string[], opts?: { cwd?: string }) => {
      if (cmd !== "git") return Buffer.from("");
      const a = args ?? [];
      const cwd = opts?.cwd ?? "";
      const isParent = cwd === engineCwd;
      const isWorktree = cwd.includes(".sparkflow-worktrees");

      if (a[0] === "worktree" && a[1] === "prune") return Buffer.from("");
      if (a[0] === "worktree" && a[1] === "remove") throw new Error("not a worktree");
      if (a[0] === "worktree" && a[1] === "add") return Buffer.from("");

      if (a[0] === "rev-parse" && a[1] === "HEAD") {
        if (isParent) {
          parentRevParseCount++;
          // First call (before step): return sha-before; second call (after step): return sha-after
          return Buffer.from(parentRevParseCount === 1 ? "sha-parent-before\n" : "sha-parent-after\n");
        }
        if (isWorktree) {
          // Worktree HEAD never changes — step made no commits there
          return Buffer.from("sha-worktree\n");
        }
      }

      if (a[0] === "rev-parse" && a[1] === "--abbrev-ref") {
        if (isParent) return Buffer.from("main\n");
        if (isWorktree) return Buffer.from("sparkflow/develop-abc\n");
      }

      // End-of-run branch report
      return Buffer.from("sparkflow/develop-abc\n");
    });

    const workflow = makeIsolatedWorkflow();
    const engine = new WorkflowEngine(
      workflow,
      { logger: silentLogger, cwd: engineCwd },
      makeAdapters({ success: true, outputs: {} }),
    );

    const result = await engine.run();

    expect(result.success).toBe(false);
    const developStatus = result.stepResults.get("develop");
    expect(developStatus?.state).toBe("failed");
    expect(developStatus?.lastError).toMatch(/escaped the worktree/);
    expect(developStatus?.lastError).toMatch(/sha-parent-after/);
    expect(developStatus?.lastError).toMatch(/develop/);
  });

  it("does NOT fail when parent HEAD stays unchanged", async () => {
    const engineCwd = "/fake/repo";

    mockExec.mockImplementation((cmd: string, args?: readonly string[], opts?: { cwd?: string }) => {
      if (cmd !== "git") return Buffer.from("");
      const a = args ?? [];
      const cwd = opts?.cwd ?? "";
      const isParent = cwd === engineCwd;

      if (a[0] === "worktree") return Buffer.from("");
      if (a[0] === "rev-parse" && a[1] === "HEAD") {
        if (isParent) return Buffer.from("sha-same\n");
        return Buffer.from("sha-worktree\n");
      }
      return Buffer.from("sparkflow/develop-abc\n");
    });

    const workflow = makeIsolatedWorkflow();
    const engine = new WorkflowEngine(
      workflow,
      { logger: silentLogger, cwd: engineCwd },
      makeAdapters({ success: true, outputs: {} }),
    );

    const result = await engine.run();
    expect(result.success).toBe(true);
    expect(result.stepResults.get("develop")?.state).toBe("succeeded");
  });

  it("does NOT fail when worktree also received commits alongside parent", async () => {
    const engineCwd = "/fake/repo";
    let parentRevParseCount = 0;
    let worktreeRevParseCount = 0;

    mockExec.mockImplementation((cmd: string, args?: readonly string[], opts?: { cwd?: string }) => {
      if (cmd !== "git") return Buffer.from("");
      const a = args ?? [];
      const cwd = opts?.cwd ?? "";
      const isParent = cwd === engineCwd;
      const isWorktree = cwd.includes(".sparkflow-worktrees");

      if (a[0] === "worktree") return Buffer.from("");

      if (a[0] === "rev-parse" && a[1] === "HEAD") {
        if (isParent) {
          parentRevParseCount++;
          return Buffer.from(parentRevParseCount === 1 ? "sha-parent-before\n" : "sha-parent-after\n");
        }
        if (isWorktree) {
          worktreeRevParseCount++;
          // Worktree also moved (this is fine — the step did commit there)
          return Buffer.from(worktreeRevParseCount === 1 ? "sha-wt-before\n" : "sha-wt-after\n");
        }
      }
      return Buffer.from("main\n");
    });

    const workflow = makeIsolatedWorkflow();
    const engine = new WorkflowEngine(
      workflow,
      { logger: silentLogger, cwd: engineCwd },
      makeAdapters({ success: true, outputs: {} }),
    );

    const result = await engine.run();
    expect(result.success).toBe(true);
    expect(result.stepResults.get("develop")?.state).toBe("succeeded");
  });

  it("skips escape detection for shared-mode steps (cwd equals repo root)", async () => {
    const engineCwd = "/fake/repo";
    let revParseCallCount = 0;

    mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (cmd !== "git") return Buffer.from("");
      const a = args ?? [];
      if (a[0] === "rev-parse" && a[1] === "HEAD") {
        revParseCallCount++;
        return Buffer.from("sha\n");
      }
      return Buffer.from("main\n");
    });

    const workflow: SparkflowWorkflow = {
      version: "1",
      name: "test",
      entry: "start",
      defaults: { runtime: { type: "claude-code" } },
      steps: {
        start: { name: "Start", interactive: false },
      },
    };

    const engine = new WorkflowEngine(
      workflow,
      { logger: silentLogger, cwd: engineCwd },
      makeAdapters({ success: true, outputs: {} }),
    );

    await engine.run();

    // No HEAD captures should have happened (cwd === this.cwd for shared steps)
    expect(revParseCallCount).toBe(0);
  });
});

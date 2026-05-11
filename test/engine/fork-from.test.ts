import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { WorkflowEngine } from "../../src/engine/engine.js";
import type { SparkflowWorkflow } from "../../src/schema/types.js";
import type { RuntimeAdapter, RuntimeContext, RuntimeResult } from "../../src/runtime/types.js";

const mockExec = vi.mocked(execFileSync);

const silentLogger = { info: () => {}, error: () => {} };

class MockAdapter implements RuntimeAdapter {
  private calls = 0;
  constructor(private readonly results: RuntimeResult[]) {}
  async run(_ctx: RuntimeContext): Promise<RuntimeResult> {
    const result = this.results[this.calls] ?? this.results[this.results.length - 1];
    this.calls++;
    return result;
  }
}

function cwdOf(opts: unknown): string {
  if (!opts || typeof opts !== "object") return "";
  const raw = (opts as Record<string, unknown>).cwd;
  if (raw instanceof URL) return raw.pathname;
  if (typeof raw === "string") return raw;
  return "";
}

describe("fork_from engine integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the fork-source step's worktree HEAD as commitish for the fork step", async () => {
    const engineCwd = "/fake/repo";
    // Track what commitish was passed to git worktree add for step B
    const worktreeAddArgs: string[][] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExec.mockImplementation((...rawArgs: any[]) => {
      const [cmd, args, opts] = rawArgs as [string, string[], unknown];
      if (cmd !== "git") return Buffer.from("");
      const cwd = cwdOf(opts);

      if (args[0] === "worktree" && args[1] === "prune") return Buffer.from("");
      if (args[0] === "worktree" && args[1] === "remove") return Buffer.from("");
      if (args[0] === "worktree" && args[1] === "add") {
        worktreeAddArgs.push([...args, `[cwd=${cwd}]`]);
        return Buffer.from("");
      }

      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        // A's worktree path contains "develop"
        if (cwd.includes("develop")) return Buffer.from("sha-develop-head\n");
        // Parent repo
        if (cwd === engineCwd) return Buffer.from("sha-parent\n");
        // B's worktree path contains "test"
        return Buffer.from("sha-test-head\n");
      }
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return Buffer.from("some-branch\n");
      }

      return Buffer.from("");
    });

    // Workflow: develop (isolated) → test (fork, fork_from: develop)
    const workflow: SparkflowWorkflow = {
      version: "1",
      name: "fork-from-test",
      entry: "develop",
      steps: {
        develop: {
          name: "Develop",
          interactive: false,
          runtime: { type: "shell", command: "true" },
          worktree: { mode: "isolated" },
          on_success: [{ step: "test" }],
        },
        test: {
          name: "Test",
          interactive: false,
          runtime: { type: "shell", command: "true" },
          worktree: { mode: "fork", fork_from: "develop" },
        },
      },
    };

    const adapters = new Map<string, RuntimeAdapter>([
      ["shell", new MockAdapter([{ success: true, outputs: {} }])],
    ]);

    const engine = new WorkflowEngine(
      workflow,
      { logger: silentLogger, cwd: engineCwd },
      adapters,
    );

    const result = await engine.run();

    expect(result.success).toBe(true);

    // Find the git worktree add call for test's fork worktree
    const testAddCall = worktreeAddArgs.find((a) => a.join(" ").includes("test"));
    expect(testAddCall).toBeDefined();
    // The commitish should be the HEAD of develop's worktree
    expect(testAddCall!.join(" ")).toContain("sha-develop-head");
  });

  it("throws a clear error when fork_from references a step that has not run yet", async () => {
    const engineCwd = "/fake/repo";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExec.mockImplementation((...rawArgs: any[]) => {
      const [cmd, args] = rawArgs as [string, string[]];
      if (cmd !== "git") return Buffer.from("");
      if (args[0] === "worktree") return Buffer.from("");
      if (args[0] === "rev-parse") return Buffer.from("sha\n");
      return Buffer.from("");
    });

    // Workflow: test (fork, fork_from: develop) — but develop never runs
    const workflow: SparkflowWorkflow = {
      version: "1",
      name: "fork-from-error-test",
      entry: "test",
      steps: {
        develop: {
          name: "Develop",
          interactive: false,
          runtime: { type: "shell", command: "true" },
          worktree: { mode: "isolated" },
        },
        test: {
          name: "Test",
          interactive: false,
          runtime: { type: "shell", command: "true" },
          worktree: { mode: "fork", fork_from: "develop" },
        },
      },
    };

    const adapters = new Map<string, RuntimeAdapter>([
      ["shell", new MockAdapter([{ success: true, outputs: {} }])],
    ]);

    const engine = new WorkflowEngine(
      workflow,
      { logger: silentLogger, cwd: engineCwd },
      adapters,
    );

    const result = await engine.run();

    // The test step should fail because develop's worktree is not resolved
    expect(result.success).toBe(false);
    const testStatus = result.stepResults.get("test");
    expect(testStatus?.state).toBe("failed");
    expect(testStatus?.lastError).toMatch(/fork_from='develop'/);
    expect(testStatus?.lastError).toMatch(/has not been resolved yet/);
  });

  it("re-run of fork step picks up new commits from the isolated source step", async () => {
    const engineCwd = "/fake/repo";
    let developHeadCallCount = 0;
    const commitishesUsedByTest: string[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExec.mockImplementation((...rawArgs: any[]) => {
      const [cmd, args, opts] = rawArgs as [string, string[], unknown];
      if (cmd !== "git") return Buffer.from("");
      const cwd = cwdOf(opts);

      if (args[0] === "worktree" && args[1] === "prune") return Buffer.from("");
      if (args[0] === "worktree" && args[1] === "remove") return Buffer.from("");
      if (args[0] === "worktree" && args[1] === "add") {
        // Record the commitish if --detach (fork step)
        if (args.includes("--detach") && args.length > 3) {
          commitishesUsedByTest.push(args[args.length - 1]);
        }
        return Buffer.from("");
      }

      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        if (cwd.includes("develop")) {
          developHeadCallCount++;
          // Simulate develop making a new commit each time
          return Buffer.from(`sha-develop-v${developHeadCallCount}\n`);
        }
        if (cwd === engineCwd) return Buffer.from("sha-parent\n");
        return Buffer.from("sha-test-wt\n");
      }
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return Buffer.from("some-branch\n");
      }

      return Buffer.from("");
    });

    // Workflow: develop (isolated) → test (fork, fork_from: develop)
    //           test on_failure → develop (retry)
    // Adapters: develop always succeeds, test fails first then succeeds
    const developAdapter = new MockAdapter([
      { success: true, outputs: {} },
      { success: true, outputs: {} },
    ]);
    const testAdapter = new MockAdapter([
      { success: false, outputs: {}, error: "first run fails" },
      { success: true, outputs: {} },
    ]);

    const workflow: SparkflowWorkflow = {
      version: "1",
      name: "retry-fork-from-test",
      entry: "develop",
      steps: {
        develop: {
          name: "Develop",
          interactive: false,
          runtime: { type: "shell", command: "true" },
          worktree: { mode: "isolated" },
          on_success: [{ step: "test" }],
          max_retries: 5,
        },
        test: {
          name: "Test",
          interactive: false,
          runtime: { type: "shell", command: "true" },
          worktree: { mode: "fork", fork_from: "develop" },
          on_failure: [{ step: "develop" }],
          max_retries: 5,
        },
      },
    };

    const adapters = new Map<string, RuntimeAdapter>([
      ["shell", developAdapter],
    ]);
    // Override per-step by using a single adapter that dispatches by stepId
    class DispatchAdapter implements RuntimeAdapter {
      async run(ctx: RuntimeContext): Promise<RuntimeResult> {
        if (ctx.stepId === "develop") return developAdapter.run(ctx);
        return testAdapter.run(ctx);
      }
    }
    adapters.set("shell", new DispatchAdapter());

    const engine = new WorkflowEngine(
      workflow,
      { logger: silentLogger, cwd: engineCwd },
      adapters,
    );

    const result = await engine.run();

    expect(result.success).toBe(true);

    // test ran twice, each time it should have used a different (advancing) HEAD from develop
    expect(commitishesUsedByTest).toHaveLength(2);
    expect(commitishesUsedByTest[0]).toMatch(/^sha-develop-v\d+$/);
    expect(commitishesUsedByTest[1]).toMatch(/^sha-develop-v\d+$/);
    // The second run should use a later HEAD than the first
    const v0 = parseInt(commitishesUsedByTest[0].replace("sha-develop-v", ""));
    const v1 = parseInt(commitishesUsedByTest[1].replace("sha-develop-v", ""));
    expect(v1).toBeGreaterThan(v0);
  });

  it("gracefully falls back to repo HEAD when fork_from references a shared-mode step", async () => {
    const engineCwd = "/fake/repo";
    const worktreeAddArgs: string[][] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExec.mockImplementation((...rawArgs: any[]) => {
      const [cmd, args] = rawArgs as [string, string[]];
      if (cmd !== "git") return Buffer.from("");
      if (args[0] === "worktree" && args[1] === "prune") return Buffer.from("");
      if (args[0] === "worktree" && args[1] === "remove") return Buffer.from("");
      if (args[0] === "worktree" && args[1] === "add") {
        worktreeAddArgs.push([...args]);
        return Buffer.from("");
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") return Buffer.from("sha-repo\n");
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return Buffer.from("main\n");
      return Buffer.from("");
    });

    // develop runs in shared mode (no worktree config), test forks from it.
    const workflow: SparkflowWorkflow = {
      version: "1",
      name: "shared-fork-from-test",
      entry: "develop",
      steps: {
        develop: {
          name: "Develop",
          interactive: false,
          runtime: { type: "shell", command: "true" },
          // no worktree → shared mode
          on_success: [{ step: "test" }],
        },
        test: {
          name: "Test",
          interactive: false,
          runtime: { type: "shell", command: "true" },
          worktree: { mode: "fork", fork_from: "develop" },
        },
      },
    };

    const adapters = new Map<string, RuntimeAdapter>([
      ["shell", new MockAdapter([{ success: true, outputs: {} }])],
    ]);

    const engine = new WorkflowEngine(
      workflow,
      { logger: silentLogger, cwd: engineCwd },
      adapters,
    );

    const result = await engine.run();

    // Workflow must succeed — no throw for a shared-mode fork source.
    expect(result.success).toBe(true);

    // test's git worktree add should have been called. Since develop has no
    // dedicated worktree (shared mode, no runWorktree), the fork is created
    // without an explicit commitish (i.e. at the current repo HEAD).
    const testAdd = worktreeAddArgs.find((a) => a.join(" ").includes("test"));
    expect(testAdd).toBeDefined();
    // The add call should be: ["worktree", "add", "--detach", "<path>"]
    // with no extra commitish argument appended.
    expect(testAdd!).toHaveLength(4);
    expect(testAdd![2]).toBe("--detach");
  });
});

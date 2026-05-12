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

/** Adapter that returns results from a pre-loaded queue, then repeats the last. */
class QueueAdapter implements RuntimeAdapter {
  private calls = 0;
  readonly ctxHistory: RuntimeContext[] = [];

  constructor(private readonly results: RuntimeResult[]) {}

  async run(ctx: RuntimeContext): Promise<RuntimeResult> {
    this.ctxHistory.push(ctx);
    const result = this.results[this.calls] ?? this.results[this.results.length - 1];
    this.calls++;
    return result;
  }
}

/** Adapter that dispatches to per-stepId delegates. */
class DispatchAdapter implements RuntimeAdapter {
  constructor(private readonly delegates: Record<string, RuntimeAdapter>) {}
  async run(ctx: RuntimeContext): Promise<RuntimeResult> {
    const delegate = this.delegates[ctx.stepId];
    if (!delegate) throw new Error(`No delegate for stepId: ${ctx.stepId}`);
    return delegate.run(ctx);
  }
}

/** Standard git mock that satisfies worktree and rev-parse calls. */
function setupGitMock(engineCwd: string): void {
  mockExec.mockImplementation((...rawArgs: unknown[]) => {
    const [cmd, args] = rawArgs as [string, string[]];
    if (cmd !== "git") return Buffer.from("");
    if (args[0] === "worktree") return Buffer.from("");
    if (args[0] === "rev-parse" && args[1] === "HEAD") return Buffer.from("sha-abc\n");
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return Buffer.from("main\n");
    return Buffer.from("");
  });
  void engineCwd; // used in some variants
}

// -----------------------------------------------------------------
// Case 1: Auto-develop pattern — re-entry via on_failure after success
// -----------------------------------------------------------------
describe("loop-iteration: re-entry after success via on_failure (auto-develop pattern)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("gives develop a fresh session and new worktree on each loop iteration", async () => {
    const engineCwd = "/fake/repo";
    setupGitMock(engineCwd);

    // pick-next fails twice (tasks remaining), then succeeds (done)
    const pickNextAdapter = new QueueAdapter([
      { success: false, outputs: {}, error: "tasks remaining" },
      { success: false, outputs: {}, error: "tasks remaining" },
      { success: true, outputs: {} },
    ]);
    // develop succeeds twice, each returning a session id
    const developAdapter = new QueueAdapter([
      { success: true, outputs: {}, sessionId: "sess-iter-1" },
      { success: true, outputs: {}, sessionId: "sess-iter-2" },
    ]);

    const workflow: SparkflowWorkflow = {
      version: "1",
      name: "auto-develop",
      entry: "pick-next",
      steps: {
        "pick-next": {
          name: "Pick Next Task",
          interactive: false,
          runtime: { type: "shell", command: "true" },
          // on_failure routes to develop (conventional "next task" routing)
          on_failure: [{ step: "develop" }],
          max_retries: 10,
        },
        develop: {
          name: "Develop",
          interactive: false,
          runtime: { type: "claude-code" },
          worktree: { mode: "isolated" },
          on_success: [{ step: "pick-next" }],
          max_retries: 10,
        },
      },
    };

    const adapters = new Map<string, RuntimeAdapter>([
      ["shell", pickNextAdapter],
      ["claude-code", developAdapter],
    ]);

    const engine = new WorkflowEngine(
      workflow,
      { logger: silentLogger, cwd: engineCwd },
      adapters,
    );

    const result = await engine.run();
    expect(result.success).toBe(true);

    // develop must have run exactly twice
    expect(developAdapter.ctxHistory).toHaveLength(2);

    // Neither invocation should be a session resume
    expect(developAdapter.ctxHistory[0].resume).toBeFalsy();
    expect(developAdapter.ctxHistory[0].sessionId).toBeUndefined();

    expect(developAdapter.ctxHistory[1].resume).toBeFalsy();
    expect(developAdapter.ctxHistory[1].sessionId).toBeUndefined();

    // git worktree add -b should have been called twice (fresh worktree each iteration)
    const addBranchCalls = mockExec.mock.calls.filter(
      (c) => (c[1] as string[]).includes("add") && (c[1] as string[]).includes("-b")
    );
    expect(addBranchCalls).toHaveLength(2);

    // The two branch names should have different random suffixes
    const branchOf = (call: unknown[]) => {
      const args = call[1] as string[];
      return args[args.indexOf("-b") + 1];
    };
    expect(branchOf(addBranchCalls[0])).not.toBe(branchOf(addBranchCalls[1]));
  });
});

// -----------------------------------------------------------------
// Case 2: Re-entry via on_success after success
// -----------------------------------------------------------------
describe("loop-iteration: re-entry after success via on_success", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resets session and worktree when a step loops back via on_success", async () => {
    const engineCwd = "/fake/repo";
    setupGitMock(engineCwd);

    // Workflow: develop (isolated, claude-code) → land (shell) → develop → land (fails, no on_failure → abort)
    // develop: succeeds twice with different session ids
    // land: succeeds once, then fails (terminating the loop)
    const developAdapter = new QueueAdapter([
      { success: true, outputs: {}, sessionId: "sess-A" },
      { success: true, outputs: {}, sessionId: "sess-B" },
    ]);
    const landAdapter = new QueueAdapter([
      { success: true, outputs: {} },
      { success: false, outputs: {}, error: "land failed" },
    ]);

    const workflow: SparkflowWorkflow = {
      version: "1",
      name: "loop-via-success",
      entry: "develop",
      steps: {
        develop: {
          name: "Develop",
          interactive: false,
          runtime: { type: "claude-code" },
          worktree: { mode: "isolated" },
          on_success: [{ step: "land" }],
          max_retries: 10,
        },
        land: {
          name: "Land",
          interactive: false,
          runtime: { type: "shell", command: "true" },
          on_success: [{ step: "develop" }],
          max_retries: 10,
        },
      },
    };

    const adapters = new Map<string, RuntimeAdapter>([
      ["claude-code", developAdapter],
      ["shell", landAdapter],
    ]);

    const engine = new WorkflowEngine(
      workflow,
      { logger: silentLogger, cwd: engineCwd },
      adapters,
    );

    // Workflow ends when land fails (no on_failure) after second iteration
    const result = await engine.run();
    // workflow fails because land failed with no recovery
    expect(result.success).toBe(false);

    // develop ran twice
    expect(developAdapter.ctxHistory).toHaveLength(2);

    // First run: fresh
    expect(developAdapter.ctxHistory[0].resume).toBeFalsy();
    expect(developAdapter.ctxHistory[0].sessionId).toBeUndefined();

    // Second run: also fresh (re-entry after success, NOT a session resume)
    expect(developAdapter.ctxHistory[1].resume).toBeFalsy();
    expect(developAdapter.ctxHistory[1].sessionId).toBeUndefined();

    // Two distinct git worktree add calls
    const addCalls = mockExec.mock.calls.filter(
      (c) => (c[1] as string[]).includes("add") && (c[1] as string[]).includes("-b")
    );
    expect(addCalls).toHaveLength(2);
  });
});

// -----------------------------------------------------------------
// Case 3: Regression guard — failure retry MUST keep the session
// -----------------------------------------------------------------
describe("loop-iteration: failure retry keeps session (regression guard)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resumes the session when develop fails and is retried via on_failure", async () => {
    const engineCwd = "/fake/repo";
    setupGitMock(engineCwd);

    // Workflow: develop (isolated, claude-code) -on_failure-> develop (self-loop retry)
    // develop: fails first (returning sessionId), then succeeds
    const developAdapter = new QueueAdapter([
      { success: false, outputs: {}, sessionId: "sess-retry-1", error: "compile error" },
      { success: true, outputs: {} },
    ]);

    const workflow: SparkflowWorkflow = {
      version: "1",
      name: "retry-on-failure",
      entry: "develop",
      steps: {
        develop: {
          name: "Develop",
          interactive: false,
          runtime: { type: "claude-code" },
          worktree: { mode: "isolated" },
          on_failure: [{ step: "develop", message: "Fix the compile error" }],
          max_retries: 10,
        },
      },
    };

    const adapters = new Map<string, RuntimeAdapter>([
      ["claude-code", developAdapter],
    ]);

    const engine = new WorkflowEngine(
      workflow,
      { logger: silentLogger, cwd: engineCwd },
      adapters,
    );

    const result = await engine.run();
    expect(result.success).toBe(true);

    // develop ran twice
    expect(developAdapter.ctxHistory).toHaveLength(2);

    // First run: fresh (no prior session)
    expect(developAdapter.ctxHistory[0].resume).toBeFalsy();
    expect(developAdapter.ctxHistory[0].sessionId).toBeUndefined();

    // Second run: MUST resume the session from the first run
    expect(developAdapter.ctxHistory[1].resume).toBe(true);
    expect(developAdapter.ctxHistory[1].sessionId).toBe("sess-retry-1");

    // Worktree should NOT have been recreated — still the same branch (only one add -b call)
    const addCalls = mockExec.mock.calls.filter(
      (c) => (c[1] as string[]).includes("add") && (c[1] as string[]).includes("-b")
    );
    expect(addCalls).toHaveLength(1);
  });
});

// -----------------------------------------------------------------
// Case 4: Diagnostic hint for stale worktree cwd
// -----------------------------------------------------------------
describe("loop-iteration: diagnostic hint for stale isolated worktree path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("appends the stale-worktree hint when adapter reports cwd-not-exist for a registered path", async () => {
    const engineCwd = "/fake/repo";
    setupGitMock(engineCwd);

    // Adapter that captures the cwd from ctx and returns "cwd does not exist" for it
    class CwdNotExistAdapter implements RuntimeAdapter {
      capturedCwd?: string;
      async run(ctx: RuntimeContext): Promise<RuntimeResult> {
        this.capturedCwd = ctx.cwd;
        return {
          success: false,
          outputs: {},
          error: `cwd does not exist or is not a directory: ${ctx.cwd}`,
        };
      }
    }

    const cwdNotExistAdapter = new CwdNotExistAdapter();

    const workflow: SparkflowWorkflow = {
      version: "1",
      name: "stale-worktree-hint",
      entry: "develop",
      steps: {
        develop: {
          name: "Develop",
          interactive: false,
          runtime: { type: "claude-code" },
          worktree: { mode: "isolated" },
          // no on_failure → workflow aborts after failure
        },
      },
    };

    const adapters = new Map<string, RuntimeAdapter>([
      ["claude-code", cwdNotExistAdapter],
    ]);

    const engine = new WorkflowEngine(
      workflow,
      { logger: silentLogger, cwd: engineCwd },
      adapters,
    );

    const result = await engine.run();
    expect(result.success).toBe(false);

    const developStatus = result.stepResults.get("develop");
    expect(developStatus?.state).toBe("failed");
    // The hint must be appended to the error stored on the step
    expect(developStatus?.lastError).toContain("was a registered isolated worktree from earlier in this run");
    expect(developStatus?.lastError).toContain(cwdNotExistAdapter.capturedCwd);
  });

  it("does NOT append the hint for a path that was never a registered worktree", async () => {
    const engineCwd = "/fake/repo";
    setupGitMock(engineCwd);

    // Adapter returns cwd-not-exist for some arbitrary unknown path
    class ArbitraryCwdErrorAdapter implements RuntimeAdapter {
      async run(_ctx: RuntimeContext): Promise<RuntimeResult> {
        return {
          success: false,
          outputs: {},
          error: "cwd does not exist or is not a directory: /some/unknown/path",
        };
      }
    }

    const workflow: SparkflowWorkflow = {
      version: "1",
      name: "no-hint-test",
      entry: "develop",
      steps: {
        develop: {
          name: "Develop",
          interactive: false,
          runtime: { type: "shell", command: "true" },
          // shared mode — no worktree registered
        },
      },
    };

    const adapters = new Map<string, RuntimeAdapter>([
      ["shell", new ArbitraryCwdErrorAdapter()],
    ]);

    const engine = new WorkflowEngine(
      workflow,
      { logger: silentLogger, cwd: engineCwd },
      adapters,
    );

    const result = await engine.run();
    expect(result.success).toBe(false);

    const developStatus = result.stepResults.get("develop");
    expect(developStatus?.lastError).not.toContain("was a registered isolated worktree");
  });
});

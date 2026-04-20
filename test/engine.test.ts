import { describe, it, expect } from "vitest";
import { WorkflowEngine } from "../src/engine/engine.js";
import type { SparkflowWorkflow } from "../src/schema/types.js";
import { NudgeQueue } from "../src/runtime/types.js";
import type { RuntimeAdapter, RuntimeContext, RuntimeResult } from "../src/runtime/types.js";

// Silent logger for tests
const silentLogger = {
  info: () => {},
  error: () => {},
};

class MockAdapter implements RuntimeAdapter {
  private handler: (ctx: RuntimeContext) => Promise<RuntimeResult>;

  constructor(handler?: (ctx: RuntimeContext) => Promise<RuntimeResult>) {
    this.handler = handler ?? (async () => ({ success: true, outputs: {} }));
  }

  async run(ctx: RuntimeContext): Promise<RuntimeResult> {
    return this.handler(ctx);
  }
}

function makeAdapters(
  handler?: (ctx: RuntimeContext) => Promise<RuntimeResult>
): Map<string, RuntimeAdapter> {
  const adapter = new MockAdapter(handler);
  return new Map([
    ["shell", adapter],
    ["claude-code", adapter],
    ["custom", adapter],
  ]);
}

function makeWorkflow(overrides: Partial<SparkflowWorkflow> = {}): SparkflowWorkflow {
  return {
    version: "1",
    name: "test-workflow",
    entry: "start",
    defaults: {
      runtime: { type: "shell", command: "echo" },
      max_retries: 3,
    },
    steps: {
      start: {
        name: "Start",
        interactive: false,
      },
    },
    ...overrides,
  };
}

describe("WorkflowEngine", () => {
  it("runs a single step workflow", async () => {
    const workflow = makeWorkflow();
    const engine = new WorkflowEngine(workflow, { logger: silentLogger }, makeAdapters());
    const result = await engine.run();

    expect(result.success).toBe(true);
    expect(result.stepResults.get("start")?.state).toBe("succeeded");
  });

  it("runs linear execution (A → B → C)", async () => {
    const executionOrder: string[] = [];
    const workflow = makeWorkflow({
      steps: {
        a: {
          name: "A",
          interactive: false,
          on_success: [{ step: "b" }],
        },
        b: {
          name: "B",
          interactive: false,
          on_success: [{ step: "c" }],
        },
        c: {
          name: "C",
          interactive: false,
        },
      },
      entry: "a",
    });

    const adapters = makeAdapters(async (ctx) => {
      executionOrder.push(ctx.stepId);
      return { success: true, outputs: {} };
    });

    const engine = new WorkflowEngine(workflow, { logger: silentLogger }, adapters);
    const result = await engine.run();

    expect(result.success).toBe(true);
    expect(executionOrder).toEqual(["a", "b", "c"]);
  });

  it("runs fan-out (A → [B, C])", async () => {
    const executed = new Set<string>();
    const workflow = makeWorkflow({
      steps: {
        a: {
          name: "A",
          interactive: false,
          on_success: [{ step: "b" }, { step: "c" }],
        },
        b: {
          name: "B",
          interactive: false,
        },
        c: {
          name: "C",
          interactive: false,
        },
      },
      entry: "a",
    });

    const adapters = makeAdapters(async (ctx) => {
      executed.add(ctx.stepId);
      return { success: true, outputs: {} };
    });

    const engine = new WorkflowEngine(workflow, { logger: silentLogger }, adapters);
    const result = await engine.run();

    expect(result.success).toBe(true);
    expect(executed).toEqual(new Set(["a", "b", "c"]));
  });

  it("runs fan-in with join (A → [B, C] → D)", async () => {
    const executionOrder: string[] = [];
    const workflow = makeWorkflow({
      steps: {
        a: {
          name: "A",
          interactive: false,
          on_success: [{ step: "b" }, { step: "c" }],
        },
        b: {
          name: "B",
          interactive: false,
          on_success: [{ step: "d" }],
        },
        c: {
          name: "C",
          interactive: false,
          on_success: [{ step: "d" }],
        },
        d: {
          name: "D",
          interactive: false,
          join: ["b", "c"],
        },
      },
      entry: "a",
    });

    const adapters = makeAdapters(async (ctx) => {
      executionOrder.push(ctx.stepId);
      return { success: true, outputs: {} };
    });

    const engine = new WorkflowEngine(workflow, { logger: silentLogger }, adapters);
    const result = await engine.run();

    expect(result.success).toBe(true);
    expect(executionOrder).toContain("d");
    // D must be last
    expect(executionOrder[executionOrder.length - 1]).toBe("d");
  });

  it("handles feedback loop (A → B fails → A retry → B succeeds)", async () => {
    let bAttempts = 0;
    const workflow = makeWorkflow({
      steps: {
        a: {
          name: "Author",
          interactive: false,
          on_success: [{ step: "b" }],
        },
        b: {
          name: "Reviewer",
          interactive: false,
          on_failure: [{ step: "a", message: "Please fix the issues" }],
        },
      },
      entry: "a",
    });

    const adapters = makeAdapters(async (ctx) => {
      if (ctx.stepId === "b") {
        bAttempts++;
        if (bAttempts === 1) {
          return { success: false, outputs: {}, error: "Review failed" };
        }
      }
      return { success: true, outputs: {} };
    });

    const engine = new WorkflowEngine(workflow, { logger: silentLogger }, adapters);
    const result = await engine.run();

    expect(result.success).toBe(true);
    expect(bAttempts).toBe(2);
  });

  it("aborts when max retries exceeded", async () => {
    const workflow = makeWorkflow({
      defaults: {
        runtime: { type: "shell", command: "echo" },
        max_retries: 1,
      },
      steps: {
        a: {
          name: "A",
          interactive: false,
          on_success: [{ step: "b" }],
          on_failure: [{ step: "a" }],
        },
        b: {
          name: "B",
          interactive: false,
        },
      },
      entry: "a",
    });

    const adapters = makeAdapters(async () => {
      return { success: false, outputs: {}, error: "always fails" };
    });

    const engine = new WorkflowEngine(workflow, { logger: silentLogger }, adapters);
    const result = await engine.run();

    expect(result.success).toBe(false);
    expect(result.error).toContain("max retries");
  });

  it("fails workflow when step fails with no on_failure", async () => {
    const workflow = makeWorkflow({
      steps: {
        start: {
          name: "Start",
          interactive: false,
          // No on_failure
        },
      },
      entry: "start",
    });

    const adapters = makeAdapters(async () => {
      return { success: false, outputs: {}, error: "boom" };
    });

    const engine = new WorkflowEngine(workflow, { logger: silentLogger }, adapters);
    const result = await engine.run();

    expect(result.success).toBe(false);
    expect(result.error).toContain("no on_failure transition");
  });

  it("passes transition message to target step", async () => {
    const receivedMessages: (string | undefined)[] = [];
    const workflow = makeWorkflow({
      steps: {
        a: {
          name: "A",
          interactive: false,
          on_success: [{ step: "b", message: "hello from a" }],
        },
        b: {
          name: "B",
          interactive: false,
        },
      },
      entry: "a",
    });

    const adapters = makeAdapters(async (ctx) => {
      receivedMessages.push(ctx.transitionMessage);
      return { success: true, outputs: {} };
    });

    const engine = new WorkflowEngine(workflow, { logger: silentLogger }, adapters);
    await engine.run();

    expect(receivedMessages).toEqual([undefined, "hello from a"]);
  });

  it("resolves templates in transition messages", async () => {
    const receivedMessages: (string | undefined)[] = [];
    const workflow = makeWorkflow({
      steps: {
        a: {
          name: "A",
          interactive: false,
          outputs: { result: { type: "text" } },
          on_success: [
            { step: "b", message: "Got: ${steps.a.output.result}" },
          ],
        },
        b: {
          name: "B",
          interactive: false,
        },
      },
      entry: "a",
    });

    const adapters = makeAdapters(async (ctx) => {
      receivedMessages.push(ctx.transitionMessage);
      if (ctx.stepId === "a") {
        return { success: true, outputs: { result: "42" } };
      }
      return { success: true, outputs: {} };
    });

    const engine = new WorkflowEngine(workflow, { logger: silentLogger }, adapters);
    await engine.run();

    expect(receivedMessages[1]).toBe("Got: 42");
  });

  it("concurrent failure queuing (B and C both fail → A)", async () => {
    let aRunCount = 0;
    const workflow = makeWorkflow({
      steps: {
        a: {
          name: "A",
          interactive: false,
          on_success: [{ step: "b" }, { step: "c" }],
        },
        b: {
          name: "B",
          interactive: false,
          on_failure: [{ step: "a", message: "B failed" }],
        },
        c: {
          name: "C",
          interactive: false,
          on_failure: [{ step: "a", message: "C failed" }],
        },
      },
      entry: "a",
    });

    let bFailCount = 0;
    let cFailCount = 0;
    const adapters = makeAdapters(async (ctx) => {
      if (ctx.stepId === "a") {
        aRunCount++;
        return { success: true, outputs: {} };
      }
      // B and C each fail once, then succeed
      if (ctx.stepId === "b" && bFailCount < 1) {
        bFailCount++;
        return { success: false, outputs: {}, error: "B failed" };
      }
      if (ctx.stepId === "c" && cFailCount < 1) {
        cFailCount++;
        return { success: false, outputs: {}, error: "C failed" };
      }
      return { success: true, outputs: {} };
    });

    const engine = new WorkflowEngine(
      workflow,
      { logger: silentLogger },
      adapters
    );
    const result = await engine.run();

    expect(result.success).toBe(true);
    // A should have run multiple times (initial + retries from failures)
    expect(aRunCount).toBeGreaterThanOrEqual(2);
  });

  it("fan-out succeeds when both downstream steps succeed", async () => {
    const executionOrder: string[] = [];
    const workflow = makeWorkflow({
      steps: {
        author: {
          name: "Author",
          interactive: false,
          on_success: [{ step: "reviewer" }, { step: "test" }],
        },
        reviewer: {
          name: "Reviewer",
          interactive: false,
          on_failure: [{ step: "author", message: "review failed" }],
        },
        test: {
          name: "Test",
          interactive: false,
          on_failure: [{ step: "author", message: "tests failed" }],
        },
      },
      entry: "author",
    });

    const adapters = makeAdapters(async (ctx) => {
      executionOrder.push(ctx.stepId);
      return { success: true, outputs: {} };
    });

    const engine = new WorkflowEngine(workflow, { logger: silentLogger }, adapters);
    const result = await engine.run();

    expect(result.success).toBe(true);
    expect(executionOrder[0]).toBe("author");
    expect(executionOrder).toContain("reviewer");
    expect(executionOrder).toContain("test");
    expect(executionOrder.length).toBe(3);
  });

  it("one downstream step fails and recycles upstream", async () => {
    const executionOrder: string[] = [];
    let reviewerAttempts = 0;
    const workflow = makeWorkflow({
      steps: {
        author: {
          name: "Author",
          interactive: false,
          on_success: [{ step: "reviewer" }, { step: "test" }],
        },
        reviewer: {
          name: "Reviewer",
          interactive: false,
          on_failure: [{ step: "author", message: "review failed" }],
        },
        test: {
          name: "Test",
          interactive: false,
          on_failure: [{ step: "author", message: "tests failed" }],
        },
      },
      entry: "author",
    });

    const adapters = makeAdapters(async (ctx) => {
      executionOrder.push(ctx.stepId);
      if (ctx.stepId === "reviewer") {
        reviewerAttempts++;
        if (reviewerAttempts === 1) {
          return { success: false, outputs: {}, error: "bad code" };
        }
      }
      return { success: true, outputs: {} };
    });

    const engine = new WorkflowEngine(workflow, { logger: silentLogger }, adapters);
    const result = await engine.run();

    expect(result.success).toBe(true);
    expect(reviewerAttempts).toBe(2);
    // author ran at least twice (initial + retry after reviewer failure)
    expect(executionOrder.filter((s) => s === "author").length).toBeGreaterThanOrEqual(2);
    // reviewer ran twice (fail then succeed)
    expect(executionOrder.filter((s) => s === "reviewer").length).toBe(2);
  });

  it("both downstream steps fail and recycle upstream", async () => {
    const executionOrder: string[] = [];
    let reviewerAttempts = 0;
    let testAttempts = 0;
    const workflow = makeWorkflow({
      steps: {
        author: {
          name: "Author",
          interactive: false,
          on_success: [{ step: "reviewer" }, { step: "test" }],
        },
        reviewer: {
          name: "Reviewer",
          interactive: false,
          on_failure: [{ step: "author", message: "review failed" }],
        },
        test: {
          name: "Test",
          interactive: false,
          on_failure: [{ step: "author", message: "tests failed" }],
        },
      },
      entry: "author",
    });

    const adapters = makeAdapters(async (ctx) => {
      executionOrder.push(ctx.stepId);
      if (ctx.stepId === "reviewer") {
        reviewerAttempts++;
        if (reviewerAttempts === 1) {
          return { success: false, outputs: {}, error: "bad code" };
        }
      }
      if (ctx.stepId === "test") {
        testAttempts++;
        if (testAttempts === 1) {
          return { success: false, outputs: {}, error: "tests broken" };
        }
      }
      return { success: true, outputs: {} };
    });

    const engine = new WorkflowEngine(workflow, { logger: silentLogger }, adapters);
    const result = await engine.run();

    expect(result.success).toBe(true);
    // Both ran at least twice (initial failure + at least one retry that succeeds)
    expect(reviewerAttempts).toBeGreaterThanOrEqual(2);
    expect(testAttempts).toBeGreaterThanOrEqual(2);
    // author ran multiple times due to failures from both downstream steps
    expect(executionOrder.filter((s) => s === "author").length).toBeGreaterThanOrEqual(2);
  });

  it("in-place retry recovers transient failure without traversing on_failure", async () => {
    let attempts = 0;
    let onFailureFired = false;
    const workflow = makeWorkflow({
      steps: {
        flaky: {
          name: "Flaky",
          interactive: false,
          retry: { attempts: 3 },
          on_failure: [{ step: "fallback" }],
        },
        fallback: {
          name: "Fallback",
          interactive: false,
        },
      },
      entry: "flaky",
    });

    const adapters = makeAdapters(async (ctx) => {
      if (ctx.stepId === "fallback") {
        onFailureFired = true;
        return { success: true, outputs: {} };
      }
      attempts++;
      if (attempts < 3) return { success: false, outputs: {}, error: "transient" };
      return { success: true, outputs: {} };
    });

    const engine = new WorkflowEngine(workflow, { logger: silentLogger }, adapters);
    const result = await engine.run();

    expect(result.success).toBe(true);
    expect(attempts).toBe(3);
    expect(onFailureFired).toBe(false);
  });

  it("retry exhaustion falls through to on_failure", async () => {
    let attempts = 0;
    let fallbackRan = false;
    const workflow = makeWorkflow({
      steps: {
        flaky: {
          name: "Flaky",
          interactive: false,
          retry: { attempts: 2 },
          on_failure: [{ step: "fallback" }],
        },
        fallback: {
          name: "Fallback",
          interactive: false,
        },
      },
      entry: "flaky",
    });

    const adapters = makeAdapters(async (ctx) => {
      if (ctx.stepId === "fallback") {
        fallbackRan = true;
        return { success: true, outputs: {} };
      }
      attempts++;
      return { success: false, outputs: {}, error: "always broken" };
    });

    const engine = new WorkflowEngine(workflow, { logger: silentLogger }, adapters);
    const result = await engine.run();

    // Workflow fails because the flaky step's terminal state is `failed`,
    // but on_failure transitions still fire and `fallback` runs.
    expect(result.success).toBe(false);
    expect(attempts).toBe(2);
    expect(fallbackRan).toBe(true);
  });

  it("retry counter is independent of upstream re-entry counter", async () => {
    // Reviewer fails once intrinsically (uses retry), then fails once on review (uses on_failure → developer).
    let reviewerCalls = 0;
    let developerCalls = 0;
    const workflow = makeWorkflow({
      defaults: {
        runtime: { type: "shell", command: "echo" },
        max_retries: 1, // tight max_retries to prove retry doesn't burn this budget
      },
      steps: {
        developer: {
          name: "Dev",
          interactive: false,
          on_success: [{ step: "reviewer" }],
        },
        reviewer: {
          name: "Reviewer",
          interactive: false,
          retry: { attempts: 3 },
          on_failure: [{ step: "developer", message: "fix it" }],
        },
      },
      entry: "developer",
    });

    const adapters = makeAdapters(async (ctx) => {
      if (ctx.stepId === "developer") {
        developerCalls++;
        return { success: true, outputs: {} };
      }
      reviewerCalls++;
      // First call: 2 transient failures then real review failure. Retry handles transients.
      if (reviewerCalls === 1) return { success: false, outputs: {}, error: "transient" };
      if (reviewerCalls === 2) return { success: false, outputs: {}, error: "transient" };
      if (reviewerCalls === 3) return { success: false, outputs: {}, error: "review failed" };
      // After developer retry: succeed cleanly
      return { success: true, outputs: {} };
    });

    const engine = new WorkflowEngine(workflow, { logger: silentLogger }, adapters);
    const result = await engine.run();

    expect(result.success).toBe(true);
    // reviewer ran 3 times in first execution (2 retries + final), then once more after dev re-entry
    expect(reviewerCalls).toBe(4);
    // developer ran twice (initial + on_failure re-entry); max_retries=1 was not exceeded
    expect(developerCalls).toBe(2);
  });

  it("dry-run does not execute adapters", async () => {
    let adapterCalled = false;
    const workflow = makeWorkflow();

    const adapters = makeAdapters(async () => {
      adapterCalled = true;
      return { success: true, outputs: {} };
    });

    const engine = new WorkflowEngine(
      workflow,
      { logger: silentLogger, dryRun: true },
      adapters
    );
    const result = await engine.run();

    expect(result.success).toBe(true);
    expect(adapterCalled).toBe(false);
  });

  // Regression: when a claude-code step is re-entered via on_success fan-out
  // (not via failure retry), the engine must not reuse the prior sessionId.
  // Reusing it caused claude-code to reject the spawn with "Session ID X is
  // already in use." See the workflow-loopback bug report for context.
  it("does not pass a stale sessionId when a claude-code step re-runs via on_success", async () => {
    const prev = process.env.SPARKFLOW_LLM;
    delete process.env.SPARKFLOW_LLM;
    try {
      // Track the ctx each claude-code step sees per invocation.
      const invocations: Array<{ stepId: string; sessionId: string | undefined; resume: boolean }> = [];
      const workflow: SparkflowWorkflow = {
        version: "1",
        name: "loopback-test",
        entry: "author",
        defaults: { runtime: { type: "shell", command: "echo" }, max_retries: 5 },
        steps: {
          author: {
            name: "Author",
            interactive: true,
            runtime: { type: "claude-code" },
            on_success: [{ step: "reviewer" }],
          },
          reviewer: {
            name: "Reviewer",
            interactive: false,
            runtime: { type: "claude-code" },
            on_success: [{ step: "gate" }],
          },
          gate: {
            // Succeeds on the first pass, fails on the second to loop the
            // workflow back to author → reviewer. Third pass stops the loop.
            name: "Gate",
            interactive: false,
            runtime: { type: "shell", command: "echo" },
            on_failure: [{ step: "author" }],
          },
        },
      };

      let gateHits = 0;
      const adapters = new Map<string, RuntimeAdapter>([
        ["claude-code", new MockAdapter(async (ctx) => {
          invocations.push({
            stepId: ctx.stepId,
            sessionId: ctx.sessionId,
            resume: !!ctx.resume,
          });
          // Mimic claude-code's contract: always return a session id.
          return { success: true, outputs: {}, sessionId: ctx.sessionId ?? `session-${ctx.stepId}-${invocations.length}` };
        })],
        ["shell", new MockAdapter(async () => {
          gateHits++;
          return { success: gateHits !== 1, outputs: {} };
        })],
      ]);

      const engine = new WorkflowEngine(workflow, { logger: silentLogger }, adapters);
      await engine.run();

      // Second reviewer invocation (the one triggered via author's on_success
      // after the loopback) must NOT carry the stale sessionId from the first
      // review. It should be undefined — a fresh, non-resuming run.
      const reviewerRuns = invocations.filter((i) => i.stepId === "reviewer");
      expect(reviewerRuns.length).toBeGreaterThanOrEqual(2);
      expect(reviewerRuns[0].sessionId).toBeUndefined();
      expect(reviewerRuns[0].resume).toBe(false);
      expect(reviewerRuns[1].sessionId).toBeUndefined();
      expect(reviewerRuns[1].resume).toBe(false);

      // The author step, in contrast, IS re-entered via on_failure — so after
      // its first run it should resume its prior session on the retry.
      const authorRuns = invocations.filter((i) => i.stepId === "author");
      expect(authorRuns.length).toBeGreaterThanOrEqual(2);
      expect(authorRuns[0].resume).toBe(false);
      expect(authorRuns[1].resume).toBe(true);
      expect(authorRuns[1].sessionId).toBe("session-author-1");
    } finally {
      if (prev === undefined) delete process.env.SPARKFLOW_LLM;
      else process.env.SPARKFLOW_LLM = prev;
    }
  });

  it("SPARKFLOW_LLM=gemini remaps claude-code runtimes at dispatch time", async () => {
    const seenTypes: string[] = [];
    const workflow: SparkflowWorkflow = {
      version: "1",
      name: "llm-override",
      entry: "a",
      defaults: { runtime: { type: "shell", command: "echo" }, max_retries: 1 },
      steps: {
        a: {
          name: "A",
          interactive: false,
          runtime: { type: "claude-code" },
          on_success: [{ step: "b" }],
        },
        b: { name: "B", interactive: false, runtime: { type: "shell", command: "echo" } },
      },
    };

    const adapters = new Map<string, RuntimeAdapter>([
      ["claude-code", new MockAdapter(async (ctx) => {
        seenTypes.push(`claude-code:${ctx.stepId}`);
        return { success: true, outputs: {} };
      })],
      ["gemini", new MockAdapter(async (ctx) => {
        seenTypes.push(`gemini:${ctx.stepId}`);
        return { success: true, outputs: {} };
      })],
      ["shell", new MockAdapter(async (ctx) => {
        seenTypes.push(`shell:${ctx.stepId}`);
        return { success: true, outputs: {} };
      })],
    ]);

    const prev = process.env.SPARKFLOW_LLM;
    process.env.SPARKFLOW_LLM = "gemini";
    try {
      const engine = new WorkflowEngine(workflow, { logger: silentLogger }, adapters);
      await engine.run();
    } finally {
      if (prev === undefined) delete process.env.SPARKFLOW_LLM;
      else process.env.SPARKFLOW_LLM = prev;
    }

    // Step a was claude-code; the override routes it to the gemini adapter.
    // Step b was shell; the override doesn't touch non-LLM runtimes.
    expect(seenTypes).toContain("gemini:a");
    expect(seenTypes).toContain("shell:b");
    expect(seenTypes.some((t) => t.startsWith("claude-code:"))).toBe(false);
  });

  describe("token limit auto-resume", () => {
    it("resumes a claude-code step that hits the token limit", async () => {
      let callCount = 0;
      const workflow: SparkflowWorkflow = {
        version: "1",
        name: "token-limit-test",
        entry: "worker",
        steps: {
          worker: {
            name: "Worker",
            interactive: false,
            runtime: { type: "claude-code" },
          },
        },
      };

      const adapters = new Map<string, RuntimeAdapter>([
        ["claude-code", new MockAdapter(async (ctx) => {
          callCount++;
          if (callCount === 1) {
            // First call hits the token limit
            return { success: false, outputs: {}, tokenLimitHit: true, sessionId: "sess-1" };
          }
          // Second call (resume) succeeds
          return { success: true, outputs: {}, sessionId: "sess-1" };
        })],
      ]);

      const engine = new WorkflowEngine(workflow, { logger: silentLogger }, adapters);
      const result = await engine.run();

      expect(result.success).toBe(true);
      expect(callCount).toBe(2);
    });

    it("resumes with the session id from the token-limited run", async () => {
      const calls: Array<{ sessionId: string | undefined; resume: boolean }> = [];
      const workflow: SparkflowWorkflow = {
        version: "1",
        name: "token-limit-session-test",
        entry: "worker",
        steps: {
          worker: {
            name: "Worker",
            interactive: false,
            runtime: { type: "claude-code" },
          },
        },
      };

      const adapters = new Map<string, RuntimeAdapter>([
        ["claude-code", new MockAdapter(async (ctx) => {
          calls.push({ sessionId: ctx.sessionId, resume: !!ctx.resume });
          if (calls.length === 1) {
            return { success: false, outputs: {}, tokenLimitHit: true, sessionId: "sess-abc" };
          }
          return { success: true, outputs: {}, sessionId: "sess-abc" };
        })],
      ]);

      const engine = new WorkflowEngine(workflow, { logger: silentLogger }, adapters);
      await engine.run();

      expect(calls).toHaveLength(2);
      expect(calls[0].resume).toBe(false);
      // Second call must resume the same session
      expect(calls[1].resume).toBe(true);
      expect(calls[1].sessionId).toBe("sess-abc");
    });

    it("aborts after exhausting token limit resumes", async () => {
      let callCount = 0;
      const workflow: SparkflowWorkflow = {
        version: "1",
        name: "token-limit-exhaust",
        entry: "worker",
        steps: {
          worker: {
            name: "Worker",
            interactive: false,
            runtime: { type: "claude-code" },
          },
        },
      };

      const adapters = new Map<string, RuntimeAdapter>([
        ["claude-code", new MockAdapter(async () => {
          callCount++;
          // Always hit the token limit
          return { success: false, outputs: {}, tokenLimitHit: true, sessionId: "sess-x" };
        })],
      ]);

      const engine = new WorkflowEngine(workflow, { logger: silentLogger }, adapters);
      const result = await engine.run();

      expect(result.success).toBe(false);
      // 1 initial + 10 resumes = 11 total calls
      expect(callCount).toBe(11);
    });

    it("does not affect the feedback-loop retry counter", async () => {
      const calls: Array<{ stepId: string; resume: boolean }> = [];
      const workflow: SparkflowWorkflow = {
        version: "1",
        name: "token-limit-no-retry-count",
        entry: "worker",
        defaults: { runtime: { type: "shell", command: "echo" }, max_retries: 1 },
        steps: {
          worker: {
            name: "Worker",
            interactive: false,
            runtime: { type: "claude-code" },
            on_failure: [{ step: "fallback" }],
          },
          fallback: {
            name: "Fallback",
            interactive: false,
          },
        },
      };

      let workerCalls = 0;
      const adapters = new Map<string, RuntimeAdapter>([
        ["claude-code", new MockAdapter(async (ctx) => {
          calls.push({ stepId: ctx.stepId, resume: !!ctx.resume });
          workerCalls++;
          if (workerCalls === 1) {
            return { success: false, outputs: {}, tokenLimitHit: true, sessionId: "sess-y" };
          }
          return { success: true, outputs: {}, sessionId: "sess-y" };
        })],
        ["shell", new MockAdapter(async () => ({ success: true, outputs: {} }))],
      ]);

      const engine = new WorkflowEngine(workflow, { logger: silentLogger }, adapters);
      const result = await engine.run();

      expect(result.success).toBe(true);
      // Token limit resume should not fire the fallback
      expect(calls.some((c) => c.stepId === "fallback")).toBe(false);
    });
  });

  describe("nudge queue", () => {
    it("provides a NudgeQueue to claude-code steps", async () => {
      let capturedQueue: unknown;
      const workflow: SparkflowWorkflow = {
        version: "1",
        name: "nudge-queue-presence",
        entry: "a",
        defaults: {},
        steps: {
          a: { name: "A", interactive: false, runtime: { type: "claude-code" } },
        },
      };

      const adapters = new Map<string, RuntimeAdapter>([
        ["claude-code", new MockAdapter(async (ctx) => {
          capturedQueue = ctx.nudgeQueue;
          return { success: true, outputs: {} };
        })],
      ]);

      await new WorkflowEngine(workflow, { logger: silentLogger }, adapters).run();

      expect(capturedQueue).toBeInstanceOf(NudgeQueue);
    });

    it("does not provide a nudgeQueue to non-claude-code steps", async () => {
      let capturedQueue: unknown = "not-set";
      const workflow: SparkflowWorkflow = {
        version: "1",
        name: "nudge-queue-shell",
        entry: "a",
        defaults: {},
        steps: {
          a: { name: "A", interactive: false, runtime: { type: "shell", command: "echo" } },
        },
      };

      const adapters = new Map<string, RuntimeAdapter>([
        ["shell", new MockAdapter(async (ctx) => {
          capturedQueue = ctx.nudgeQueue;
          return { success: true, outputs: {} };
        })],
      ]);

      await new WorkflowEngine(workflow, { logger: silentLogger }, adapters).run();

      expect(capturedQueue).toBeUndefined();
    });

    it("routes mid-run message to nudgeQueue when target claude-code step is running", async () => {
      // Fan-out: start → [A (claude-code, long-running), B (shell, fast)]
      // B's on_success triggers A with a nudge. Since A is still running when B
      // completes, the message must land in A's nudgeQueue (not pendingMessages).
      let releaseA!: (r: RuntimeResult) => void;
      let capturedQueue: NudgeQueue | undefined;

      const workflow: SparkflowWorkflow = {
        version: "1",
        name: "nudge-routing-test",
        entry: "start",
        defaults: {},
        steps: {
          start: {
            name: "Start", interactive: false,
            runtime: { type: "shell", command: "echo" },
            on_success: [{ step: "a" }, { step: "b" }],
          },
          a: { name: "A", interactive: false, runtime: { type: "claude-code" } },
          b: {
            name: "B", interactive: false,
            runtime: { type: "shell", command: "echo" },
            on_success: [{ step: "a", message: "nudge from b" }],
          },
        },
      };

      const adapters = new Map<string, RuntimeAdapter>([
        ["claude-code", new MockAdapter(async (ctx) => {
          capturedQueue = ctx.nudgeQueue as NudgeQueue | undefined;
          // Hold A running so B can complete and push a nudge while A is live
          return new Promise<RuntimeResult>((r) => { releaseA = r; });
        })],
        ["shell", new MockAdapter(async () => ({ success: true, outputs: {} }))],
      ]);

      const runPromise = new WorkflowEngine(workflow, { logger: silentLogger }, adapters).run();

      // One setImmediate boundary lets all pending microtasks drain: start → B
      // completes → on_success fires → nudge pushed to A's queue.
      await new Promise<void>((r) => setImmediate(r));

      expect(capturedQueue).toBeInstanceOf(NudgeQueue);
      expect(capturedQueue?.shift()).toBe("nudge from b");

      releaseA({ success: true, outputs: {} });
      const result = await runPromise;
      expect(result.success).toBe(true);
    });

    it("flushes undelivered nudges to pendingMessages on step completion", async () => {
      // Simulate a nudge that was pushed to the queue just as A was about to
      // finish — i.e., we push to the queue manually after capturing it, then
      // release A. The engine's finally block should move those nudges into
      // pendingMessages, causing A to re-run with them.
      let releaseA!: (r: RuntimeResult) => void;
      let capturedQueue: NudgeQueue | undefined;
      const aRunMessages: Array<string | undefined> = [];

      const workflow: SparkflowWorkflow = {
        version: "1",
        name: "nudge-flush-test",
        entry: "a",
        defaults: {},
        steps: {
          a: { name: "A", interactive: false, runtime: { type: "claude-code" } },
        },
      };

      let callCount = 0;
      const adapters = new Map<string, RuntimeAdapter>([
        ["claude-code", new MockAdapter(async (ctx) => {
          callCount++;
          aRunMessages.push(ctx.transitionMessage);
          if (callCount === 1) {
            capturedQueue = ctx.nudgeQueue as NudgeQueue | undefined;
            return new Promise<RuntimeResult>((r) => { releaseA = r; });
          }
          return { success: true, outputs: {} };
        })],
      ]);

      const runPromise = new WorkflowEngine(workflow, { logger: silentLogger }, adapters).run();

      // Let A start and capture its queue
      await new Promise<void>((r) => setImmediate(r));
      expect(capturedQueue).toBeInstanceOf(NudgeQueue);

      // Push a nudge directly into the queue (simulates a late-arriving nudge)
      capturedQueue!.push("late nudge");

      // Release A — its run loop will see the nudge, drain it into pendingMessages,
      // which triggers a second invocation of A with "late nudge" as transitionMessage.
      releaseA({ success: true, outputs: {} });

      const result = await runPromise;
      expect(result.success).toBe(true);
      expect(callCount).toBe(2);
      expect(aRunMessages[1]).toBe("late nudge");
    });
  });

  it("SPARKFLOW_LLM=claude routes gemini runtimes through the claude-code adapter", async () => {
    const seenTypes: string[] = [];
    const workflow: SparkflowWorkflow = {
      version: "1",
      name: "llm-override-reverse",
      entry: "a",
      defaults: { runtime: { type: "shell", command: "echo" }, max_retries: 1 },
      steps: { a: { name: "A", interactive: false, runtime: { type: "gemini" } } },
    };

    const adapters = new Map<string, RuntimeAdapter>([
      ["claude-code", new MockAdapter(async (ctx) => {
        seenTypes.push(`claude-code:${ctx.stepId}`);
        return { success: true, outputs: {} };
      })],
      ["gemini", new MockAdapter(async (ctx) => {
        seenTypes.push(`gemini:${ctx.stepId}`);
        return { success: true, outputs: {} };
      })],
      ["shell", new MockAdapter(async () => ({ success: true, outputs: {} }))],
    ]);

    const prev = process.env.SPARKFLOW_LLM;
    process.env.SPARKFLOW_LLM = "claude";
    try {
      const engine = new WorkflowEngine(workflow, { logger: silentLogger }, adapters);
      await engine.run();
    } finally {
      if (prev === undefined) delete process.env.SPARKFLOW_LLM;
      else process.env.SPARKFLOW_LLM = prev;
    }

    expect(seenTypes).toEqual(["claude-code:a"]);
  });
});
